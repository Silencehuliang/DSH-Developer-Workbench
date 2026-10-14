/**
 * Tickets: the tracker-agnostic domain object, the two adapters that produce it,
 * and the analysis the board renders.
 *
 * Three separable pieces, on purpose:
 *
 *   - **Parsing** turns text into tickets. Pure, so CRLF, empty blockers, cycles
 *     and checkbox arithmetic are testable without a tracker.
 *   - **Adapters** fetch rows. Each takes an injected command runner, so the
 *     GitHub path never needs the network to be exercised.
 *   - **Analysis** derives blocked/open/ready. Pure, and it is the only place
 *     that decides what "can start" means.
 *
 * The board must never claim a ticket is startable when it could not read the
 * ticket's blocking edges. Reading failure is a distinct state, not an empty set.
 *
 * @module lib/tickets
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** Status strings that mean a local ticket is finished. */
const DONE_STATUSES = new Set(['resolved', 'done', 'closed', 'completed', 'merged', 'wontfix'])

/** One acceptance checkbox: `- [ ] thing` or `- [x] thing`. */
const CHECKBOX = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/

/** Largest number of issues one board will read. */
export const MAX_TICKETS = 200

/**
 * Read the value of a labelled line such as `Status: ready-for-agent`.
 *
 * Tolerant of the emphasis the ticket template uses (`**Blocked by:** 01, 02`)
 * and of the leading markers a list item may carry.
 *
 * @param text - document body.
 * @param label - the label, without punctuation.
 * @returns the trimmed value, or null when the line is absent.
 */
export function readLabelledLine(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^[\\s>*_+\\-]*${escaped}[\\s*_:-]*(.*)$`, 'im')
  const match = pattern.exec(text)
  if (match === null) return null
  const value = match[1].replace(/[*_`]/g, '').trim()
  return value.length === 0 ? null : value
}

/**
 * Count acceptance checkboxes.
 * @param text - document body.
 * @returns `{ total, done }`.
 */
export function parseAcceptance(text) {
  let total = 0
  let done = 0
  for (const line of String(text).split(/\r?\n/)) {
    const match = CHECKBOX.exec(line)
    if (match === null) continue
    total += 1
    if (match[1].toLowerCase() === 'x') done += 1
  }
  return { total, done }
}

/**
 * Read the `Blocked by` line into blocker ids.
 *
 * Accepts the local template's `01, 02`, a `#3` cross-reference, and the
 * explicit `None (can start immediately)`.
 *
 * @param text - document body.
 * @returns blocker ids, without the `#` prefix.
 */
