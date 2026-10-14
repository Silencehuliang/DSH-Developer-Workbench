/**
 * Project projection.
 *
 * A "project" is an existing DSH workspace — there is deliberately no second
 * registry of projects, because two lists of the same thing is how they drift
 * apart. What the workbench *does* own is the per-project record: the tracker
 * decision and the user's feature/stage state, keyed by canonical directory.
 *
 * @module lib/projects
 */

import fs from 'node:fs'
import path from 'node:path'

import { gitOverview } from './git.js'
import { projectKey } from './state.js'
import { declarationPath, resolveTracker } from './tracker.js'

/** Largest number of session ids one project row carries. */
const SESSION_ID_LIMIT = 200

/**
 * Project a live workspace into the shape the left column renders.
 *
 * @param options - projection inputs.
 * @param options.workspace - a live DSH workspace entity.
 * @param options.state - the workbench state store.
 * @returns the project row.
 */
export async function describeProject({ workspace, state }) {
  const key = projectKey(workspace.path)
  const record = state.get(key) ?? null

  let directoryStatus = 'unknown'
  try {
    directoryStatus = await workspace.status()
  } catch (error) {
    directoryStatus = 'unknown'
  }

  const tracker = resolveTracker({ projectPath: workspace.path, mapping: record?.tracker ?? null })

  return {
    key,
    workspaceId: workspace.id,
    title: workspace.title,
    path: workspace.path,
    /** `missing-dir` means the workspace outlives its directory. */
    directoryStatus,
    sessionCount: workspace.sessionIds.length,
    /**
     * The session ids themselves, so a session-side surface can resolve its
     * project from the overview it already has instead of asking again.
     * Capped: this is a projection, not a ledger.
     */
    sessionIds: workspace.sessionIds.slice(0, SESSION_ID_LIMIT),
    git: gitOverview(workspace.path),
    tracker,
    /** The user's own decisions, kept separate from anything derived. */
    feature: record?.feature ?? null,
    /**
     * The last derived stage, persisted by `/stage` so the left column can show
     * one without re-reading every tracker on every overview request. Null until
     * the project has been opened at least once.
     */
    stage: record?.stage ?? null,
    stageOverride: record?.stageOverride ?? null,
    neverDispatched: record?.lastSessionId === undefined || record.lastSessionId === null,
  }
}

/**
 * Inspect an arbitrary directory before — or without — binding it.
 *
 * This is the one route that takes a path rather than a workspace, which makes
 * it both the bind flow's preview and the seam every filesystem-facing
 * assertion goes through.
 *
 * @param options - probe inputs.
 * @param options.target - directory to inspect.
 * @param options.mapping - the persisted tracker choice for that directory, if any.
 * @param options.readFile - injectable file reader.
 * @param options.runGit - injectable git reader.
 * @returns the probe result.
 */
export function probeDirectory({ target, mapping = null, readFile = undefined, runGit = gitOverview }) {
  const resolved = path.resolve(target)

  let stats = null
  try {
    stats = fs.statSync(resolved)
  } catch (error) {
    stats = null
  }

  const exists = stats !== null
  const isDirectory = stats !== null && stats.isDirectory()
  const declaration = declarationPath(resolved)
  let declarationPresent = false
  try {
    declarationPresent = fs.statSync(declaration).isFile()
  } catch (error) {
    declarationPresent = false
  }

  return {
    path: resolved,
    key: projectKey(resolved),
    exists,
    isDirectory,
    declaration: { path: declaration, present: declarationPresent },
    tracker: isDirectory ? resolveTracker({ projectPath: resolved, mapping, readFile }) : null,
    git: isDirectory
      ? runGit(resolved)
      : { ok: false, isRepo: false, reason: 'not-a-directory', reasonDetail: null },
    mapping: mapping === null ? null : mapping,
  }
}
