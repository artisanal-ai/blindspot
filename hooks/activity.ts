import type { Repo } from './repo'
import { normalize, resolve, toRepoPath } from './repo'

// What a tool call did to the repo's files: which Claude read (and which of
// their lines), edited, or only saw in a search. Bash counts too: plenty of
// agent work is `sed -i` and `cat`.

/** Lines of a file a read showed, 1-based and inclusive; negative counts back from the end (`tail`). */
export type Read = { path: string; from: number; to: number }
export type Effect = { read: Read[]; edited: string[]; seen: string[] }

/** The last line of any file. */
export const END = Number.MAX_SAFE_INTEGER
// The Read tool's page when it isn't given a limit.
const READ_PAGE = 2000

const NOTHING: Effect = { read: [], edited: [], seen: [] }
const EDITORS = /^(Edit|MultiEdit|Write|NotebookEdit)$/

/** Repo files named in a search's output (`path` or `path:line:text`), its paths relative to `dir`. */
export function pathsIn(output: string, repo: Repo, dir?: string | null): string[] {
  const paths = output.split('\n').map(line => toRepoPath(repo, line.trim().split(':')[0] ?? '', dir))
  return [...new Set(paths.filter(path => repo.known.has(path)))]
}

// `head -n 20`, `-n20`, `-20`, `--lines=20`, `tail -n +5`: the count as written.
function countOf(args: string[]): string | undefined {
  for (const [i, arg] of args.entries()) {
    if (arg === '-n' || arg === '--lines') return args[i + 1]
    const m = /^(?:-n|--lines=)(.+)$|^-(\d+)$/.exec(arg)
    if (m !== null) return m[1] ?? m[2]
  }
  return undefined
}

// The lines `sed` prints: all of them, unless `-n` and a script of `Np`,
// `N,Mp`, `N,$p` say which; null for a script that picks lines by pattern.
function sedLines(args: string[]): [number, number][] | null {
  if (!args.some(arg => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(arg) || arg === '--quiet' || arg === '--silent')) return [[1, END]]
  const given = args.filter((_, i) => /^-[a-zA-Z]*e$/.test(args[i - 1] ?? ''))
  const scripts = given.length > 0 ? given : args.filter(arg => !arg.startsWith('-')).slice(0, 1)
  const spans = scripts
    .flatMap(script => script.split(/[;\n]/))
    .filter(command => command.trim() !== '')
    .map(command => /^\s*(\d+|\$)\s*(?:,\s*(\d+|\$)\s*)?p\s*$/.exec(command))
  if (spans.length === 0 || spans.some(m => m === null)) return null
  const line = (n: string) => (n === '$' ? -1 : Number(n))
  return spans.map(m => {
    const [, from = '', to] = m as RegExpExecArray
    return [line(from), to === undefined ? line(from) : to === '$' ? END : Number(to)]
  })
}

// --- Bash ---

/** One command of a shell line, its words read against the repo. */
type Command = {
  /** Its arguments, past the name (and past git's subcommand). */
  args: string[]
  /** The arguments that aren't flags, as repo paths: '' at the root, null outside the repo. */
  places: (string | null)[]
  /** The arguments that are repo files. */
  known: string[]
  /** The arguments that aren't flags and are, or look like, files: an edit may make them. */
  named: string[]
  isFile: (path: string) => boolean
  /** The repo files its output names (a search's results). */
  listed: () => string[]
}

/** What a command does to the files it names, added to `effect`. */
type Handler = (command: Command, effect: Effect) => void

const whole = (paths: string[]): Read[] => paths.map(path => ({ path, from: 1, to: END }))
const isInPlace = (c: Command) => c.args.some(arg => /^-\w*i/.test(arg) || arg === '--in-place')

const edits: Handler = (c, effect) => void effect.edited.push(...c.named)
const reads: Handler = (c, effect) => void effect.read.push(...whole(c.known))
const searches: Handler = (c, effect) => void effect.seen.push(...c.known, ...c.listed())
// `diff` shows only the lines that differ.
const compares: Handler = (c, effect) => void effect.seen.push(...c.known)

