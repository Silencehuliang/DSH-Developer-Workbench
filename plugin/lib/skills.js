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
 * The provider name this plugin registers its bundled skills under.
 * Kept here so the self-check can tell our skills apart from a project's own.
 */
export const SKILL_PROVIDER_NAME = 'developer-workbench-skills'

/**
 * Reconcile what the package ships against what DSH's catalog actually exposes.
 *
 * This is the whole point of the self-check: the plugin's `skills/` directory
 * being present proves nothing about whether a session can load them. The
 * registry is what the `skill` tool reads, so the registry is what decides.
 *
 * The two failure modes are different and must not be conflated:
 *
 *   - **on disk, not in the catalog** — discovery is not reaching the package
 *     (the desktop-profile failure this plugin was built against);
 *   - **on disk, in the catalog, but with bad frontmatter** — DSH skips it
 *     silently, so it looks present while being unloadable.
 *
 * @param options - reconciliation inputs.
 * @param options.onDisk - rows from {@link readSkillInventory}.
 * @param options.catalog - `SkillSummary[]` from `ctx.skills.snapshot()`.
 * @param options.complete - whether that snapshot finished discovering.
 * @returns the reconciled self-check payload.
 */
export function reconcileSkills({ onDisk, catalog, complete = true }) {
  const byName = new Map((Array.isArray(catalog) ? catalog : []).map((entry) => [entry.name, entry]))

  const rows = onDisk.map((row) => {
    const entry = byName.get(row.name) ?? null
    const status = row.problems.length > 0
      ? 'invalid'
      : entry !== null
        ? 'discovered'
        : 'not-discovered'
    return {
      name: row.name,
      dir: row.dir,
      file: row.file,
      bytes: row.bytes,
      description: row.description,
      problems: row.problems,
      status,
      // The registry's policy wins when we have it: it is the value the `skill`
      // tool actually obeys, rather than our reading of the frontmatter.
      modelInvocable: entry === null ? row.modelInvocable : entry.invocation?.modelInvocable !== false,
      userInvocable: entry === null ? row.userInvocable : entry.invocation?.userInvocable !== false,
      registrySource: entry?.source ?? null,
      registryProvider: entry?.provider ?? null,
    }
  })

  const shipped = new Set(rows.map((row) => row.name))
  const otherSkills = (Array.isArray(catalog) ? catalog : [])
    .filter((entry) => !shipped.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      description: entry.description,
      source: entry.source,
      provider: entry.provider,
      modelInvocable: entry.invocation?.modelInvocable !== false,
    }))

  const counts = {
    total: rows.length,
    discovered: rows.filter((row) => row.status === 'discovered').length,
    notDiscovered: rows.filter((row) => row.status === 'not-discovered').length,
    invalid: rows.filter((row) => row.status === 'invalid').length,
    modelInvocable: rows.filter((row) => row.modelInvocable).length,
    humanOnly: rows.filter((row) => !row.modelInvocable).length,
  }

  return {
    counts,
    complete: complete !== false,
    rows,
    otherSkills,
    diagnosis: diagnoseSkills({ counts, complete, rows }),
  }
}

/**
 * Say what is wrong and what to do about it, without doing it.
 *
 * The workbench does not edit a profile behind the user's back, so this reports
 * and points; acting on it stays the user's call.
 *
 * @param options - `{ counts, complete, rows }`.
 * @returns `{ code, hint }`.
 */
function diagnoseSkills({ counts, complete, rows }) {
  if (complete === false) {
    return {
      code: 'discovery-incomplete',
      hint: 'DSH 这次的技能发现没有跑完，所以「缺失」可能只是没读完。先重试，不要把不完整当成缺失。',
    }
  }
  if (counts.invalid > 0) {
    const names = rows.filter((row) => row.status === 'invalid').map((row) => row.name).join(', ')
    return {
      code: 'invalid-entries',
      hint: `这些技能的 frontmatter 有问题，DSH 会静默跳过它们（看起来在，实际加载不了）：${names}。修好对应 SKILL.md 顶部的 frontmatter 再刷新。`,
    }
  }
  if (counts.total > 0 && counts.discovered === 0) {
    return {
      code: 'none-discovered',
      hint: '技能文件都在插件包里，但 DSH 的会话目录里一个都看不到 —— 也就是说 `skill` 工具加载不到它们。检查插件自己的 cordis.patch.yml 里那一行 skill-filesystem（providerName 为 developer-workbench-skills、customSkillDirs 指向包内 skills/）是否生效。这一行失效时，项目与用户技能根也会一起失效，所以先看它。',
    }
  }
  if (counts.notDiscovered > 0) {
    const names = rows.filter((row) => row.status === 'not-discovered').map((row) => row.name).join(', ')
    return {
      code: 'partially-discovered',
      hint: `这些在磁盘上但没进目录：${names}。最常见的原因是技能目录是在会话运行中途才创建的，文件监听没挂上 —— 新开一个会话通常就好。`,
    }
  }
  return { code: 'ok', hint: null }
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
    if (entry.isDirectory()) {
      const file = path.join(skillsDir, entry.name, 'SKILL.md')
      try {
        const row = describeSkill(entry.name, fs.readFileSync(file, 'utf8'))
        rows.push({ ...row, file, flat: false })
      } catch (error) {
        rows.push({
          dir: entry.name,
          file,
          flat: false,
          name: entry.name,
          description: '',
          modelInvocable: false,
          userInvocable: false,
          problems: [`SKILL.md is unreadable: ${String(error?.message ?? error)}`],
        })
      }
      continue
    }

    // A flat `<name>.md` at the root of a scanned directory is a skill too. DSH
    // skips one whose frontmatter is invalid, so the self-check has to see it —
    // otherwise a broken flat file reads as "not shipped" instead of "broken".
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    const file = path.join(skillsDir, entry.name)
    const base = entry.name.slice(0, -3)
    try {
      const row = describeSkill(base, fs.readFileSync(file, 'utf8'))
      rows.push({ ...row, file, flat: true })
    } catch (error) {
      rows.push({
        dir: base,
        file,
        flat: true,
        name: base,
        description: '',
        modelInvocable: false,
        userInvocable: false,
        problems: [`file is unreadable: ${String(error?.message ?? error)}`],
      })
    }
  }
  rows.sort((left, right) => left.name.localeCompare(right.name))
  return rows
}
