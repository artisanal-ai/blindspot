import type { BlindSpot } from '../types'
import type { Git, Repo } from './repo'
import { toRepoPath } from './repo'

// Blind spots: files that use a function Claude changed, which Claude never
// read. Works for any language:
//   1. Which functions changed: `git diff` gives the changed lines; the
//      declaration each one sits in is found in the file. A declaration the
//      diff removed, whose name the file no longer declares, was renamed or
//      deleted: its old name is looked for.
//   2. Who uses them: the language server's "find references" when one runs
//      for the file (exact), or else a search for the name (no setup needed),
//      narrowed to the files that import its module when the name is taken twice.

/** What finding blind spots needs from Claude Code. The hooks module builds these. */
export type Tools = {
  git: Git
  /** A repo file's text; null when it can't be read. */
  readFile: (path: string) => Promise<string | null>
  /** The LSP tool's "find references" answer for the symbol at a 1-based position; null when no language server runs. */
  references: (path: string, line: number, column: number) => Promise<string | null>
  sleep: (ms: number) => Promise<void>
  /** Milliseconds since the epoch. */
  now: () => Promise<number>
}

/** A changed function: its name and where it's declared (1-based); line 0 when the change removed it. */
export type Declaration = { name: string; path: string; line: number; column: number }

type Place = { path: string; line: number }

// --- Declarations, in any language ---

