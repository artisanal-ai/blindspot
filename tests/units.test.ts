import { describe, expect, test } from 'claude-code/testing'

import { covers, effectOf, END, spanOf } from '../hooks/activity'
import { changedDeclarations, declarationIn, moduleNames, parseReferences } from '../hooks/blindspots'
import { buildGrid, LEVELS, runsOf } from '../hooks/heatmap'
import type { Repo } from '../hooks/repo'
import { normalize, resolve, toRepoPath } from '../hooks/repo'
import { checkPrompt, codeSpan, statusLine } from '../hooks/text'

const FILES = ['src/auth/token.ts', 'src/api/session.ts', 'src/db/pool.ts', 'pkg/api/src/b.ts']
const REPO: Repo = { root: '/repo', cwd: '/repo', prefix: '', files: FILES, known: new Set(FILES) }

describe('repo and blind spots', () => {
  test('paths', () => {
    expect(normalize('src/a/../b/./c.ts')).toBe('src/b/c.ts')
    expect(normalize('../x')).toBeNull()
    expect(toRepoPath(REPO, '/repo/src/db/pool.ts')).toBe('src/db/pool.ts')
    expect(toRepoPath(REPO, '/etc/hosts')).toBe('')
    expect(toRepoPath(REPO, 'src/b.ts', 'pkg/api')).toBe('pkg/api/src/b.ts')
    expect(resolve(REPO, '/repo')).toBe('')
    expect(resolve(REPO, '~/notes.md')).toBeNull()
  })

  test('declarations in many languages; statements are not declarations', () => {
    const name = (line: string) => declarationIn(line)?.name ?? null
    expect(name('def format_money(cents: int) -> str:')).toBe('format_money')
    expect(name('    async def fetch(self, id):')).toBe('fetch')
    expect(name('    public static String formatMoney(long cents) {')).toBe('formatMoney')
    expect(name('  private async Task<Invoice> LoadInvoice(Guid id)')).toBe('LoadInvoice')
    expect(name('func (s *Server) HandleRefund(w http.ResponseWriter) {')).toBe('HandleRefund')
    expect(name('pub fn parse_amount(input: &str) -> u64 {')).toBe('parse_amount')
    expect(name('fun formatMoney(cents: Long): String {')).toBe('formatMoney')
    expect(name('export const formatMoney = (cents: number) =>')).toBe('formatMoney')
    expect(name('  async load(id) {')).toBe('load')
    expect(name('    return format_money(x)')).toBeNull()
    expect(name('    raise ValueError(msg)')).toBeNull()
    expect(name('  } else if (ready) {')).toBeNull()
    expect(name('    label = format_money(cents)')).toBeNull()
    expect(declarationIn('def format_money(cents):')?.column).toBe(5)
  })

  test("a function's locals are not declarations; top-level and exported variables are", () => {
    const name = (line: string) => declarationIn(line)?.name ?? null
    expect(name('  const rate = 0.2')).toBeNull()
    expect(name('    let total = 0')).toBeNull()
    expect(name('const RATE = 0.2')).toBe('RATE')
    expect(name('  export const rate = 0.2')).toBe('rate')
  })

  test('the column is where the name is, even when a keyword before it spells it', () => {
    expect(declarationIn('export async function sync() {')?.column).toBe(23)
    expect(declarationIn('export function port(n) {')?.column).toBe(17)
  })

  test('changed declarations: the one each changed line sits in', () => {
    const file = 'class Money:\n    def format(self, c):\n        return str(c)\n\n    def parse(self, s):\n        return int(s)\n'
    expect(changedDeclarations('m.py', '@@ -3 +3 @@\n-x\n+y', file).map(d => d.name)).toEqual(['format'])
    expect(changedDeclarations('m.py', '@@ -3 +3 @@\n-x\n+y\n@@ -6 +6 @@\n-a\n+b', file).map(d => [d.name, d.line, d.column])).toEqual([
      ['format', 2, 9],
      ['parse', 5, 9],
    ])
  })

  test('a changed local, or a line under one, belongs to its function', () => {
    const file = 'export function computeTax(x) {\n  const rate = 0.2\n  if (x) {\n    return x * rate\n  }\n}\n'
    expect(changedDeclarations('t.ts', '@@ -2 +2 @@\n-a\n+b', file).map(d => d.name)).toEqual(['computeTax'])
    expect(changedDeclarations('t.ts', '@@ -4 +4 @@\n-a\n+b', file).map(d => d.name)).toEqual(['computeTax'])
  })

  test('a renamed or deleted function is looked for by its old name; a changed signature is not', () => {
    const renamed = 'export function formatAmount(c) {\n  return c\n}\n'
    const rename = '@@ -1 +1 @@\n-export function formatMoney(c) {\n+export function formatAmount(c) {'
    expect(changedDeclarations('m.ts', rename, renamed).map(d => [d.name, d.line])).toEqual([
      ['formatMoney', 0],
      ['formatAmount', 1],
    ])
    // The function before a deleted one didn't change.
    const kept = 'def keep():\n    return 1\n'
    const deletion = '@@ -4,2 +2,0 @@\n-def format_money(c):\n-    return c'
    expect(changedDeclarations('m.py', deletion, kept).map(d => d.name)).toEqual(['format_money'])
    const signature = '@@ -1 +1 @@\n-export function formatMoney(c) {\n+export function formatMoney(c, currency) {'
    expect(changedDeclarations('m.ts', signature, 'export function formatMoney(c, currency) {\n}\n').map(d => [d.name, d.line])).toEqual([['formatMoney', 1]])
  })

  test("a module goes by its own name and its folder's; an index file by its folder's alone", () => {
    expect(moduleNames('billing/money.py')).toEqual(['money', 'billing'])
    expect(moduleNames('src/money/index.ts')).toEqual(['money'])
    expect(moduleNames('money.go')).toEqual(['money'])
  })

  test("the LSP tool's answer, in both of its shapes", () => {
    expect(parseReferences('Found 1 reference:\n  billing/money.py:1:5')).toEqual([{ path: 'billing/money.py', line: 1 }])
    expect(parseReferences('Found 2 references across 2 files:\n\na.py:\n  Line 1:5\n\nb.py:\n  Line 7:2')).toEqual([
      { path: 'a.py', line: 1 },
      { path: 'b.py', line: 7 },
    ])
  })
})

