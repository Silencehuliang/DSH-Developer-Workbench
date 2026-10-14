/**
 * Bundled-skill inventory.
 *
 * The workbench ships Matt Pocock's skills inside its own package and serves
 * them through its own `skill-filesystem` row, so the self-check must report
 * both what is on disk and what DSH would actually accept.
 *
 * @module lib/skills
 */

import fs from 'node:fs'
import path from 'node:path'

/** Frontmatter scalars DSH's skill provider accepts as boolean true. */
const TRUTHY_FLAGS = new Set(['true', 'yes', 'on', '1'])
/** Frontmatter scalars DSH's skill provider accepts as boolean false. */
const FALSY_FLAGS = new Set(['false', 'no', 'off', '0'])
/** Kebab-case, the only shape DSH accepts for a skill name. */
const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

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
export function readFlag(value) {
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
export function parseFrontmatter(text) {
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
 * Classify one skill directory.
 *
 * @param dir - the skill's directory name.
 * @param text - its SKILL.md contents.
 * @returns a row for the self-check.
 */
export function describeSkill(dir, text) {
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
  return {
    dir,
    name: declaredName.length > 0 ? declaredName : dir,
    description: front.description ?? '',
    /** `disable-model-invocation: true` keeps a skill out of the `skill` tool's catalog. */
    modelInvocable: modelFlag.value !== true,
    /** `user-invocable: false` keeps a skill out of the human `/name` surface. */
    userInvocable: userFlag.value !== false,
    bytes: Buffer.byteLength(text, 'utf8'),
    /** Non-empty means DSH's provider skips this skill with a warning. */
    problems,
  }
}

/**
 * Read every skill bundled in a directory: one directory per skill, each with a
 * `SKILL.md`. Discovery in DSH is one level deep, which is why the vendored tree
 * is flat rather than mirroring the upstream grouping.
 *
 * @param skillsDir - absolute directory holding the skill folders.
 * @returns one row per skill directory, sorted by name.
 */
export function readSkillInventory(skillsDir) {
  let entries
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  } catch (error) {
    return []
  }
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(skillsDir, entry.name, 'SKILL.md')
    try {
      const row = describeSkill(entry.name, fs.readFileSync(file, 'utf8'))
      rows.push({ ...row, file })
    } catch (error) {
      rows.push({
        dir: entry.name,
        file,
        name: entry.name,
        description: '',
        modelInvocable: false,
        userInvocable: false,
        problems: [`SKILL.md is unreadable: ${String(error?.message ?? error)}`],
      })
    }
  }
  rows.sort((left, right) => left.name.localeCompare(right.name))
  return rows
}
