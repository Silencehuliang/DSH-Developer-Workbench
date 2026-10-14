/**
 * Dispatch prompt generation.
 *
 * One job: turn "this project is at stage X" into the text a fresh session needs
 * in order to run the step. It is a pure function over facts, so what a session
 * would actually receive is assertable.
 *
 * The rule that shapes all of it: **the skill's absolute path is always in the
 * prompt.** 16 of the 27 bundled skills set `disable-model-invocation: true`,
 * which keeps them out of the `skill` tool's catalog — and the workflow-gating
 * skills (`to-spec`, `to-tickets`, `wayfinder`, `implement`, `handoff`) are all
 * in that 16. A prompt that only said "load the skill" would silently fail for
 * exactly the steps that matter, so the tool is offered as a shortcut and the
 * path is the guaranteed route.
 *
 * @module lib/prompts
 */

import fs from 'node:fs'
import path from 'node:path'

import { STAGES } from './stage.js'

/** The five canonical triage roles, used when a project declares none. */
export const DEFAULT_TRIAGE_LABELS = [
  'needs-triage',
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'wontfix',
]

/**
 * Per-language prompt text.
 *
 * The dispatch prompt used to be hard-coded Chinese, which meant an English
 * interface still sent Chinese instructions into a session. Both tables define
 * the same keys, and the assertion suite checks that they stay in step.
 */
