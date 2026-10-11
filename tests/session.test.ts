import { expect, test } from 'claude-code/testing'

import type { FakeRepo } from './support'
import { BAND, command, endTurn, fakeEngine, recorder, startSession } from './support'

// A small repo with no language server: token.ts's `sign` is used by
// session.ts and Login.tsx, so blindspot finds them by searching for the name.
const ROOT = '/repo'
const DIFF = '@@ -1 +1 @@\n-export function sign(userId, ttlSeconds = 3600) {\n+export function sign(userId, ttlSeconds = 900) {'
const CONTENTS: Record<string, string> = {
  'src/auth/token.ts': 'export function sign(userId, ttlSeconds = 900) {\n  return { userId, ttlSeconds }\n}\n',
  'src/api/session.ts': "import { sign } from '../auth/token'\n\nexport const login = (id) => sign(id)\n",
  'src/ui/Login.tsx': "import { sign } from '../auth/token'\nexport const Login = () => <b>{sign('me').userId}</b>\n",
}
// `git grep` for the name its arguments end with: every line of `contents` that names it.
const grep = (contents: Record<string, string>, args: string) => {
  const name = args.split(' ').at(-1) ?? ''
  return Object.entries(contents)
    .flatMap(([path, text]) => text.split('\n').map((line, i) => ({ path, n: i + 1, line })))
    .filter(({ line }) => new RegExp(`\\b${name}\\b`).test(line))
    .map(({ path, n, line }) => `${path}:${n}:${line}`)
    .join('\n')
}
const REPO: FakeRepo = {
  root: ROOT,
  files: ['src/auth/token.ts', 'src/api/session.ts', 'src/ui/Login.tsx', 'src/billing/invoice.ts'],
  contents: CONTENTS,
  git: args => (args.startsWith('diff') ? DIFF : args.startsWith('grep') ? grep(CONTENTS, args) : null),
}
const EDIT = { tool: 'Edit', file_path: `${ROOT}/src/auth/token.ts`, old_string: 'a', new_string: 'b' } as const

test('an edit turns unread importers into blind spots, and the band asks Claude to check them', async ($, on) => {
  const rec = recorder()
  fakeEngine(on, REPO, rec)
  await startSession($, ROOT)
  await $.tool.call(EDIT)
  await endTurn($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /BLIND SPOT/ })).toBeDefined()
    expect(await ui.find({ text: /src\/api\/session\.ts/ })).toBeDefined()
    expect(await ui.find({ text: /src\/ui\/Login\.tsx/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'ask' })
  expect(rec.submitted[0]).toContain('You changed sign')
  expect(rec.submitted[0]).toContain('src/api/session.ts:3 uses sign: `export const login = (id) => sign(id)`')
  expect(await ui.find({ text: /BLIND SPOT/ })).toBeUndefined()
  // Paths come back from git as they are, not quoted and escaped.
  expect(rec.git.every(args => args.startsWith('-c core.quotePath=false '))).toBe(true)
})

test('reading an importer clears its blind spot', async ($, on) => {
  fakeEngine(on, REPO)
  await startSession($, ROOT)
  await $.tool.call(EDIT)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/api/session.ts` })
  await endTurn($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /src\/api\/session\.ts/ })).toBeUndefined()
  expect(await ui.find({ text: /src\/ui\/Login\.tsx/ })).toBeDefined()
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ text: /BLIND SPOT/ })).toBeUndefined()
})

test('a read of some lines leaves a blind spot until the lines that use the function are read', async ($, on) => {
  fakeEngine(on, REPO)
  await startSession($, ROOT)
  // Line 1 is the import; the call is on line 3.
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/api/session.ts`, limit: 1 })
  await $.tool.call(EDIT)
  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /src\/api\/session\.ts:3/ })).toBeDefined()

  // `tail -n 1` of a three-line file is line 3.
  await $.tool.call({ tool: 'Bash', command: 'tail -n 1 src/api/session.ts' })
  expect(await ui.find({ text: /src\/api\/session\.ts/ })).toBeUndefined()
  expect(await ui.find({ text: /src\/ui\/Login\.tsx/ })).toBeDefined()
})

