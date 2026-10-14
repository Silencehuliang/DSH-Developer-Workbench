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

// Both dictionaries must define the same keys, or one language renders raw keys.
const zhKeys = Object.keys(seam.dicts.zh).sort()
const enKeys = Object.keys(seam.dicts.en).sort()
check('zh and en dictionaries define identical key sets', zhKeys.length === enKeys.length && zhKeys.every((key, index) => key === enKeys[index]), `zh=${zhKeys.length} en=${enKeys.length}`)
check('every rendered label is a real dictionary key', ['projects', 'noProjects', 'trackerUnknown', 'noGit', 'skillsTotal'].every((key) => key in seam.dicts.zh && key in seam.dicts.en))

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
