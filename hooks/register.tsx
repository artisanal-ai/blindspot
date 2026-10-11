import { atom, read, update } from 'claude-code'
import type { EngineInterface, ElementTable, Register, ToolCallInput } from 'claude-code'

import type { BlindSpot, Touch } from '../types'
import type { Read } from './activity'
import { covers, effectOf, spanOf } from './activity'
import type { Tools } from './blindspots'
import { findBlindSpots } from './blindspots'
import { buildGrid, heatOf, LEVELS, levelOf, runsOf } from './heatmap'
import type { Git, Repo } from './repo'
import { readRepo, resolve } from './repo'
import { changedNames, checkPrompt, plural, statusLine, USAGE } from './text'

// The hooks module: the one file that talks to Claude Code (its `$` may not
// leave it). It keeps the session's state, gives the other modules git, file
// reads and the language server as plain functions, and draws the band and
// the map.

// Theme keys, not raw colors, so blindspot follows the person's theme.
const ALERT = 'error'
const PANE = { id: 'blindspot-map', title: 'blindspot' }
const MAX_BLIND_SPOTS = 10
const BAND_ROWS = 4 // blind spots listed in the band; the rest are counted
const PANE_CHROME_ROWS = 16 // the pane's rows that aren't the heatmap
const MAP_FILES = 20_000 // enough for any repo a person works in; past this the map would be noise
const GIT_TIMEOUT_MS = 15_000
const LSP_TIMEOUT_MS = 5_000

// Session state, held by Claude Code so it survives a reload.
const touches = atom({ plugin: 'blindspot', key: 'touches' } as const, {})
const readLines = atom({ plugin: 'blindspot', key: 'readLines' } as const, {})
const blindSpots = atom({ plugin: 'blindspot', key: 'blindSpots' } as const, [])
const pending = atom({ plugin: 'blindspot', key: 'pending' } as const, [])
const bases = atom({ plugin: 'blindspot', key: 'bases' } as const, { session: null, turn: null })
const isPaused = atom({ plugin: 'blindspot', key: 'isPaused' } as const, false)

let autoOpenPane = true
let repo: Promise<Repo | null> | null = null

// --- Git and the repo ---