const TEXT = {
  zh: {
    skillIntro: (path) => `请先读取并严格遵循这个文件里的流程：${path}`,
    skillFallback: (skill) => `（如果 \`skill\` 工具能加载 "${skill}"，优先用它。这些技能里有一部分设置了 disable-model-invocation，工具读不到；那就直接读上面那个文件，效果一样。）`,
    skillAlternative: (name, path) => `需要时可以参考同一目录下的 \`${name}\`：${path}`,
    noSkill: '这次不需要先加载某个技能 —— 按下面的任务做；需要时再加载交接文档里建议的技能。',
    project: (value) => `项目：${value}`,
    workingDir: (value) => `工作目录：${value}`,
    triage: (value) => `triage 标签：${value}`,
    ticket: (value) => `工单：${value}`,
    ticketLink: (value) => `工单链接：${value}`,
    ticketBlocked: (ids) => `注意：这张单还有未解除的阻塞（${ids}），请先确认是否真的可以开工。`,
    ticketMissing: '⚠️ 这次派发没有指定工单编号 —— 请先在 tracker 上选一张「所有阻塞都已解除」的工单，或让我重新派发。',
    handoff: (value) => `交接文档：${value}`,
    handoffWrite: '（这是系统临时目录里的路径，不是工作区 —— 上游 handoff 技能就要求写在那里。工作台会记住这个路径，所以请**严格写到它**，不要另起文件名。）',
    handoffRead: '（如果这个文件已经不存在，说明它被删除或移动过 —— 先告诉用户，不要凭空继续。）',
    task: (value) => `任务：${value}`,
    report: (value) => `完成时请回报：${value}`,
    trackerNone: 'tracker：尚未确定。先做 setup 那一步，不要自己假设一个。',
    trackerGithub: (slug) => `tracker：GitHub Issues ${slug}，用 \`gh\` CLI 操作。阻塞关系**优先用 GitHub 原生依赖边**，而不是只在正文里写一行 —— 看板读的就是原生边。`,
    trackerGitlab: 'tracker：GitLab Issues，用 `glab` CLI 操作。',
    trackerLocal: [
      'tracker：本地 markdown，约定如下。',
      '- 一个 feature 一个目录：`.scratch/<feature-slug>/`',
      '- spec：`.scratch/<feature-slug>/spec.md`',
      '- 工单：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，一单一文件、从 01 编号、按依赖顺序',
      '- 每单顶部用 `Status:` 行记 triage 状态，用 `Blocked by: NN, NN` 行记阻塞',
    ].join('\n'),
    trackerCustom: 'tracker：自定义流程。严格按 `docs/agents/issue-tracker.md` 里写的约定操作，不要自己发明。',
    inferredRemote: '（从 git remote 推断）',
    tasks: {
      setup: { task: '运行这个技能的流程：为这个仓库确定 issue tracker、triage 标签词汇与领域文档布局，并把它写进 docs/agents/。', report: 'tracker 的选择、五个 triage 标签、以及你写下的 docs/agents/*.md 路径。' },
      grill: { task: '对当前方案做一轮拷问：把没想清楚的地方逼出来，别急着实现。顺手把已经定下来的决定落成 ADR 与术语表。', report: '拷问出的关键决定，以及新增或改动的 ADR、GLOSSARY 路径。' },
      spec: { task: '把我们已经讨论清楚的东西综合成 spec 并发布到 tracker —— 不要再做一轮访谈。', report: 'spec 在 tracker 上的编号或路径。' },
      tickets: { task: '把 spec 拆成 tracer-bullet 垂直切片工单：每个切片单独可验证、能在一个会话里做完；每单声明它被谁阻塞，并按依赖顺序发布。', report: '工单清单与它们之间的依赖边。' },
      implement: { task: '实现指定的那张工单。测试优先时先写失败测试。', report: '改了哪些文件、验收项的完成情况、以及任何未决问题。' },
      review: { task: '按两条轴走查这次改动：代码是否遵守本仓库的规范；实现是否与 spec 一致。两条轴都要给结论。', report: '两条轴各自的结论，以及必须修的项。' },
      pr: { task: '撰写这次改动的 PR 正文。', report: 'PR 正文，以及它引用的 spec / 工单编号。' },
      retro: { task: '对这次会话做复盘：流程哪里顺、哪里卡。', report: '做得好的、值得改的、以及下一步建议。' },
      handoff: { task: '把当前会话压缩成交接文档，写到下面给出的那个路径。只**引用**已有产物（spec、工单、ADR、提交、diff）的路径，不要重复它们的内容；文档里要有一节「suggested skills」，列出下一个 agent 该调用哪些技能。敏感信息要脱敏。', report: '写好的交接文档路径，以及你建议下一个会话先做什么。' },
      resume: { task: '读取下面那份交接文档，按它的内容继续那次工作。如果它列了 suggested skills，先加载对应技能再动手。', report: '你从哪里接上、做了什么、以及还剩什么。' },
    },
  },
  en: {
    skillIntro: (path) => `Read and follow the process in this file exactly: ${path}`,
    skillFallback: (skill) => `(If the \`skill\` tool can load "${skill}", prefer it. Some of these skills set disable-model-invocation and the tool cannot see them; read the file above instead — same result.)`,
    skillAlternative: (name, path) => `When useful, the sibling skill \`${name}\` is here: ${path}`,
    noSkill: 'No skill needs loading first — just do the task below, and load whatever skills the handoff document suggests.',
    project: (value) => `Project: ${value}`,
    workingDir: (value) => `Working directory: ${value}`,
    triage: (value) => `Triage labels: ${value}`,
    ticket: (value) => `Ticket: ${value}`,
    ticketLink: (value) => `Ticket link: ${value}`,
    ticketBlocked: (ids) => `Careful: this ticket still has unresolved blockers (${ids}) — confirm it can actually start.`,
    ticketMissing: '⚠️ This dispatch names no ticket — pick one whose blockers are all resolved on the tracker, or ask me to dispatch again.',
    handoff: (value) => `Handoff document: ${value}`,
    handoffWrite: '(This path is in the OS temp directory, not the workspace — the upstream handoff skill requires that. The workbench remembers this path, so write to it **exactly**; do not choose another name.)',
    handoffRead: '(If this file no longer exists it was deleted or moved — tell the user instead of continuing from nothing.)',
    task: (value) => `Task: ${value}`,
    report: (value) => `Report back: ${value}`,
    trackerNone: 'Tracker: not decided yet. Run the setup step first; do not assume one.',
    trackerGithub: (slug) => `Tracker: GitHub Issues ${slug}, driven by the \`gh\` CLI. Prefer **native GitHub blocking edges** over a line in the body — the board reads the native edges.`,
    trackerGitlab: 'Tracker: GitLab Issues, driven by the `glab` CLI.',
    trackerLocal: [
      'Tracker: local markdown, conventions below.',
      '- One directory per feature: `.scratch/<feature-slug>/`',
      '- Spec: `.scratch/<feature-slug>/spec.md`',
      '- Tickets: `.scratch/<feature-slug>/issues/<NN>-<slug>.md` — one file per ticket, numbered from 01, in dependency order',
      '- Each ticket carries a `Status:` line for triage and a `Blocked by: NN, NN` line for blockers',
    ].join('\n'),
    trackerCustom: 'Tracker: a custom workflow. Follow `docs/agents/issue-tracker.md` exactly; do not invent conventions.',
    inferredRemote: '(inferred from the git remote)',
    tasks: {
      setup: { task: 'Run this skill\u2019s process: settle the issue tracker, the triage label vocabulary and the domain doc layout for this repository, and write them into docs/agents/.', report: 'The tracker choice, the five triage labels, and the docs/agents/*.md paths you wrote.' },
      grill: { task: 'Grill the current plan: force out what is not yet thought through, and do not rush into implementation. Record the decisions that do settle as ADRs and glossary entries.', report: 'The key decisions, plus the ADR and GLOSSARY paths you added or changed.' },
      spec: { task: 'Synthesise what we have already settled into a spec and publish it to the tracker — do not run another interview.', report: 'The spec\u2019s tracker number or path.' },
      tickets: { task: 'Break the spec into tracer-bullet vertical slices: each independently verifiable and small enough for one session; declare each one\u2019s blockers and publish in dependency order.', report: 'The ticket list and the blocking edges between them.' },
      implement: { task: 'Implement the named ticket. When working test-first, write the failing test first.', report: 'Which files changed, how the acceptance criteria stand, and anything unresolved.' },
      review: { task: 'Review this change along two axes: does the code follow this repository\u2019s standards, and does the implementation match the spec. Conclude on both.', report: 'The conclusion for each axis, and what must be fixed.' },
      pr: { task: 'Write the pull request body for this change.', report: 'The PR body, and the spec / ticket numbers it references.' },
      retro: { task: 'Run a retrospective on this session: where the process flowed, where it stuck.', report: 'What worked, what should change, and what to do next.' },
      handoff: { task: 'Compress this session into a handoff document at the path given below. Reference existing artifacts (spec, tickets, ADRs, commits, diffs) by path instead of repeating them, and include a "suggested skills" section naming the skills the next agent should load. Redact anything sensitive.', report: 'The handoff path, and what you suggest the next session starts with.' },
      resume: { task: 'Read the handoff document below and continue that work. If it lists suggested skills, load them before acting.', report: 'Where you picked up, what you did, and what remains.' },
    },
  },
}