test('a change staged or committed by the end of the turn is diffed against the tree from before its first edit', async ($, on) => {
  const rec = recorder()
  fakeEngine(
    on,
    {
      ...REPO,
      // The edit was committed: only a diff against the snapshot shows it.
      git: args => (args === 'stash create' ? 'snap1\n' : args.startsWith('diff') ? (args.includes(' snap1 ') ? DIFF : '') : REPO.git(args)),
      fails: () => {
        rec.git.push('(the tool ran)')
        return false
      },
    },
    rec,
  )
  await startSession($, ROOT)
  await $.tool.call(EDIT)
  await $.tool.call(EDIT)
  await endTurn($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /src\/api\/session\.ts/ })).toBeDefined()
  // Once a turn, before the edit ran.
  const snapshots = rec.git.filter(args => args.endsWith('stash create'))
  expect(snapshots).toHaveLength(1)
  expect(rec.git.findIndex(args => args.endsWith('stash create'))).toBeLessThan(rec.git.indexOf('(the tool ran)'))
})

test('edits made while paused are not scanned after resuming', async ($, on) => {
  fakeEngine(on, REPO)
  await startSession($, ROOT)
  await command($, 'off')
  await $.tool.call(EDIT)
  await endTurn($)
  await command($, 'on')
  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /BLIND SPOT/ })).toBeUndefined()
})

test("a subagent's turn ending leaves the scan to the main turn", async ($, on) => {
  fakeEngine(on, REPO)
  await startSession($, ROOT)
  await $.tool.call(EDIT)
  await endTurn($, 'agent-1')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /BLIND SPOT/ })).toBeUndefined()
  await endTurn($)
  expect(await ui.find({ text: /BLIND SPOT/ })).toBeDefined()
})

test('edits made through Bash count: grep then sed -i, as a bash-first session works', async ($, on) => {
  fakeEngine(on, REPO)
  await startSession($, ROOT)
  await $.tool.call({ tool: 'Bash', command: 'grep -n -i "ttl\\|expir" src/auth/token.ts' })
  await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/ttlSeconds = 3600)/ttlSeconds = 900)/' src/auth/token.ts && sed -n 3p src/auth/token.ts" })
  await endTurn($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /src\/api\/session\.ts/ })).toBeDefined()
  expect(await ui.find({ text: /src\/ui\/Login\.tsx/ })).toBeDefined()

  const status = await command($, 'status')
  expect(status.text).toContain('1 edited')
})

test('a Bash command that fails still made its edits', async ($, on) => {
  fakeEngine(on, { ...REPO, fails: input => String(input.command).includes('npm test') })
  await startSession($, ROOT)
  await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/3600/900/' src/auth/token.ts && npm test" })
  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /src\/api\/session\.ts/ })).toBeDefined()
})

test("Bash paths are the shell's, after a cd", async ($, on) => {
  fakeEngine(on, { ...REPO, shellCwd: () => `${ROOT}/src/auth` })
  await startSession($, ROOT)
  await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/3600/900/' token.ts" })
  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /src\/api\/session\.ts/ })).toBeDefined()
})

