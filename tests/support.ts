import { mock } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// The world beneath the plugin in hook-level tests: a fake repo answered
// through git, and the engine's own behaviour (tools, turns, prompts, the UI)
// reduced to what blindspot calls.

/** A fake repository: its files, and what git prints for the commands a test cares about. */
export type FakeRepo = {
  root: string
  files: readonly string[]
  /** git's output for `args` (joined by spaces, after `git`); null for "nothing" (exit 1). */
  git: (args: string) => string | null
  /** File contents by repo path, for reads. */
  contents?: Record<string, string>
  /** The LSP tool's answer for a position; leave out for a session with no language server. */
  lsp?: (path: string, line: number) => string
  /** The shell's folder, absolute, when a test has moved it (`cd`); the root otherwise. */
  shellCwd?: () => string
  /** Whether a tool call ends in an error (a Bash command exiting non-zero). */
  fails?: (input: Record<string, unknown>) => boolean
  /** The clock, in milliseconds; 0 throughout when left out. */
  now?: () => number
  /** A language server that never answers: the LSP tool call hangs, and every `$.clock.after` timer fires at once. */
  lspHangs?: boolean
  /** A terminal too narrow for a pane opened unasked: `ui.open` leaves it unplaced. */
  isNarrow?: boolean
}

/**
 * What a test watches: the prompts the plugin submitted, the status lines and
 * toasts it showed, how long it slept, the git it ran (argv after `git`), and
 * where it asked the language server (`path:line`).
 */
export type Recorder = { submitted: string[]; statuses: (string | undefined)[]; toasts: string[]; slept: number[]; git: string[]; lsp: string[] }

export function recorder(): Recorder {
  return { submitted: [], statuses: [], toasts: [], slept: [], git: [], lsp: [] }
}

const value = <T,>(v: T) => ({ value: v })
const ran = (stdout: string, exitCode = 0) => value({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

/** Answers everything blindspot asks of Claude Code, from `repo`, recording into `rec`. */
export function fakeEngine(on: On, repo: FakeRepo, rec: Recorder = recorder()) {
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => value(repo.shellCwd?.() ?? repo.root))
  on('session.root', () => value(repo.root))
  on('command.register', (_, e) => value({ command: e.name }))
  on('ui.status', (_, e) => {
    rec.statuses.push(e.text)
    return value(undefined)
  })
  on('ui.toast', (_, e) => {
    rec.toasts.push(e.text)
    return value(undefined)
  })
  on('ui.open', () => value(repo.isNarrow ? { isPlaced: false, reason: 'narrow' } : { isPlaced: true }) as never)
  // The engine's own band: nothing drawn.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  on('process.run', (_, e) => {
    // Past git's own `-c name=value` settings, to the command.
    const argv = e.argv.slice(1)
    rec.git.push(argv.join(' '))
    while (argv[0] === '-c') argv.splice(0, 2)
    const args = argv.join(' ')
    if (args.startsWith('rev-parse --show-toplevel')) return ran(`${repo.root}\n\n`)
    if (args.startsWith('ls-files')) return ran(`${repo.files.join('\n')}\n`)
    const stdout = repo.git(args)
    return stdout === null ? ran('', 1) : ran(stdout)
  })
  on('fs.read', (_, e) => {
    // The plugin's own manifest, wherever the test engine puts the plugin.
    if (String(e.path).endsWith('/.claude-plugin/plugin.json')) return value(JSON.stringify({ name: 'blindspot', version: '9.9.9' }))
    const path = String(e.path).slice(repo.root.length + 1)
    const text = repo.contents?.[path]
    return text === undefined ? ({ deny: `no such file: ${path}` } as never) : value(text)
  })
  on('clock.sleep', (_, e) => {
    rec.slept.push(e.ms)
    return value(undefined)
  })
  on('clock.now', () => value(repo.now?.() ?? 0))
  if (repo.lspHangs) on('clock.after', () => value(undefined))
  on('tool.call', (_, e) => {
    if (String(e.tool) !== 'LSP') return { result: {}, text: `ran ${String(e.tool)}`, ...(repo.fails?.(e as never) ? { isError: true } : {}) } as never
    const input = e as unknown as { filePath: string; line: number }
    const path = input.filePath.slice(repo.root.length + 1)
    rec.lsp.push(`${path}:${input.line}`)
    if (repo.lspHangs) return new Promise<never>(() => {})
    if (repo.lsp === undefined) throw new Error('no tool named "LSP" in this session')
    return { result: {}, text: repo.lsp(path, input.line) }
  })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_, e) => {
    rec.submitted.push(e.text)
    return { text: e.text }
  })
}

export async function startSession($: Engine, root: string, isInteractive = false) {
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive })
}

/** Ends the main loop's turn, or with `agentId` a subagent's. */
export async function endTurn($: Engine, agentId?: string) {
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...(agentId === undefined ? {} : { agentId }) })
}

export async function command($: Engine, args: string) {
  const presentation = { isFullscreen: false, columns: 100 } as never
  return $.command.run({ command: 'blindspot', args, origin: { kind: 'composer' } as never, presentation })
}

/** The band above the prompt, to mount. */
export const BAND = {
  plugin: 'blindspot',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 14, bodyColumns: 120, scroll: { offset: 0, bodyRows: 14 }, view: {} },
} as const