export function parseBlockedBy(text) {
  const raw = readLabelledLine(text, 'Blocked by')
  if (raw === null) return []
  if (/^none\b/i.test(raw)) return []
  return raw
    .split(/[,;]|\s+/)
    .map((token) => token.replace(/^#/, '').replace(/[.,;:]+$/, '').trim())
    .filter((token) => /^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(token))
}

/**
 * Parse one local-markdown ticket file.
 *
 * @param text - file contents.
 * @param fileName - the file's basename, which supplies the number.
 * @returns a ticket.
 */
export function parseLocalIssue(text, fileName) {
  const base = path.basename(fileName, '.md')
  const numbered = /^(\d+)/.exec(base)
  const id = numbered === null ? base : numbered[1]

  const heading = /^#\s*(?:\d+\s*[:.)]\s*)?(.+?)\s*$/m.exec(String(text))
  const status = readLabelledLine(text, 'Status')
  const blockedBy = parseBlockedBy(text)

  return {
    id,
    number: /^\d+$/.test(id) ? Number(id) : null,
    title: heading === null ? base : heading[1],
    status: status ?? 'open',
    statusKind: status !== null && DONE_STATUSES.has(status.toLowerCase()) ? 'done' : 'open',
    url: null,
    blockedBy,
    blockedBySource: blockedBy.length > 0 ? 'body-line' : 'none',
    /** False only when the adapter could not read this ticket's edges at all. */
    edgesRead: true,
    acceptance: parseAcceptance(text),
    origin: 'local-markdown',
  }
}

/**
 * Parse one GitHub issue row.
 *
 * @param row - the issue as `gh issue list --json` returned it.
 * @param blockedByNumbers - native blocker issue numbers, or null when the
 *   dependency read failed. Null is deliberately different from `[]`: an empty
 *   array means "nothing blocks this", null means "I could not find out".
 * @returns a ticket.
 */
export function parseGitHubIssue(row, blockedByNumbers) {
  const labels = Array.isArray(row?.labels)
    ? row.labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter((name) => typeof name === 'string' && name.length > 0)
    : []
  const state = String(row?.state ?? '').toUpperCase()
  const bodyBlocked = parseBlockedBy(row?.body ?? '')
  const edgesRead = Array.isArray(blockedByNumbers)
  const nativeBlocked = edgesRead ? blockedByNumbers.filter((value) => value !== null && value !== undefined).map(String) : []
  const blockedBy = nativeBlocked.length > 0 ? nativeBlocked : bodyBlocked

  return {
    id: String(row?.number ?? ''),
    number: typeof row?.number === 'number' ? row.number : null,
    title: String(row?.title ?? ''),
    status: labels.length > 0 ? labels.join(', ') : state.toLowerCase(),
    statusKind: state === 'CLOSED' ? 'done' : 'open',
    state: state.toLowerCase() || null,
    labels,
    url: typeof row?.url === 'string' ? row.url : null,
    blockedBy,
    blockedBySource: nativeBlocked.length > 0 ? 'native-edge' : edgesRead ? (bodyBlocked.length > 0 ? 'body-line' : 'none') : 'unread',
    edgesRead,
    acceptance: parseAcceptance(row?.body ?? ''),
    origin: 'github',
  }
}

/**
 * Derive the board: which tickets are done, blocked, or startable.
 *
 * Pure. This is the single place that decides what "can start" means, so the
 * three ways a ticket can fail to be startable — an open blocker, an unreadable
 * edge, membership in a blocking cycle — are all handled here rather than being
 * papered over by the adapters.
 *
 * @param tickets - tickets from any adapter.
 * @returns `{ tickets, frontier, problems }`.
 */
export function analyseBoard(tickets) {
  const list = Array.isArray(tickets) ? tickets : []
  const byId = new Map(list.map((ticket) => [ticket.id, ticket]))

  // Cycle detection over the blockedBy graph.
  const mark = new Map()
  const inCycle = new Set()
  const visit = (id, stack) => {
    const state = mark.get(id)
    if (state === 2) return
    if (state === 1) {
      const start = stack.indexOf(id)
      for (const node of stack.slice(start < 0 ? 0 : start)) inCycle.add(node)
      return
    }
    mark.set(id, 1)
    stack.push(id)
    for (const blocker of byId.get(id)?.blockedBy ?? []) {
      if (byId.has(blocker)) visit(blocker, stack)
    }
    stack.pop()
    mark.set(id, 2)
  }
  for (const ticket of list) visit(ticket.id, [])

  const isDone = (id) => byId.get(id)?.statusKind === 'done'

  const enriched = list.map((ticket) => {
    const unknownBlockers = ticket.blockedBy.filter((blocker) => !byId.has(blocker) && blocker !== ticket.id)
    const openBlockers = ticket.blockedBy.filter((blocker) => byId.has(blocker) && !isDone(blocker))
    const cycle = inCycle.has(ticket.id)
    const done = ticket.statusKind === 'done'
    const ready = !done && !cycle && ticket.edgesRead === true && openBlockers.length === 0 && unknownBlockers.length === 0
    return { ...ticket, unknownBlockers, openBlockers, cycle, ready }
  })

  const problems = []
  if (inCycle.size > 0) problems.push({ code: 'cycle', ids: [...inCycle].sort() })
  const unknown = [...new Set(enriched.flatMap((ticket) => ticket.unknownBlockers))].sort()
  if (unknown.length > 0) problems.push({ code: 'unknown-blocker', ids: unknown })
  const selfBlocked = enriched.filter((ticket) => ticket.blockedBy.includes(ticket.id)).map((ticket) => ticket.id)
  if (selfBlocked.length > 0) problems.push({ code: 'self-blocked', ids: selfBlocked })
  const unreadable = enriched.filter((ticket) => ticket.edgesRead !== true).map((ticket) => ticket.id)
  if (unreadable.length > 0) problems.push({ code: 'edges-unread', ids: unreadable })

  return {
    tickets: enriched,
    frontier: enriched.filter((ticket) => ticket.ready).map((ticket) => ticket.id),
    problems,
  }
}

/**
 * Build a command runner.
 *
 * The runner is the injection point that keeps every CLI-touching assertion
 * offline: tests pass their own function instead of this one.
 *
 * @param options - runner options.
 * @returns `(command, args, options) => { ok, code, stdout, stderr, spawnFailed }`.
 */
export function createCommandRunner(options = {}) {
  const binaries = {
    gh: options.gh ?? 'gh',
    glab: options.glab ?? 'glab',
    git: options.git ?? 'git',
  }
  return (command, args, runOptions = {}) => {
    const binary = binaries[command] ?? command
    try {
      const stdout = execFileSync(binary, args, {
        cwd: runOptions.cwd,
        encoding: 'utf8',
        timeout: runOptions.timeoutMs ?? 20000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { ok: true, code: 0, stdout, stderr: '', spawnFailed: false }
    } catch (error) {
      return {
        ok: false,
        code: typeof error?.status === 'number' ? error.status : null,
        stdout: typeof error?.stdout === 'string' ? error.stdout : '',
        stderr: typeof error?.stderr === 'string' ? error.stderr : String(error?.message ?? error),
        spawnFailed: error?.code === 'ENOENT',
      }
    }
  }
}

/**
 * Parse a GitHub remote URL into owner and repo.
 * @param url - any of the https, ssh or scp-like spellings.
 * @returns `{ owner, repo }`, or null when it is not a GitHub remote.
 */
export function parseGitHubRemote(url) {
  const cleaned = String(url).trim().replace(/\.git$/i, '')
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+)$/i.exec(cleaned)
  return match === null ? null : { owner: match[1], repo: match[2] }
}

/**
 * Infer the GitHub repository from a clone's own remote.
 *
 * The tracker declaration names the repo in prose; the remote is authoritative
 * and needs no parsing of a sentence.
 *
 * @param projectPath - project root.
 * @param run - command runner.
 * @returns `{ owner, repo }`, or null when it cannot be inferred.
 */
export function resolveGitHubRepo(projectPath, run) {
  const remote = run('git', ['remote', 'get-url', 'origin'], { cwd: projectPath })
  if (remote.ok !== true) return null
  return parseGitHubRemote(remote.stdout)
}

/**
 * First non-empty line of a diagnostic blob.
 * @param text - stderr text.
 * @returns the line, or an empty string.
 */
function firstLine(text) {
  const line = String(text ?? '').split('\n').map((part) => part.trim()).find((part) => part.length > 0)
  return line ?? ''
}

/**
 * Read every issue of a GitHub repository, with its native blocking edges.
 *
 * @param options - read inputs.
 * @param options.run - command runner.
 * @param options.owner - repository owner.
 * @param options.repo - repository name.
 * @param options.limit - largest number of issues to read.
 * @returns `{ ok: true, tickets, notes }` or `{ ok: false, code, message }`.
 */
export function readGitHubTickets({ run, owner, repo, limit = MAX_TICKETS }) {
  const slug = `${owner}/${repo}`
  const list = run('gh', [
    'issue', 'list',
    '--repo', slug,
    '--state', 'all',
    '--limit', String(Math.min(limit, MAX_TICKETS)),
    '--json', 'number,title,state,labels,url,body',
  ])

  if (list.ok !== true) {
    const stderr = String(list.stderr ?? '')
    const code = list.spawnFailed === true
      ? 'gh-unavailable'
      : /auth|login|credential|token/i.test(stderr)
        ? 'gh-not-authenticated'
        : /could not resolve host|network|timeout|timed out/i.test(stderr)
          ? 'gh-offline'
          : 'gh-failed'
    return { ok: false, code, message: firstLine(stderr) || 'gh could not list issues' }
  }

  let rows
  try {
    rows = JSON.parse(list.stdout)
  } catch (error) {
    return { ok: false, code: 'gh-bad-json', message: 'gh did not return JSON' }
  }
  if (!Array.isArray(rows)) {
    return { ok: false, code: 'gh-bad-json', message: 'gh returned a non-array issue list' }
  }

  // Native edges are the canonical representation, and our own tickets set ONLY
  // those (the ticket template omits the text section once edges are native), so
  // a body-only read would call every blocked ticket startable.
  const edges = new Map()
  for (const row of rows) {
    const dependencies = run('gh', [
      'api', `repos/${slug}/issues/${row.number}/dependencies/blocked_by`,
      '--jq', '.[].number',
    ])
    if (dependencies.ok !== true) {
      edges.set(row.number, null)
      continue
    }
    edges.set(
      row.number,
      dependencies.stdout.split(/\s+/).filter((token) => /^\d+$/.test(token)).map(Number),
    )
  }

  const tickets = rows.map((row) => parseGitHubIssue(row, edges.get(row.number) ?? null))
  const unread = [...edges.entries()].filter(([, value]) => value === null).map(([number]) => String(number)).sort()
  return {
    ok: true,
    tickets,
    notes: unread.length > 0
      ? [{ code: 'edges-unread', ids: unread, message: 'blocking edges could not be read for these issues' }]
      : [],
  }
}

/**
 * Read every ticket a local-markdown tracker holds.
 *
 * The layout is the one `setup-matt-pocock-skills` documents: one feature
 * directory per feature, one file per ticket under `issues/`.
 *
 * @param options - read inputs.
 * @param options.projectPath - project root.
 * @returns `{ ok: true, tickets, notes }`.
 */
export function readLocalTickets({ projectPath }) {
  const scratch = path.join(projectPath, '.scratch')
  let features
  try {
    features = fs.readdirSync(scratch, { withFileTypes: true })
  } catch (error) {
    return { ok: true, tickets: [], notes: [{ code: 'no-tracker-data', message: '.scratch does not exist yet' }] }
  }

  const tickets = []
  for (const feature of features) {
    if (!feature.isDirectory()) continue
    const issuesDir = path.join(scratch, feature.name, 'issues')
    let files
    try {
      files = fs.readdirSync(issuesDir, { withFileTypes: true })
    } catch (error) {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.toLowerCase().endsWith('.md')) continue
      try {
        const text = fs.readFileSync(path.join(issuesDir, file.name), 'utf8')
        tickets.push({ ...parseLocalIssue(text, file.name), feature: feature.name })
      } catch (error) {
        continue
      }
    }
  }

  tickets.sort((left, right) => left.id.localeCompare(right.id))
  return {
    ok: true,
    tickets,
    notes: tickets.length === 0 ? [{ code: 'no-tracker-data', message: 'no ticket files under .scratch/*/issues/' }] : [],
  }
}