function gitAt($: EngineInterface, defaultCwd: string): Git {
  return async (args, cwd = defaultCwd) => {
    try {
      // Paths as they are, not quoted and escaped (`"caf\303\251.ts"`).
      const ran = await $.process.run(['git', '-c', 'core.quotePath=false', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
      return ran.exitCode > 1 ? null : ran.stdout // 1 is git grep's "nothing found"
    } catch {
      return null
    }
  }
}

// What finding blind spots needs, built from Claude Code. `references` asks
// Claude Code's LSP tool, which exists only when a language server is
// installed; without one it answers null, and the name search takes over.
function toolsFor($: EngineInterface, r: Repo): Tools {
  // A language server that took too long once is not asked again this scan.
  let isSlow = false
  return {
    git: gitAt($, r.root),
    readFile: async path => {
      try {
        return String(await $.fs.read(`${r.root}/${path}`))
      } catch {
        return null
      }
    },
    references: async (path, line, character) => {
      if (isSlow) return null
      const asked = $.tool
        .call({ tool: 'LSP', operation: 'findReferences', filePath: `${r.root}/${path}`, line, character })
        .then(found => (found.deny === undefined && found.isError !== true ? (found.text ?? null) : null))
        .catch(() => null)
      // A timer, not a sleep: waiting on it doesn't spend the hook's budget.
      let timer: { cancel: () => void } | undefined
      const late = new Promise<'late'>(resolve => {
        timer = $.clock.after(LSP_TIMEOUT_MS, () => resolve('late'))
      })
      const answer = await Promise.race([asked, late])
      timer?.cancel()
      if (answer !== 'late') return answer
      isSlow = true
      return null
    },
    sleep: ms => $.clock.sleep(ms),
    now: () => $.clock.now(),
  }
}

// The repo the session's project sits in (where it started: a shell `cd` doesn't move it).
async function loadRepo($: EngineInterface): Promise<Repo | null> {
  try {
    const root = await $.session.root()
    return await readRepo(gitAt($, root), root)
  } catch {
    return null
  }
}

function repoOf($: EngineInterface): Promise<Repo | null> {
  repo ??= loadRepo($)
  return repo
}

// Lists the repo's files again, so files made since count; a listing that
// fails keeps the last one.
async function refreshRepo($: EngineInterface): Promise<Repo | null> {
  const old = await repoOf($)
  const fresh = await loadRepo($)
  if (fresh === null) return old
  repo = Promise.resolve(fresh)
  // The map draws the file list, which isn't state: a new list redraws it.
  if (old === null || old.known.size !== fresh.known.size || fresh.files.some(file => !old.known.has(file))) $.ui.invalidate('ui.render')
  return fresh
}

// The working tree as a commit, touching nothing: `git stash create`, or HEAD
// when nothing has changed; '' when the repo has no commit yet.
async function snapshot(git: Git): Promise<string> {
  const stash = (await git(['stash', 'create']))?.trim()
  if (stash) return stash
  return (await git(['rev-parse', '--verify', '-q', 'HEAD']))?.trim() ?? ''
}

// --- What happens around a tool call ---

async function refreshStatus($: EngineInterface) {
  $.ui.status((await read($, isPaused)) ? undefined : statusLine((await read($, blindSpots)).length))
}

// Adds one to each file's counter of `kind` (seen, read or edit).
function withTouches(all: Record<string, Touch>, paths: string[], kind: keyof Touch): Record<string, Touch> {
  const next = { ...all }
  for (const path of paths) {
    const touch = next[path] ?? { seen: 0, read: 0, edit: 0 }
    next[path] = { ...touch, [kind]: touch[kind] + 1 }
  }
  return next
}

// Adds lines read to each file's spans, merging those that touch.
function withSpans(all: Record<string, [number, number][]>, spans: (readonly [string, [number, number][]])[]): Record<string, [number, number][]> {
  const next = { ...all }
  for (const [path, list] of spans) {
    const sorted = [...(next[path] ?? []), ...list].sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = []
    for (const [from, to] of sorted) {
      const last = merged.at(-1)
      if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to)
      else merged.push([from, to])
    }
    next[path] = merged
  }
  return next
}

// Before a tool runs: the shell's folder in the repo (a `cd` moves it), and,
// before the first edit of the session and of the turn, the working tree as
// it was, to tell Claude's changes from what was there.
async function prepare($: EngineInterface, e: ToolCallInput): Promise<{ dir: string | null } | null> {
  const r = await repoOf($)
  if (r === null) return null
  const dir = resolve(r, await $.session.cwd())
  const { edited } = effectOf(r, String(e.tool), e as unknown as Record<string, unknown>, '', dir)
  const taken = await read($, bases)
  if (edited.length > 0 && (taken.session === null || taken.turn === null)) {
    const at = await snapshot(gitAt($, r.root))
    await update($, bases, b => ({ session: b.session ?? at, turn: b.turn ?? at }))
  }
  return { dir }
}

// After a tool ran: count what it touched on the map. A file Claude edited,
// or read every line of that uses a changed function, is no blind spot any
// more; an edited one waits for the turn's scan.
async function recordRun($: EngineInterface, e: ToolCallInput, output: string, dir: string | null) {
  const r = await repoOf($)
  if (r === null) return
  const { read: reads, edited, seen } = effectOf(r, String(e.tool), e as unknown as Record<string, unknown>, output, dir)
  if (reads.length + edited.length + seen.length === 0) return
  // A file the Write tool made is known from now on, not from the next listing.
  if (e.tool !== 'Bash') {
    for (const path of edited.filter(p => !r.known.has(p))) {
      r.known.add(path)
      r.files.push(path)
    }
  }

  // Lines counted back from the end (`tail`) need the file's length.
  const files = toolsFor($, r)
  const lengthOf = async (read: Read) => {
    if (read.from > 0) return null
    const text = await files.readFile(read.path)
    return text === null ? null : text.replace(/\n$/, '').split('\n').length
  }
  const spans = await Promise.all(reads.map(async read => [read.path, spanOf(read, await lengthOf(read))] as const))

  await update($, touches, all => withTouches(withTouches(withTouches(all, seen, 'seen'), [...new Set(reads.map(read => read.path))], 'read'), edited, 'edit'))
  const lines = await update($, readLines, all => withSpans(all, spans))
  const isLooked = (spot: BlindSpot) => edited.includes(spot.path) || (spot.lines ?? [spot.line]).every(line => covers(lines[spot.path] ?? [], line))
  await update($, blindSpots, list => list.filter(spot => !isLooked(spot)))
  if (edited.length > 0) await update($, pending, list => [...new Set([...list, ...edited])])
  await refreshStatus($)
}

// The blind spots of `changed` since `base`, added to the band. Returns how many are new.
async function scan($: EngineInterface, changed: string[], base: string | null): Promise<number> {
  const r = await repoOf($)
  if (r === null || changed.length === 0) return 0
  const all = await read($, touches)
  const lines = await read($, readLines)
  const isRead = (path: string, line: number) => (all[path]?.edit ?? 0) > 0 || covers(lines[path] ?? [], line)
  // '' is a repo with no commit yet: the change is diffed against the index.
  const found = await findBlindSpots(toolsFor($, r), r, changed, base || null, isRead, MAX_BLIND_SPOTS)
  let added = 0
  await update($, blindSpots, open => {
    const next = [...open, ...found.filter(spot => !open.some(o => o.path === spot.path))].slice(0, MAX_BLIND_SPOTS)
    added = Math.max(0, next.length - open.length)
    return next
  })
  await refreshStatus($)
  return added
}

// --- /blindspot ---

// The version in plugin.json: what `claude plugin list` shows.
async function versionOf($: EngineInterface): Promise<string> {
  try {
    const manifest = JSON.parse(String(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))) as { version?: string }
    return manifest.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

async function command($: EngineInterface, arg: string): Promise<string> {
  if (arg === 'off' || arg === 'on') {
    await update($, isPaused, () => arg === 'off')
    await refreshStatus($)
    return arg === 'off' ? 'blindspot paused: no blind-spot scans. /blindspot on to resume.' : 'blindspot on.'
  }
  if (arg === 'reset') {
    await update($, touches, () => ({}))
    await update($, readLines, () => ({}))
    await update($, blindSpots, () => [])
    await update($, pending, () => [])
    await update($, bases, () => ({ session: null, turn: null }))
    await refreshStatus($)
    return 'blindspot: map cleared.'
  }
  if (arg === 'scan') {
    await refreshRepo($)
    const all = await read($, touches)
    const added = await scan($, Object.keys(all).filter(path => (all[path]?.edit ?? 0) > 0), (await read($, bases)).session)
    return `blindspot: ${plural(added, 'new blind spot')}.`
  }
  if (arg === 'status') {
    const all = Object.values(await read($, touches))
    const r = await repoOf($)
    const n = (kind: keyof Touch) => all.filter(t => t[kind] > 0).length
    return (
      `blindspot ${(await read($, isPaused)) ? 'paused' : 'on'}. ${n('edit')} edited, ${n('read')} read, ${n('seen')} seen in searches` +
      `${r === null ? ' (not in a git repo)' : ` of ${plural(r.files.length, 'file')}`}. ${plural((await read($, blindSpots)).length, 'blind spot')}.`
    )
  }
  if (arg === 'version') return `blindspot ${await versionOf($)}`
  if (arg !== '' && arg !== 'map') return USAGE
  await $.ui.open(PANE)
  return 'blindspot map open.'
}

// --- Drawing ---

function Band(ui: ElementTable, spots: BlindSpot[], $: EngineInterface) {
  const { Box, Button, Text } = ui
  const names = changedNames(spots)
  const dismiss = async () => {
    await update($, blindSpots, () => [])
    await refreshStatus($)
  }
  const ask = async () => {
    const text = checkPrompt(await read($, blindSpots))
    await dismiss()
    await $.prompt.submit({ text })
  }
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color="inverseText" backgroundColor={ALERT}>{' BLIND SPOT '}</Text>
        <Text bold>{` ${plural(spots.length, 'file')} ${spots.length === 1 ? 'uses' : 'use'} ${names}, which Claude changed`}</Text>
        <Text dimColor>{`, but it never read ${spots.length === 1 ? 'it' : 'them'}`}</Text>
      </Text>
      {spots.slice(0, BAND_ROWS).map(spot => (
        <Text wrap="truncate-end">
          <Text color={ALERT}>{'  █ '}</Text>
          <Text>{`${spot.path}:${spot.line}`}</Text>
          <Text dimColor>{`  ${spot.usage}`}</Text>
        </Text>
      ))}
      {spots.length > BAND_ROWS && <Text dimColor>{`    +${spots.length - BAND_ROWS} more`}</Text>}
      <Box flexDirection="row">
        <Button key="ask" hotkey="1" plain label="Ask Claude to check them" onPress={ask} />
        <Text>   </Text>
        <Button key="dismiss" hotkey="2" plain label="Dismiss" onPress={dismiss} />
        <Text>   </Text>
        <Button key="map" hotkey="3" plain label="Map" onPress={() => void $.ui.open(PANE)} />
      </Box>
    </Box>
  )
}

function MapPane(ui: ElementTable<'terminal'>, files: string[], all: Record<string, Touch>, spots: BlindSpot[], columns: number, rows: number) {
  const { Box, Text } = ui
  const blind = new Set(spots.map(spot => spot.path))
  const grid = buildGrid([...new Set([...files.slice(0, MAP_FILES), ...Object.keys(all)])], all, blind, columns, Math.max(4, rows - PANE_CHROME_ROWS))
  const n = (kind: keyof Touch) => Object.values(all).filter(t => t[kind] > 0).length
  const hottest = Object.entries(all).sort(([, a], [, b]) => heatOf(b) - heatOf(a)).slice(0, 6)
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{plural(files.length, 'file')}</Text>
        <Text dimColor>{` · ${n('seen')} seen · ${n('read')} read · ${n('edit')} edited`}</Text>
        {spots.length > 0 && <Text color={ALERT}>{` · ${spots.length} blind`}</Text>}
      </Text>
      {grid.rows.map(row => (
        <Text wrap="truncate-end">
          <Text>{`${row.label} `}</Text>
          {runsOf(row.levels).map(run => (
            <Text color={LEVELS[run.level]?.color}>{(LEVELS[run.level]?.char ?? ' ').repeat(run.count)}</Text>
          ))}
        </Text>
      ))}
      {grid.hidden > 0 && <Text dimColor>{`+${grid.hidden} quieter folders`}</Text>}
      <Text>
        {LEVELS.map(level => (
          <Text color={level.color}>{`${level.char} ${level.name}  `}</Text>
        ))}
      </Text>
      <Text bold>{'\nHottest'}</Text>
      {hottest.length === 0 && <Text dimColor>Nothing touched yet.</Text>}
      {hottest.map(([path, t]) => {
        const level = LEVELS[levelOf(t, blind.has(path))]
        return (
          <Text wrap="truncate-start">
            <Text color={level?.color}>{'█ '}</Text>
            <Text>{path}</Text>
            <Text dimColor>{`  ${[t.edit && `edited ${t.edit}`, t.read && `read ${t.read}`, t.seen && `seen ${t.seen}`].filter(Boolean).join(' · ')}`}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

// --- Hooks ---

export const register: Register = (on, options) => {
  autoOpenPane = options.autoOpenPane !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'blindspot', description: 'Where Claude looked: /blindspot [map|scan|status|reset|off|on|version]' })
    await refreshStatus($)
    void repoOf($) // listed now, not on the first tool call
    // Unasked, Claude Code places the pane only in a wide terminal; it waits for one, so say so.
    if (autoOpenPane && e.isInteractive) {
      void $.ui
        .open(PANE)
        .then(opened => {
          if (!opened.isPlaced) $.ui.toast('blindspot: the map opens once the terminal is wider. /blindspot opens it now.')
        })
        .catch(() => {})
    }
    return next(e)
  })

  // blindspot must never break Claude's work: if recording fails, the tool's result goes back as it was.
  on('tool.call', async ($, e, next) => {
    const before = await prepare($, e).catch(() => null)
    const ran = await next(e)
    // A Bash command that failed may still have made its edits (`sed -i … && npm test`).
    const isAnswered = ran.deny === undefined && (ran.isError !== true || e.tool === 'Bash')
    if (before !== null && isAnswered) await recordRun($, e, ran.text ?? '', before.dir).catch(() => {})
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's turn ends inside the main one; its edits wait for that.
    if (e.agentId !== undefined) return result
    let changed: string[] = []
    let base: string | null = null
    // Emptied even while paused, so a resume starts clean.
    await update($, pending, list => {
      changed = list
      return []
    })
    await update($, bases, b => {
      base = b.turn
      return { ...b, turn: null }
    })
    await refreshRepo($)
    if (changed.length === 0 || (await read($, isPaused))) return result
    const added = await scan($, changed, base).catch(() => 0)
    if (added > 0) $.ui.toast(`${plural(added, 'file')} ${added === 1 ? 'uses' : 'use'} what Claude changed but never read`)
    return result
  })

  on('command.run', { command: 'blindspot' }, async ($, e) => ({ text: await command($, e.args.trim()) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const spots = await read($, blindSpots)
    if (spots.length === 0 || e.props.hasSurvey || (await read($, isPaused))) return next(e)
    return Band($.ui.resolve(e), spots, $)
  })

  on('ui.render', { component: 'Pane', requestId: PANE.id }, async ($, e) => {
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>The attention map draws in the terminal.</Text>
    }
    const r = await repoOf($)
    return MapPane($.ui.resolve(e), r?.files ?? [], await read($, touches), await read($, blindSpots), Math.max(20, e.props.bodyColumns), e.viewport?.rows ?? 30)
  })
}