// `cp a b`, `mv a b`, or into a folder (`cp a b dest/`), each keeping its name.
const moves =
  (isCopy: boolean): Handler =>
  (c, effect) => {
    const target = c.places.at(-1) ?? null
    const sources = c.places.slice(0, -1)
    const into = sources.length > 1 || (target !== null && !c.isFile(target))
    const targets = into ? sources.map(s => (target === null || s === null ? null : normalize(`${target}/${s.split('/').at(-1)}`))) : [target]
    const files = (list: (string | null)[]) => list.filter((p): p is string => p !== null && c.isFile(p))
    if (isCopy) effect.read.push(...whole(files(sources).filter(p => c.known.includes(p))))
    else effect.edited.push(...files(sources))
    effect.edited.push(...files(targets))
  }

const head: Handler = (c, effect) => {
  const count = Number(countOf(c.args) ?? 10)
  effect.read.push(...c.known.map(path => ({ path, from: 1, to: count > 0 ? count : END })))
}

// `tail -n 20` counts back from the end; `tail -n +5` counts from the start.
const tail: Handler = (c, effect) => {
  const count = countOf(c.args) ?? '10'
  const from = count.startsWith('+') ? Number(count) : -Math.abs(Number(count))
  effect.read.push(...c.known.map(path => ({ path, from: Number.isFinite(from) ? from : 1, to: from < 0 ? -1 : END })))
}

const sed: Handler = (c, effect) => {
  if (isInPlace(c)) return void effect.edited.push(...c.known)
  const lines = sedLines(c.args)
  if (lines === null) effect.seen.push(...c.known)
  else effect.read.push(...c.known.flatMap(path => lines.map(([from, to]) => ({ path, from, to }))))
}

const each = (names: string[], handler: Handler) => names.map(name => [name, handler] as const)

/** The commands blindspot understands, by name (`git mv` for git's). */
const COMMANDS = new Map<string, Handler>([
  ...each(['rm', 'touch', 'tee', 'truncate', 'git rm', 'git checkout', 'git restore'], edits),
  ...each(['cat', 'bat', 'less', 'more', 'nl', 'awk', 'git show', 'git blame'], reads),
  ...each(['grep', 'egrep', 'rg', 'ag', 'find', 'fd', 'ls', 'tree', 'git grep', 'git ls-files', 'git status'], searches),
  ...each(['diff', 'git diff'], compares),
  ['cp', moves(true)],
  ['mv', moves(false)],
  ['git mv', moves(false)],
  ['head', head],
  ['tail', tail],
  ['sed', sed],
  ['perl', (c, effect) => void (isInPlace(c) && effect.edited.push(...c.known))],
])

