/**
 * Project artifacts: discovery and read-only preview.
 *
 * Two jobs, deliberately separated:
 *
 *   - {@link scanArtifacts} answers "what planning documents does this project
 *     have, and where", using the conventions `setup-matt-pocock-skills` writes
 *     into the repo rather than an invented layout.
 *   - {@link readArtifactPreview} answers "show me a page of that file" with
 *     every failure mode named, because a preview that silently truncates reads
 *     as the whole document.
 *
 * Nothing here writes. The workbench never edits a project's documents.
 *
 * @module lib/artifacts
 */

import fs from 'node:fs'
import path from 'node:path'

/** Caps that keep a preview honest: refuse, never silently shorten. */
export const PREVIEW_LIMITS = {
  /** Largest file a preview will open at all. */
  maxFileBytes: 512 * 1024,
  /** Lines returned when the caller does not ask. */
  defaultLines: 400,
  /** Largest page a caller may request. */
  maxLines: 2000,
  /** Directories walked, so a pathological tree cannot hang the request. */
  maxEntries: 2000,
}

/**
 * Is this path an existing regular file?
 * @param target - absolute path.
 * @returns whether it is a file.
 */
function isFile(target) {
  try {
    return fs.statSync(target).isFile()
  } catch (error) {
    return false
  }
}

/**
 * Walk a directory tree collecting files with the given extensions.
 *
 * @param dir - directory to walk.
 * @param extensions - accepted suffixes, lower-case.
 * @param budget - mutable remaining-entry allowance.
 * @param depth - remaining recursion depth.
 * @returns absolute file paths, sorted.
 */
function walk(dir, extensions, budget, depth) {
  if (depth < 0 || budget.left <= 0) return []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (budget.left <= 0) break
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...walk(target, extensions, budget, depth - 1))
      continue
    }
    if (!entry.isFile()) continue
    const lowered = entry.name.toLowerCase()
    if (!extensions.some((extension) => lowered.endsWith(extension))) continue
    budget.left -= 1
    found.push(target)
  }
  return found
}

/**
 * Specs and planning maps this project keeps for a local-file tracker.
 * @param root - project root.
 * @returns absolute paths.
 */
