/**
 * Acceptance test for dsh-developer-workbench.
 *
 * Two seams, both runnable without a browser:
 *
 *   1. **Client bundle** — loads `client.js` against a stub `window` and a stub
 *      React, materialises the factory, runs `apply` against a fake context, and
 *      asserts the registrations. This catches the wiring that decides WHERE the
 *      entry lands, which no HTTP assertion can see.
 *   2. **Host routes** — asserts the live HTTP API against real directories this
 *      script creates. Fixtures are real git repositories and real tracker
 *      declaration files, so the assertions exercise real git and real parsing
 *      rather than a mock of them.
 *
 * Host assertions are skipped with a clear notice when no DSH is reachable, so
 * the script still proves something useful offline.
 *
 * Usage:
 *   node scripts/verify.mjs                    # client assertions + live routes
 *   node scripts/verify.mjs --base=http://127.0.0.1:19387
 *   node scripts/verify.mjs --client-only
 *
 * Exit code 0 means every executed assertion passed.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  analyseBoard,
  parseBlockedBy,
  parseGitHubIssue,
  parseGitHubRemote,
  parseLocalIssue,
  readGitHubTickets,
} from '../lib/tickets.js'
import { STAGES, deriveStage } from '../lib/stage.js'
import { DEFAULT_TRIAGE_LABELS, buildDispatchPrompt, readTriageLabels } from '../lib/prompts.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')

const args = new Map(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.split('=')
    return [key.replace(/^--/, ''), value ?? '']
  }),
)
const BASE = args.get('base') ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387'
const CLIENT_ONLY = args.has('client-only')

/** Total skills bundled in `skills/`, and how the invocation flags split them. */
const EXPECTED_TOTAL = 27
const EXPECTED_MODEL_INVOCABLE = 11

let passed = 0
const failures = []

/**
 * Assert one condition.
 * @param label - what is being asserted.
 * @param condition - the result to require.
 * @param detail - extra text printed on failure.
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

// ── 1. client bundle ──────────────────────────────────────────────────────────

/**
 * Load the browser half with stubs and return its registrations.
 * @returns captured bundle id, plugin exports, and every registration it made.
 */
function exerciseClientBundle() {
  const code = fs.readFileSync(path.join(PLUGIN_DIR, 'client.js'), 'utf8')

  /** Minimal React surface the factory destructures at materialisation time. */
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }

  let captured = null
  const stubWindow = {
    __ModuleLoader__: {
      load: (spec) => {
        captured = spec
      },
    },
  }

  const requireStub = (id) => {
    if (id === 'react') return reactStub
    throw new Error(`client bundle required an unexpected module: ${id}`)
  }

  // The bundle is a plain script that registers itself against `window`.
  new Function('window', code)(stubWindow)

  if (captured === null) throw new Error('client.js never called window.__ModuleLoader__.load')
  const plugin = captured.factory(requireStub)

  const localeRegistrations = []
  const slotRegistrations = []
  const slotPeeks = []

  const fakeCtx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    get: () => undefined,
    locale: {
      register: (ns, dicts) => {
        localeRegistrations.push({ ns, dicts })
        return () => {}
      },
      bind: (ns) => (key) => `${ns}.${key}`,
    },
    slots: {
      inject: (slotName, callback) => {
        slotPeeks.push(slotName)
        return callback()
      },
      register: (options, component) => {
        slotRegistrations.push({ options, component })
        return () => {}
      },
    },
  }

  plugin.apply(fakeCtx)

  return { bundleId: captured.id, plugin, localeRegistrations, slotRegistrations, slotPeeks }
}

console.log('client bundle')
const client = exerciseClientBundle()

check('bundle id is the package name', client.bundleId === 'dsh-developer-workbench', client.bundleId)
check('plugin exposes apply/inject/name', typeof client.plugin.apply === 'function' && Array.isArray(client.plugin.inject) && client.plugin.name === 'developer-workbench')
check('registers a zh + en dictionary pair', client.localeRegistrations.some((row) => row.dicts.zh !== undefined && row.dicts.en !== undefined))

const panelRow = client.slotRegistrations.find((row) => row.options.name === 'sidebar.panellist')
check('registers into sidebar.panellist', panelRow !== undefined)
check('panel id is developer-workbench', panelRow?.options.id === 'developer-workbench', String(panelRow?.options.id))
// The shipped Plugins page uses order 0 and the sidebar sorts ascending, so a
// negative order is what places this row between New Session and Plugins.
check('panel order is negative (above Plugins)', typeof panelRow?.options.order === 'number' && panelRow.options.order < 0, String(panelRow?.options.order))
check('panel declares a localized label thunk', typeof panelRow?.options.label === 'function' && typeof panelRow.options.label() === 'string')
check('panel registers a component', panelRow?.component !== undefined)

const mainRow = client.slotRegistrations.find((row) => row.options.name === 'main')
check('registers into main', mainRow !== undefined)
check('main key matches the panel id', mainRow?.options.key === 'developer-workbench', String(mainRow?.options.key))
check('main registers a component', mainRow?.component !== undefined)
check('uses declaration-aware slots.inject for both', client.slotPeeks.includes('sidebar.panellist') && client.slotPeeks.includes('main'))

const icon = panelRow?.component?.({ size: 16, active: true })
check('icon renders a sized glyph', icon !== undefined && icon.props?.width === 16)

// ── 1b. client rendering over fixture data ────────────────────────────────────

console.log('\nclient rendering')

const seam = client.plugin.__test

/**
 * Render an element tree to the list of strings it would show.
 *
 * The stub React returns plain objects, so function components are invoked here
 * by hand. That is the whole point of splitting the page into pure components:
 * rendered output is assertable without a browser or a reconciler.
 *
 * @param node - an element returned by the stub `createElement`.
 * @returns every text node, flattened.
 */
function renderText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(renderText)
  if (typeof node.type === 'function') {
    const props = { ...(node.props ?? {}) }
    if (props.children === undefined && node.children !== undefined) props.children = node.children
    return renderText(node.type(props))
  }
  const kids = node.props?.children !== undefined ? node.props.children : node.children
  return renderText(kids)
}

const zhT = (key, params) => seam.translate(seam.dicts.zh, key, params)

const fixtureProjects = [
  {
    key: 'a',
    workspaceId: 'ws-a',
    title: 'Developer Workbench',
    path: '/tmp/a',
    directoryStatus: 'ok',
    sessionCount: 3,
    git: { ok: true, isRepo: true, branch: 'main', dirtyCount: 2, lastCommit: 'abc123\tinitial' },
    tracker: { kind: 'github', label: 'GitHub Issues', source: 'project-declaration' },
  },
  {
    key: 'b',
    workspaceId: 'ws-b',
    title: 'Goal Dashboard',
    path: '/tmp/b',
    directoryStatus: 'ok',
    sessionCount: 1,
    git: { ok: false, isRepo: false, reason: 'not-a-git-work-tree' },
    tracker: null,
  },
]

const listText = renderText(seam.ProjectList({ projects: fixtureProjects, t: zhT })).join(' | ')
check('project list renders every project title', listText.includes('Developer Workbench') && listText.includes('Goal Dashboard'))
check('project list shows the git branch and dirty count', listText.includes('main') && listText.includes('2'))
check('project list shows the session count', listText.includes('3') && listText.includes('1'))
check('project list labels a non-repo instead of inventing a branch', listText.includes('不是 git 仓库'))
check('project list shows a resolved tracker label', listText.includes('GitHub Issues'))
check('project list flags an undecided tracker', listText.includes('tracker 未定'))
check('project list badges the stage placeholder until derivation lands', listText.includes('阶段待接入'))
check('project list shows the empty state when nothing is bound', renderText(seam.ProjectList({ projects: [], t: zhT })).join(' ').includes('还没有登记任何工作区'))
check('project list survives a missing projects prop', renderText(seam.ProjectList({ t: zhT })) !== undefined)

// The tracker chip must not claim a source it cannot name.
const chipText = renderText(seam.TrackerChip({ tracker: fixtureProjects[0].tracker, t: zhT })).join(' ')
check('tracker chip renders the tracker label', chipText.includes('GitHub Issues'))

// Picker: absent, prompting, and conflicting.
check('tracker picker renders nothing when there is no pending decision', seam.TrackerPicker({ pending: null, t: zhT, onChoose: () => {} }) === null)
const promptText = renderText(seam.TrackerPicker({ pending: { path: '/tmp/b', conflict: null }, t: zhT, onChoose: () => {} })).join(' | ')
check('tracker picker asks when the project declares nothing', promptText.includes('这个项目用哪个 tracker？'))
check('tracker picker offers every tracker kind', seam.TRACKER_CHOICES.every((choice) => promptText.includes(choice.label)))
const conflictText = renderText(seam.TrackerPicker({ pending: { path: '/tmp/b', conflict: { declaredKind: 'github', mappedKind: 'local-markdown' } }, t: zhT, onChoose: () => {} })).join(' | ')
check('tracker picker surfaces a conflict instead of guessing', conflictText.includes('不一致') && conflictText.includes('github') && conflictText.includes('local-markdown'))

// Skill grid.
const skillText = renderText(seam.SkillGrid({ inventory: { skills: [
  { name: 'grilling', description: 'grill', modelInvocable: true },
  { name: 'to-tickets', description: 'tickets', modelInvocable: false },
] }, t: zhT })).join(' | ')
check('skill grid names every skill', skillText.includes('grilling') && skillText.includes('to-tickets'))
check('skill grid separates model-loadable from human-only', skillText.includes('model') && skillText.includes('human'))
check('skill grid degrades when the self-check is unavailable', renderText(seam.SkillGrid({ inventory: null, t: zhT })).join(' ').includes('技能自检暂不可用'))