const MODIFIERS = '(?:(?:export|default|public|private|protected|internal|static|final|abstract|async|override|virtual|sealed|open|inline|suspend|pub(?:\\([^)]*\\))?)\\s+)*'
// `def f`, `func f`, `fn f`, `function f`, `class C`, …
const KEYWORD_DECLARATION = new RegExp(
  `^\\s*${MODIFIERS}(?:function\\*?|def|fn|fun|func(?:\\s*\\([^)]*\\))?|class|interface|struct|enum|record|trait)\\s+([A-Za-z_$][\\w$]*)`,
  'd',
)
// `const f =`, `let`, `var`, `val`: at the top of the file, or exported; inside
// a function they're its locals.
const VARIABLE_DECLARATION = new RegExp(`^(?:\\s*export\\s+)?${MODIFIERS}(?:const|let|var|val)\\s+([A-Za-z_$][\\w$]*)`, 'd')
// Java, C#, TypeScript methods: `public String formatMoney(long cents) {`. The
// first group is the return type, so a statement (`return f(x)`) isn't one.
const TYPED_METHOD = new RegExp(`^\\s*${MODIFIERS}([\\w<>\\[\\],.?]+)\\s+([A-Za-z_]\\w*)\\s*\\([^;=]*$`, 'd')
// JavaScript class methods: `  async load(id) {`
const BARE_METHOD = /^\s+(?:(?:static|async|get|set|public|private|protected)\s+)*([A-Za-z_$][\w$]*)\s*\([^;=]*\)\s*(?::[^=;]*)?\{\s*$/d
// Words that start statements, never a declaration's name or return type.
const KEYWORDS = new Set(
  'if elif else for foreach while do switch case when match try catch except finally return yield await throw raise new delete typeof instanceof void assert del print echo go defer with using lock synchronized import from package not and or in is'.split(' '),
)

// The name in `match`'s group `group`, and the 1-based column it starts at.
function named(match: RegExpExecArray | null, group: number): { name: string; column: number } | null {
  const name = match?.[group]
  const start = match?.indices?.[group]?.[0]
  return name === undefined || start === undefined || KEYWORDS.has(name) ? null : { name, column: start + 1 }
}

/** The name a line declares, and the 1-based column it starts at; null when it declares nothing. */
export function declarationIn(line: string): { name: string; column: number } | null {
  const typed = TYPED_METHOD.exec(line)
  return (
    named(KEYWORD_DECLARATION.exec(line), 1) ??
    named(VARIABLE_DECLARATION.exec(line), 1) ??
    (typed !== null && !KEYWORDS.has(typed[1] ?? '') ? named(typed, 2) : null) ??
    named(BARE_METHOD.exec(line), 1)
  )
}

const indentOf = (line: string) => line.length - line.trimStart().length

// The declaration line `number` (1-based) sits in: the line itself, or the
// nearest one above that each step up is less indented than the last.
function enclosing(lines: string[], number: number): { line: number; name: string; column: number } | null {
  const own = declarationIn(lines[number - 1] ?? '')
  if (own !== null) return { line: number, ...own }
  let indent = indentOf(lines[number - 1] ?? '')
  for (let i = number - 2; i >= 0 && indent > 0; i--) {
    const text = lines[i] ?? ''
    if (text.trim() === '' || indentOf(text) >= indent) continue
    const found = declarationIn(text)
    if (found !== null) return { line: i + 1, ...found }
    indent = indentOf(text)
  }
  return null
}

/**
 * The declarations a change touched, from its `git diff -U0` and the file as
 * it is now: those its changed lines sit in, and first those it removed (line
 * 0), renamed or deleted.
 */
export function changedDeclarations(path: string, diff: string, content: string): Declaration[] {
  const lines = content.split('\n')
  const declared = new Set(lines.map(line => declarationIn(line)?.name))
  const gone = new Map<string, Declaration>()
  const found = new Map<string, Declaration>()
  for (const hunk of diff.split(/^(?=@@ )/m)) {
    const header = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(hunk)
    if (header === null) continue
    const removed = hunk
      .split('\n')
      .slice(1)
      .filter(line => line.startsWith('-'))
      .map(line => declarationIn(line.slice(1)))
      .filter((decl): decl is { name: string; column: number } => decl !== null)
    for (const { name } of removed) if (!declared.has(name)) gone.set(name, { name, path, line: 0, column: 0 })

    const [, start = '0', count = '1'] = header
    // A hunk that only removed a declaration: the line before it didn't change.
    if (Number(count) === 0 && removed.length > 0) continue
    const first = Number(start)
    const last = Number(count) === 0 ? first : first + Number(count) - 1
    for (let n = Math.max(1, first); n <= last; n++) {
      const decl = enclosing(lines, n)
      if (decl !== null) found.set(`${decl.name}:${decl.line}`, { path, ...decl })
    }
  }
  return [...gone.values(), ...found.values()]
}

// --- References ---

/** Places in the LSP tool's answer: `path:line:col` lines, or a `path:` header with `Line l:c` under it. */
export function parseReferences(text: string): Place[] {
  const places: Place[] = []
  let file = ''
  for (const line of text.split('\n')) {
    const inline = /^\s*(\S[^:]*):(\d+):\d+\s*$/.exec(line)
    const header = /^(\S.*):\s*$/.exec(line)
    const under = /^\s+Line (\d+):\d+/.exec(line)
    if (inline !== null) places.push({ path: inline[1] ?? '', line: Number(inline[2]) })
    else if (under !== null && file !== '') places.push({ path: file, line: Number(under[1]) })
    else if (header !== null && !line.startsWith('Found')) file = header[1] ?? ''
  }
  return places
}

// Names too common to search for: they'd match half the repo.
const GENERIC = new Set(['get', 'set', 'run', 'init', 'main', 'call', 'load', 'save', 'test', 'data', 'value', 'update', 'create', 'delete', 'handle', 'process', 'render', 'build', 'parse', 'start', 'stop', 'setup', 'apply', 'execute', 'toString', 'equals', 'hashCode', '__init__', 'constructor'])
// Prose and data: a mention in a README or a log is no use of the function.
const PROSE = /\.(md|mdx|markdown|txt|rst|adoc|org|log|csv|tsv|lock)$/i
// `#`, `//`, `/*`, a block comment's `* ` line, `--`, `<!--`.
const COMMENT = /^\s*(#|\/\/|\/\*|\*(\s|\/|$)|--|<!--)/

// Index files are imported by their folder's name.
const INDEX = new Set(['index', '__init__', 'mod', 'lib', 'main', 'init'])

/** The names another file would import `path` by: its own name, and its folder's. */
export function moduleNames(path: string): string[] {
  const parts = path.split('/')
  const stem = (parts.at(-1) ?? '').replace(/\.[^.]*$/, '')
  return [stem, parts.at(-2)].filter((n): n is string => n !== undefined && n !== '' && !INDEX.has(n))
}

const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1)

// Without a language server: every line of code that names the function as
// a whole word, comments and prose files left out. When another file declares
// a function of the same name, only the files that can see this one count:
// those in its folder, and those that name its module (`import money`,
// `"billing"`, `money.h`).
async function searchFor(git: Git, decl: Declaration): Promise<Place[]> {
  const { name } = decl
  if (name.length < 4 || GENERIC.has(name)) return []
  const grep = (await git(['grep', '-n', '-w', '-F', '--untracked', name])) ?? ''
  const hits = grep
    .split('\n')
    .map(row => /^([^:]+):(\d+):(.*)$/.exec(row))
    .filter((m): m is RegExpExecArray => m !== null && !PROSE.test(m[1] ?? '') && !COMMENT.test(m[3] ?? ''))
    .map(m => ({ path: m[1] ?? '', line: Number(m[2]), text: m[3] ?? '' }))
  const others = new Set(hits.filter(h => h.path !== decl.path && declarationIn(h.text)?.name === name).map(h => h.path))
  const places = hits.map(({ path, line }) => ({ path, line }))
  if (others.size === 0) return places

  const names = moduleNames(decl.path)
  const naming = names.length === 0 ? '' : ((await git(['grep', '-l', '-w', '-F', '--untracked', ...names.flatMap(n => ['-e', n])])) ?? '')
  const sees = new Set(naming.split('\n'))
  const folder = folderOf(decl.path)
  return places.filter(p => p.path === decl.path || (!others.has(p.path) && (folderOf(p.path) === folder || sees.has(p.path))))
}

// The language server's answer when all it knows is the declaration itself:
// it may still be indexing, or nothing uses the function.
const isAlone = (places: Place[], decl: Declaration) => places.length === 1 && places[0]?.path === decl.path && places[0].line === decl.line

// Where a declaration is used: the language server's answer (asked once more
// after a moment, the first time it knows only the declaration), else the
// name search. A removed declaration has no place to ask about.
async function usesOf(tools: Tools, repo: Repo, decl: Declaration, retry: () => boolean): Promise<Place[]> {
  if (decl.line === 0) return searchFor(tools.git, decl)
  const ask = async () => parseReferences((await tools.references(decl.path, decl.line, decl.column)) ?? '').map(p => ({ ...p, path: toRepoPath(repo, p.path) }))
  let places = await ask()
  if (isAlone(places, decl) && retry()) {
    await tools.sleep(2500)
    places = await ask()
  }
  return places.length > 0 ? places : searchFor(tools.git, decl)
}

// --- Blind spots ---

// An import line: a use, but a line that calls the function says more.
const IMPORT_LINE = /^\s*(import|from\s+\S+\s+import|using|require|#include|use)\b|\brequire\s*\(/

const TEST = /(^|\/)(test|tests|__tests__|spec)\/|(\.|_)(test|spec)\.[^.]+$|(^|\/)test_[^/]+$/

// How long a scan may look before it reports what it has.
const SCAN_MS = 20_000
const MAX_DECLARATIONS = 10 // per changed file
const USAGE_MAX = 160

const clip = (line: string) => (line.length <= USAGE_MAX ? line : `${line.slice(0, USAGE_MAX - 1)}…`)

/**
 * The blind spots of `changed`, the files Claude edited since `base` (a
 * commit; null for the index): the files that use a changed function on a
 * line Claude never read, each with the line that uses it. A function used
 * only inside its own file stands for the functions there that call it.
 * Tests after the code they test, at most `limit`.
 */
export async function findBlindSpots(
  tools: Tools,
  repo: Repo,
  changed: string[],
  base: string | null,
  isRead: (path: string, line: number) => boolean,
  limit: number,
): Promise<BlindSpot[]> {
  const spots = new Map<string, BlindSpot>()
  const deadline = (await tools.now()) + SCAN_MS
  let retried = false
  const retry = () => !retried && (retried = true)

  for (const path of changed) {
    const diff = await tools.git(['diff', '-U0', '--no-color', ...(base === null ? [] : [base]), '--', path])
    const content = diff === null || diff === '' ? null : await tools.readFile(path)
    if (diff === null || content === null) continue
    const lines = content.split('\n')
    // Each declaration with the changed one it stands for.
    const queue = changedDeclarations(path, diff, content).map(decl => ({ decl, origin: decl.name }))
    const asked = new Set<string>()

    while (queue.length > 0 && asked.size < MAX_DECLARATIONS && (await tools.now()) < deadline) {
      const { decl, origin } = queue.shift() as { decl: Declaration; origin: string }
      if (asked.has(decl.name)) continue
      asked.add(decl.name)
      const places = await usesOf(tools, repo, decl, retry)
      const elsewhere = places.filter(p => p.path !== path)
      if (elsewhere.length === 0) {
        // Only used in its own file: what calls it there changed too.
        for (const p of places.filter(p => p.line !== decl.line)) {
          const caller = enclosing(lines, p.line)
          if (caller !== null && caller.line !== decl.line) queue.push({ decl: { path, ...caller }, origin })
        }
        continue
      }
      for (const file of new Set(elsewhere.map(p => p.path))) {
        if (spots.has(file) || !repo.known.has(file)) continue
        const unread = elsewhere.filter(p => p.path === file && !isRead(file, p.line))
        if (unread.length === 0) continue
        const text = ((await tools.readFile(file)) ?? '').split('\n')
        const uses = unread.map(p => ({ line: p.line, usage: clip(text[p.line - 1]?.trim() ?? '') }))
        const best = uses.find(use => !IMPORT_LINE.test(use.usage)) ?? uses[0]
        if (best !== undefined) spots.set(file, { path: file, changedFile: path, symbol: decl.name, changedSymbol: origin, ...best, lines: uses.map(use => use.line) })
      }
    }
  }
  const rank = (spot: BlindSpot) => (TEST.test(spot.path) ? 1 : 0)
  return [...spots.values()].sort((a, b) => rank(a) - rank(b)).slice(0, limit)
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The blind spots in `spots` that still hold, rechecked after a turn that left
 * them open: the change each traces back to is still in its file since `base`
 * (a commit; null for the index), and the file still uses the function on a
 * line Claude hasn't read, its line numbers as the file is now. A spot dropped
 * here was reverted, or fixed or moved by someone else. One git can't answer
 * for stays as it was.
 */
export async function recheck(tools: Tools, spots: BlindSpot[], base: string | null, isRead: (path: string, line: number) => boolean): Promise<BlindSpot[]> {
  // The names each changed file's diff still touches; null when git failed.
  const touched = new Map<string, Set<string> | null>()
  const namesChangedIn = async (path: string) => {
    if (!touched.has(path)) {
      const diff = await tools.git(['diff', '-U0', '--no-color', ...(base === null ? [] : [base]), '--', path])
      // A deleted file reads as empty: its declarations are all gone.
      const content = diff === null ? '' : ((await tools.readFile(path)) ?? '')
      touched.set(path, diff === null ? null : new Set(changedDeclarations(path, diff, content).map(decl => decl.name)))
    }
    return touched.get(path) ?? null
  }

  const kept: BlindSpot[] = []
  for (const spot of spots) {
    const names = await namesChangedIn(spot.changedFile)
    if (names === null) {
      kept.push(spot)
      continue
    }
    if (!names.has(spot.changedSymbol ?? spot.symbol)) continue
    const text = await tools.readFile(spot.path)
    if (text === null) continue
    const word = new RegExp(`(?<![\\w$])${escapeRegExp(spot.symbol)}(?![\\w$])`)
    const uses = text
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(use => word.test(use.text) && !COMMENT.test(use.text) && declarationIn(use.text)?.name !== spot.symbol && !isRead(spot.path, use.line))
      .map(use => ({ line: use.line, usage: clip(use.text.trim()) }))
    const best = uses.find(use => !IMPORT_LINE.test(use.usage)) ?? uses[0]
    if (best !== undefined) kept.push({ ...spot, ...best, lines: uses.map(use => use.line) })
  }
  return kept
}