test('a file made after the session started can be a blind spot', async ($, on) => {
  const files = [...REPO.files]
  const contents = { ...CONTENTS }
  fakeEngine(on, { ...REPO, files, contents, git: args => (args.startsWith('diff') ? DIFF : args.startsWith('grep') ? grep(contents, args) : null) })
  await startSession($, ROOT)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/auth/token.ts` })
  // Someone else adds a file that uses sign.
  files.push('src/ui/Banner.tsx')
  contents['src/ui/Banner.tsx'] = "import { sign } from '../auth/token'\nexport const Banner = () => sign('banner')\n"
  await $.tool.call(EDIT)
  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /src\/ui\/Banner\.tsx:2/ })).toBeDefined()
})

test('the toast counts the blind spots the band kept; a long line is clipped', async ($, on) => {
  const rec = recorder()
  // pool.ts's connect has twelve users, each on a long line.
  const users = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/u/U${i}.ts`, `export const u${i} = ${'1 + '.repeat(100)}connect(${i})\n`]))
  const contents = { ...CONTENTS, 'src/db/pool.ts': 'export function connect(url) {\n  return url\n}\n', ...users }
  const connectDiff = '@@ -2 +2 @@\n-  return null\n+  return url'
  fakeEngine(
    on,
    { ...REPO, files: Object.keys(contents), contents, git: args => (args.startsWith('diff') ? (args.endsWith('pool.ts') ? connectDiff : DIFF) : args.startsWith('grep') ? grep(contents, args) : null) },
    rec,
  )
  await startSession($, ROOT)
  await $.tool.call(EDIT)
  await endTurn($)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/db/pool.ts`, old_string: 'null', new_string: 'url' })
  await endTurn($)
  // Two open, then room for eight of connect's ten.
  expect(rec.toasts).toEqual(['2 files use what Claude changed but never read', '8 files use what Claude changed but never read'])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'ask' })
  const lines = (rec.submitted[0] ?? '').split('\n').filter(line => line.startsWith('- src/u/'))
  expect(lines).toHaveLength(8)
  expect(lines.every(line => line.length < 220 && line.includes('…'))).toBe(true)
})

test('the map pane draws the heatmap in the terminal, and says so elsewhere', async ($, on) => {
  fakeEngine(on, REPO)
  await startSession($, ROOT)
  await $.tool.call(EDIT)
  const pane = { plugin: 'blindspot', component: 'Pane', requestId: 'blindspot-map', props: { bodyColumns: 60 } as never } as const
  const terminal = await $.ui.mount({ ...pane, surface: 'terminal' })
  expect(await terminal.find({ text: /4 files/ })).toBeDefined()
  expect(await terminal.find({ text: /src\/auth\/token\.ts/ })).toBeDefined()
  const desktop = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(await desktop.find({ text: /draws in the terminal/ })).toBeDefined()
})

test('/blindspot version says the version plugin.json gives', async ($, on) => {
  fakeEngine(on, REPO)
  await startSession($, ROOT)
  expect((await command($, 'version')).text).toBe('blindspot 9.9.9')
})

test('a mention in a README or a log is no use', async ($, on) => {
  const contents = { ...CONTENTS, 'docs/log.md': '- Tests: 178 passed; sign now takes a ttl\n' }
  fakeEngine(on, { ...REPO, files: Object.keys(contents), contents, git: args => (args.startsWith('diff') ? DIFF : args.startsWith('grep') ? grep(contents, args) : null) })
  await startSession($, ROOT)
  await $.tool.call(EDIT)
  await endTurn($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ text: /src\/api\/session\.ts/ })).toBeDefined()
  expect(await ui.find({ text: /log\.md/ })).toBeUndefined()
})

test('/blindspot status, off and on; a word it doesn\'t know gets the usage', async ($, on) => {
  const rec = recorder()
  fakeEngine(on, REPO, rec)
  await startSession($, ROOT)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/auth/token.ts` })
  const status = await command($, 'status')
  expect(status.text).toContain('1 read')
  expect(status.text).toContain('of 4 files')

  await $.tool.call(EDIT)
  await endTurn($)
  expect(rec.statuses.at(-1)).toBe('2 blind spots')
  await command($, 'off')
  expect((await command($, 'status')).text).toContain('blindspot paused')
  // Paused, the status line goes with the band.
  expect(rec.statuses.at(-1)).toBeUndefined()
  await command($, 'on')
  expect(rec.statuses.at(-1)).toBe('2 blind spots')

  expect((await command($, 'stauts')).text).toContain('Usage: /blindspot')
})

test("the band and the map paint in theme keys, so they follow the person's theme", async ($, on) => {
  fakeEngine(on, REPO)
  await startSession($, ROOT)
  await $.tool.call(EDIT)
  await endTurn($)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pane = await $.ui.mount({ plugin: 'blindspot', component: 'Pane', requestId: 'blindspot-map', props: { bodyColumns: 60 } as never, surface: 'terminal' })
  const texts = [...(await band.findAll({ type: 'Text' })), ...(await pane.findAll({ type: 'Text' }))]
  const colors = new Set(texts.flatMap(t => [t.props.color, t.props.backgroundColor]).filter(c => c !== undefined))
  expect([...colors].sort()).toEqual(['claude', 'error', 'inactive', 'inverseText', 'subtle', 'suggestion'])
})

test('a file listed after the session started shows on the open map, without a resize', async ($, on) => {
  const files = [...REPO.files]
  fakeEngine(on, { ...REPO, files })
  await startSession($, ROOT)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/auth/token.ts` })
  const pane = await $.ui.mount({ plugin: 'blindspot', component: 'Pane', requestId: 'blindspot-map', props: { bodyColumns: 60 } as never, surface: 'terminal' })
  expect(await pane.find({ text: /src\/jobs/ })).toBeUndefined()
  files.push('src/jobs/cleanup.ts')
  await endTurn($)
  expect(await pane.find({ text: /src\/jobs/ })).toBeDefined()
})

test('a map that waits for a wider terminal says how to open it now', async ($, on) => {
  const rec = recorder()
  fakeEngine(on, { ...REPO, isNarrow: true }, rec)
  await startSession($, ROOT, true)
  await endTurn($)
  expect(rec.toasts).toEqual(['blindspot: the map opens once the terminal is wider. /blindspot opens it now.'])
})