// Artifacts: grouping, preview, and every refusal keeping its own words.
const artifactScan = {
  groups: [
    { id: 'spec', label: 'Specs and plans', items: [{ name: '.scratch/feat/spec.md', path: '/tmp/a/.scratch/feat/spec.md', bytes: 2048, mtime: '2026-10-14T06:00:00.000Z' }] },
    { id: 'adr', label: 'ADRs', items: [{ name: 'docs/adr/0001-first.md', path: '/tmp/a/docs/adr/0001-first.md', bytes: 512, mtime: '2026-10-14T05:00:00.000Z' }] },
  ],
}
const groupsText = renderText(seam.ArtifactGroups({ scan: artifactScan, t: zhT, selectedPath: null, onOpen: () => {} })).join(' | ')
check('artifact list renders every group by its host-given label', groupsText.includes('Specs and plans') && groupsText.includes('ADRs'))
check('artifact list names each document', groupsText.includes('.scratch/feat/spec.md') && groupsText.includes('docs/adr/0001-first.md'))
check('artifact list shows size and modification time', groupsText.includes('2 KB') && groupsText.includes('2026-10-14'))
check('artifact list shows an empty state, not an empty heading', renderText(seam.ArtifactGroups({ scan: { groups: [] }, t: zhT, onOpen: () => {} })).join(' ').includes('这个项目还没有'))
check('artifact list says it is scanning while the scan is pending', renderText(seam.ArtifactGroups({ scan: null, t: zhT, onOpen: () => {} })).join(' ').includes('正在扫描产物'))

check('preview renders nothing when no document is selected', seam.ArtifactPreview({ preview: null, t: zhT }) === null)
const readyPreview = renderText(seam.ArtifactPreview({
  preview: { status: 'ready', item: { path: '/tmp/a/long.md' }, result: { ok: true, lines: ['line 1', 'line 2'], totalLines: 50, hasMore: true, bytes: 10 } },
  t: zhT,
  onLoadMore: () => {},
  onClose: () => {},
})).join(' | ')
check('preview renders the file body', readyPreview.includes('line 1') && readyPreview.includes('line 2'))
check('preview shows how much of the file is shown', readyPreview.includes('2 / 50'))
check('preview offers more when the file continues', readyPreview.includes('还剩 48 行'))
const endPreview = renderText(seam.ArtifactPreview({
  preview: { status: 'ready', item: { path: '/tmp/a/short.md' }, result: { ok: true, lines: ['only'], totalLines: 1, hasMore: false, bytes: 5 } },
  t: zhT,
  onLoadMore: () => {},
  onClose: () => {},
})).join(' | ')
check('preview says so at the end of the file', endPreview.includes('已到文件末尾'))

const refusalCases = [
  { code: 'binary', text: '二进制' },
  { code: 'not-utf8', text: 'UTF-8' },
  { code: 'missing', text: '文件不存在' },
  { code: 'not-a-file', text: '普通文件' },
]
for (const refusal of refusalCases) {
  const text = renderText(seam.ArtifactPreview({
    preview: { status: 'refused', item: { path: '/tmp/a/x' }, code: refusal.code, result: {}, message: 'host detail' },
    t: zhT,
    onLoadMore: () => {},
    onClose: () => {},
  })).join(' | ')
  check(`preview refusal "${refusal.code}" explains itself`, text.includes(refusal.text))
}
const tooLargeText = renderText(seam.ArtifactPreview({
  preview: { status: 'refused', item: { path: '/tmp/a/huge.md' }, code: 'too-large', result: { bytes: 614400, maxFileBytes: 524288 }, message: 'too big' },
  t: zhT,
  onLoadMore: () => {},
  onClose: () => {},
})).join(' | ')
check('preview refusal "too-large" quotes both sizes', tooLargeText.includes('600 KB') && tooLargeText.includes('512 KB'))

check('byte formatting is readable', seam.formatBytes(512) === '512 B' && seam.formatBytes(2048) === '2 KB' && seam.formatBytes(1024 * 1024 * 3) === '3.0 MB')
check('time formatting is locale-stable', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(seam.formatWhen('2026-10-14T06:00:00.000Z')))

// Ticket board rendering. The point of these assertions is that no failure state
// is allowed to look like "this project simply has no tickets".
const boardFixture = {
  state: 'ready',
  frontier: ['3'],
  problems: [],
  tickets: [
    { id: '3', title: 'Board', statusKind: 'open', status: 'ready-for-agent', ready: true, blockedBy: [], openBlockers: [], unknownBlockers: [], acceptance: { total: 5, done: 3 }, edgesRead: true, blockedBySource: 'native-edge' },
    { id: '6', title: 'Stage', statusKind: 'open', status: 'ready-for-agent', ready: false, blockedBy: ['3'], openBlockers: ['3'], unknownBlockers: [], acceptance: { total: 2, done: 0 }, edgesRead: true, blockedBySource: 'native-edge' },
    { id: '2', title: 'Projects', statusKind: 'done', status: 'closed', ready: false, blockedBy: [], openBlockers: [], unknownBlockers: [], acceptance: { total: 1, done: 1 }, edgesRead: true, blockedBySource: 'none' },
  ],
}
const boardText = renderText(seam.TicketBoard({ board: boardFixture, t: zhT })).join(' | ')
check('board: every ticket is listed with its number', boardText.includes('#3') && boardText.includes('#6') && boardText.includes('#2'))
check('board: ticket titles render', boardText.includes('Board') && boardText.includes('Stage') && boardText.includes('Projects'))
check('board: the frontier count is shown', boardText.includes('可开工 1 张'))
check('board: a startable ticket is chipped as startable', boardText.includes('可开工'))
check('board: a blocked ticket is chipped as blocked', boardText.includes('被阻塞'))
check('board: a blocked ticket names its open blocker', boardText.includes('被 #3 阻塞'))
check('board: acceptance progress renders as done/total', boardText.includes('验收 3/5') && boardText.includes('验收 0/2'))
check('board: a finished ticket is chipped as done', boardText.includes('已完成'))

check('board: an undecided tracker explains itself instead of showing an empty board', renderText(seam.TicketBoard({ board: { state: 'needs-tracker' }, t: zhT })).join(' ').includes('tracker 还没定'))
check('board: an unimplemented tracker names the kind it cannot read', renderText(seam.TicketBoard({ board: { state: 'unsupported', tracker: { kind: 'gitlab' } }, t: zhT })).join(' ').includes('gitlab'))
check('board: an unreadable tracker quotes the reason code', renderText(seam.TicketBoard({ board: { state: 'unavailable', reason: { code: 'gh-offline', message: 'no route to host' } }, t: zhT })).join(' ').includes('gh-offline'))
check('board: a healthy but empty board says it is empty', renderText(seam.TicketBoard({ board: { state: 'ready', tickets: [], frontier: [], problems: [] }, t: zhT })).join(' ').includes('还没有工单'))
check('board: loading shows before the first answer', renderText(seam.TicketBoard({ board: null, t: zhT })).join(' ').includes('正在读取'))

const boardProblemText = renderText(seam.TicketBoard({
  board: {
    state: 'ready',
    tickets: [],
    frontier: [],
    problems: [
      { code: 'cycle', ids: ['1', '2'] },
      { code: 'self-blocked', ids: ['3'] },
      { code: 'unknown-blocker', ids: ['99'] },
      { code: 'edges-unread', ids: ['7'] },
    ],
  },
  t: zhT,
})).join(' | ')
check('board: a blocking cycle is called out with its members', boardProblemText.includes('依赖成环') && boardProblemText.includes('1, 2'))
check('board: a self-block is called out', boardProblemText.includes('自己阻塞自己') && boardProblemText.includes('3'))
check('board: an unknown blocker is called out', boardProblemText.includes('不存在的工单') && boardProblemText.includes('99'))
check('board: unreadable edges are called out as not startable', boardProblemText.includes('读不到') && boardProblemText.includes('7'))

// Stage pipeline rendering, and the localised step vocabulary.
const stageSteps = [
  { id: 'setup', skill: 'setup-matt-pocock-skills' },
  { id: 'grill', skill: 'grilling', alternative: 'grill-with-docs' },
  { id: 'spec', skill: 'to-spec' },
  { id: 'tickets', skill: 'to-tickets' },
  { id: 'implement', skill: 'implement', alternative: 'tdd' },
  { id: 'review', skill: 'code-review' },
  { id: 'pr', skill: 'pr' },
  { id: 'retro', skill: 'retro' },
]
const stageFixture = {
  stage: 'implement',
  derived: 'implement',
  overridden: false,
  completed: ['setup', 'grill', 'spec', 'tickets'],
  stages: stageSteps,
  evidence: [{ stage: 'implement', code: 'tickets-open', note: '8 of 11 ticket(s) are still open, 2 startable' }],
  bypass: [],
}
const pipelineText = renderText(seam.StagePipeline({ stage: stageFixture, t: zhT, onOverride: () => {} })).join(' | ')
check('pipeline: every step is labelled', ['配置 tracker', '拷问', '成稿', '拆工单', '实现', '评审', '提 PR', '复盘'].every((label) => pipelineText.includes(label)), pipelineText.slice(0, 140))
check('pipeline: the current step offers its skill and its alternative', pipelineText.includes('implement / tdd'), pipelineText)
check('pipeline: the evidence for the step is shown', pipelineText.includes('依据') && pipelineText.includes('8 of 11'))
check('pipeline: the pin control lists every stage', pipelineText.includes('手动覆盖') && pipelineText.includes('配置 tracker'))
check('pipeline: the unpin control is absent while nothing is pinned', pipelineText.includes('恢复自动推导') === false)

const overriddenPipeline = renderText(
  seam.StagePipeline({ stage: { ...stageFixture, stage: 'pr', derived: 'implement', overridden: true }, t: zhT, onOverride: () => {}, onClearOverride: () => {} }),
).join(' | ')
check('pipeline: a pin is labelled as a manual override', overriddenPipeline.includes('已被手动覆盖'))
check('pipeline: a pin still shows what the derivation said', overriddenPipeline.includes('推导结果是 实现'), overriddenPipeline)
check('pipeline: the unpin control appears once pinned', overriddenPipeline.includes('恢复自动推导'))

const bypassPipeline = renderText(
  seam.StagePipeline({ stage: { ...stageFixture, bypass: [{ skill: 'wayfinder', code: 'too-many-open-tickets', note: '30 open tickets is at or above the 12-ticket threshold' }] }, t: zhT, onOverride: () => {} }),
).join(' | ')
check('pipeline: a bypass suggestion names its skill and its reason', bypassPipeline.includes('旁路建议') && bypassPipeline.includes('wayfinder') && bypassPipeline.includes('12-ticket threshold'))

