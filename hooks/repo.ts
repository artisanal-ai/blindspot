// The git repository the session runs in, and paths as tools spell them.

/** Runs git with `args` (at the repo root unless `cwd` says otherwise); its output, or null when it failed. */
export type Git = (args: string[], cwd?: string) => Promise<string | null>

export type Repo = {
  /** The repository's top folder, absolute. */
  root: string
  /** The session's folder, absolute. */
  cwd: string
  /** Where the session's folder sits inside the repo ('' at the top). */
  prefix: string
  /** Every tracked file, and untracked ones git doesn't ignore, relative to the root. */
  files: string[]
  known: Set<string>
}

export async function readRepo(git: Git, cwd: string): Promise<Repo | null> {
  const top = await git(['rev-parse', '--show-toplevel', '--show-prefix'], cwd)
  if (top === null) return null
  const [root = '', prefix = ''] = top.split('\n')
  const listed = (await git(['ls-files', '--cached', '--others', '--exclude-standard'], root)) ?? ''
  const files = [...new Set(listed.split('\n').filter(Boolean))]
  return { root, cwd, prefix: prefix.replace(/\/$/, ''), files, known: new Set(files) }
}

/** `a/./b/../c` → `a/c`; null when it climbs out of the repo. */
export function normalize(path: string): string | null {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') {
      if (out.pop() === undefined) return null
    } else if (part !== '' && part !== '.') {
      out.push(part)
    }
  }
  return out.join('/')
}

/**
 * A path as a tool spelled it (absolute, or relative to `dir`, the shell's
 * folder inside the repo), relative to the repo root: '' for the root itself,
 * null outside the repo or when the shell would have to expand it.
 */
export function resolve(repo: Repo, path: string, dir: string | null = repo.prefix): string | null {
  if (/^[~$]/.test(path)) return null
  if (!path.startsWith('/')) return dir === null ? null : normalize(`${dir}/${path}`)
  // The repo's own spelling, then the session's (a symlink, /tmp vs /private/tmp).
  for (const [base, at] of [[repo.root, ''], [repo.cwd, repo.prefix]] as const) {
    if (path === base) return at
    if (path.startsWith(`${base}/`)) return normalize(`${at}/${path.slice(base.length + 1)}`)
  }
  return null
}

/** A file path as a tool spelled it, relative to the repo root; '' outside the repo. */
export const toRepoPath = (repo: Repo, path: string, dir?: string | null): string => resolve(repo, path, dir) ?? ''