/**
 * How the tracker is actually operated, per kind.
 *
 * Embedding this is what lets a fresh session act without re-deriving the
 * project's conventions from `docs/agents/`.
 *
 * @param lang - `'zh'` or `'en'`.
 * @param tracker - the resolved tracker.
 * @param repository - `{ owner, repo }` for a GitHub tracker, or null.
 * @returns the tracker paragraph.
 */
function describeTracker(lang, tracker, repository) {
  const text = TEXT[lang] ?? TEXT.zh
  if (tracker === null) return text.trackerNone
  if (tracker.kind === 'github') {
    const slug = repository === null ? text.inferredRemote : `(${repository.owner}/${repository.repo})`
    return text.trackerGithub(slug)
  }
  if (tracker.kind === 'gitlab') return text.trackerGitlab
  if (tracker.kind === 'local-markdown') return text.trackerLocal
  return text.trackerCustom
}

/**
 * Dispatchable actions that are not pipeline stages.
 *
 * `handoff` is cross-cutting by design: it can be run from any stage, which is
 * why it cannot be a step in the pipeline. `resume` has no skill of its own —
 * it reads a previous handoff and follows whatever that document suggests.
 */
export const DISPATCH_ACTIONS = [
  { id: 'handoff', skill: 'handoff', requiresHandoff: false },
  { id: 'resume', skill: null, requiresHandoff: true },
]

/**
 * Read a project's triage label vocabulary.
 *
 * The vocabulary lives in a markdown table written by
 * `setup-matt-pocock-skills`; the second column is the real label string.
 *
 * @param projectPath - project root.
 * @returns the label strings, or the canonical five when nothing is declared.
 */