check('pipeline: loading shows before the first answer', renderText(seam.StagePipeline({ stage: null, t: zhT })).join(' ').includes('正在读取'))
check('stage labels: a known id is localised', seam.stageLabel('implement', zhT) === '实现', seam.stageLabel('implement', zhT))
check('stage labels: an unknown id falls back to itself rather than blank', seam.stageLabel('mystery', zhT) === 'mystery')
check('stage labels: every step has a key in both dictionaries', Object.values(seam.STAGE_LABEL_KEYS).every((key) => key in seam.dicts.zh && key in seam.dicts.en))

const rowWithStage = renderText(seam.ProjectRow({ project: { ...fixtureProjects[0], stage: { id: 'implement', overridden: false } }, t: zhT })).join(' | ')
check('project row: the badge shows the derived stage', rowWithStage.includes('实现'), rowWithStage)
const rowPinned = renderText(seam.ProjectRow({ project: { ...fixtureProjects[0], stage: { id: 'pr', overridden: true } }, t: zhT })).join(' | ')
check('project row: a pinned stage still renders its label', rowPinned.includes('提 PR'))

// Dispatch confirmation: what would be sent, to where, and how.
/**
 * Collect every host element of one type from a stub element tree.
 *
 * `renderText` only reports strings; a textarea's value and a button's disabled
 * flag are props, so they need their own walk.
 *
 * @param node - an element returned by the stub `createElement`.
 * @param type - the host element name to collect.
 * @returns every matching element.
 */
function findNodes(node, type) {
  const found = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current === 'boolean') return
    if (typeof current === 'string' || typeof current === 'number') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (typeof current.type === 'function') {
      const props = { ...(current.props ?? {}) }
      if (props.children === undefined && current.children !== undefined) props.children = current.children
      walk(current.type(props))
      return
    }
    if (current.type === type) found.push(current)
    walk(current.props?.children !== undefined ? current.props.children : current.children)
  }
  walk(node)
  return found
}

const dispatchPromptFixture = {
  stage: 'implement',
  skill: 'implement',
  skillPath: '/plugins/skills/implement/SKILL.md',
  subject: 'implement · implement',
  text: 'PROMPT BODY',
  targets: {
    project: { path: '/tmp/demo', title: 'Developer Workbench', workspaceId: 'ws-1' },
    ticket: { id: '7', title: 'Dispatch', url: 'https://example/7' },
    board: { state: 'ready', frontier: ['7'] },
  },
}
const dispatchProps = {
  prompt: dispatchPromptFixture,
  draft: 'edited draft',
  choice: 'new',
  sessions: [{ sessionId: 'session-aaaa-bbbb-cccc-eeeeeeeeeeee', cwd: '/tmp/demo', running: false }],
  busy: false,
  error: null,
  notice: null,
  t: zhT,
  onDraft: () => {},
  onChoice: () => {},
  onSend: () => {},
  onCopy: () => {},
  onClose: () => {},
}
const dialog = seam.DispatchDialog(dispatchProps)
const dialogText = renderText(dialog).join(' | ')
check('dispatch: the dialog names its stage and skill', dialogText.includes('派发确认') && dialogText.includes('implement'))
check('dispatch: the dialog shows the target project and its path', dialogText.includes('Developer Workbench') && dialogText.includes('/tmp/demo'))
check('dispatch: the dialog shows the target ticket', dialogText.includes('#7') && dialogText.includes('Dispatch'))
check('dispatch: the prompt is editable and holds the current draft', findNodes(dialog, 'textarea')[0]?.props?.value === 'edited draft')
check('dispatch: a new session is offered', dialogText.includes('新建会话'))
check('dispatch: the project\u2019s existing sessions are offered', dialogText.includes('eeeeeeee'), dialogText)
check('dispatch: the three actions are present', dialogText.includes('新建会话并发送') && dialogText.includes('复制提示词') && dialogText.includes('取消'))
check('dispatch: nothing renders without a prompt', seam.DispatchDialog({ prompt: null, t: zhT }) === null)
check('dispatch: sending is labelled while in flight', renderText(seam.DispatchDialog({ ...dispatchProps, busy: true })).join(' ').includes('发送中'))
check('dispatch: a running session is marked as such', renderText(seam.DispatchDialog({ ...dispatchProps, sessions: [{ sessionId: 'session-1-2-3-4-running', cwd: '/tmp/demo', running: true }] })).join(' ').includes('running'))
check('dispatch: no sessions explains why only a new one is offered', renderText(seam.DispatchDialog({ ...dispatchProps, sessions: [] })).join(' ').includes('还没有会话'))
check('dispatch: reusing a session changes the primary action', renderText(seam.DispatchDialog({ ...dispatchProps, choice: 'session-aaaa-bbbb-cccc-eeeeeeeeeeee' })).join(' ').includes('在已有会话发送'))
const failedDialog = renderText(seam.DispatchDialog({ ...dispatchProps, error: 'boom' })).join(' | ')
check('dispatch: a failed send keeps the dialog and shows the reason', failedDialog.includes('派发失败') && failedDialog.includes('boom'))
check('dispatch: a copied prompt is acknowledged', renderText(seam.DispatchDialog({ ...dispatchProps, notice: '已复制到剪贴板' })).join(' ').includes('已复制'))
check('dispatch: a session id is shortened, never invented', seam.shortSessionId('session-aa-bb-cc-1234567890abcdef') === '12345678', seam.shortSessionId('session-aa-bb-cc-1234567890abcdef'))
check('remote failures: a message is used verbatim', seam.describeRemoteFailure({ ok: false, error: { message: 'nope' } }, 'fallback') === 'nope')
check('remote failures: a code alone still reads as a failure', seam.describeRemoteFailure({ ok: false, error: { code: 'E_DENIED' } }, 'fallback').includes('E_DENIED'))
check('remote failures: an empty failure is still not silence', seam.describeRemoteFailure({ ok: false }, 'fallback') === 'fallback')

const pipelineWithDispatch = renderText(seam.StagePipeline({ stage: stageFixture, t: zhT, onOverride: () => {}, onDispatch: () => {} })).join(' | ')
check('pipeline: the dispatch button names the skill it will run', pipelineWithDispatch.includes('派发 · implement'), pipelineWithDispatch.slice(0, 200))
check('pipeline: no dispatch button when the container offers none', renderText(seam.StagePipeline({ stage: stageFixture, t: zhT, onOverride: () => {} })).join(' | ').includes('派发') === false)

// The dispatch sequence itself, with the side effects stubbed. This is the part
// that would stay invisible until it broke in front of a user.
const dispatchCalls = []
const sentSession = await seam.performDispatch(
  {
    createSession: async (project) => {
      dispatchCalls.push(`create:${project.workspaceId ?? project.path}`)
      return 'session-new'
    },
    sendPrompt: async (sessionId, text) => {
      dispatchCalls.push(`send:${sessionId}:${text}`)
    },
    openSession: (sessionId) => {
      dispatchCalls.push(`open:${sessionId}`)
    },
  },
  { text: 'hello', choice: 'new', project: { workspaceId: 'ws-1', path: '/tmp/demo' } },
)
check('dispatch run: a new session is created, sent to, then opened, in that order', sentSession === 'session-new' && dispatchCalls.join(' | ') === 'create:ws-1 | send:session-new:hello | open:session-new', dispatchCalls.join(' | '))

const reuseCalls = []
await seam.performDispatch(
  {
    createSession: async () => {
      reuseCalls.push('create')
      return 'wrong'
    },
    sendPrompt: async (sessionId, text) => {
      reuseCalls.push(`send:${sessionId}:${text}`)
    },
    openSession: (sessionId) => {
      reuseCalls.push(`open:${sessionId}`)
    },
  },
  { text: 'again', choice: 'session-existing', project: {} },
)
check('dispatch run: reusing a session never creates one', reuseCalls.join(' | ') === 'send:session-existing:again | open:session-existing', reuseCalls.join(' | '))

let createFailure = null
try {
  await seam.performDispatch(
    { createSession: async () => { throw new Error('no workspace') }, sendPrompt: async () => {}, openSession: () => {} },
    { text: 'x', choice: 'new', project: {} },
  )
} catch (error) {
  createFailure = error.message
}
check('dispatch run: a failed creation surfaces its reason', createFailure === 'no workspace', String(createFailure))

const afterSendFailure = []
let sendFailure = null
try {
  await seam.performDispatch(
    {
      createSession: async () => 'session-x',
      sendPrompt: async () => {
        afterSendFailure.push('send')
        throw new Error('refused')
      },
      openSession: () => {
        afterSendFailure.push('open')
      },
    },
    { text: 'x', choice: 'new', project: {} },
  )
} catch (error) {
  sendFailure = error.message
}
check('dispatch run: a refused prompt is never followed by navigation', sendFailure === 'refused' && afterSendFailure.join(',') === 'send', afterSendFailure.join(','))

let emptyChoice = null
try {
  await seam.performDispatch({ sendPrompt: async () => {} }, { text: 'x', choice: '', project: {} })
} catch (error) {
  emptyChoice = error.message
}
check('dispatch run: an empty session choice is refused', emptyChoice === 'no target session was chosen', String(emptyChoice))

// Both dictionaries must define the same keys, or one language renders raw keys.
const zhKeys = Object.keys(seam.dicts.zh).sort()
const enKeys = Object.keys(seam.dicts.en).sort()
check('zh and en dictionaries define identical key sets', zhKeys.length === enKeys.length && zhKeys.every((key, index) => key === enKeys[index]), `zh=${zhKeys.length} en=${enKeys.length}`)
check('every rendered label is a real dictionary key', ['projects', 'noProjects', 'trackerUnknown', 'noGit', 'skillsTotal'].every((key) => key in seam.dicts.zh && key in seam.dicts.en))

// ── 1c. tickets: parsing and analysis, with no tracker and no network ────────
//
// The board's hard cases are all textual or graphical, not remote: CRLF bodies,
// `None (can start immediately)`, mutual blocks, self-references, and the
// difference between "nothing blocks this" and "I could not find out". Those are
// exercised here through the library, and the live GitHub path is exercised
// separately over HTTP below.

console.log('\ntickets (hermetic)')

