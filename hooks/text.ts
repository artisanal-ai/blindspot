import type { BlindSpot } from '../types'

// Everything blindspot says, to Claude and to you.

export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** The changed functions the spots use: `formatMoney, sumCents`. */
export const changedNames = (spots: BlindSpot[]) => [...new Set(spots.map(spot => spot.symbol))].join(', ')

/** `text` as a Markdown code span, whatever backticks it holds. */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = longest > 0 ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** The prompt that sends Claude to check its blind spots. */
export function checkPrompt(spots: BlindSpot[]): string {
  const lines = spots.map(spot => `- ${spot.path}:${spot.line} uses ${spot.symbol}: ${codeSpan(spot.usage)}`)
  const them = new Set(spots.map(spot => spot.symbol)).size === 1 ? 'it' : 'them'
  return (
    `You changed ${changedNames(spots)}, but never read these files that use ${them}:\n${lines.join('\n')}\n\n` +
    'Read each one and check it still works with your change. Fix what breaks, and tell me which were fine.'
  )
}

/** The status line (Claude Code heads it `⚠ blindspot:`): open blind spots, or nothing. */
export function statusLine(spots: number): string | undefined {
  return spots > 0 ? plural(spots, 'blind spot') : undefined
}

/** What `/blindspot` takes. */
export const USAGE = 'Usage: /blindspot [map|scan|status|reset|off|on|version]'
