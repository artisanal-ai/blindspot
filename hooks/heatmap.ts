import type { Touch } from '../types'

// The attention map: every file of the repo as one cell, a row per folder,
// colored by the most Claude did with it. Colors are theme keys, so the map
// follows the person's theme, light or dark.

export const LEVELS = [
  { char: '░', color: 'subtle', name: 'unseen' },
  { char: '▒', color: 'inactive', name: 'in a search' },
  { char: '▓', color: 'suggestion', name: 'read' },
  { char: '█', color: 'claude', name: 'edited' },
  { char: '█', color: 'error', name: 'blind spot' },
] as const

/** 0 unseen, 1 seen, 2 read, 3 edited, 4 blind spot. */
export function levelOf(touch: Touch | undefined, isBlind: boolean): number {
  if (isBlind) return 4
  if (touch === undefined) return 0
  return touch.edit > 0 ? 3 : touch.read > 0 ? 2 : touch.seen > 0 ? 1 : 0
}

/** How busy a file is: an edit outweighs a read, a read a search. */
export const heatOf = (t: Touch) => t.edit * 4 + t.read * 2 + t.seen

/** The map: a row per folder, a level per cell, and how many quieter folders didn't fit. */
export type Grid = { rows: { label: string; levels: number[] }[]; labelWidth: number; hidden: number }

/**
 * One row per folder (two levels deep), busiest first. A folder with more
 * files than the row has cells shares each cell among several and shows the
 * most any of them reached.
 */
export function buildGrid(files: string[], touches: Record<string, Touch>, blind: Set<string>, columns: number, maxRows: number): Grid {
  const labelWidth = Math.max(4, Math.min(18, Math.floor(columns / 3)))
  const width = Math.max(1, columns - labelWidth - 1)
  const levelOfFile = (file: string) => levelOf(touches[file], blind.has(file))

  const folders = new Map<string, string[]>()
  for (const file of files) {
    const folder = file.includes('/') ? file.split('/').slice(0, -1).slice(0, 2).join('/') : '.'
    const list = folders.get(folder)
    if (list === undefined) folders.set(folder, [file])
    else list.push(file)
  }
  const fileHeat = (file: string) => (touches[file] ? heatOf(touches[file]) : 0) + (blind.has(file) ? 8 : 0)
  const heat = new Map([...folders].map(([folder, list]) => [folder, list.reduce((sum, file) => sum + fileHeat(file), 0)]))
  const ordered = [...folders].sort(([a], [b]) => (heat.get(b) ?? 0) - (heat.get(a) ?? 0) || a.localeCompare(b))

  const rows = ordered.slice(0, Math.max(1, maxRows)).map(([folder, list]) => {
    const sorted = list.toSorted()
    const cells = Math.min(width, sorted.length)
    // Cell i stands for its share of the folder's files, and shows the strongest of them.
    const share = (i: number) => sorted.slice(Math.floor((i * sorted.length) / cells), Math.floor(((i + 1) * sorted.length) / cells))
    const levels = Array.from({ length: cells }, (_, i) => Math.max(...share(i).map(levelOfFile)))
    const label = folder.length <= labelWidth ? folder.padEnd(labelWidth) : `…${folder.slice(folder.length - labelWidth + 1)}`
    return { label: label.replace(/[^\x20-\x7e…]/g, '?'), levels }
  })
  return { rows, labelWidth, hidden: ordered.length - rows.length }
}

/** A row's cells as runs of one level: a Text each, not one per cell. */
export function runsOf(levels: number[]): { level: number; count: number }[] {
  const runs: { level: number; count: number }[] = []
  for (const level of levels) {
    const last = runs.at(-1)
    if (last?.level === level) last.count++
    else runs.push({ level, count: 1 })
  }
  return runs
}
