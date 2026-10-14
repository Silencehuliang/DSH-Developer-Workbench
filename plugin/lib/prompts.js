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

/** What the step is for, and what the session should report back. */
const STAGE_TASKS = {
  setup: {
    task: '运行这个技能的流程：为这个仓库确定 issue tracker、triage 标签词汇与领域文档布局，并把它写进 docs/agents/。',
    report: 'tracker 的选择、五个 triage 标签、以及你写下的 docs/agents/*.md 路径。',
  },
  grill: {
    task: '对当前方案做一轮拷问：把没想清楚的地方逼出来，别急着实现。顺手把已经定下来的决定落成 ADR 与术语表。',
    report: '拷问出的关键决定，以及新增或改动的 ADR、GLOSSARY 路径。',
  },
  spec: {
    task: '把我们已经讨论清楚的东西综合成 spec 并发布到 tracker —— 不要再做一轮访谈。',
    report: 'spec 在 tracker 上的编号或路径。',
  },
  tickets: {
    task: '把 spec 拆成 tracer-bullet 垂直切片工单：每个切片单独可验证、能在一个会话里做完；每单声明它被谁阻塞，并按依赖顺序发布。',
    report: '工单清单与它们之间的依赖边。',
  },
  implement: {
    task: '实现指定的那张工单。测试优先时先写失败测试。',
    report: '改了哪些文件、验收项的完成情况、以及任何未决问题。',
  },
  review: {
    task: '按两条轴走查这次改动：代码是否遵守本仓库的规范；实现是否与 spec 一致。两条轴都要给结论。',
    report: '两条轴各自的结论，以及必须修的项。',
  },
  pr: {
    task: '撰写这次改动的 PR 正文。',
    report: 'PR 正文，以及它引用的 spec / 工单编号。',
  },
  retro: {
    task: '对这次会话做复盘：流程哪里顺、哪里卡。',
    report: '做得好的、值得改的、以及下一步建议。',
  },
}

/**
 * How the tracker is actually operated, per kind.
 *
 * Embedding this is what lets a fresh session act without re-deriving the
 * project's conventions from `docs/agents/`.
 * @param tracker - the resolved tracker.
 * @param repository - `{ owner, repo }` for a GitHub tracker, or null.
 * @returns the tracker paragraph.
 */
function describeTracker(tracker, repository) {
  if (tracker === null) {
    return 'tracker：尚未确定。先做 setup 那一步，不要自己假设一个。'
  }
  if (tracker.kind === 'github') {
    const slug = repository === null ? '（从 git remote 推断）' : `（${repository.owner}/${repository.repo}）`
    return [
      `tracker：GitHub Issues ${slug}，用 \`gh\` CLI 操作。`,
      '阻塞关系**优先用 GitHub 原生依赖边**（`gh api .../issues/<n>/dependencies/blocked_by`），而不是只在正文里写一行 —— 看板读的是原生边。',
    ].join('\n')
  }
  if (tracker.kind === 'gitlab') {
    return 'tracker：GitLab Issues，用 `glab` CLI 操作。'
  }
  if (tracker.kind === 'local-markdown') {
    return [
      'tracker：本地 markdown，约定如下。',
      '- 一个 feature 一个目录：`.scratch/<feature-slug>/`',
      '- spec：`.scratch/<feature-slug>/spec.md`',
      '- 工单：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，一单一文件、从 01 编号、按依赖顺序',
      '- 每单顶部用 `Status:` 行记 triage 状态，用 `Blocked by: NN, NN` 行记阻塞',
    ].join('\n')
  }
  return 'tracker：自定义流程。严格按 `docs/agents/issue-tracker.md` 里写的约定操作，不要自己发明。'
}

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
}) {
  const tasks = STAGE_TASKS[stage.id] ?? { task: `执行 ${stage.id} 这一步。`, report: '结果与遇到的问题。' }
  const skillPath = path.join(skillsDir, stage.skill, 'SKILL.md').split(path.sep).join('/')
  const alternativePath = stage.alternative === undefined
    ? null
    : path.join(skillsDir, stage.alternative, 'SKILL.md').split(path.sep).join('/')

  const lines = []
  lines.push(`请先读取并严格遵循这个文件里的流程：${skillPath}`)
  lines.push(
    `（如果 \`skill\` 工具能加载 "${stage.skill}"，优先用它。这些技能里有一部分设置了 disable-model-invocation，工具读不到；那就直接读上面那个文件，效果一样。）`,
  )
  if (alternativePath !== null) {
    lines.push(`需要时可以参考同一目录下的 \`${stage.alternative}\`：${alternativePath}`)
  }
  lines.push('')
  lines.push(`项目：${project.title}`)
  lines.push(`工作目录：${project.path.split(path.sep).join('/')}`)
  lines.push(describeTracker(tracker, repository))
  lines.push(`triage 标签：${triageLabels.join(' / ')}`)
  lines.push('')
  if (stage.id === 'implement') {
    if (ticket === null) {
      lines.push('⚠️ 这次派发没有指定工单编号 —— 请先在 tracker 上选一张「所有阻塞都已解除」的工单，或让我重新派发。')
    } else {
      lines.push(`工单：#${ticket.id} ${ticket.title}`)
      if (ticket.url !== null && ticket.url !== undefined) lines.push(`工单链接：${ticket.url}`)
      if (Array.isArray(ticket.openBlockers) && ticket.openBlockers.length > 0) {
        lines.push(`注意：这张单还有未解除的阻塞（${ticket.openBlockers.map((id) => `#${id}`).join(', ')}），请先确认是否真的可以开工。`)
      }
    }
    lines.push('')
  }
  lines.push(`任务：${tasks.task}`)
  lines.push('')
  lines.push(`完成时请回报：${tasks.report}`)

  return {
    stage: stage.id,
    skill: stage.skill,
    skillPath,
    alternative: stage.alternative ?? null,
    alternativePath,
    /** What the confirm dialog shows as the subject line. */
    subject: `${stage.id} · ${stage.skill}`,
    text: lines.join('\n'),
  }
}

/** Stage ids this module can build a prompt for. */
export const PROMPT_STAGES = STAGES.map((entry) => entry.id)