describe('activity', () => {
  const bash = (command: string, output = '', dir?: string | null) => effectOf(REPO, 'Bash', { command }, output, dir)
  const paths = (command: string) => bash(command).read.map(read => read.path)
  const whole = (path: string) => ({ path, from: 1, to: END })

  test('tools', () => {
    expect(effectOf(REPO, 'Read', { file_path: '/repo/src/db/pool.ts' }, '').read).toEqual([{ path: 'src/db/pool.ts', from: 1, to: 2000 }])
    expect(effectOf(REPO, 'Write', { file_path: '/repo/src/new.ts' }, '').edited).toEqual(['src/new.ts'])
    expect(effectOf(REPO, 'Grep', {}, 'src/auth/token.ts:1:x\n/elsewhere/y.ts').seen).toEqual(['src/auth/token.ts'])
    expect(effectOf(REPO, 'NotebookEdit', { notebook_path: '/repo/notes/a.ipynb' }, '').edited).toEqual(['notes/a.ipynb'])
  })

  test('a read shows the lines it asked for', () => {
    expect(effectOf(REPO, 'Read', { file_path: '/repo/src/db/pool.ts', offset: 40, limit: 10 }, '').read).toEqual([{ path: 'src/db/pool.ts', from: 40, to: 49 }])
    expect(bash('head -n 5 src/db/pool.ts').read).toEqual([{ path: 'src/db/pool.ts', from: 1, to: 5 }])
    expect(bash('head src/db/pool.ts').read).toEqual([{ path: 'src/db/pool.ts', from: 1, to: 10 }])
    expect(bash('tail -20 src/db/pool.ts').read).toEqual([{ path: 'src/db/pool.ts', from: -20, to: -1 }])
    expect(bash('tail -n +5 src/db/pool.ts').read).toEqual([{ path: 'src/db/pool.ts', from: 5, to: END }])
    expect(bash("sed -n '10,20p;30p' src/db/pool.ts").read).toEqual([
      { path: 'src/db/pool.ts', from: 10, to: 20 },
      { path: 'src/db/pool.ts', from: 30, to: 30 },
    ])
    expect(bash("sed 's/a/b/' src/db/pool.ts").read).toEqual([whole('src/db/pool.ts')])
    // Lines picked by a pattern: seen, not read.
    expect(bash("sed -n '/pool/p' src/db/pool.ts")).toMatchObject({ read: [], seen: ['src/db/pool.ts'] })
    expect(bash('git diff src/db/pool.ts')).toMatchObject({ read: [], seen: ['src/db/pool.ts'] })
  })

  test("a tail's lines resolve against the file's length; spans cover lines", () => {
    expect(spanOf({ path: 'a', from: -20, to: -1 }, 100)).toEqual([[81, 100]])
    expect(spanOf({ path: 'a', from: -20, to: -1 }, null)).toEqual([])
    expect(covers([[1, 10], [20, 30]], 25)).toBe(true)
    expect(covers([[1, 10]], 11)).toBe(false)
  })

  test('shell: sed -i edits, sed -n and cat read, grep sees; scripts and patterns are not files', () => {
    expect(bash("sed -i '' 's/ttlSeconds = 3600)/ttlSeconds = 900)/' src/auth/token.ts && sed -n 3p src/auth/token.ts")).toEqual({
      read: [{ path: 'src/auth/token.ts', from: 3, to: 3 }],
      edited: ['src/auth/token.ts'],
      seen: [],
    })
    expect(bash('grep -n "ttl\\|expir" src/auth/token.ts', '3:export function sign').seen).toEqual(['src/auth/token.ts'])
    expect(paths('cat src/db/pool.ts missing.ts')).toEqual(['src/db/pool.ts'])
    expect(paths('for f in src/db/pool.ts src/api/session.ts; do echo "== $f"; cat "$f"; done')).toEqual(['src/db/pool.ts', 'src/api/session.ts'])
  })

  test('shell: cd moves where relative paths point, until a subshell ends', () => {
    expect(bash("cd pkg/api && sed -i 's/a/b/' src/b.ts").edited).toEqual(['pkg/api/src/b.ts'])
    expect(bash('cat src/b.ts', '', 'pkg/api').read).toEqual([whole('pkg/api/src/b.ts')])
    expect(paths('(cd pkg/api && cat src/b.ts) && cat src/db/pool.ts')).toEqual(['pkg/api/src/b.ts', 'src/db/pool.ts'])
    // Outside the repo, relative paths name nothing; absolute ones still do.
    expect(paths('cd /tmp && cat src/db/pool.ts /repo/src/api/session.ts')).toEqual(['src/api/session.ts'])
  })

  test('shell: redirects, heredocs, movers; stderr is no file', () => {
    expect(bash("cat > src/new.ts <<'EOF'\nimport x from 'src/db/pool.ts'\nEOF").edited).toEqual(['src/new.ts'])
    expect(bash('npm test 2>&1 | tail -20').edited).toEqual([])
    expect(bash('mv src/db/pool.ts src/db/pg.ts').edited).toEqual(['src/db/pool.ts', 'src/db/pg.ts'])
    expect(bash('cp src/db/pool.ts src/db/copy.ts')).toMatchObject({ read: [whole('src/db/pool.ts')], edited: ['src/db/copy.ts'] })
    // Into a folder, each file keeps its name, and every source is a source.
    expect(bash('cp src/db/pool.ts src/api/session.ts backup/')).toMatchObject({
      read: [whole('src/db/pool.ts'), whole('src/api/session.ts')],
      edited: ['backup/pool.ts', 'backup/session.ts'],
    })
    expect(bash('git mv src/db/pool.ts src/api').edited).toEqual(['src/db/pool.ts', 'src/api/pool.ts'])
    // Folders aren't files: no phantom cells on the map.
    expect(bash('rm -rf dist && mv build out').edited).toEqual([])
    expect(bash('echo done > /dev/null').edited).toEqual([])
  })
})