/** Build a command runner whose replies are scripted, so no CLI ever runs. */
function makeRunner(replies) {
  const calls = []
  const run = (command, args) => {
    calls.push({ command, args })
    const match = replies.find((entry) => entry.when(command, args))
    if (match === undefined) {
      return { ok: false, code: 1, stdout: '', stderr: `unexpected call: ${command} ${args.join(' ')}`, spawnFailed: false }
    }
    return match.reply
  }
  return { run, calls }
}

const okReply = (stdout) => ({ ok: true, code: 0, stdout, stderr: '', spawnFailed: false })

// CRLF is the real shape of these files on Windows, and an offset-based parser
// silently drops the last line of such a body.
const crlfTicket = '# 01: Wire the board\r\n\r\n**Blocked by:** None (can start immediately)\r\n\r\n**Status:** ready-for-agent\r\n\r\n- [ ] one\r\n- [x] two\r\n'
const parsedLocal = parseLocalIssue(crlfTicket, '01-wire-the-board.md')
check('local parse: CRLF body yields the numbered title', parsedLocal.title === 'Wire the board' && parsedLocal.id === '01', `${parsedLocal.id} / ${parsedLocal.title}`)
check('local parse: "None (can start immediately)" means no blockers', parsedLocal.blockedBy.length === 0, JSON.stringify(parsedLocal.blockedBy))
check('local parse: the Status line is read through emphasis', parsedLocal.status === 'ready-for-agent' && parsedLocal.statusKind === 'open', String(parsedLocal.status))
check('local parse: checkboxes are counted', parsedLocal.acceptance.total === 2 && parsedLocal.acceptance.done === 1, JSON.stringify(parsedLocal.acceptance))
check('local parse: a finished status is recognised', parseLocalIssue('# 02: x\r\n\r\n**Status:** resolved\r\n', '02-x.md').statusKind === 'done')
check('blocker parse: a #-prefixed reference and a bare number both work', parseBlockedBy('**Blocked by:** #3, 02').join(',') === '3,02', parseBlockedBy('**Blocked by:** #3, 02').join(','))
check('blocker parse: an absent line means no blockers', parseBlockedBy('no such line here').length === 0)

check(
  'github remote: https, scp and ssh spellings all parse, and non-GitHub is refused',
  parseGitHubRemote('https://github.com/o/r.git')?.repo === 'r' &&
    parseGitHubRemote('git@github.com:o/r.git')?.repo === 'r' &&
    parseGitHubRemote('git@github.com:o/r')?.owner === 'o' &&
    parseGitHubRemote('https://gitlab.com/o/r.git') === null,
)
check(
  'github issue: a fallback body line is used when edges could not be read',
  parseGitHubIssue({ number: 1, title: 't', state: 'OPEN', body: '**Blocked by:** 7\n' }, null).blockedBy.join(',') === '7',
)

const listReply = JSON.stringify([
  { number: 3, title: 'board', state: 'OPEN', labels: [{ name: 'ready-for-agent' }], url: 'https://x/3', body: '- [x] a\n- [ ] b\n' },
  { number: 6, title: 'stage', state: 'OPEN', labels: [], url: 'https://x/6', body: 'no blockers line\n' },
  { number: 2, title: 'projects', state: 'CLOSED', labels: [], url: 'https://x/2', body: '' },
])
const scripted = makeRunner([
  { when: (command, args) => command === 'gh' && args[0] === 'issue' && args[1] === 'list', reply: okReply(listReply) },
  { when: (command, args) => command === 'gh' && args[0] === 'api' && args[1].endsWith('/issues/6/dependencies/blocked_by'), reply: okReply('3\n') },
  { when: (command, args) => command === 'gh' && args[0] === 'api', reply: okReply('') },
])
const scriptedRead = readGitHubTickets({ run: scripted.run, owner: 'o', repo: 'r' })
check('github read: every issue becomes a ticket', scriptedRead.ok === true && scriptedRead.tickets.length === 3, JSON.stringify(scriptedRead).slice(0, 120))
const blockedTicket = scriptedRead.tickets.find((ticket) => ticket.id === '6')
check('github read: blockers come from native edges, not the body', blockedTicket.blockedBy.join(',') === '3' && blockedTicket.blockedBySource === 'native-edge', JSON.stringify({ blockedBy: blockedTicket.blockedBy, source: blockedTicket.blockedBySource }))
check('github read: acceptance checkboxes are counted from the body', scriptedRead.tickets.find((ticket) => ticket.id === '3').acceptance.done === 1)
check('github read: a closed issue is done', scriptedRead.tickets.find((ticket) => ticket.id === '2').statusKind === 'done')
check('github read: labels become the status text', scriptedRead.tickets.find((ticket) => ticket.id === '3').status === 'ready-for-agent')

const scriptedBoard = analyseBoard(scriptedRead.tickets)
check('analysis: a ticket with an open blocker is not startable', scriptedBoard.tickets.find((ticket) => ticket.id === '6').ready === false && scriptedBoard.frontier.includes('6') === false)
check('analysis: an unblocked open ticket is startable', scriptedBoard.frontier.includes('3') === true, JSON.stringify(scriptedBoard.frontier))
check('analysis: a finished ticket is never offered as startable', scriptedBoard.frontier.includes('2') === false)

const blockedThenOpen = analyseBoard([
  { id: '1', title: 'a', statusKind: 'done', blockedBy: [], edgesRead: true, acceptance: { total: 0, done: 0 } },
  { id: '2', title: 'b', statusKind: 'open', blockedBy: ['1'], edgesRead: true, acceptance: { total: 0, done: 0 } },
])
check('analysis: a finished blocker unlocks its dependent', blockedThenOpen.frontier.join(',') === '2', JSON.stringify(blockedThenOpen.frontier))

const nasty = analyseBoard([
  { id: '1', title: 'a', statusKind: 'open', blockedBy: ['2'], edgesRead: true, acceptance: { total: 0, done: 0 } },
  { id: '2', title: 'b', statusKind: 'open', blockedBy: ['1'], edgesRead: true, acceptance: { total: 0, done: 0 } },
  { id: '3', title: 'c', statusKind: 'open', blockedBy: ['3'], edgesRead: true, acceptance: { total: 0, done: 0 } },
  { id: '4', title: 'd', statusKind: 'open', blockedBy: ['99'], edgesRead: true, acceptance: { total: 0, done: 0 } },
  { id: '5', title: 'e', statusKind: 'open', blockedBy: [], edgesRead: true, acceptance: { total: 0, done: 0 } },
])
check('analysis: a mutual block is a cycle and neither end is startable', nasty.frontier.includes('1') === false && nasty.frontier.includes('2') === false && nasty.problems.some((problem) => problem.code === 'cycle'))
check('analysis: a self-reference is reported, not silently startable', nasty.frontier.includes('3') === false && nasty.problems.some((problem) => problem.code === 'self-blocked'))
check('analysis: an unknown blocker keeps a ticket off the frontier', nasty.frontier.includes('4') === false && nasty.problems.some((problem) => problem.code === 'unknown-blocker'))
check('analysis: the untouched ticket is the only startable one', nasty.frontier.join(',') === '5', JSON.stringify(nasty.frontier))

const failureCases = [
  { label: 'gh is missing', reply: { ok: false, code: null, stdout: '', stderr: '', spawnFailed: true }, expected: 'gh-unavailable' },
  { label: 'gh is not authenticated', reply: { ok: false, code: 1, stdout: '', stderr: 'gh: To get started with GitHub CLI, please run: gh auth login', spawnFailed: false }, expected: 'gh-not-authenticated' },
  { label: 'the network is down', reply: { ok: false, code: 1, stdout: '', stderr: 'dial tcp: lookup github.com: could not resolve host', spawnFailed: false }, expected: 'gh-offline' },
  { label: 'gh answers with something else', reply: { ok: false, code: 1, stdout: '', stderr: 'weird failure', spawnFailed: false }, expected: 'gh-failed' },
]
for (const failure of failureCases) {
  const result = readGitHubTickets({ run: makeRunner([{ when: () => true, reply: failure.reply }]).run, owner: 'o', repo: 'r' })
  check(`github read: "${failure.label}" is named, not swallowed`, result.ok === false && result.code === failure.expected, `${result.code}`)
}
const notJson = readGitHubTickets({ run: makeRunner([{ when: () => true, reply: okReply('total nonsense') }]).run, owner: 'o', repo: 'r' })
check('github read: non-JSON output is refused', notJson.code === 'gh-bad-json', String(notJson.code))

const edgesBroken = readGitHubTickets({
  run: makeRunner([
    { when: (command, args) => args[0] === 'issue', reply: okReply(JSON.stringify([{ number: 1, title: 'a', state: 'OPEN', labels: [], url: '', body: '' }])) },
    { when: (command, args) => args[0] === 'api', reply: { ok: false, code: 1, stdout: '', stderr: 'boom', spawnFailed: false } },
  ]).run,
  owner: 'o',
  repo: 'r',
})
check('github read: an unreadable edge is marked unread, not empty', edgesBroken.tickets[0].edgesRead === false && edgesBroken.tickets[0].blockedBySource === 'unread')
const edgesBrokenBoard = analyseBoard(edgesBroken.tickets)
check('analysis: an unreadable edge is never called startable', edgesBrokenBoard.frontier.length === 0 && edgesBrokenBoard.problems.some((problem) => problem.code === 'edges-unread'))

// ── 1d. stage derivation: a pure function over facts ─────────────────────────

console.log('\nstage derivation (hermetic)')

const trackerFacts = { tracker: { kind: 'local-markdown', label: 'Local markdown', source: 'project-declaration' } }

check('stage: a project with no tracker is at setup', deriveStage({}).stage === 'setup')
check('stage: setup is the only complete thing before it', deriveStage({}).completed.length === 0)
check('stage: a tracker with nothing else is at grill', deriveStage({ ...trackerFacts }).stage === 'grill', deriveStage({ ...trackerFacts }).stage)
check('stage: design docs but no spec is spec, not grill', deriveStage({ ...trackerFacts, adrCount: 2 }).stage === 'spec')
check('stage: a glossary alone also counts as sharpening', deriveStage({ ...trackerFacts, glossaryCount: 1 }).stage === 'spec')
check('stage: a spec with no tickets is the tickets step', deriveStage({ ...trackerFacts, specCount: 1 }).stage === 'tickets')
check('stage: partially done tickets is the implement step', deriveStage({ ...trackerFacts, specCount: 1, ticketTotal: 5, ticketDone: 2, frontierCount: 1 }).stage === 'implement')
check('stage: every ticket done with no review is the review step', deriveStage({ ...trackerFacts, specCount: 1, ticketTotal: 5, ticketDone: 5 }).stage === 'review')
check('stage: a review with no PR is the pr step', deriveStage({ ...trackerFacts, specCount: 1, ticketTotal: 5, ticketDone: 5, reviewCount: 1 }).stage === 'pr')
check('stage: a PR is the retro step', deriveStage({ ...trackerFacts, specCount: 1, ticketTotal: 5, ticketDone: 5, reviewCount: 1, prCount: 1 }).stage === 'retro')