// One shell command line, read without running it. A word that is a known
// file is a file; anything else (a sed script, a grep pattern, a flag) is not.
// Redirects (`> f`), writers and `cp` may name new files: those count when
// they look like one (have an extension), so `rm -rf dist` names no file.
// `start` is the shell's folder; `cd` moves it, until a `( … )` subshell ends.
function shellEffect(repo: Repo, line: string, output: string, start: string | null): Effect {
  const effect: Effect = { read: [], edited: [], seen: [] }
  const isFile = (path: string) => repo.known.has(path) || /\.\w+$/.test(path)
  let dir = start
  const outer: (string | null)[] = [] // the folder to go back to when a subshell ends

  // Quoted text is set aside first, so a `|`, `;` or `>` inside quotes never splits or redirects.
  const quoted: string[] = []
  const masked = line
    .replace(/<<-?\s*['"]?(\w+)['"]?([^\n]*)\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g, '$2') // heredoc bodies are data
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, q => `\0${quoted.push(q.slice(1, -1)) - 1}\0`)
  const unmask = (word: string) => word.replace(/\0(\d+)\0/g, (_, i: string) => quoted[Number(i)] ?? '')
  // `for f in a.py b.py; do cat "$f"; done`: `$f` stands for the loop's words.
  const loops = new Map<string, string[]>()
  for (const [, variable = '', list = ''] of masked.matchAll(/\bfor\s+(\w+)\s+in\s+([^;\n]*)/g)) loops.set(variable, (list.match(/\S+/g) ?? []).map(unmask))
  const expand = (word: string) => loops.get(/^\$\{?(\w+)\}?$/.exec(word)?.[1] ?? '') ?? [word]

  for (const raw of masked.split(/&&|\|\||[;|\n]/)) {
    const opens = /^\s*\(*/.exec(raw)?.[0].trim().length ?? 0
    const closes = /\)*\s*$/.exec(raw)?.[0].trim().length ?? 0
    for (let i = 0; i < opens; i++) outer.push(dir)
    const segment = raw.replace(/^\s*\(+/, '').replace(/\)+\s*$/, '')
    const words = (segment.match(/\S+/g) ?? []).map(unmask).flatMap(expand)
    const [name = '', ...rest] = words.filter(word => !/^\w+=/.test(word) && word !== 'sudo').filter((word, i) => i > 0 || !/^(do|then|else)$/.test(word))
    const path = (word: string) => toRepoPath(repo, word, dir)
    const operands = rest.filter(word => !word.startsWith('-'))

    const redirected = [...segment.matchAll(/(?:^|[^\d&])>>?\s*([^\s;&|)]+)/g)].map(([, target = '']) => path(unmask(target)))
    effect.edited.push(...redirected.filter(isFile))
    if (name === 'cd' || name === 'pushd') dir = operands[0] === undefined ? null : resolve(repo, operands[0], dir)
    else if (name === 'popd') dir = null
    else {
      const sub = name === 'git' ? (rest[0] ?? '') : ''
      const args = sub === '' ? rest : rest.slice(1)
      const notFlags = args.filter(word => !word.startsWith('-'))
      const shellDir = dir
      COMMANDS.get(sub === '' ? name : `git ${sub}`)?.(
        {
          args,
          places: notFlags.map(word => resolve(repo, word, shellDir)),
          known: args.map(path).filter(p => repo.known.has(p)),
          named: notFlags.map(path).filter(isFile),
          isFile,
          listed: () => pathsIn(output, repo, shellDir),
        },
        effect,
      )
    }
    for (let i = 0; i < closes; i++) dir = outer.pop() ?? dir
  }
  const unique = (paths: string[]) => [...new Set(paths)]
  return {
    read: [...new Map(effect.read.map(r => [`${r.path}:${r.from}:${r.to}`, r])).values()],
    edited: unique(effect.edited),
    seen: unique(effect.seen),
  }
}

/**
 * What a tool call did: Read reads (a page of the file), the editors edit,
 * Grep and Glob see, Bash is read from its command line. `dir` is the shell's
 * folder in the repo before the call ran (null outside it).
 */
export function effectOf(repo: Repo, tool: string, input: Record<string, unknown>, output: string, dir: string | null = repo.prefix): Effect {
  const file = input.file_path ?? input.notebook_path
  const path = typeof file === 'string' ? toRepoPath(repo, file, dir) : ''
  const only = path === '' ? [] : [path]
  if (tool === 'Read') {
    const from = Math.max(1, Number(input.offset) || 1)
    return { ...NOTHING, read: only.map(p => ({ path: p, from, to: from + (Number(input.limit) || READ_PAGE) - 1 })) }
  }
  if (EDITORS.test(tool)) return { ...NOTHING, edited: only }
  if (tool === 'Grep' || tool === 'Glob') return { ...NOTHING, seen: pathsIn(output, repo, dir) }
  if (tool === 'Bash' && typeof input.command === 'string') return shellEffect(repo, input.command, output, dir)
  return NOTHING
}

/** Whether `spans` (from `Read`s, negatives resolved) show line `line`. */
export const covers = (spans: readonly (readonly [number, number])[], line: number) => spans.some(([from, to]) => from <= line && line <= to)

/** A read's lines with a negative end resolved against the file's length; [] when the length isn't known. */
export function spanOf(read: Read, length: number | null): [number, number][] {
  if (read.from > 0) return [[read.from, read.to]]
  if (length === null) return []
  const at = (n: number) => (n < 0 ? length + 1 + n : n)
  return [[Math.max(1, at(read.from)), at(read.to)]]
}
