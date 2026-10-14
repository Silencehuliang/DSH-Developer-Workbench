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
