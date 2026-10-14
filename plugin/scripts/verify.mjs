/**
 * P0 acceptance test for dsh-developer-workbench.
 *
 * Two independent halves, both runnable without a browser:
 *
 *   1. **Client bundle** — loads `client.js` against a stub `window` and a stub
 *      React, materialises the factory, runs `apply` against a fake context, and
 *      asserts the registrations. This catches the wiring that decides WHERE the
 *      entry lands, which is the whole point of P0.
 *   2. **Host routes** — asserts the live HTTP API of a running DSH. Skipped with
 *      a clear notice when the server is not reachable, so the script still
 *      proves something useful offline.
 *
 * Usage:
 *   node scripts/verify.mjs                    # client assertions + live routes
 *   node scripts/verify.mjs --base=http://127.0.0.1:19387
 *   node scripts/verify.mjs --client-only
 *
 * Exit code 0 means every executed assertion passed.
 */

import fs from 'node:fs'
import path from 'node:path'
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
 * @returns captured plugin exports and every registration it made.
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

if (CLIENT_ONLY) {
  console.log('\nhost routes: skipped (--client-only)')
} else {
  console.log(`\nhost routes @ ${BASE}`)

  /** Fetch JSON, or throw with the status in the message. */
  const getJson = async (route) => {
    const response = await fetch(`${BASE}${route}`, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`${route} -> HTTP ${response.status}`)
    return await response.json()
  }

  try {
    const health = await getJson('/api/developer-workbench/health')
    check('health reports the package dir', typeof health.packageDir === 'string' && health.packageDir.endsWith('plugin'), health.packageDir)
    check('health reports the bundled skills dir', typeof health.skillsDir === 'string' && health.skillsDir.endsWith('skills'), health.skillsDir)
    check('health reports a resolved state dir', typeof health.dataDir?.dir === 'string' && health.dataDir.dir.length > 0, JSON.stringify(health.dataDir))
    check('state dir is not the package fallback', health.dataDir?.source !== 'package', `source=${health.dataDir?.source}`)
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
  } catch (error) {
    console.log(`  skip host routes: ${error.message}`)
    console.log('       (start DSH, or pass --base=<url>, to run these)')
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