describe('text and map', () => {
  const spot = { path: 'src/a.ts', changedFile: 'src/m.ts', symbol: 'f', line: 4, usage: 'f(1)', lines: [4] }

  test('the check prompt names each use; the status line counts blind spots', () => {
    const prompt = checkPrompt([spot])
    expect(prompt).toContain('You changed f, but never read these files that use it')
    expect(prompt).toContain('- src/a.ts:4 uses f: `f(1)`')
    expect(checkPrompt([spot, { ...spot, path: 'src/b.ts', symbol: 'g' }])).toContain('You changed f, g, but never read these files that use them')
    expect(statusLine(0)).toBeUndefined()
    expect(statusLine(2)).toBe('2 blind spots')
  })

  test('a line with backticks stays one code span', () => {
    expect(codeSpan('f(1)')).toBe('`f(1)`')
    expect(codeSpan('return `$${f(x)}`')).toBe('`` return `$${f(x)}` ``')
    expect(checkPrompt([{ ...spot, usage: 'return `${f(1)}`' }])).toContain('uses f: `` return `${f(1)}` ``')
  })

  test('busy folders first; a row draws as runs of one level', () => {
    const grid = buildGrid(['README.md', 'src/a/x.ts', 'src/a/y.ts', 'src/b/z.ts'], { 'src/b/z.ts': { seen: 0, read: 1, edit: 0 } }, new Set(), 30, 10)
    expect(grid.rows.map(r => r.label.trim())).toEqual(['src/b', '.', 'src/a'])
    expect(runsOf([0, 0, 2, 2, 2, 4, 0])).toEqual([
      { level: 0, count: 2 },
      { level: 2, count: 3 },
      { level: 4, count: 1 },
      { level: 0, count: 1 },
    ])
  })

  test("the map's colors are theme keys, so they follow the person's theme", () => {
    expect(LEVELS.map(level => level.color)).toEqual(['subtle', 'inactive', 'suggestion', 'claude', 'error'])
  })

  test('a folder of 20,000 files draws in well under a render', () => {
    const files = Array.from({ length: 20_000 }, (_, i) => `src/f${i}.ts`)
    const started = performance.now()
    buildGrid(files, { 'src/f7.ts': { seen: 1, read: 0, edit: 0 } }, new Set(), 120, 40)
    expect(performance.now() - started).toBeLessThan(250)
  })
})
