/**
 * End-to-end acceptance: one project, walked up the whole ladder.
 *
 * `verify.mjs` asserts each route in isolation. This script asserts the thing the
 * product actually claims: **the stage advances by itself as artifacts appear**,
 * on one real project, through the real HTTP surface.
 *
 * It also reports where the chain stops. That is a finding, not a failure — an
 * acceptance run that hid it would be worth less than no run at all.
 *
 * Usage:
 *   node plugin/scripts/acceptance.mjs
 *   node plugin/scripts/acceptance.mjs --base=http://127.0.0.1:19387
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')

const args = new Map(process.argv.slice(2).map((raw) => {
  const [key, value] = raw.split('=')
  return [key.replace(/^--/, ''), value ?? '']
}))
const BASE = args.get('base') ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387'

let passed = 0
const failures = []

/**
 * Assert one condition.
 * @param label - what is being asserted.
 * @param condition - the result to require.
 * @param detail - extra text on failure.
 */
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * Fetch JSON, failing loudly on a non-2xx response.
 * @param route - path beginning with `/`.
 * @returns the parsed body.
 */
async function getJson(route) {
  const response = await fetch(`${BASE}${route}`, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${route} -> HTTP ${response.status}`)
  return await response.json()
}

/** Run git in the fixture. */
function git(cwd, gitArgs) {
  execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** The step we just took, and the stage it should have produced. */
const walk = []

/**
 * Take one step in the walk and record what the workbench made of it.
 * @param label - what was added.
 * @param mutate - the filesystem change.
 * @param expected - the stage expected afterwards.
 */
async function step(label, mutate, expected) {
  mutate()
  const stage = await getJson(`/api/developer-workbench/stage?path=${encodeURIComponent(fixture)}`)
  walk.push({ label, stage: stage.stage, code: stage.evidence[0]?.code ?? null, ok: stage.stage === expected })
  check(`walk: after ${label} the stage is ${expected}`, stage.stage === expected, `got ${stage.stage} (${stage.evidence[0]?.code ?? '?'})`)
  return stage
}

// ── the fixture ───────────────────────────────────────────────────────────────

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wb-accept-'))
console.log(`acceptance @ ${BASE}`)
console.log(`fixture   @ ${fixture}\n`)

try {
  git(fixture, ['init', '-q'])
  git(fixture, ['config', 'user.email', 'acceptance@local'])
  git(fixture, ['config', 'user.name', 'Acceptance'])
  fs.writeFileSync(path.join(fixture, 'README.md'), '# fixture\n', 'utf8')
  git(fixture, ['add', '-A'])
  git(fixture, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial'])

  fs.mkdirSync(path.join(fixture, 'docs', 'agents'), { recursive: true })
  fs.writeFileSync(
    path.join(fixture, 'docs', 'agents', 'issue-tracker.md'),
    '# Issue tracker: Local Markdown\n\nIssues and specs for this repo live as markdown files in `.scratch/`.\n',
    'utf8',
  )
  fs.mkdirSync(path.join(fixture, '.scratch', 'feat', 'issues'), { recursive: true })

  // ── the ladder ──────────────────────────────────────────────────────────────

  console.log('the ladder')
  await step('a tracker declaration', () => {}, 'grill')
  await step('an ADR', () => {
    fs.mkdirSync(path.join(fixture, 'docs', 'adr'), { recursive: true })
    fs.writeFileSync(path.join(fixture, 'docs', 'adr', '0001-first.md'), '# 0001\n\nA decision.\n', 'utf8')
  }, 'spec')
  await step('a spec', () => {
    fs.writeFileSync(path.join(fixture, '.scratch', 'feat', 'spec.md'), '# Spec\n\nWhat to build.\n', 'utf8')
  }, 'tickets')
  await step('the first ticket', () => {
    fs.writeFileSync(path.join(fixture, '.scratch', 'feat', 'issues', '01-alpha.md'), '# 01: Alpha\r\n\r\n**Blocked by:** None (can start immediately)\r\n\r\n**Status:** ready-for-agent\r\n\r\n- [ ] one\r\n- [ ] two\r\n', 'utf8')
  }, 'implement')
  await step('a second, blocked ticket', () => {
    fs.writeFileSync(path.join(fixture, '.scratch', 'feat', 'issues', '02-beta.md'), '# 02: Beta\r\n\r\n**Blocked by:** 01\r\n\r\n**Status:** ready-for-agent\r\n\r\n- [x] done\r\n', 'utf8')
  }, 'implement')
  await step('the first ticket finished', () => {
    fs.writeFileSync(path.join(fixture, '.scratch', 'feat', 'issues', '01-alpha.md'), '# 01: Alpha\r\n\r\n**Status:** resolved\r\n\r\n- [x] one\r\n- [x] two\r\n', 'utf8')
  }, 'implement')
  const finished = await step('every ticket finished', () => {
    // Keep the blocking edge: a finished ticket still records what gated it, and
    // dropping the line here would make the board assertion below lie.
    fs.writeFileSync(path.join(fixture, '.scratch', 'feat', 'issues', '02-beta.md'), '# 02: Beta\r\n\r\n**Blocked by:** 01\r\n\r\n**Status:** resolved\r\n\r\n- [x] done\r\n', 'utf8')
  }, 'review')

  // ── the board agreed at every point ─────────────────────────────────────────

  console.log('\nthe board along the way')
  const board = await getJson(`/api/developer-workbench/tickets?path=${encodeURIComponent(fixture)}`)
  check('board: reads the local tracker', board.state === 'ready', String(board.state))
  check('board: two tickets, both done', board.tickets.length === 2 && board.tickets.every((ticket) => ticket.statusKind === 'done'))
  check('board: nothing is startable once everything is done', board.frontier.length === 0, JSON.stringify(board.frontier))
  check('board: the blocked ticket names its blocker', board.tickets.find((ticket) => ticket.id === '02')?.blockedBy.includes('01') === true)
  check('board: acceptance checkboxes survived CRLF', board.tickets.find((ticket) => ticket.id === '02')?.acceptance.done === 1)

  // ── every dispatchable step can be prepared ─────────────────────────────────

  console.log('\ndispatch along the way')
  const dispatchables = ['setup', 'grill', 'spec', 'tickets', 'implement', 'review', 'pr', 'retro', 'handoff', 'resume']
  for (const id of dispatchables) {
    const suffix = id === 'resume' ? `&handoff=${encodeURIComponent(path.join(os.tmpdir(), 'x.md'))}` : ''
    const prompt = await getJson(`/api/developer-workbench/prompt?path=${encodeURIComponent(fixture)}&stage=${id}${suffix}`)
    const carries = prompt.skillPath === null
      ? prompt.text.includes('不需要先加载某个技能')
      : prompt.text.includes(prompt.skillPath.split(path.sep).join('/'))
    check(`dispatch: ${id} builds a prompt with its coordinates`, carries && prompt.text.includes('.scratch/'), `${prompt.skillPath}`)
  }

  // ── artifacts, handoff, skills, settings ────────────────────────────────────

  console.log('\nthe surrounding surfaces')
  const artifacts = await getJson(`/api/developer-workbench/artifacts?path=${encodeURIComponent(fixture)}`)
  check('artifacts: the spec is listed', artifacts.groups.some((group) => group.id === 'spec' && group.items.length > 0))
  check('artifacts: the ADR is listed', artifacts.groups.some((group) => group.id === 'adr' && group.items.length > 0))
  check('artifacts: no handoff group before one exists', artifacts.groups.some((group) => group.id === 'handoff') === false)

  const handoff = await getJson(`/api/developer-workbench/prompt?path=${encodeURIComponent(fixture)}&stage=handoff`)
  const handoffPath = handoff.targets.handoff.path
  fs.mkdirSync(path.dirname(handoffPath), { recursive: true })
  fs.writeFileSync(handoffPath, '# Handoff\n\nnext\n', 'utf8')
  const recorded = await fetch(`${BASE}/api/developer-workbench/projects/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: fixture, handoffPath, sessionId: 'acceptance' }),
  })
  check('handoff: recording it succeeds', recorded.ok === true, `HTTP ${recorded.status}`)
  const withHandoff = await getJson(`/api/developer-workbench/artifacts?path=${encodeURIComponent(fixture)}`)
  check('handoff: it then appears in the artifact list', withHandoff.groups.some((group) => group.id === 'handoff'))
  const resume = await getJson(`/api/developer-workbench/prompt?path=${encodeURIComponent(fixture)}&stage=resume&handoff=${encodeURIComponent(handoffPath)}`)
  check('handoff: resuming it is offered and the document is present', resume.targets.handoff.exists === true)

  const selfCheck = await getJson(`/api/developer-workbench/skills/status?path=${encodeURIComponent(fixture)}`)
  check('skills: the bundled set is really visible to DSH', selfCheck.counts?.discovered === 27, JSON.stringify(selfCheck.counts))
  check('skills: the self-check is healthy', selfCheck.diagnosis?.code === 'ok', String(selfCheck.diagnosis?.code))

  const settings = await getJson('/api/developer-workbench/settings')
  check('settings: read back with defaults', settings.settings?.promptLanguage !== undefined)

  // ── where the chain stops ───────────────────────────────────────────────────

  console.log('\nwhere the chain stops')
  check('chain: review is reached from finished tickets', finished.stage === 'review', String(finished.stage))
  // Nothing writes reviews or pull requests yet, so pr/retro are pin-only.
  // Asserting the current behaviour keeps this honest without hiding the gap.
  console.log('  GAP  nothing writes reviews or pull requests, so pr and retro cannot be')
  console.log('       reached automatically — see issue #12. Pinning a stage still works.')

  // ── the walk, as evidence ───────────────────────────────────────────────────

  console.log('\nwatch it advance')
  for (const row of walk) {
    console.log(`  ${row.ok ? '→' : '✗'} ${String(row.stage).padEnd(10)} ${row.label.padEnd(28)} (${row.code ?? '?'})`)
  }
} catch (error) {
  failures.push(`the acceptance run threw: ${String(error?.message ?? error)}`)
  console.log(`\n  FAIL the acceptance run threw: ${String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ')}`)
} finally {
  try {
    fs.rmSync(fixture, { recursive: true, force: true })
  } catch (error) {
    // A leftover temp directory must never fail the run.
  }
}

console.log('')
if (failures.length === 0) {
  console.log(`PASS — ${passed} assertions`)
  process.exit(0)
}
console.log(`FAIL — ${passed} passed, ${failures.length} failed`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