// The inference that makes issue trackers work: `to-tickets` consumes a spec, so
// tickets on the tracker prove the spec step ran even when the spec is not a file
// this project can show.
check('stage: tickets imply a spec even with no spec file', deriveStage({ ...trackerFacts, ticketTotal: 3, ticketDone: 0 }).stage === 'implement', deriveStage({ ...trackerFacts, ticketTotal: 3, ticketDone: 0 }).stage)
check('stage: a spec without a configured tracker is still setup (the missing piece wins)', deriveStage({ specCount: 4, ticketTotal: 9 }).stage === 'setup')

check('stage: completed is every stage before the current one', deriveStage({ ...trackerFacts, specCount: 1 }).completed.join(',') === 'setup,grill,spec', deriveStage({ ...trackerFacts, specCount: 1 }).completed.join(','))
check('stage: every stage names the skill that owns it', STAGES.every((entry) => typeof entry.id === 'string' && typeof entry.skill === 'string') && STAGES.length === 8)

check('stage: the evidence says which stage it decided', deriveStage({ ...trackerFacts, specCount: 1 }).evidence[0].stage === 'tickets')

const overridden = deriveStage({ ...trackerFacts, specCount: 1, override: 'pr' })
check('stage: an override changes the stage', overridden.stage === 'pr')
check('stage: an override keeps the derivation, so both can be shown', overridden.derived === 'tickets', String(overridden.derived))
check('stage: an override is flagged', overridden.overridden === true)
check('stage: an unknown override is ignored rather than accepted', deriveStage({ ...trackerFacts, specCount: 1, override: 'nonsense' }).stage === 'tickets')
check('stage: completed follows the override, not the derivation', overridden.completed.includes('spec') === true && overridden.completed.includes('tickets') === true)

const wayfinder = deriveStage({ ...trackerFacts, specCount: 1, ticketTotal: 30, ticketDone: 2, frontierCount: 20 })
check('stage: a large open workload suggests the wayfinder bypass', wayfinder.bypass.some((entry) => entry.skill === 'wayfinder'), JSON.stringify(wayfinder.bypass))
check('stage: the bypass states the number that triggered it', wayfinder.bypass[0].note.includes('28') && wayfinder.bypass[0].note.includes('12'), wayfinder.bypass[0].note)
check('stage: a small workload suggests no bypass', deriveStage({ ...trackerFacts, specCount: 1, ticketTotal: 3, ticketDone: 1 }).bypass.length === 0)
check('stage: the threshold is reported so the rule is inspectable', wayfinder.facts.wayfinderThreshold === 12)
const mapWithoutTickets = deriveStage({ ...trackerFacts, planCount: 1 })
check('stage: a planning map with no tickets points at cutting tickets', mapWithoutTickets.bypass.some((entry) => entry.skill === 'to-tickets'), JSON.stringify(mapWithoutTickets.bypass))
check('stage: a map counts as spec-shaped progress, not as grill', deriveStage({ ...trackerFacts, planCount: 1 }).stage === 'tickets', deriveStage({ ...trackerFacts, planCount: 1 }).stage)

// ── 1e. dispatch prompts: what a session would actually receive ──────────────

console.log('\ndispatch prompts (hermetic)')

const BUNDLED_SKILLS = path.join(PLUGIN_DIR, 'skills')
const stageEntry = new Map(STAGES.map((entry) => [entry.id, entry]))
const asPosix = (target) => target.split(path.sep).join('/')

const ticketsPrompt = buildDispatchPrompt({
  stage: stageEntry.get('tickets'),
  skillsDir: BUNDLED_SKILLS,
  tracker: { kind: 'github', label: 'GitHub Issues', source: 'project-declaration' },
  repository: { owner: 'o', repo: 'r' },
  project: { title: 'Demo', path: '/tmp/demo' },
  triageLabels: DEFAULT_TRIAGE_LABELS,
})
check('prompt: the skill absolute path is always present', ticketsPrompt.text.includes(asPosix(ticketsPrompt.skillPath)), ticketsPrompt.skillPath)
check('prompt: the skill path points at a file that exists', fs.existsSync(ticketsPrompt.skillPath), ticketsPrompt.skillPath)
check('prompt: the skill name is quoted so the tool shortcut can be offered', ticketsPrompt.text.includes('"to-tickets"'))
// 16 of 27 skills set this, and every workflow-gating skill is among them, so the
// fallback sentence is what makes the prompt work at all.
check('prompt: the disable-model-invocation fallback is explained', ticketsPrompt.text.includes('disable-model-invocation'))
check('prompt: the tracker is named with its repository', ticketsPrompt.text.includes('GitHub Issues') && ticketsPrompt.text.includes('o/r'))
check('prompt: the triage vocabulary is listed', DEFAULT_TRIAGE_LABELS.every((label) => ticketsPrompt.text.includes(label)))
check('prompt: the project title and working directory are given', ticketsPrompt.text.includes('Demo') && ticketsPrompt.text.includes('/tmp/demo'))
check('prompt: the report back is specified', ticketsPrompt.text.includes('完成时请回报'))

// The acceptance criterion is per-stage, so check every stage, not a sample.
const everyStageHasItsSkill = STAGES.every((entry) => {
  const built = buildDispatchPrompt({
    stage: entry,
    skillsDir: BUNDLED_SKILLS,
    tracker: { kind: 'local-markdown' },
    project: { title: 'D', path: '/tmp/d' },
  })
  return built.text.includes(asPosix(built.skillPath)) && fs.existsSync(built.skillPath)
})
check('prompt: every stage names a skill file that exists on disk', everyStageHasItsSkill)

const implementPrompt = buildDispatchPrompt({
  stage: stageEntry.get('implement'),
  skillsDir: BUNDLED_SKILLS,
  tracker: { kind: 'github' },
  project: { title: 'D', path: '/tmp/d' },
  ticket: { id: '7', title: 'Dispatch', url: 'https://example/7', openBlockers: [] },
})
check('prompt: the implement step names the target ticket', implementPrompt.text.includes('#7') && implementPrompt.text.includes('Dispatch'))
check('prompt: the implement step links the ticket', implementPrompt.text.includes('https://example/7'))
const noTicket = buildDispatchPrompt({ stage: stageEntry.get('implement'), skillsDir: BUNDLED_SKILLS, tracker: null, project: { title: 'D', path: '/tmp/d' }, ticket: null })
check('prompt: an implement dispatch with no ticket says so instead of pretending', noTicket.text.includes('没有指定工单编号'))
const blockedImplementPrompt = buildDispatchPrompt({ stage: stageEntry.get('implement'), skillsDir: BUNDLED_SKILLS, tracker: null, project: { title: 'D', path: '/tmp/d' }, ticket: { id: '9', title: 'X', openBlockers: ['7'] } })
check('prompt: a still-blocked ticket is flagged inside the prompt', blockedImplementPrompt.text.includes('#7') && blockedImplementPrompt.text.includes('未解除的阻塞'))

const localPrompt = buildDispatchPrompt({ stage: stageEntry.get('tickets'), skillsDir: BUNDLED_SKILLS, tracker: { kind: 'local-markdown' }, project: { title: 'D', path: '/tmp/d' } })
check('prompt: a local-markdown tracker carries its file conventions', localPrompt.text.includes('.scratch/<feature-slug>/issues/'))
const customPrompt = buildDispatchPrompt({ stage: stageEntry.get('tickets'), skillsDir: BUNDLED_SKILLS, tracker: { kind: 'custom' }, project: { title: 'D', path: '/tmp/d' } })
check('prompt: a custom tracker defers to the project declaration', customPrompt.text.includes('docs/agents/issue-tracker.md'))
const noTrackerPrompt = buildDispatchPrompt({ stage: stageEntry.get('tickets'), skillsDir: BUNDLED_SKILLS, tracker: null, project: { title: 'D', path: '/tmp/d' } })
check('prompt: an unresolved tracker is stated, not invented', noTrackerPrompt.text.includes('尚未确定'))

const labelFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wb-labels-'))
check('labels: a project with no declaration gets the canonical five', readTriageLabels(labelFixture).join(',') === DEFAULT_TRIAGE_LABELS.join(','))
fs.mkdirSync(path.join(labelFixture, 'docs', 'agents'), { recursive: true })
fs.writeFileSync(
  path.join(labelFixture, 'docs', 'agents', 'triage-labels.md'),
  ['# Triage Labels', '', '| Label in mattpocock/skills | Label in our tracker | Meaning |', '| --- | --- | --- |', '| `needs-triage` | `bug:triage` | evaluate |', '| `ready-for-agent` | `agent-ready` | go |'].join('\n'),
  'utf8',
)
const declaredLabels = readTriageLabels(labelFixture)
check('labels: the tracker column is read, not the canonical column', declaredLabels.join(',') === 'bug:triage,agent-ready', declaredLabels.join(','))
fs.rmSync(labelFixture, { recursive: true, force: true })

// ── 2. host routes ────────────────────────────────────────────────────────────

/** Directories this run created, removed at the end. */
const FIXTURES = []

/**
 * Create a scratch directory that is cleaned up with the run.
 * @param prefix - mkdtemp prefix.
 * @returns the new directory.
 */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  FIXTURES.push(dir)
  return dir
}

/**
 * Run git in a fixture.
 * @param cwd - fixture directory.
 * @param gitArgs - git arguments.
 * @returns stdout.
 */