export function readTriageLabels(projectPath) {
  const file = path.join(projectPath, 'docs', 'agents', 'triage-labels.md')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return [...DEFAULT_TRIAGE_LABELS]
  }
  const labels = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    // cells[0] is the empty run before the first pipe.
    const candidate = (cells[2] ?? '').replace(/[`*]/g, '').trim()
    if (candidate.length === 0) continue
    if (candidate.toLowerCase() === 'label in our tracker') continue
    if (/^[-: ]+$/.test(candidate)) continue
    if (!labels.includes(candidate)) labels.push(candidate)
  }
  return labels.length > 0 ? labels : [...DEFAULT_TRIAGE_LABELS]
}

/**
 * Build the dispatch prompt for one stage.
 *
 * @param options - prompt inputs.
 * @param options.stage - the pipeline entry being dispatched.
 * @param options.skillsDir - the plugin's bundled `skills/` directory.
 * @param options.tracker - the resolved tracker, or null.
 * @param options.repository - `{ owner, repo }` for a GitHub tracker, or null.
 * @param options.project - `{ title, path }` of the target project.
 * @param options.ticket - the ticket to implement, when the stage is `implement`.
 * @param options.triageLabels - the project's label vocabulary.
 * @param options.lang - `'zh'` or `'en'`; the prompt's language.
 * @returns the prompt plus the coordinates the UI must show before sending.
 */
export function buildDispatchPrompt({
  stage,
  skillsDir,
  tracker,
  repository = null,
  project,
  ticket = null,
  triageLabels = DEFAULT_TRIAGE_LABELS,
  handoffPath = null,
  lang = 'zh',
}) {
  const text = TEXT[lang] ?? TEXT.zh
  const tasks = text.tasks[stage.id] ?? { task: `Execute the ${stage.id} step.`, report: 'The result and anything unresolved.' }
  const hasSkill = typeof stage.skill === 'string' && stage.skill.length > 0
  const skillPath = hasSkill ? path.join(skillsDir, stage.skill, 'SKILL.md').split(path.sep).join('/') : null
  const alternativePath = !hasSkill || stage.alternative === undefined
    ? null
    : path.join(skillsDir, stage.alternative, 'SKILL.md').split(path.sep).join('/')

  const lines = []
  if (hasSkill) {
    lines.push(text.skillIntro(skillPath))
    lines.push(text.skillFallback(stage.skill))
    if (alternativePath !== null) {
      lines.push(text.skillAlternative(stage.alternative, alternativePath))
    }
  } else {
    lines.push(text.noSkill)
  }
  lines.push('')
  lines.push(text.project(project.title))
  lines.push(text.workingDir(project.path.split(path.sep).join('/')))
  lines.push(describeTracker(lang, tracker, repository))
  lines.push(text.triage(triageLabels.join(' / ')))
  lines.push('')
  if (stage.id === 'implement') {
    if (ticket === null) {
      lines.push(text.ticketMissing)
    } else {
      lines.push(text.ticket(`#${ticket.id} ${ticket.title}`))
      if (ticket.url !== null && ticket.url !== undefined) lines.push(text.ticketLink(ticket.url))
      if (Array.isArray(ticket.openBlockers) && ticket.openBlockers.length > 0) {
        lines.push(text.ticketBlocked(ticket.openBlockers.map((id) => `#${id}`).join(', ')))
      }
    }
    lines.push('')
  }
  if (handoffPath !== null) {
    lines.push(text.handoff(handoffPath.split(path.sep).join('/')))
    lines.push(stage.id === 'handoff' ? text.handoffWrite : text.handoffRead)
    lines.push('')
  }
  lines.push(text.task(tasks.task))
  lines.push('')
  lines.push(text.report(tasks.report))

  return {
    stage: stage.id,
    skill: stage.skill ?? null,
    skillPath,
    alternative: stage.alternative ?? null,
    alternativePath,
    handoffPath,
    lang,
    /** What the confirm dialog shows as the subject line. */
    subject: `${stage.id} · ${stage.skill ?? 'no skill'}`,
    text: lines.join('\n'),
  }
}

/** Every dispatchable id: the pipeline steps plus the cross-cutting actions. */
export const PROMPT_STAGES = [
  ...STAGES.map((entry) => entry.id),
  ...DISPATCH_ACTIONS.map((entry) => entry.id),
]

/**
 * Resolve a dispatchable id.
 * @param id - a pipeline stage id or a dispatch action id.
 * @returns the entry to build a prompt for, or undefined.
 */
export function findDispatchable(id) {
  return STAGES.find((entry) => entry.id === id) ?? DISPATCH_ACTIONS.find((entry) => entry.id === id)
}
