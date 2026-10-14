/**
 * The workbench's own durable state.
 *
 * This is the **local mapping** the tracker resolution falls back to, plus the
 * per-project facts the user decided (feature slug, stage override, last
 * dispatched session). It lives beside the DSH profile, never inside a project,
 * so a project repository is never written to by the workbench.
 *
 * Writes go through a temporary file and a rename, so an interrupted write
 * cannot leave a half-parsed state file behind.
 *
 * @module lib/state
 */

import fs from 'node:fs'
import path from 'node:path'

/** Bumped when the on-disk shape changes incompatibly. */
const STATE_VERSION = 1

/**
 * Stable key for a project directory.
 *
 * Windows paths compare case-insensitively, so the key folds case there; the
 * original spelling is kept in the record for display.
 *
 * @param projectPath - any spelling of the project directory.
 * @returns the storage key.
 */
export function projectKey(projectPath) {
  const resolved = path.resolve(projectPath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Coerce whatever was on disk into a usable state object.
 * @param raw - the parsed file, or null when absent or corrupt.
 * @returns a valid state object.
 */
function normalise(raw) {
  const projects = raw !== null && typeof raw === 'object' && raw.projects !== null && typeof raw.projects === 'object'
    ? raw.projects
    : {}
  // Settings are global, not per project: they describe the workbench itself.
  const settings = raw !== null && typeof raw === 'object' && raw.settings !== null && typeof raw.settings === 'object'
    ? raw.settings
    : {}
  return { version: STATE_VERSION, settings, projects }
}

/**
 * Open the state store for one directory.
 *
 * The file is read once and cached; every mutator flushes immediately, because
 * losing a tracker decision on an ungraceful shutdown is exactly the kind of
 * silent regression this store exists to prevent.
 *
 * @param dir - absolute directory to keep `state.json` in.
 * @returns the store's operations.
 */
export function createStateStore(dir) {
  const file = path.join(dir, 'state.json')
  let cache = null

  const load = () => {
    if (cache !== null) return cache
    try {
      cache = normalise(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (error) {
      cache = normalise(null)
    }
    return cache
  }

  const flush = () => {
    fs.mkdirSync(dir, { recursive: true })
    const temporary = `${file}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(load(), null, 2), 'utf8')
    fs.renameSync(temporary, file)
  }

  return {
    /** Absolute path of the backing file, for diagnostics. */
    file,
    /** The stored global settings, as written. Normalising is the caller's job. */
    settings() {
      return { ...load().settings }
    },
    /**
     * Merge a settings patch and persist it.
     * @param patch - accepted settings fields.
     * @returns the stored settings.
     */
    saveSettings(patch) {
      const state = load()
      state.settings = { ...state.settings, ...patch }
      flush()
      return { ...state.settings }
    },
    /** Every project record, keyed by {@link projectKey}. */
    all() {
      return load().projects
    },
    /** One project record, or undefined. */
    get(key) {
      return load().projects[key]
    },
    /**
     * Merge a patch into one project record, creating it if needed.
     * @param key - the project key.
     * @param patch - fields to merge.
     * @returns the stored record.
     */
    upsert(key, patch) {
      const state = load()
      const next = { ...(state.projects[key] ?? {}), ...patch }
      state.projects[key] = next
      flush()
      return next
    },
    /**
     * Drop one project record.
     * @param key - the project key.
     * @returns whether a record was removed.
     */
    remove(key) {
      const state = load()
      if (!(key in state.projects)) return false
      delete state.projects[key]
      flush()
      return true
    },
  }
}
