/**
 * Where handoff documents live.
 *
 * The upstream `handoff` skill says: write to the operating system's temporary
 * directory, **not** the workspace, and it does not prescribe a file name. That
 * leaves the workbench unable to list or link the document afterwards — it would
 * have to guess by scanning the temp directory.
 *
 * So the workbench chooses the path and puts it in the prompt. The document stays
 * in the temp directory exactly as the skill requires; only the name becomes
 * deterministic, which is what makes "继续这个交接" possible at all.
 *
 * @module lib/handoffs
 */

import os from 'node:os'
import path from 'node:path'

/**
 * A filesystem-safe slug for one project.
 * @param projectPath - the project root.
 * @returns the slug, never empty.
 */
export function projectSlug(projectPath) {
  const base = path.basename(path.resolve(projectPath))
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug.length > 0 ? slug : 'project'
}

/**
 * The temporary directory one project's handoffs live in.
 * @param projectPath - the project root.
 * @param tempDir - the OS temp directory; injectable for tests.
 * @returns the absolute directory (not created here).
 */
export function handoffDirectory(projectPath, tempDir = os.tmpdir()) {
  return path.join(tempDir, 'developer-workbench', projectSlug(projectPath))
}

/**
 * The path a new handoff document should be written to.
 *
 * Timestamped to the second so two handoffs in one session do not collide, and
 * quoted in full in the dispatch prompt, so the document lands where the
 * workbench will look for it.
 *
 * @param projectPath - the project root.
 * @param when - the timestamp to encode; injectable for tests.
 * @param tempDir - the OS temp directory; injectable for tests.
 * @returns the absolute file path.
 */
export function nextHandoffPath(projectPath, when = new Date(), tempDir = os.tmpdir()) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = [
    when.getFullYear(),
    pad(when.getMonth() + 1),
    pad(when.getDate()),
    '-',
    pad(when.getHours()),
    pad(when.getMinutes()),
    pad(when.getSeconds()),
  ].join('')
  return path.join(handoffDirectory(projectPath, tempDir), `handoff-${stamp}.md`)
}
