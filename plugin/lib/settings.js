/**
 * Workbench settings.
 *
 * Deliberately small, and every entry has a real effect somewhere.
 *
 * The ticket that asked for this page listed a "skills install root". The
 * resolved design serves the skills straight from the plugin package and never
 * writes them into a project, so such a knob would control nothing — and a
 * placebo setting is worse than no setting, because it teaches the user that
 * this page lies. It was replaced by `promptLanguage`, which is the real gap
 * this page exists to close: the dispatch prompts used to be hard-coded Chinese.
 *
 * @module lib/settings
 */

/** Every setting, with the value used when nothing was chosen. */
export const SETTINGS_DEFAULTS = {
  /** Ambient bar under the composer card. */
  sessionBar: true,
  /** Record / advance / handoff row after a completed turn. */
  turnTail: true,
  /** The project · stage line in a session row's hover card. */
  sessionHover: true,
  /** Open tickets at which the stage derivation suggests the wayfinder bypass. */
  wayfinderThreshold: 12,
  /** `auto` follows the request's locale; `zh`/`en` pin the dispatch prompts. */
  promptLanguage: 'auto',
}

/** Prompt languages the setting accepts. */
export const PROMPT_LANGUAGES = ['auto', 'zh', 'en']

/** Accepted bounds for the wayfinder threshold. */
export const WAYFINDER_RANGE = { min: 1, max: 200 }

/** The session-side switches, keyed the way the client asks about them. */
export const SURFACE_SETTINGS = {
  bar: 'sessionBar',
  turnTail: 'turnTail',
  hover: 'sessionHover',
}

/**
 * Coerce stored or submitted settings into the accepted shape.
 *
 * Every unknown or out-of-range value falls back to its default rather than
 * being stored, so a bad write cannot leave the workbench in a state the UI
 * cannot describe.
 *
 * @param raw - the stored or submitted object.
 * @returns a complete, valid settings object.
 */
export function normalizeSettings(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const out = { ...SETTINGS_DEFAULTS }

  for (const key of ['sessionBar', 'turnTail', 'sessionHover']) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }
  if (
    Number.isInteger(input.wayfinderThreshold) &&
    input.wayfinderThreshold >= WAYFINDER_RANGE.min &&
    input.wayfinderThreshold <= WAYFINDER_RANGE.max
  ) {
    out.wayfinderThreshold = input.wayfinderThreshold
  }
  if (PROMPT_LANGUAGES.includes(input.promptLanguage)) out.promptLanguage = input.promptLanguage

  return out
}

/**
 * Decide which language a dispatch prompt is written in.
 *
 * `auto` means "follow the interface", which the client reports as `requested`.
 * A pinned language wins, so a user who wants English prompts in a Chinese UI
 * (or the reverse) can have it.
 *
 * @param setting - the stored `promptLanguage`.
 * @param requested - the locale the caller asks for.
 * @returns `'zh'` or `'en'`.
 */
export function resolvePromptLanguage(setting, requested) {
  if (setting === 'zh' || setting === 'en') return setting
  if (requested === 'zh' || requested === 'en') return requested
  return 'zh'
}

/**
 * Whether one session-side surface should render.
 * @param key - `bar`, `turnTail` or `hover`.
 * @param settings - the current settings.
 * @returns false only when the surface is explicitly switched off.
 */
export function isSurfaceEnabled(key, settings) {
  const setting = SURFACE_SETTINGS[key]
  if (setting === undefined) return true
  const effective = settings === null || settings === undefined ? SETTINGS_DEFAULTS : settings
  return effective[setting] !== false
}