function runGit(cwd, gitArgs) {
  return execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Write a `docs/agents/issue-tracker.md` declaring a tracker.
 * @param projectPath - fixture root.
 * @param heading - the text after `Issue tracker:`.
 */
function writeDeclaration(projectPath, heading) {
  const dir = path.join(projectPath, 'docs', 'agents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'issue-tracker.md'),
    `# Issue tracker: ${heading}\n\nIssues live there.\n`,
    'utf8',
  )
}

/**
 * Build a clean git repository with one commit and one uncommitted file.
 * @returns the repository root.
 */
function makeGitFixture() {
  const root = tempDir('dsh-wb-git-')
  runGit(root, ['init', '-q'])
  runGit(root, ['config', 'user.email', 'fixture@local'])
  runGit(root, ['config', 'user.name', 'Fixture'])
  fs.writeFileSync(path.join(root, 'committed.txt'), 'hello\n', 'utf8')
  runGit(root, ['add', '-A'])
  runGit(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial commit'])
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'dirty\n', 'utf8')
  return root
}

if (CLIENT_ONLY) {
  console.log('\nhost routes: skipped (--client-only)')
} else {
  console.log(`\nhost routes @ ${BASE}`)

  /**
   * Fetch JSON, or throw with the status in the message.
   * @param route - path beginning with `/`.
   * @returns the parsed body.
   */
  const getJson = async (route) => {
    const response = await fetch(`${BASE}${route}`, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`${route} -> HTTP ${response.status}`)
    return await response.json()
  }

  /**
   * POST JSON and report the status without throwing.
   * @param route - path beginning with `/`.
   * @param body - JSON payload.
   * @returns the status and parsed body.
   */
  const postJson = async (route, body) => {
    const response = await fetch(`${BASE}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let parsed = null
    try {
      parsed = await response.json()
    } catch (error) {
      parsed = null
    }
    return { status: response.status, body: parsed }
  }

  try {
    // ── identity and the bundled skills ──────────────────────────────────────
    const health = await getJson('/api/developer-workbench/health')
    check('health reports the package dir', typeof health.packageDir === 'string' && health.packageDir.endsWith('plugin'), health.packageDir)
    check('health reports the bundled skills dir', typeof health.skillsDir === 'string' && health.skillsDir.endsWith('skills'), health.skillsDir)
    check('health reports a resolved state dir', typeof health.dataDir?.dir === 'string' && health.dataDir.dir.length > 0, JSON.stringify(health.dataDir))
    check('state dir is not the package fallback', health.dataDir?.source !== 'package', `source=${health.dataDir?.source}`)
    check('health reports the state file', typeof health.stateFile === 'string' && health.stateFile.endsWith('state.json'), health.stateFile)
    check(`health counts ${EXPECTED_TOTAL} skills`, health.skills === EXPECTED_TOTAL, String(health.skills))
    check('health reports no skill problems', health.skillProblems === 0, String(health.skillProblems))

    const skills = await getJson('/api/developer-workbench/skills')
    check(`skills route returns ${EXPECTED_TOTAL} rows`, skills.total === EXPECTED_TOTAL, String(skills.total))
    check(`model-invocable split is ${EXPECTED_MODEL_INVOCABLE}`, skills.modelInvocable === EXPECTED_MODEL_INVOCABLE, String(skills.modelInvocable))
    check('every row carries a kebab-case name', skills.skills.every((row) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(row.name)))
    check('every row carries a description', skills.skills.every((row) => row.description.length > 0))
    check('no row reports a problem', skills.withProblems === 0, String(skills.withProblems))
    check('workflow-gating skills are present', ['to-spec', 'to-tickets', 'handoff', 'wayfinder', 'implement', 'code-review'].every((name) => skills.skills.some((row) => row.name === name)))
    // The CRLF truncation bug dropped the LAST frontmatter key, which is exactly
    // where this flag sits for most upstream skills. Pin it so it cannot regress.
    check('disable-model-invocation is read from the last frontmatter line', skills.skills.find((row) => row.name === 'handoff')?.modelInvocable === false)

    // ── probe: git overview against a real repository ────────────────────────
    const repo = makeGitFixture()
    const repoProbe = await getJson(`/api/developer-workbench/probe?path=${encodeURIComponent(repo)}`)
    check('probe: a real repo reports a work tree', repoProbe.git.ok === true && repoProbe.git.isRepo === true, JSON.stringify(repoProbe.git))
    check('probe: branch is read', typeof repoProbe.git.branch === 'string' && repoProbe.git.branch.length > 0, String(repoProbe.git.branch))
    check('probe: dirty count counts the untracked file', repoProbe.git.dirtyCount === 1, String(repoProbe.git.dirtyCount))
    check('probe: last commit is read', typeof repoProbe.git.lastCommit === 'string' && repoProbe.git.lastCommit.includes('initial commit'), String(repoProbe.git.lastCommit))

    // ── probe: tracker declaration wins ─────────────────────────────────────
    const githubProject = tempDir('dsh-wb-gh-')
    writeDeclaration(githubProject, 'GitHub')
    const githubProbe = await getJson(`/api/developer-workbench/probe?path=${encodeURIComponent(githubProject)}`)
    check('probe: GitHub declaration resolves to the github kind', githubProbe.tracker?.kind === 'github', JSON.stringify(githubProbe.tracker))
    check('probe: the declaration is the source of truth', githubProbe.tracker?.source === 'project-declaration', String(githubProbe.tracker?.source))
    check('probe: the declaration path is reported', githubProbe.declaration.present === true && githubProbe.declaration.path.endsWith('issue-tracker.md'))

    const gitlabProject = tempDir('dsh-wb-gl-')
    writeDeclaration(gitlabProject, 'GitLab')
    const gitlabProbe = await getJson(`/api/developer-workbench/probe?path=${encodeURIComponent(gitlabProject)}`)
    check('probe: GitLab declaration resolves to the gitlab kind', gitlabProbe.tracker?.kind === 'gitlab', String(gitlabProbe.tracker?.kind))

    const localProject = tempDir('dsh-wb-lm-')
    writeDeclaration(localProject, 'Local markdown')
    const localProbe = await getJson(`/api/developer-workbench/probe?path=${encodeURIComponent(localProject)}`)
    check('probe: a local-markdown declaration resolves to local-markdown', localProbe.tracker?.kind === 'local-markdown', String(localProbe.tracker?.kind))

    const customProject = tempDir('dsh-wb-cx-')
    writeDeclaration(customProject, 'Jira, described elsewhere')
    const customProbe = await getJson(`/api/developer-workbench/probe?path=${encodeURIComponent(customProject)}`)
    check('probe: an unrecognised declaration resolves to custom, not to a guess', customProbe.tracker?.kind === 'custom', String(customProbe.tracker?.kind))

    const bareProject = tempDir('dsh-wb-bare-')
    const bareProbe = await getJson(`/api/developer-workbench/probe?path=${encodeURIComponent(bareProject)}`)
    check('probe: an undeclared project resolves to no tracker', bareProbe.tracker === null, JSON.stringify(bareProbe.tracker))
    check('probe: an undeclared project is still a directory', bareProbe.exists === true && bareProbe.isDirectory === true)
    check('probe: a non-repo degrades instead of throwing', bareProbe.git.ok === false && bareProbe.git.reason === 'not-a-git-work-tree', JSON.stringify(bareProbe.git))

    // ── probe: bad input ─────────────────────────────────────────────────────
    const missing = path.join(os.tmpdir(), 'dsh-wb-definitely-absent-9f3a7c')
    const missingProbe = await getJson(`/api/developer-workbench/probe?path=${encodeURIComponent(missing)}`)
    check('probe: an absent path reports exists=false', missingProbe.exists === false && missingProbe.isDirectory === false)
    check('probe: an absent path has no tracker and no git', missingProbe.tracker === null && missingProbe.git.reason === 'not-a-directory')

    const noPath = await fetch(`${BASE}/api/developer-workbench/probe`)
    check('probe: a missing path parameter is a 400', noPath.status === 400, `HTTP ${noPath.status}`)

    // ── artifacts: discovery by convention ───────────────────────────────────
    const artProject = tempDir('dsh-wb-art-')
    fs.mkdirSync(path.join(artProject, 'docs', 'adr'), { recursive: true })
    fs.writeFileSync(path.join(artProject, 'docs', 'adr', '0001-first.md'), '# 0001\n\nA decision.\n', 'utf8')
    fs.mkdirSync(path.join(artProject, 'docs', 'specs'), { recursive: true })
    fs.writeFileSync(path.join(artProject, 'docs', 'specs', 'thing.md'), '# Spec\n', 'utf8')
    fs.writeFileSync(path.join(artProject, 'GLOSSARY.md'), '# Glossary\n\nA term.\n', 'utf8')
    fs.mkdirSync(path.join(artProject, '.scratch', 'feat'), { recursive: true })
    fs.writeFileSync(path.join(artProject, '.scratch', 'feat', 'spec.md'), '# Local spec\n', 'utf8')
    fs.writeFileSync(path.join(artProject, '.scratch', 'feat', 'map.md'), '# Map\n', 'utf8')

    const artScan = await getJson(`/api/developer-workbench/artifacts?path=${encodeURIComponent(artProject)}`)
    const groupIds = artScan.groups.map((group) => group.id)
    check('artifacts: groups are discovered by convention', groupIds.includes('spec') && groupIds.includes('adr') && groupIds.includes('glossary'), JSON.stringify(groupIds))
    check('artifacts: no handoff group while none is recorded', groupIds.includes('handoff') === false, JSON.stringify(groupIds))
    const specNames = artScan.groups.find((group) => group.id === 'spec').items.map((item) => item.name)
    // The local-markdown tracker keeps its spec and its wayfinder map under .scratch.
    check('artifacts: the .scratch spec and map are both found', specNames.includes('.scratch/feat/spec.md') && specNames.includes('.scratch/feat/map.md'), JSON.stringify(specNames))
    check('artifacts: docs/specs is found too', specNames.includes('docs/specs/thing.md'), JSON.stringify(specNames))
    check('artifacts: every item carries name, bytes and mtime', artScan.groups.every((group) => group.items.every((item) => typeof item.name === 'string' && typeof item.bytes === 'number' && typeof item.mtime === 'string')))

    const emptyProject = tempDir('dsh-wb-empty-')
    const emptyScan = await getJson(`/api/developer-workbench/artifacts?path=${encodeURIComponent(emptyProject)}`)
    check('artifacts: an empty project yields no groups at all', emptyScan.groups.length === 0, String(emptyScan.groups.length))
    const absentScan = await getJson(`/api/developer-workbench/artifacts?path=${encodeURIComponent(missing)}`)
    check('artifacts: an absent project yields no groups instead of failing', absentScan.groups.length === 0)

    const noPathArtifacts = await fetch(`${BASE}/api/developer-workbench/artifacts`)
    check('artifacts: a missing path parameter is a 400', noPathArtifacts.status === 400, `HTTP ${noPathArtifacts.status}`)

    // ── artifacts: read-only preview ─────────────────────────────────────────
    const smallFile = path.join(artProject, 'docs', 'adr', '0001-first.md')
    const preview = await getJson(`/api/developer-workbench/artifact?path=${encodeURIComponent(smallFile)}`)
    check('artifact preview: returns the file body', preview.ok === true && preview.lines.join('\n').includes('A decision.'), JSON.stringify(preview.lines))
    check('artifact preview: reports that nothing follows', preview.hasMore === false && typeof preview.totalLines === 'number', JSON.stringify({ hasMore: preview.hasMore, total: preview.totalLines }))

    const longFile = path.join(artProject, 'long.md')
    fs.writeFileSync(longFile, Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join('\n'), 'utf8')
    const firstPage = await getJson(`/api/developer-workbench/artifact?path=${encodeURIComponent(longFile)}&limit=10&offset=0`)
    check('artifact preview: pages instead of truncating silently', firstPage.lines.length === 10 && firstPage.hasMore === true && firstPage.totalLines === 50, JSON.stringify({ lines: firstPage.lines.length, hasMore: firstPage.hasMore, total: firstPage.totalLines }))
    const laterPage = await getJson(`/api/developer-workbench/artifact?path=${encodeURIComponent(longFile)}&limit=10&offset=40`)
    check('artifact preview: a later page is the requested window', laterPage.lines[0] === 'line 41' && laterPage.hasMore === false, String(laterPage.lines[0]))

    const binaryFile = path.join(artProject, 'blob.bin')
    fs.writeFileSync(binaryFile, Buffer.from([0x00, 0x01, 0x02, 0x00]))
    const binaryResponse = await fetch(`${BASE}/api/developer-workbench/artifact?path=${encodeURIComponent(binaryFile)}`)
    const binaryBody = await binaryResponse.json()
    check('artifact preview: binary is refused with a reason', binaryResponse.status === 415 && binaryBody.code === 'binary', `HTTP ${binaryResponse.status} ${binaryBody.code}`)

    const badUtf8 = path.join(artProject, 'bad.md')
    fs.writeFileSync(badUtf8, Buffer.from([0xff, 0xfe, 0xfd]))
    const badResponse = await fetch(`${BASE}/api/developer-workbench/artifact?path=${encodeURIComponent(badUtf8)}`)
    const badBody = await badResponse.json()
    check('artifact preview: invalid UTF-8 is refused, never mojibake', badResponse.status === 415 && badBody.code === 'not-utf8', `HTTP ${badResponse.status} ${badBody.code}`)

    const absentResponse = await fetch(`${BASE}/api/developer-workbench/artifact?path=${encodeURIComponent(missing)}`)
    const absentBody = await absentResponse.json()
    check('artifact preview: a missing file is a 404 with a reason', absentResponse.status === 404 && absentBody.code === 'missing', `HTTP ${absentResponse.status} ${absentBody.code}`)

    const hugeFile = path.join(artProject, 'huge.md')
    fs.writeFileSync(hugeFile, 'x'.repeat(600 * 1024), 'utf8')
    const hugeResponse = await fetch(`${BASE}/api/developer-workbench/artifact?path=${encodeURIComponent(hugeFile)}`)
    const hugeBody = await hugeResponse.json()
    check('artifact preview: an oversized file is refused, never silently cut', hugeResponse.status === 413 && hugeBody.code === 'too-large' && hugeBody.maxFileBytes === 512 * 1024, `HTTP ${hugeResponse.status} ${hugeBody.code}`)

    // ── tickets: the board over HTTP ─────────────────────────────────────────
    const boardProject = tempDir('dsh-wb-board-')
    writeDeclaration(boardProject, 'Local markdown')
    fs.mkdirSync(path.join(boardProject, '.scratch', 'feat', 'issues'), { recursive: true })
    fs.writeFileSync(path.join(boardProject, '.scratch', 'feat', 'issues', '01-first.md'), '# 01: First\r\n\r\n**Blocked by:** None (can start immediately)\r\n\r\n**Status:** ready-for-agent\r\n\r\n- [ ] a\r\n- [ ] b\r\n', 'utf8')
    fs.writeFileSync(path.join(boardProject, '.scratch', 'feat', 'issues', '02-second.md'), '# 02: Second\r\n\r\n**Blocked by:** 01\r\n\r\n**Status:** ready-for-agent\r\n\r\n- [x] a\r\n', 'utf8')

    const localBoard = await getJson(`/api/developer-workbench/tickets?path=${encodeURIComponent(boardProject)}`)
    check('board: a local-markdown project reads its tickets', localBoard.state === 'ready' && localBoard.tickets.length === 2, `${localBoard.state} / ${localBoard.tickets.length}`)
    check('board: a CRLF ticket body parses', localBoard.tickets.find((ticket) => ticket.id === '01')?.title === 'First', String(localBoard.tickets.find((ticket) => ticket.id === '01')?.title))
    check('board: only the unblocked ticket is on the frontier', localBoard.frontier.join(',') === '01', JSON.stringify(localBoard.frontier))
    check('board: a blocked ticket names its blocker', localBoard.tickets.find((ticket) => ticket.id === '02')?.openBlockers.join(',') === '01')
    check('board: acceptance progress travels with the ticket', localBoard.tickets.find((ticket) => ticket.id === '02')?.acceptance.done === 1)

    const undeclaredProject = tempDir('dsh-wb-undeclared-')
    const needsTracker = await getJson(`/api/developer-workbench/tickets?path=${encodeURIComponent(undeclaredProject)}`)
    check('board: an undecided tracker asks for initialization, not an empty board', needsTracker.state === 'needs-tracker' && needsTracker.tracker === null, String(needsTracker.state))

    const gitlabBoard = tempDir('dsh-wb-glab-board-')
    writeDeclaration(gitlabBoard, 'GitLab')
    const unsupportedBoard = await getJson(`/api/developer-workbench/tickets?path=${encodeURIComponent(gitlabBoard)}`)
    check('board: a tracker with no adapter is its own state', unsupportedBoard.state === 'unsupported' && unsupportedBoard.reason?.code === 'adapter-missing', `${unsupportedBoard.state}/${unsupportedBoard.reason?.code}`)

    const noPathTickets = await fetch(`${BASE}/api/developer-workbench/tickets`)
    check('board: a missing path parameter is a 400', noPathTickets.status === 400, `HTTP ${noPathTickets.status}`)

    // Live board on this very repository. An environment failure is reported as a
    // skip; anything else is a failure, because "could not read" must never be
    // mistaken for "nothing is blocked".
    const liveBoard = await getJson(`/api/developer-workbench/tickets?path=${encodeURIComponent(path.resolve(HERE, '..', '..'))}`)
    const environmentCodes = ['gh-unavailable', 'gh-not-authenticated', 'gh-offline', 'no-github-remote']
    if (liveBoard.state === 'ready') {
      check('board: the live GitHub board reads this repository', liveBoard.tickets.length > 0 && liveBoard.repository?.repo === 'DSH-Developer-Workbench', JSON.stringify(liveBoard.repository))
      const liveIssue6 = liveBoard.tickets.find((ticket) => ticket.id === '6')
      check('board: the live native edge #6 blocked_by #3 reaches the ticket', liveIssue6?.blockedBy.includes('3') === true && liveIssue6?.blockedBySource === 'native-edge', JSON.stringify({ blockedBy: liveIssue6?.blockedBy, source: liveIssue6?.blockedBySource }))
      check('board: every live ticket carries id, title and acceptance', liveBoard.tickets.every((ticket) => typeof ticket.id === 'string' && ticket.id.length > 0 && typeof ticket.title === 'string' && typeof ticket.acceptance?.total === 'number'))
      check('board: the unblocked spec issue is on the live frontier', liveBoard.frontier.includes('1') === true, JSON.stringify(liveBoard.frontier))
    } else if (environmentCodes.includes(liveBoard.reason?.code)) {
      console.log(`  skip live GitHub board: ${liveBoard.reason.code} — ${liveBoard.reason.message}`)
    } else {
      check('board: the live GitHub board is readable', false, JSON.stringify(liveBoard.reason ?? liveBoard.state))
    }

    // ── stage: derivation over HTTP, and the persisted badge ─────────────────
    const stageProject = tempDir('dsh-wb-stage-')
    writeDeclaration(stageProject, 'Local markdown')
    fs.mkdirSync(path.join(stageProject, '.scratch', 'feat', 'issues'), { recursive: true })
    const stageUrl = (target) => `/api/developer-workbench/stage?path=${encodeURIComponent(target)}`

    const freshStage = await getJson(stageUrl(stageProject))
    check('stage: a tracked project with nothing in it is at grill', freshStage.stage === 'grill', String(freshStage.stage))
    check('stage: the whole pipeline is returned', Array.isArray(freshStage.stages) && freshStage.stages.length === 8, String(freshStage.stages?.length))
    check('stage: every step names the skill that owns it', freshStage.stages.every((entry) => typeof entry.skill === 'string'))

    fs.writeFileSync(path.join(stageProject, '.scratch', 'feat', 'spec.md'), '# Spec\n', 'utf8')
    const afterSpec = await getJson(stageUrl(stageProject))
    check('stage: adding a spec advances to tickets', afterSpec.stage === 'tickets', String(afterSpec.stage))
    check('stage: the evidence names why', afterSpec.evidence[0]?.code === 'spec-without-tickets', String(afterSpec.evidence[0]?.code))

    fs.writeFileSync(path.join(stageProject, '.scratch', 'feat', 'issues', '01-a.md'), '# 01: A\r\n\r\n**Status:** ready-for-agent\r\n\r\n- [ ] x\r\n', 'utf8')
    const afterTicket = await getJson(stageUrl(stageProject))
    check('stage: adding a ticket advances to implement', afterTicket.stage === 'implement', String(afterTicket.stage))
    check('stage: the frontier count reaches the derivation facts', afterTicket.facts.frontierCount === 1, String(afterTicket.facts.frontierCount))

    fs.writeFileSync(path.join(stageProject, '.scratch', 'feat', 'issues', '01-a.md'), '# 01: A\r\n\r\n**Status:** resolved\r\n\r\n- [x] x\r\n', 'utf8')
    const afterDone = await getJson(stageUrl(stageProject))
    check('stage: finishing every ticket advances to review', afterDone.stage === 'review', String(afterDone.stage))

    // Persistence is what lets the left column show a stage without re-reading
    // every tracker on every overview request.
    const stateFile = (await getJson('/api/developer-workbench/health')).stateFile
    const persistedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    const persistedEntry = Object.values(persistedState.projects).find((row) => row.path === stageProject)
    check('stage: the derived stage is persisted for the cheap badge', persistedEntry?.stage?.id === 'review', JSON.stringify(persistedEntry?.stage))
    check('stage: a derived stage is not recorded as a manual override', persistedEntry?.stage?.overridden === false)

    const undeclaredStage = tempDir('dsh-wb-stage-none-')
    const setupStage = await getJson(stageUrl(undeclaredStage))
    check('stage: an undeclared project is at setup', setupStage.stage === 'setup', String(setupStage.stage))
    check('stage: setup says no tracker is declared', setupStage.evidence[0]?.code === 'no-tracker')

    const noPathStage = await fetch(`${BASE}/api/developer-workbench/stage`)
    check('stage: a missing path parameter is a 400', noPathStage.status === 400, `HTTP ${noPathStage.status}`)

    // The pin round-trip: a pin must never replace the derivation, only sit over it.
    const pinned = await postJson('/api/developer-workbench/projects/stage', { path: stageProject, stage: 'pr' })
    check('stage pin: a valid stage is accepted', pinned.status === 200 && pinned.body?.stageOverride === 'pr', `HTTP ${pinned.status}`)
    const afterPin = await getJson(stageUrl(stageProject))
    check('stage pin: the derivation keeps running beside the pin', afterPin.stage === 'pr' && afterPin.derived === 'review' && afterPin.overridden === true, JSON.stringify({ stage: afterPin.stage, derived: afterPin.derived, overridden: afterPin.overridden }))
    const pinnedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    const pinnedEntry = Object.values(pinnedState.projects).find((row) => row.path === stageProject)
    check('stage pin: the persisted badge records the override', pinnedEntry?.stage?.id === 'pr' && pinnedEntry?.stage?.overridden === true, JSON.stringify(pinnedEntry?.stage))
    const badPin = await postJson('/api/developer-workbench/projects/stage', { path: stageProject, stage: 'nonsense' })
    check('stage pin: an unknown stage is refused with the accepted list', badPin.status === 400 && Array.isArray(badPin.body?.accepted), `HTTP ${badPin.status}`)
    const cleared = await postJson('/api/developer-workbench/projects/stage', { path: stageProject, stage: null })
    check('stage pin: a null stage clears the pin', cleared.status === 200 && cleared.body?.stageOverride === null, `HTTP ${cleared.status}`)
    const afterClear = await getJson(stageUrl(stageProject))
    check('stage pin: clearing returns to the derived stage', afterClear.stage === 'review' && afterClear.overridden === false, JSON.stringify({ stage: afterClear.stage, overridden: afterClear.overridden }))

    // ── prompt: the text a session would actually be sent ────────────────────
    const promptUrl = (target, stage, ticket) =>
      `/api/developer-workbench/prompt?path=${encodeURIComponent(target)}&stage=${stage}${ticket === undefined ? '' : `&ticket=${encodeURIComponent(ticket)}`}`

    const ticketsPromptLive = await getJson(promptUrl(stageProject, 'tickets'))
    check('prompt route: a valid stage returns a prompt', typeof ticketsPromptLive.text === 'string' && ticketsPromptLive.stage === 'tickets', String(ticketsPromptLive.stage))
    check('prompt route: the skill path is absolute and really exists', path.isAbsolute(ticketsPromptLive.skillPath) && fs.existsSync(ticketsPromptLive.skillPath), ticketsPromptLive.skillPath)
    check('prompt route: the text carries that exact path', ticketsPromptLive.text.includes(ticketsPromptLive.skillPath))
    check('prompt route: the tracker convention is spelled out', ticketsPromptLive.text.includes('.scratch/<feature-slug>/issues/'), ticketsPromptLive.text.slice(0, 260))

    fs.writeFileSync(
      path.join(stageProject, 'docs', 'agents', 'triage-labels.md'),
      ['| Label in mattpocock/skills | Label in our tracker | Meaning |', '| --- | --- | --- |', '| `needs-triage` | `bug:triage` | evaluate |'].join('\n'),
      'utf8',
    )
    const labelled = await getJson(promptUrl(stageProject, 'tickets'))
    check('prompt route: triage labels come from the project declaration', labelled.text.includes('bug:triage'), labelled.text.slice(0, 200))

    const badStage = await fetch(`${BASE}${promptUrl(stageProject, 'nope')}`)
    check('prompt route: an unknown stage is a 400', badStage.status === 400, `HTTP ${badStage.status}`)
    const noStage = await fetch(`${BASE}/api/developer-workbench/prompt?path=${encodeURIComponent(stageProject)}`)
    check('prompt route: a missing stage is a 400', noStage.status === 400, `HTTP ${noStage.status}`)

    // Live: this repository at implement, which must name a real startable ticket.
    const livePrompt = await getJson(promptUrl(path.resolve(HERE, '..', '..'), 'implement'))
    if (livePrompt.targets?.board?.state === 'ready') {
      check('prompt route: the live implement prompt names a startable ticket', livePrompt.targets.ticket !== null && livePrompt.text.includes(`#${livePrompt.targets.ticket.id}`), JSON.stringify(livePrompt.targets.ticket))
      check('prompt route: the live prompt names this repository', livePrompt.text.includes('DSH-Developer-Workbench'))
      check('prompt route: the live prompt offers a workspace to create the session in', livePrompt.targets.project.workspaceId !== null || typeof livePrompt.targets.project.path === 'string')
    } else {
      console.log(`  skip live prompt: board state ${livePrompt.targets?.board?.state}`)
    }

    // Live: this repository. Guarded on the board being readable so an offline
    // environment skips rather than failing for the wrong reason.
    const liveStage = await getJson(stageUrl(path.resolve(HERE, '..', '..')))
    if (liveStage.board?.state === 'ready') {
      check('stage: the live repository derives a real stage', ['tickets', 'implement', 'review', 'pr', 'retro'].includes(liveStage.stage), String(liveStage.stage))
      check('stage: the live repository resolves a github tracker', liveStage.tracker?.kind === 'github', String(liveStage.tracker?.kind))
      check('stage: the live derivation sees finished tickets', liveStage.facts.ticketDone > 0, String(liveStage.facts.ticketDone))
    } else {
      console.log(`  skip live stage: board state ${liveStage.board?.state} (${liveStage.board?.reason?.code ?? 'n/a'})`)
    }

    // ── overview ─────────────────────────────────────────────────────────────
    const overview = await getJson('/api/developer-workbench/overview')
    check('overview: returns a project array', Array.isArray(overview.projects), typeof overview.projects)
    check('overview: count matches the workspace count', overview.workspaceCount === overview.projects.length, `${overview.workspaceCount} vs ${overview.projects.length}`)
    check('overview: every row carries the fields the left column needs', overview.projects.every((row) => typeof row.key === 'string' && typeof row.path === 'string' && typeof row.title === 'string' && typeof row.sessionCount === 'number' && row.git !== undefined && 'tracker' in row))
    check('overview: at least one workspace is registered', overview.projects.length > 0, String(overview.projects.length))

    // ── project mutations ────────────────────────────────────────────────────
    const unknownKind = await postJson('/api/developer-workbench/projects/tracker', { path: bareProject, kind: 'jira' })
    check('tracker: an unknown kind is refused with the accepted list', unknownKind.status === 400 && Array.isArray(unknownKind.body?.accepted), `HTTP ${unknownKind.status}`)

    const unboundTracker = await postJson('/api/developer-workbench/projects/tracker', { path: bareProject, kind: 'github' })
    check('tracker: choosing a tracker needs a bound project first', unboundTracker.status === 404, `HTTP ${unboundTracker.status}`)

    // Cross-half consistency: the picker's list must be a subset of what the host
    // accepts, or the UI can offer a choice the host then refuses.
    const kindAcceptance = []
    for (const choice of seam.TRACKER_CHOICES) {
      const result = await postJson('/api/developer-workbench/projects/tracker', { path: bareProject, kind: choice.kind })
      kindAcceptance.push({ kind: choice.kind, status: result.status })
    }
    check('every tracker the picker offers is accepted by the host', kindAcceptance.every((row) => row.status !== 400), JSON.stringify(kindAcceptance))

    const bindMissingPath = await postJson('/api/developer-workbench/projects/bind', { path: missing })
    check('bind: a nonexistent directory is refused', bindMissingPath.status === 400, `HTTP ${bindMissingPath.status}`)

    const unbindUnknown = await postJson('/api/developer-workbench/projects/unbind', { path: bareProject })
    check('unbind: an unbound project is a 404', unbindUnknown.status === 404, `HTTP ${unbindUnknown.status}`)

    const badJson = await fetch(`${BASE}/api/developer-workbench/projects/bind`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    check('bind: a malformed body is a 500, not a crash', badJson.status === 500, `HTTP ${badJson.status}`)
  } catch (error) {
    console.log(`  skip host routes: ${error.message}`)
    console.log('       (start DSH, or pass --base=<url>, to run these)')
  }
}

// ── cleanup ───────────────────────────────────────────────────────────────────

for (const dir of FIXTURES) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    // A leftover temp directory must never fail the run.
  }
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log('')
if (failures.length === 0) {
  console.log(`PASS — ${passed} assertions`)
  process.exit(0)
}
console.log(`FAIL — ${passed} passed, ${failures.length} failed`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
