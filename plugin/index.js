/**
 * dsh-developer-workbench — host half.
 *
 * P0 scope: prove the wiring end to end.
 *
 *   - `GET /api/developer-workbench/health` reports where the plugin resolved
 *     its own files, its state directory, and how many skills it ships.
 *   - `GET /api/developer-workbench/skills` is the first slice of the skill
 *     self-check: every skill bundled in `skills/`, parsed from its frontmatter,
 *     with the invocation flags DSH's own provider honours and any problem that
 *     would make it skip the skill.
 *
 * No third-party dependency is used on purpose: this half only touches `ctx`,
 * `node:*`, and its own files, so it needs no build step and no install.
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package name, used by the skill provider row in `cordis.patch.yml`. */
export const name = 'developer-workbench'

/**
 * No hard requirement: the workbench is useless without a web carrier, but a
 * composition without one should skip the routes rather than fail the row.
 * The routes are registered in a nested fiber below.
 */
export const inject = []

/** Absolute directory of this package, resolved from the module's own URL. */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))
/** Directory holding the bundled Matt Pocock skills. */
const SKILLS_DIR = path.join(PACKAGE_DIR, 'skills')
/** Base path of every route this plugin owns. */
const ROUTE_BASE = '/api/developer-workbench'

/** Frontmatter scalars DSH's skill provider accepts as boolean true. */
const TRUTHY_FLAGS = new Set(['true', 'yes', 'on', '1'])
/** Frontmatter scalars DSH's skill provider accepts as boolean false. */
const FALSY_FLAGS = new Set(['false', 'no', 'off', '0'])
/** Kebab-case, the only shape DSH accepts for a skill name. */
const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Send one JSON response.
 * @param res - the response to own and finish.
 * @param status - HTTP status code.
 * @param body - JSON-serialisable payload.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/**
 * Read one frontmatter boolean the way DSH's skill provider does.
 *
 * The documented grammar is a YAML boolean plus the case-insensitive
 * `true/false`, `yes/no`, `on/off`, and `1/0` spellings. A rejected spelling or
 * a non-boolean makes the provider drop the whole skill, so this reports the
 * rejection instead of guessing.
 *
 * @param value - the raw scalar, or undefined when the key is absent.
 * @returns `{ accepted, value }`; `value` is undefined when absent or rejected.
 */
function readFlag(value) {
  if (value === undefined) return { accepted: true, value: undefined }
  const normalised = value.trim().toLowerCase()
  if (TRUTHY_FLAGS.has(normalised)) return { accepted: true, value: true }
  if (FALSY_FLAGS.has(normalised)) return { accepted: true, value: false }
  return { accepted: false, value: undefined }
}

/**
 * Parse the leading YAML frontmatter of a SKILL.md into a flat string map.
 *
 * Deliberately minimal: skill frontmatter here is a flat block of scalars, and
 * depending on a YAML parser would cost this package its zero-dependency build.
 *
 * It scans by line rather than by character offset on purpose. These files are
 * CRLF on Windows, and an offset search for the closing delimiter silently
 * truncates the last key — which is exactly where `disable-model-invocation`
 * tends to sit. Line scanning also cannot be fooled by `---` inside a value.
 *
 * @param text - full file contents.
 * @returns parsed keys, or an empty object when there is no frontmatter block.
 */
function parseFrontmatter(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') return {}
  const out = {}
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() === '---') break
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    out[match[1]] = value
  }
  return out
}

/**
 * Read every bundled skill: one directory per skill, `<name>/SKILL.md`.
 *
 * Discovery in DSH is one level deep, which is why the vendored tree is flat
 * rather than mirroring the upstream `engineering/` + `productivity/` layout.
 *
 * @returns one row per skill directory, sorted by name.
 */
function readSkillInventory() {
  let entries
  try {
    entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
  } catch (error) {
    return []
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(SKILLS_DIR, entry.name, 'SKILL.md')
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      rows.push({ dir: entry.name, file, name: entry.name, problems: [`SKILL.md is unreadable: ${String(error?.message ?? error)}`] })
      continue
    }
    const front = parseFrontmatter(text)
    const declaredName = front.name ?? ''
    const modelFlag = readFlag(front['disable-model-invocation'])
    const userFlag = readFlag(front['user-invocable'])
    const problems = []
    if (declaredName.length === 0) problems.push('name is missing')
    else if (!KEBAB_NAME.test(declaredName)) problems.push('name must be kebab-case')
    if ((front.description ?? '').length === 0) problems.push('description is required')
    if (!modelFlag.accepted) problems.push('disable-model-invocation is not a boolean')
    if (!userFlag.accepted) problems.push('user-invocable is not a boolean')
    rows.push({
      dir: entry.name,
      file,
      name: declaredName.length > 0 ? declaredName : entry.name,
      description: front.description ?? '',
      /** `disable-model-invocation: true` keeps a skill out of the `skill` tool's catalog. */
      modelInvocable: modelFlag.value !== true,
      /** `user-invocable: false` keeps a skill out of the human `/name` surface. */
      userInvocable: userFlag.value !== false,
      bytes: Buffer.byteLength(text, 'utf8'),
      /** Non-empty means DSH's provider skips this skill with a warning. */
      problems,
    })
  }
  rows.sort((left, right) => (left.name ?? '').localeCompare(right.name ?? ''))
  return rows
}

/**
 * Resolve the state directory.
 *
 * An explicit `dataDir` wins. Otherwise the profile directory is read from the
 * environment the launcher exports; a missing value falls back to `<dshHome>/
 * .developer-workbench`, and only if that is missing too does it stay inside the
 * package, so a misconfigured composition still runs instead of throwing.
 *
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
 * Install the plugin: register the workbench's routes on the web carrier.
 *
 * @param ctx - host context.
 * @param config - resolved row config (`dataDir`).
 */
export function apply(ctx, config) {
  /** Resolved once: the state directory cannot change while the row is loaded. */
  const stateDir = resolveDataDir(ctx, config)
  ctx.inject(['webServer'], (webCtx) => {
    const routes = [
      {
        kind: 'exact',
        path: `${ROUTE_BASE}/health`,
        handler: (req, res) => {
          const skills = readSkillInventory()
          sendJson(res, 200, {
            name,
            version: '0.1.0',
            packageDir: PACKAGE_DIR,
            skillsDir: SKILLS_DIR,
            dataDir: stateDir,
            pid: process.pid,
            skills: skills.length,
            skillProblems: skills.filter((row) => (row.problems ?? []).length > 0).length,
          })
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_BASE}/skills`,
        handler: (req, res) => {
          const skills = readSkillInventory()
          sendJson(res, 200, {
            total: skills.length,
            modelInvocable: skills.filter((row) => row.modelInvocable).length,
            userInvocable: skills.filter((row) => row.userInvocable).length,
            withProblems: skills.filter((row) => (row.problems ?? []).length > 0).length,
            skills,
          })
        },
      },
    ]
    for (const route of routes) {
      webCtx.effect(
        () => webCtx.webServer.register(route),
        `developer-workbench: route ${route.path}`,
      )
    }
  })
}
