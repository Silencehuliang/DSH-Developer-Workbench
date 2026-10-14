/**
 * Read-only git overview for one project directory.
 *
 * The workbench never writes to git. Every command here is a query, and every
 * failure mode — no repository, no git binary, a corrupt index — degrades to an
 * explanatory result instead of throwing, because the project list must render
 * for a directory that is not a repository.
 *
 * **These calls are asynchronous on purpose.** An earlier version used
 * `execFileSync`, which blocks Node's event loop for the whole life of each
 * child process. Measured on a real profile, one board read held the entire DSH
 * web server for roughly eighteen seconds, and `/overview` — which needs no
 * subprocess of its own beyond git — went from 551 ms to 19 272 ms while that
 * read was in flight. Spawning asynchronously yields the loop while the child
 * runs, so a slow subprocess costs only the request that asked for it.
 *
 * @module lib/git
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** How long any single git query may take before it is abandoned. */
const GIT_TIMEOUT_MS = 5000

/**
 * Run one git command.
 *
 * @param cwd - directory to run in.
 * @param args - git arguments, without the leading `git`.
 * @returns `{ code, stdout, stderr }`; `code` is null when the command could not start.
 */
async function defaultRun(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr: stderr ?? '' }
  } catch (error) {
    return {
      code: typeof error?.code === 'number' ? error.code : null,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : String(error?.message ?? error),
      spawnFailed: error?.code === 'ENOENT',
    }
  }
}

/**
 * Read one directory's git state.
 *
 * @param cwd - directory to inspect.
 * @param run - command runner; injectable for tests.
 * @returns the overview, always with an `ok` flag and an explanation when not ok.
 */
export async function gitOverview(cwd, run = defaultRun) {
  const inside = await run(cwd, ['rev-parse', '--is-inside-work-tree'])

  if (inside.spawnFailed === true) {
    return { ok: false, isRepo: false, reason: 'git-unavailable', error: 'the git executable could not be started' }
  }
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    const detail = inside.stderr.trim().split('\n')[0] ?? ''
    return { ok: false, isRepo: false, reason: 'not-a-git-work-tree', error: detail.length > 0 ? detail : null }
  }

  // Three independent queries, so the request waits once rather than three times.
  const [branch, status, log] = await Promise.all([
    run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    run(cwd, ['status', '--porcelain']),
    run(cwd, ['log', '-1', '--pretty=%h%x09%s']),
  ])

  return {
    ok: true,
    isRepo: true,
    reason: null,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    /** Untracked files count too: an untracked file is uncommitted work. */
    dirtyCount: status.code === 0 ? status.stdout.split('\n').filter((line) => line.trim().length > 0).length : null,
    lastCommit: log.code === 0 ? log.stdout.trim() : null,
  }
}
