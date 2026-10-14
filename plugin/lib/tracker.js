/**
 * Per-project tracker resolution.
 *
 * **The tracker belongs to the project, not to the workbench.** A single
 * workbench routinely holds projects on different trackers — GitHub here, local
 * markdown there — so nothing in this module may promote one project's choice
 * into a default for any other.
 *
 * Resolution order is fixed and one-directional:
 *
 *   1. the project's own declaration, written per repo by
 *      `setup-matt-pocock-skills` into `docs/agents/issue-tracker.md`;
 *   2. the workbench's own persisted mapping for that project;
 *   3. an explicit caller-supplied fallback.
 *
 * A disagreement between (1) and (2) is surfaced, never silently resolved.
 *
 * @module lib/tracker
 */

import fs from 'node:fs'
import path from 'node:path'

/** The tracker kinds this build can name. Adapters arrive with the board. */
export const TRACKER_KINDS = ['github', 'gitlab', 'local-markdown', 'custom']

/** Human labels for the kinds, used when a declaration gives no usable label. */
export const TRACKER_LABELS = {
  github: 'GitHub Issues',
  gitlab: 'GitLab Issues',
  'local-markdown': 'Local markdown',
  custom: 'Custom workflow',
}

/**
 * Relative location of the per-repo tracker declaration.
 * Kept as a segment list so callers join it with the platform separator.
 */
const DECLARATION_SEGMENTS = ['docs', 'agents', 'issue-tracker.md']

/**
 * Map a declaration's heading label onto a tracker kind.
 * @param label - the text after `Issue tracker:`.
 * @returns the closest known kind.
 */
function classify(label) {
  const lowered = label.toLowerCase()
  if (lowered.includes('github')) return 'github'
  if (lowered.includes('gitlab')) return 'gitlab'
  if (lowered.includes('local') || lowered.includes('markdown')) return 'local-markdown'
  return 'custom'
}

/**
 * Parse one `docs/agents/issue-tracker.md`.
 *
 * The file's first heading is the contract (`# Issue tracker: GitHub`); the PR
 * flag is read because `/triage` uses it. Anything else in the file is prose for
 * the model, not configuration for us.
 *
 * @param text - the declaration file's contents.
 * @returns the declaration, or null when the file does not declare a tracker.
 */
export function parseTrackerDeclaration(text) {
  const heading = /^#\s*Issue tracker:\s*(.+?)\s*$/m.exec(text)
  if (heading === null) return null
  const label = heading[1].trim()
  const prs = /PRs as a request surface:\s*(yes|no)/i.exec(text)
  return {
    kind: classify(label),
    label,
    prsAsRequestSurface: prs !== null && prs[1].toLowerCase() === 'yes',
  }
}

/**
 * Absolute path of a project's tracker declaration.
 * @param projectPath - the project's root directory.
 * @returns the declaration file path.
 */
export function declarationPath(projectPath) {
  return path.join(projectPath, ...DECLARATION_SEGMENTS)
}

/**
 * Resolve one project's tracker.
 *
 * @param options - resolution inputs.
 * @param options.projectPath - the project root to read the declaration from.
 * @param options.mapping - the workbench's persisted choice for this project, if any.
 * @param options.fallback - a caller-supplied last resort, if any.
 * @param options.readFile - reads a file as UTF-8; injectable for tests.
 * @returns the resolution, or null when nothing could decide it.
 */
export function resolveTracker({ projectPath, mapping = null, fallback = null, readFile = defaultReadFile }) {
  const file = declarationPath(projectPath)

  let declaration = null
  try {
    declaration = parseTrackerDeclaration(readFile(file))
  } catch (error) {
    declaration = null
  }

  if (declaration !== null) {
    const mappedKind = mapping?.kind ?? null
    return {
      kind: declaration.kind,
      label: TRACKER_LABELS[declaration.kind] ?? declaration.label,
      declaredLabel: declaration.label,
      source: 'project-declaration',
      declarationPath: file,
      prsAsRequestSurface: declaration.prsAsRequestSurface,
      /** Set when the persisted mapping disagrees: the caller must ask, not guess. */
      conflict: mappedKind !== null && mappedKind !== declaration.kind
        ? { mappedKind, declaredKind: declaration.kind }
        : null,
    }
  }

  if (mapping?.kind) {
    return {
      kind: mapping.kind,
      label: TRACKER_LABELS[mapping.kind] ?? mapping.kind,
      declaredLabel: null,
      source: 'workbench-mapping',
      declarationPath: file,
      prsAsRequestSurface: null,
      conflict: null,
    }
  }

  if (fallback !== null && fallback !== undefined) {
    return { ...fallback, source: 'global-default', declarationPath: file, conflict: null }
  }

  return null
}

/**
 * Default file reader.
 * @param file - absolute path.
 * @returns the file's UTF-8 contents.
 */
function defaultReadFile(file) {
  return fs.readFileSync(file, 'utf8')
}
