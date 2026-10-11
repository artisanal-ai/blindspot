/** How Claude has touched one file this session. */
export type Touch = { seen: number; read: number; edit: number }

/** A file that uses a function Claude changed, on lines Claude never read. */
export type BlindSpot = {
  path: string
  /** The file Claude changed, and the function in it this file uses. */
  changedFile: string
  symbol: string
  /** Where this file uses it best (a call over an import): the line number and the line, trimmed. */
  line: number
  usage: string
  /** Every line that uses it that Claude hasn't read; the spot clears once it has read them all. */
  lines: number[]
}

declare module 'claude-code' {
  interface PluginState {
    blindspot: {
      touches: Record<string, Touch>
      /** The lines Claude has read of each file, as 1-based inclusive spans. */
      readLines: Record<string, [number, number][]>
      blindSpots: BlindSpot[]
      /** Files edited this turn, scanned for blind spots when it ends. */
      pending: string[]
      /**
       * The working tree just before Claude's first edit of the session and of
       * this turn, as a commit to diff against ('' for the index: no commit
       * yet); null until that edit.
       */
      bases: { session: string | null; turn: string | null }
      isPaused: boolean
    }
  }
}