function collectScratchPlans(root) {
  const scratch = path.join(root, '.scratch')
  let entries
  try {
    entries = fs.readdirSync(scratch, { withFileTypes: true })
  } catch (error) {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const name of ['spec.md', 'map.md']) {
      const candidate = path.join(scratch, entry.name, name)
      if (isFile(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * The artifact groups this build knows how to find.
 *
 * The paths come from the tracker/domain conventions in `docs/agents/`, so a
 * project set up by `setup-matt-pocock-skills` needs no extra configuration.
 */
const GROUPS = [
  {
    id: 'spec',
    label: 'Specs and plans',
    collect: (root, budget) => [
      ...walk(path.join(root, 'docs', 'specs'), ['.md'], budget, 3),
      ...collectScratchPlans(root),
    ],
  },
  {
    id: 'adr',
    label: 'ADRs',
    collect: (root, budget) => walk(path.join(root, 'docs', 'adr'), ['.md'], budget, 3),
  },
  {
    id: 'glossary',
    label: 'Glossary',
    collect: (root) => [
      path.join(root, 'GLOSSARY.md'),
      path.join(root, 'GLOSSARY-MAP.md'),
    ].filter(isFile),
  },
]

/**
 * Describe one file for a list row.
 * @param absolute - absolute file path.
 * @param root - project root, used for the display name.
 * @returns the row, or null when the file cannot be read.
 */
function describeItem(absolute, root) {
  let stats
  try {
    stats = fs.statSync(absolute)
  } catch (error) {
    return null
  }
  return {
    name: path.relative(root, absolute).split(path.sep).join('/'),
    path: absolute,
    bytes: stats.size,
    mtime: stats.mtime.toISOString(),
  }
}

/**
 * Find every planning artifact of a project, grouped.
 *
 * Groups with no items are omitted entirely: an empty heading is worse than no
 * heading, and the caller cannot tell "absent" from "broken" otherwise.
 *
 * @param projectPath - project root.
 * @param options - scan inputs.
 * @param options.handoffs - handoff documents the workbench recorded, if any.
 *   Handoffs live in the OS temp directory by the upstream skill's design, so
 *   they cannot be discovered from the project tree.
 * @returns `{ projectPath, groups, scanned }`.
 */
export function scanArtifacts(projectPath, options = {}) {
  const root = path.resolve(projectPath)
  const budget = { left: PREVIEW_LIMITS.maxEntries }
  const groups = []
  let scanned = 0

  for (const group of GROUPS) {
    const items = []
    const seen = new Set()
    for (const absolute of group.collect(root, budget)) {
      if (seen.has(absolute)) continue
      seen.add(absolute)
      const item = describeItem(absolute, root)
      if (item === null) continue
      items.push(item)
    }
    items.sort((left, right) => left.name.localeCompare(right.name))
    scanned += items.length
    if (items.length > 0) groups.push({ id: group.id, label: group.label, items })
  }

  const handoffs = Array.isArray(options.handoffs) ? options.handoffs : []
  const handoffItems = []
  for (const record of handoffs) {
    if (typeof record?.path !== 'string') continue
    const absolute = path.resolve(record.path)
    const item = describeItem(absolute, path.dirname(absolute))
    if (item === null) continue
    handoffItems.push({ ...item, name: path.basename(absolute), createdAt: record.createdAt ?? null, fromState: true })
  }
  if (handoffItems.length > 0) {
    handoffItems.sort((left, right) => String(right.mtime).localeCompare(String(left.mtime)))
    groups.push({ id: 'handoff', label: 'Handoffs', items: handoffItems })
  }

  return { projectPath: root, groups, scanned }
}

/**
 * Read one page of a text artifact.
 *
 * Every refusal names itself, so the UI can say why instead of rendering mojibake
 * or a document that looks complete but is not.
 *
 * @param target - absolute file path.
 * @param options - page inputs.
 * @returns a page result, or a refusal with a `code`.
 */
export function readArtifactPreview(target, options = {}) {
  const absolute = path.resolve(target)
  const maxFileBytes = options.maxFileBytes ?? PREVIEW_LIMITS.maxFileBytes
  const offset = Math.max(0, Number.isInteger(options.offset) ? options.offset : 0)
  const requested = Number.isInteger(options.limit) ? options.limit : PREVIEW_LIMITS.defaultLines
  const limit = Math.min(Math.max(1, requested), PREVIEW_LIMITS.maxLines)

  let stats
  try {
    stats = fs.statSync(absolute)
  } catch (error) {
    return { ok: false, code: 'missing', message: 'the file does not exist', path: absolute }
  }
  if (!stats.isFile()) {
    return { ok: false, code: 'not-a-file', message: 'the path is not a regular file', path: absolute }
  }
  if (stats.size > maxFileBytes) {
    return {
      ok: false,
      code: 'too-large',
      message: `the file is ${stats.size} bytes, above the ${maxFileBytes}-byte preview limit`,
      path: absolute,
      bytes: stats.size,
      maxFileBytes,
    }
  }

  const buffer = fs.readFileSync(absolute)
  if (buffer.includes(0)) {
    return { ok: false, code: 'binary', message: 'the file looks binary: it contains a NUL byte', path: absolute, bytes: stats.size }
  }

  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error) {
    return { ok: false, code: 'not-utf8', message: 'the file is not valid UTF-8', path: absolute, bytes: stats.size }
  }

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const page = lines.slice(offset, offset + limit)

  return {
    ok: true,
    path: absolute,
    bytes: stats.size,
    mtime: stats.mtime.toISOString(),
    offset,
    limit,
    totalLines: lines.length,
    hasMore: offset + limit < lines.length,
    lines: page,
  }
}
