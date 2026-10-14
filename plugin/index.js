/**
 * dsh-developer-workbench — host half.
 *
 * Thin on purpose: this module resolves where the plugin lives and where its
 * state goes, then hands the whole HTTP surface to `lib/routes.js`. Every piece
 * of behaviour lives in `lib/`, reachable through the routes, so the host side
 * has exactly one seam to test.
 *
 * No third-party dependency is used here: this half touches only `ctx`,
 * `node:*`, and its own files, so it needs no build step and no install.
 *
 * @module index.js
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildRoutes } from './lib/routes.js'
import { createStateStore } from './lib/state.js'

/** Package name; the skill provider row in `cordis.patch.yml` references it. */
export const name = 'developer-workbench'

/**
 * No hard requirement: the workbench is useless without a web carrier, but a
 * composition without one should skip the routes rather than fail the row.
 */
export const inject = []

/** Absolute directory of this package, resolved from the module's own URL. */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))
/** Directory holding the bundled Matt Pocock skills. */
const SKILLS_DIR = path.join(PACKAGE_DIR, 'skills')
/** Reported by `/health`; keep in step with package.json. */
const VERSION = '0.1.0'

/**
 * Resolve the state directory.
 *
 * An explicit `dataDir` wins. Otherwise the profile directory is read from the
 * environment the launcher exports; a missing value falls back to `<dshHome>/
 * .developer-workbench`, and only if that is missing too does it stay inside the
 * package, so a misconfigured composition still runs instead of throwing.
 *
 * @param ctx - host context.
 * @param config - the row's config, possibly empty.
 * @returns the absolute directory to keep state in, plus how it was chosen.
 */
function resolveDataDir(ctx, config) {
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configured.length > 0) return { dir: path.resolve(configured), source: 'config' }
  // The host process is not started from the profile directory, so the profile
  // path is not in its environment. HMR knows it: its module-watch base is the
  // profile directory (the profile patch watches "." there).
  const hmrBase = (() => {
    try {
      const hmr = typeof ctx?.get === 'function' ? ctx.get('hmr') : undefined
      return typeof hmr?.baseDir === 'string' && hmr.baseDir.length > 0 ? hmr.baseDir : undefined
    } catch (error) {
      return undefined
    }
  })()
  if (hmrBase !== undefined) return { dir: path.join(hmrBase, '.developer-workbench'), source: 'hmr-base' }
  const profileDir = process.env.DSH_PROFILE_DIR?.trim()
  if (profileDir) return { dir: path.join(profileDir, '.developer-workbench'), source: 'profile' }
  const home = process.env.DSH_HOME?.trim()
  if (home) return { dir: path.join(home, '.developer-workbench'), source: 'dsh-home' }
  return { dir: path.join(PACKAGE_DIR, '.developer-workbench'), source: 'package' }
}

/**
 * Install the plugin: register its routes on the web carrier.
 *
 * @param ctx - host context.
 * @param config - resolved row config (`dataDir`).
 */
export function apply(ctx, config) {
  const dataDir = resolveDataDir(ctx, config)
  const store = createStateStore(dataDir.dir)

  ctx.inject(['webServer'], (webCtx) => {
    const routes = buildRoutes({
      ctx,
      store,
      info: {
        name,
        version: VERSION,
        packageDir: PACKAGE_DIR,
        skillsDir: SKILLS_DIR,
        dataDir,
      },
    })
    for (const route of routes) {
      webCtx.effect(
        () => webCtx.webServer.register(route),
        `developer-workbench: route ${route.path}`,
      )
    }
  })
}
