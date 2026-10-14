/**
 * dsh-developer-workbench — browser half.
 *
 * Hand-written ModuleLoader bundle: no build step, no install. The only modules
 * it requires are the ones the shell guarantees in its frozen baseline table
 * (`react` today; the official component library later as the UI grows).
 *
 * Registered surfaces:
 *   1. `sidebar.panellist` with `order: -10`, which lands the entry below New
 *      Session and above Plugins (the shipped Plugins page uses 0 and the shell
 *      sorts ascending);
 *   2. the page that same id addresses in the layout's keyed `main` slot.
 *
 * Layout note: everything that renders from data is a **pure component** taking
 * its data as props, and the container that fetches is a thin shell around them.
 * That split is what lets `scripts/verify.mjs` assert rendered output with a stub
 * React instead of a browser.
 *
 * Colours come from theme alias tokens so the page survives a scheme switch.
 */

window.__ModuleLoader__.load({
  id: 'dsh-developer-workbench',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'developerWorkbench'
    /** Sidebar panel id: addresses both the icon row and the `main` key. */
    const PANEL_ID = 'developer-workbench'
    /** Base path of the host half's routes. */
    const ROUTE_BASE = '/api/developer-workbench'

    /** Services this plugin's browser half needs. */
    const inject = ['slots', 'locale', 'uiWorkspace']

    const zh = {
      panel: '开发工作台',
      title: '开发工作台',
      subtitle: '绑定本地项目，看清走到哪一步，把下一步派发给工作区会话',
      loading: '正在读取…',
      errorTitle: '读不到宿主半身',
      errorHint: '宿主路由没有响应。可能插件刚装载、宿主半身未激活，或 web 载体未就绪。',
      retry: '重试',
      projects: '项目',
      projectsHint: '「项目」就是已注册的 DSH 工作区，所以这里和左侧列表永远一致。',
      bind: '＋ 绑定本地项目',
      binding: '绑定中…',
      unbind: '解除绑定',
      noProjects: '还没有登记任何工作区。先绑定一个本地项目。',
      missingDir: '目录不见了',
      branch: '分支',
      dirty: '未提交',
      sessions: '会话',
      noGit: '不是 git 仓库',
      gitUnavailable: '找不到 git',
      trackerUnknown: 'tracker 未定',
      trackerSourceDeclaration: '来自项目声明',
      trackerSourceMapping: '来自工作台记录',
      trackerSourceUser: '你选的',
      trackerSourceDefault: '全局默认',
      trackerPrompt: '这个项目用哪个 tracker？',
      trackerPromptHint: '项目里没有 docs/agents/issue-tracker.md，所以需要你定一次；之后记在工作台里，不再问。',
      trackerConflict: '项目声明与工作台记录不一致',
      trackerConflictHint: '项目自己的声明是 {declared}，工作台记的是 {mapped}。以哪个为准由你决定，我不会替你猜。',
      choose: '就用这个',
      stageUnknown: '阶段待接入',
      stageBody: '项目列表已经接上真实数据。下一步是工单看板与阶段推导。',
      stagePipeline: '阶段流水线',
      stageNow: '当前',
      stageDone: '已完成',
      stagePending: '未开始',
      stageSkill: '技能 {skill}',
      stageEvidenceNote: '依据',
      stageOverridden: '已被手动覆盖',
      stageDerivedWas: '推导结果是 {derived}',
      stageOverride: '手动覆盖',
      stageClearOverride: '恢复自动推导',
      stageBypass: '旁路建议',
      stageSetup: '配置 tracker',
      stageGrill: '拷问',
      stageSpec: '成稿',
      stageTickets: '拆工单',
      stageImplement: '实现',
      stageReview: '评审',
      stagePr: '提 PR',
      stageRetro: '复盘',
      dispatch: '派发',
      dispatchTitle: '派发确认',
      dispatchTarget: '目标工作区',
      dispatchTicket: '目标工单',
      dispatchSession: '目标会话',
      dispatchNew: '新建会话',
      dispatchExisting: '复用已有会话',
      dispatchNoSessions: '这个项目还没有会话，只能新建。',
      dispatchPrompt: '将发送的提示词（可编辑）',
      dispatchSendNew: '新建会话并发送',
      dispatchSendExisting: '在已有会话发送',
      dispatchCopy: '复制提示词',
      dispatchCopied: '已复制到剪贴板',
      dispatchCancel: '取消',
      dispatchSending: '发送中…',
      dispatchFailed: '派发失败：{reason}',
      dispatchBlocked: '这张单还有未解除的阻塞：{ids}',
      dispatchPickSession: '先选一个会话',
      sessionProject: '项目',
      sessionAdvance: '推进',
      sessionAdvanceNext: '推进到下一阶段…',
      sessionRecord: '记录到工作台',
      sessionHandoff: '生成交接文档',
      sessionFocusAdvance: '会话请求：推进「{title}」',
      sessionFocusHandoff: '会话请求：为「{title}」生成交接文档',
      sessionFocusRecord: '会话请求：把「{title}」记到工作台',
      sessionFocusHint: '请在下面的流水线上按「派发」确认要发送的内容 —— 工作台不会替你发送。',
      sessionFocusDismiss: '知道了',
      actionHandoff: '生成交接文档',
      actionResume: '继续这个交接',
      handoffMissing: '文件不见了',
      handoffHint: '交接文档按上游 handoff 技能的约定写在系统临时目录里（不是工作区）。工作台会记住路径，所以「继续这个交接」能直接接上。',
      handoffPlanned: '将写入：{path}',
      settingsTitle: '开发工作台设置',
      settingsLead: '这些是工作台自己的偏好。改动立即生效，不用重启。',
      settingSessionBar: '输入框下方显示「项目 · 阶段」',
      settingSessionBarNote: '只在该会话属于已登记项目时出现。',
      settingTurnTail: '每轮回答后显示推进动作',
      settingTurnTailNote: '记录 / 推进 / 交接三个动作。',
      settingSessionHover: '会话悬停卡显示项目',
      settingSessionHoverNote: '一行「项目 · 阶段」，纯展示。',
      settingThreshold: '旁路建议阈值',
      settingThresholdNote: '开放工单达到这个数就建议走 wayfinder。',
      settingPromptLanguage: '派发提示词语言',
      settingPromptLanguageNote: '跟随界面，或固定为某种语言。',
      settingLanguageAuto: '跟随界面',
      settingsSkillsNote: '这里没有「技能安装位置」这个设置：技能由插件包直接供给，不写进你的项目 —— 旋钮如果控制不了任何东西，就不该出现在设置里。技能是否真的被 DSH 看到，看右栏的技能自检。',
      settingsFailed: '保存失败',
      settingsSaved: '已保存',
      dispatchHandoff: '交接文档',
      dispatchHandoffNew: '这次派发会把它写到上面这个路径 —— 系统临时目录，不是工作区。',
      dispatchHandoffResume: '将读取这份已有文档，按它列出的 suggested skills 继续。',
      board: '工单看板',
      boardNeedsTracker: '这个项目的 tracker 还没定。先绑定项目并选择 tracker，看板才有东西可读。',
      boardUnsupported: '还没有 {kind} tracker 的适配器，所以这里不显示任何工单。',
      boardUnavailable: '读不到 tracker（{reason}）。',
      boardEmpty: '这个项目在 tracker 上还没有工单。',
      boardFrontier: '可开工 {n} 张',
      boardBlockedBy: '被 {ids} 阻塞',
      boardBlockedByUnknown: '被不存在的 {ids} 阻塞',
      boardAcceptance: '验收 {done}/{total}',
      boardReady: '可开工',
      boardDone: '已完成',
      boardBlocked: '被阻塞',
      boardProblemCycle: '依赖成环：{ids} —— 这些工单永远不会解锁。',
      boardProblemSelf: '自己阻塞自己：{ids}。',
      boardProblemUnknown: '这些工单依赖了不存在的工单：{ids}。',
      boardProblemUnread: '这些工单的依赖读不到，已按「不可开工」处理：{ids}。',
      artifacts: '产物',
      artifactsLoading: '正在扫描产物…',
      artifactsEmpty: '这个项目还没有 spec / ADR / 术语表。',
      artifactOpen: '预览',
      previewTitle: '只读预览',
      previewClose: '关闭',
      previewMore: '载入更多（还剩 {n} 行）',
      previewEnd: '已到文件末尾',
      previewProgress: '已显示 {shown} / {total} 行',
      previewRefused: '无法预览',
      previewBinary: '这是二进制文件，不做文本预览。',
      previewTooLarge: '文件 {bytes} 字节，超过 {max} 字节的预览上限。',
      previewNotUtf8: '文件不是合法的 UTF-8 文本。',
      previewMissing: '文件不存在，可能已被删除或移动。',
      previewNotAFile: '这不是一个普通文件。',
      skillsTitle: 'Matt Pocock 技能自检',
      skillsTotal: '共 {n} 个',
      skillsModel: '可被模型加载 {n} 个',
      skillsManual: '仅人工调用 {n} 个',
      skillsDiscovered: 'DSH 看到 {n} 个',
      skillsLoading: '正在读取技能自检…',
      skillsUnavailable: '读不到 DSH 的技能目录',
      skillsDiagnosis: '自检结论',
      skillsOther: 'DSH 还看到 {n} 个别的技能',
      skillsHint: '技能由插件包直接供给，不写进你的项目 —— 所以「项目里没有技能文件」是正常的，别去拷文件。带「仅人工」的技能设置了 disable-model-invocation，skill 工具加载不到；派发提示词会给出绝对路径，两条路都能跑通。',
    }

    const en = {
      panel: 'Workbench',
      title: 'Developer Workbench',
      subtitle: 'Bind a local project, see which step it is on, dispatch the next step to a workspace session',
      loading: 'Reading…',
      errorTitle: 'Host half is not answering',
      errorHint: 'The host route did not respond. The plugin may have just loaded, the host half may be inactive, or no web carrier is ready.',
      retry: 'Retry',
      projects: 'Projects',
      projectsHint: 'A project is a registered DSH workspace, so this list and the sidebar can never disagree.',
      bind: '＋ Bind a local project',
      binding: 'Binding…',
      unbind: 'Unbind',
      noProjects: 'No workspace is registered yet. Bind a local project to start.',
      missingDir: 'directory is gone',
      branch: 'branch',
      dirty: 'uncommitted',
      sessions: 'sessions',
      noGit: 'not a git repository',
      gitUnavailable: 'git not found',
      trackerUnknown: 'tracker undecided',
      trackerSourceDeclaration: 'from the project',
      trackerSourceMapping: 'from the workbench',
      trackerSourceUser: 'your choice',
      trackerSourceDefault: 'global default',
      trackerPrompt: 'Which tracker does this project use?',
      trackerPromptHint: 'The project has no docs/agents/issue-tracker.md, so this is asked once and then remembered by the workbench.',
      trackerConflict: 'The project and the workbench disagree',
      trackerConflictHint: 'The project declares {declared}; the workbench recorded {mapped}. You decide which wins — I will not guess.',
      choose: 'Use this',
      stageUnknown: 'Stage pending',
      stageBody: 'The project list is wired to real data. Next are the ticket board and stage derivation.',
      stagePipeline: 'Stage pipeline',
      stageNow: 'now',
      stageDone: 'done',
      stagePending: 'not started',
      stageSkill: 'skill {skill}',
      stageEvidenceNote: 'because',
      stageOverridden: 'manually overridden',
      stageDerivedWas: 'the derivation says {derived}',
      stageOverride: 'Override',
      stageClearOverride: 'Back to automatic',
      stageBypass: 'Suggested detour',
      stageSetup: 'Configure tracker',
      stageGrill: 'Grill',
      stageSpec: 'Spec',
      stageTickets: 'Tickets',
      stageImplement: 'Implement',
      stageReview: 'Review',
      stagePr: 'Pull request',
      stageRetro: 'Retro',
      dispatch: 'Dispatch',
      dispatchTitle: 'Confirm dispatch',
      dispatchTarget: 'Target project',
      dispatchTicket: 'Target ticket',
      dispatchSession: 'Target session',
      dispatchNew: 'New session',
      dispatchExisting: 'Reuse a session',
      dispatchNoSessions: 'This project has no sessions yet, so a new one is the only option.',
      dispatchPrompt: 'Prompt to send (editable)',
      dispatchSendNew: 'Create a session and send',
      dispatchSendExisting: 'Send to the selected session',
      dispatchCopy: 'Copy the prompt',
      dispatchCopied: 'Copied to the clipboard',
      dispatchCancel: 'Cancel',
      dispatchSending: 'Sending…',
      dispatchFailed: 'Dispatch failed: {reason}',
      dispatchBlocked: 'This ticket still has unresolved blockers: {ids}',
      dispatchPickSession: 'Pick a session first',
      sessionProject: 'Project',
      sessionAdvance: 'Advance',
      sessionAdvanceNext: 'Advance to the next stage…',
      sessionRecord: 'Record in the workbench',
      sessionHandoff: 'Write a handoff document',
      sessionFocusAdvance: 'From a session: advance {title}',
      sessionFocusHandoff: 'From a session: write a handoff document for {title}',
      sessionFocusRecord: 'From a session: record {title} in the workbench',
      sessionFocusHint: 'Press Dispatch on the pipeline below to confirm what gets sent — the workbench will not send it for you.',
      sessionFocusDismiss: 'Got it',
      actionHandoff: 'Write a handoff',
      actionResume: 'Resume this handoff',
      handoffMissing: 'file is gone',
      handoffHint: 'Handoff documents live in the OS temp directory by the upstream skill\u2019s design, not in the workspace. The workbench remembers the path, which is what makes "resume this handoff" possible.',
      handoffPlanned: 'will be written to: {path}',
      settingsTitle: 'Developer Workbench settings',
      settingsLead: 'Preferences for the workbench itself. Changes take effect immediately \u2014 no restart.',
      settingSessionBar: 'Show project \u00b7 stage under the composer',
      settingSessionBarNote: 'Only appears when the session belongs to a registered project.',
      settingTurnTail: 'Show advance actions after each turn',
      settingTurnTailNote: 'Record, advance, and handoff.',
      settingSessionHover: 'Show the project in the session hover card',
      settingSessionHoverNote: 'One informational line, nothing interactive.',
      settingThreshold: 'Detour threshold',
      settingThresholdNote: 'Open tickets at which wayfinder is suggested.',
      settingPromptLanguage: 'Dispatch prompt language',
      settingPromptLanguageNote: 'Follow the interface, or pin one language.',
      settingLanguageAuto: 'Follow the interface',
      settingsSkillsNote: 'There is no "skills install location" here: the skills are served straight from the plugin package and never written into your project, so such a knob would control nothing. Whether DSH actually sees them is what the skill self-check reports.',
      settingsFailed: 'Could not save',
      settingsSaved: 'Saved',
      dispatchHandoff: 'Handoff document',
      dispatchHandoffNew: 'This dispatch will write it to the path above — the OS temp directory, not the workspace.',
      dispatchHandoffResume: 'It will read this existing document and continue from the skills it suggests.',
      board: 'Ticket board',
      boardNeedsTracker: 'This project has no tracker yet. Bind it and pick a tracker before the board can read anything.',
      boardUnsupported: 'There is no adapter for a {kind} tracker yet, so no tickets are shown.',
      boardUnavailable: 'The tracker could not be read ({reason}).',
      boardEmpty: 'This project has no tickets on its tracker yet.',
      boardFrontier: '{n} startable',
      boardBlockedBy: 'blocked by {ids}',
      boardBlockedByUnknown: 'blocked by the missing {ids}',
      boardAcceptance: 'acceptance {done}/{total}',
      boardReady: 'startable',
      boardDone: 'done',
      boardBlocked: 'blocked',
      boardProblemCycle: 'Blocking cycle: {ids} — these will never unlock.',
      boardProblemSelf: 'Blocked by itself: {ids}.',
      boardProblemUnknown: 'These depend on tickets that do not exist: {ids}.',
      boardProblemUnread: 'Blocking edges could not be read for {ids}, so they are treated as not startable.',
      artifacts: 'Artifacts',
      artifactsLoading: 'Scanning artifacts…',
      artifactsEmpty: 'This project has no spec, ADR or glossary yet.',
      artifactOpen: 'Preview',
      previewTitle: 'Read-only preview',
      previewClose: 'Close',
      previewMore: 'Load more ({n} lines left)',
      previewEnd: 'End of file',
      previewProgress: 'showing {shown} / {total} lines',
      previewRefused: 'Cannot preview',
      previewBinary: 'This is a binary file, so there is no text preview.',
      previewTooLarge: 'The file is {bytes} bytes, above the {max}-byte preview limit.',
      previewNotUtf8: 'The file is not valid UTF-8 text.',
      previewMissing: 'The file does not exist; it may have been deleted or moved.',
      previewNotAFile: 'That path is not a regular file.',
      skillsTitle: 'Matt Pocock skill self-check',
      skillsTotal: '{n} total',
      skillsModel: '{n} model-loadable',
      skillsManual: '{n} human-only',
      skillsDiscovered: 'DSH sees {n}',
      skillsLoading: 'Reading the skill self-check…',
      skillsUnavailable: 'The DSH skill catalog could not be read',
      skillsDiagnosis: 'Verdict',
      skillsOther: 'DSH also sees {n} other skills',
      skillsHint: 'The skills are served straight from the plugin package and never written into your project — so "the project has no skill files" is expected; do not go copying files. Skills marked human-only set disable-model-invocation, which the skill tool cannot load; dispatch prompts pass the absolute path, so both routes work.',
    }

    /** Tracker kinds a user may pick, in the order the picker shows them. */
    const TRACKER_CHOICES = [
      { kind: 'github', label: 'GitHub Issues' },
      { kind: 'gitlab', label: 'GitLab Issues' },
      { kind: 'local-markdown', label: 'Local markdown' },
      { kind: 'custom', label: 'Custom workflow' },
    ]

    /**
     * Resolve one dictionary key, substituting `{name}` placeholders.
     * @param dict - the dictionary to read.
     * @param key - the key.
     * @param params - placeholder values.
     * @returns the text, or the key when it is missing.
     */
    function translate(dict, key, params) {
      let text = dict[key] ?? key
      if (params) {
        for (const name of Object.keys(params)) text = text.replace(`{${name}}`, String(params[name]))
      }
      return text
    }

    /**
     * Build a translate function bound to a dictionary.
     * @param dict - the dictionary to read.
     * @returns a `(key, params) => string` function.
     */
    function makeTranslate(dict) {
      return (key, params) => translate(dict, key, params)
    }

    /** Short local timestamp for a list row. */
    function formatWhen(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return '—'
      const when = new Date(iso)
      if (Number.isNaN(when.getTime())) return '—'
      const pad = (value) => String(value).padStart(2, '0')
      return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`
    }

    /** Compact byte count for a list row. */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /**
     * Fetch one JSON route and fail loudly on a non-2xx response.
     * @param url - absolute path.
     * @returns the parsed body.
     */
    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`)
      return await response.json()
    }

    /**
     * Fetch one JSON route without throwing, so a refusal keeps its own reason.
     * @param url - absolute path.
     * @returns `{ ok, status, body }`.
     */
    async function requestJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      let body = null
      try {
        body = await response.json()
      } catch (error) {
        body = null
      }
      return { ok: response.ok, status: response.status, body }
    }

    /**
     * POST one JSON route, surfacing the host's `error` text when it refuses.
     * @param url - absolute path.
     * @param body - JSON payload.
     * @returns the parsed body.
     */
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      let parsed = null
      try {
        parsed = await response.json()
      } catch (error) {
        parsed = null
      }
      if (!response.ok) throw new Error(parsed?.error ?? `${url} → HTTP ${response.status}`)
      return parsed
    }

    /**
     * One overview request shared by every session-side surface.
     *
     * Three independently-mounted surfaces each need "which project owns this
     * session", and asking the host three times per session row is exactly the
     * kind of cost that makes a small feature feel heavy.
     */
    let overviewCache = { at: 0, promise: null }
    const OVERVIEW_CACHE_MS = 5000

    /**
     * Load the project overview, coalescing concurrent callers.
     * @returns the overview, or null when it could not be read.
     */
    function loadOverview() {
      const now = Date.now()
      if (overviewCache.promise !== null && now - overviewCache.at < OVERVIEW_CACHE_MS) return overviewCache.promise
      overviewCache = { at: now, promise: getJson(`${ROUTE_BASE}/overview`).catch(() => null) }
      return overviewCache.promise
    }

    /**
     * The project a session belongs to, or null when it belongs to none.
     * @param sessionId - the session to resolve.
     * @returns the project row, or null.
     */
    async function findProjectForSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      const overview = await loadOverview()
      const projects = Array.isArray(overview?.projects) ? overview.projects : []
      return projects.find((row) => Array.isArray(row.sessionIds) && row.sessionIds.includes(sessionId)) ?? null
    }

    /**
     * Cross-surface intent: a session-side action asks the main panel to focus.
     *
     * The session-side surfaces deliberately do not dispatch anything themselves.
     * They land the user on the one place that confirms before sending, because
     * two send paths would mean two chances to send something unreviewed.
     */
    const focusIntent = { value: null, listeners: new Set() }

    /**
     * Publish a focus request.
     * @param intent - `{ kind, path, title }`.
     */
    function requestFocus(intent) {
      focusIntent.value = intent
      for (const listener of Array.from(focusIntent.listeners)) {
        try {
          listener(intent)
        } catch (error) {
          // One bad listener must not break the user's click.
        }
      }
    }

    /**
     * Observe focus requests.
     * @param listener - called with each new intent.
     * @returns an unsubscribe function.
     */
    function subscribeFocus(listener) {
      focusIntent.listeners.add(listener)
      return () => {
        focusIntent.listeners.delete(listener)
      }
    }

    /**
     * The interface language, as a prompt language id.
     * @param localeService - the `locale` client service.
     * @returns `'zh'` or `'en'`.
     */
    function interfaceLanguage(localeService) {
      try {
        const snapshot = localeService?.getSnapshot?.() ?? localeService?.getLocale?.()
        const active = String(snapshot?.active ?? '')
        return active.toLowerCase().startsWith('en') ? 'en' : 'zh'
      } catch (error) {
        return 'zh'
      }
    }

    /** Client-side defaults, mirroring `lib/settings.js`; the suite compares them. */
    const SETTINGS_FALLBACK = {
      sessionBar: true,
      turnTail: true,
      sessionHover: true,
      wayfinderThreshold: 12,
      promptLanguage: 'auto',
    }

    /**
     * Settings are global and shared by everything that reads them, so they live
     * in one cache with subscribers rather than being fetched per surface. That
     * is also what makes a change take effect without a reload.
     */
    let settingsCache = { value: null, promise: null }
    const settingsListeners = new Set()

    /** The last settings this page has seen, or null. */
    function currentSettings() {
      return settingsCache.value
    }

    /**
     * Publish new settings to every subscriber.
     * @param next - the settings object.
     */
    function applySettings(next) {
      settingsCache.value = next
      for (const listener of Array.from(settingsListeners)) {
        try {
          listener(next)
        } catch (error) {
          // One bad subscriber must not stop the others from updating.
        }
      }
    }

    /**
     * Observe settings changes.
     * @param listener - called with each new settings object.
     * @returns an unsubscribe function.
     */
    function subscribeSettings(listener) {
      settingsListeners.add(listener)
      return () => {
        settingsListeners.delete(listener)
      }
    }

    /**
     * Fetch the settings once, sharing the request.
     * @param force - refetch even if a request is in flight.
     * @returns the settings, or null when they could not be read.
     */
    function loadSettings(force = false) {
      if (force !== true && settingsCache.promise !== null) return settingsCache.promise
      const promise = getJson(`${ROUTE_BASE}/settings`)
        .then((body) => {
          const next = body?.settings ?? null
          if (next !== null) applySettings(next)
          return next
        })
        .catch(() => null)
      settingsCache = { value: settingsCache.value, promise }
      return promise
    }

    /** Whether one session-side surface should render, per the switches. */
    function surfaceEnabled(key, settings) {
      const effective = settings ?? settingsCache.value ?? SETTINGS_FALLBACK
      const field = key === 'bar' ? 'sessionBar' : key === 'turnTail' ? 'turnTail' : key === 'hover' ? 'sessionHover' : null
      if (field === null) return true
      return effective[field] !== false
    }

    /**
     * Render a failed `RemoteResult` as a sentence.
     *
     * Remote calls answer `{ ok: false, error }` rather than throwing, so every
     * one of them has to be unwrapped explicitly — and a failure that produced no
     * readable message must still read as a failure, not as silence.
     *
     * @param result - the result that failed.
     * @param fallback - text to use when the failure carries nothing readable.
     * @returns the message to show.
     */
    function describeRemoteFailure(result, fallback) {
      const failure = result?.error
      if (failure === null || failure === undefined) return fallback
      if (typeof failure === 'string' && failure.length > 0) return failure
      if (typeof failure.message === 'string' && failure.message.length > 0) return failure.message
      if (typeof failure.code === 'string' && failure.code.length > 0) return `${fallback} (${failure.code})`
      return fallback
    }

    /**
     * Run one dispatch: create or choose a session, send the prompt, then navigate.
     *
     * Extracted from the component on purpose. The order and the refusals are the
     * parts that would stay invisible until they broke: never navigate after a
     * failed send, never create a session when one was chosen, never send without
     * a target.
     *
     * @param operations - the injected side effects.
     * @param request - `{ text, choice, project }`.
     * @returns the session id the prompt went to.
     */
    async function performDispatch(operations, { text, choice, project }) {
      let sessionId = choice
      if (choice === 'new') {
        if (typeof operations?.createSession !== 'function') throw new Error('session creation is unavailable')
        sessionId = await operations.createSession(project ?? {})
      }
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('no target session was chosen')
      if (typeof operations?.sendPrompt !== 'function') throw new Error('sending a prompt is unavailable')
      await operations.sendPrompt(sessionId, text)
      if (typeof operations?.openSession === 'function') operations.openSession(sessionId)
      return sessionId
    }

    // ── shared style tokens ──────────────────────────────────────────────────

    const S = {
      page: {
        height: '100%',
        overflow: 'auto',
        paddingTop: 'var(--dsh-frame-top-clearance, 0px)',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
      },
      columns: { display: 'grid', gridTemplateColumns: '236px minmax(0, 1fr) 268px', minHeight: '100%' },
      col: { padding: '22px 18px 40px', borderRight: '1px solid var(--dsw-alias-border-l1)', minWidth: 0 },
      colLast: { padding: '22px 18px 40px', minWidth: 0 },
      h1: { fontSize: 20, lineHeight: 1.3, margin: '0 0 4px', letterSpacing: '-.2px' },
      lead: { margin: '0 0 18px', fontSize: 12.8, color: 'var(--dsw-alias-label-secondary)' },
      sectionTitle: {
        fontSize: 10.5,
        letterSpacing: '1.1px',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 700,
        margin: '0 0 9px',
      },
      card: {
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        padding: '14px 16px',
        marginBottom: 14,
      },
      row: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 10,
        padding: '9px 11px',
        marginBottom: 7,
      },
      rowActive: { borderColor: 'var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-bg-layer-2)' },
      /** Reset the user-agent button styling so a row can be a real button. */
      rowButton: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
      },
      rowHead: { display: 'flex', alignItems: 'baseline', gap: 7 },
      rowTitle: { fontSize: 13, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { display: 'flex', gap: 9, flexWrap: 'wrap', marginTop: 5, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      chip: { fontSize: 9.5, padding: '1px 6px', borderRadius: 5, border: '1px solid var(--dsw-alias-border-l2)', whiteSpace: 'nowrap' },
      banner: {
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderLeft: '3px solid var(--dsw-alias-brand-primary)',
        borderRadius: 10,
        padding: '12px 15px',
        marginBottom: 16,
      },
      bannerTitle: { fontSize: 13, fontWeight: 600, marginBottom: 3 },
      bannerBody: { fontSize: 12.4, color: 'var(--dsw-alias-label-secondary)', margin: 0, lineHeight: 1.6 },
      button: {
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '5px 11px',
        fontSize: 12,
        cursor: 'pointer',
        font: 'inherit',
      },
      buttonPrimary: {
        background: 'var(--dsw-alias-brand-primary)',
        // Text on the brand colour, read from the scheme's own base token rather
        // than a literal: a hardcoded `#fff` fails on a light accent.
        color: 'var(--dsw-alias-bg-base)',
        border: '0',
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        font: 'inherit',
      },
      errBox: {
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        borderRadius: 10,
        padding: '13px 15px',
      },
      muted: { fontSize: 12.4, color: 'var(--dsw-alias-label-secondary)' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 7 },
      skillChip: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: 9,
        padding: '8px 10px',
      },
      skillName: { fontSize: 12, fontWeight: 600 },
      skillDesc: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        lineHeight: 1.5,
        margin: '3px 0 0',
        display: '-webkit-box',
        WebkitLineClamp: 3,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      counts: { display: 'flex', gap: 12, fontSize: 11.6, marginBottom: 10, flexWrap: 'wrap' },
      textarea: {
        width: '100%',
        minHeight: 190,
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        padding: '10px 12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11.6,
        lineHeight: 1.6,
        resize: 'vertical',
      },
      picker: { display: 'grid', gap: 6, marginTop: 9 },
      groupLabel: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', margin: '9px 0 5px', fontWeight: 600 },
      artifact: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 7,
        padding: '5px 7px',
        borderRadius: 7,
        cursor: 'pointer',
        fontSize: 11.6,
        color: 'var(--dsw-alias-label-primary)',
      },
      artifactName: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      artifactMeta: { marginLeft: 'auto', fontSize: 10, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      pre: {
        margin: 0,
        padding: '12px 14px',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11.6,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: '58vh',
        overflow: 'auto',
      },
      previewHead: { display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 9, flexWrap: 'wrap' },
      previewPath: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.4, color: 'var(--dsw-alias-label-secondary)', minWidth: 0, wordBreak: 'break-all' },
    }

    /**
     * Human text for a git overview result.
     * @param git - the overview from the host.
     * @param t - translate function.
     * @returns the text to show, or null when there is a healthy repository.
     */
    function describeGit(git, t) {
      if (git?.ok !== true) {
        if (git?.reason === 'git-unavailable') return t('gitUnavailable')
        if (git?.reason === 'not-a-directory') return t('missingDir')
        return t('noGit')
      }
      return null
    }

    /**
     * Label for where a tracker resolution came from.
     * @param source - the resolution source.
     * @param t - translate function.
     * @returns the label, or null when the source is unknown.
     */
    function describeTrackerSource(source, t) {
      if (source === 'project-declaration') return t('trackerSourceDeclaration')
      if (source === 'workbench-mapping') return t('trackerSourceMapping')
      if (source === 'user-choice') return t('trackerSourceUser')
      if (source === 'global-default') return t('trackerSourceDefault')
      return null
    }

    /** Dictionary keys for the pipeline steps, in presentation order. */
    const STAGE_LABEL_KEYS = {
      setup: 'stageSetup',
      grill: 'stageGrill',
      spec: 'stageSpec',
      tickets: 'stageTickets',
      implement: 'stageImplement',
      review: 'stageReview',
      pr: 'stagePr',
      retro: 'stageRetro',
    }

    /**
     * Localized label for a stage id.
     * @param id - the stage id from the host.
     * @param t - translate function.
     * @returns the label, or the raw id when it is unknown.
     */
    function stageLabel(id, t) {
      const key = STAGE_LABEL_KEYS[id]
      return key === undefined ? String(id) : t(key)
    }

    /**
     * Localized reason for a refused preview, so the UI never shows mojibake or
     * a document that merely looks complete.
     * @param code - the refusal code from the host.
     * @param result - the refusal payload.
     * @param t - translate function.
     * @returns the sentence to show.
     */
    function describeRefusal(code, result, t) {
      if (code === 'binary') return t('previewBinary')
      if (code === 'too-large') {
        return translate(
          { text: t('previewTooLarge') },
          'text',
          { bytes: formatBytes(result?.bytes), max: formatBytes(result?.maxFileBytes) },
        )
      }
      if (code === 'not-utf8') return t('previewNotUtf8')
      if (code === 'missing') return t('previewMissing')
      if (code === 'not-a-file') return t('previewNotAFile')
      return t('previewRefused')
    }

    // ── pure components (the rendering seam tests exercise) ──────────────────

    /** One badge showing a project's tracker and where the decision came from. */
    function TrackerChip(props) {
      const { tracker, t } = props
      if (tracker === null || tracker === undefined) {
        return h(
          'span',
          {
            className: 'dw-chip dw-chip-unknown',
            style: { ...S.chip, color: 'var(--dsw-alias-state-warn-primary)', borderColor: 'var(--dsw-alias-state-warn-primary)' },
          },
          t('trackerUnknown'),
        )
      }
      const source = describeTrackerSource(tracker.source, t)
      return h(
        'span',
        {
          className: 'dw-chip dw-chip-tracker',
          style: { ...S.chip, color: 'var(--dsw-alias-label-primary)' },
          title: source === null ? tracker.label : `${tracker.label} · ${source}`,
        },
        tracker.label,
      )
    }

    /** One project row in the left column. */
    function ProjectRow(props) {
      const { project, t, onUnbind, onSelect, active } = props
      const gitNote = describeGit(project.git, t)
      const meta = []

      if (gitNote !== null) {
        meta.push(h('span', { key: 'gitNote', style: { color: 'var(--dsw-alias-label-secondary)' } }, gitNote))
      } else {
        meta.push(h('span', { key: 'branch', style: S.mono }, `${t('branch')} ${project.git.branch ?? '—'}`))
        meta.push(h('span', { key: 'dirty', style: S.mono }, `${t('dirty')} ${project.git.dirtyCount ?? '—'}`))
      }
      meta.push(h('span', { key: 'sessions', style: S.mono }, `${t('sessions')} ${project.sessionCount}`))
      if (project.directoryStatus === 'missing-dir') {
        meta.push(h('span', { key: 'missing', style: { color: 'var(--dsw-alias-state-error-primary)' } }, t('missingDir')))
      }

      const head = [h('span', { key: 'title', style: S.rowTitle }, project.title)]
      head.push(h(TrackerChip, { key: 'tracker', tracker: project.tracker, t }))
      // The badge is the last derived stage, persisted by `/stage`. A pinned stage
      // is marked in its tooltip, so a decision is never mistaken for a reading.
      const stageInfo = project.stage ?? null
      head.push(
        h(
          'span',
          {
            key: 'stage',
            className: 'dw-stage-badge',
            style: {
              ...S.chip,
              color: stageInfo === null ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-brand-primary)',
              borderColor: stageInfo === null ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-brand-primary)',
            },
            title: stageInfo?.overridden === true ? t('stageOverridden') : undefined,
          },
          stageInfo === null ? t('stageUnknown') : stageLabel(stageInfo.id, t),
        ),
      )

      const children = [
        h('div', { key: 'head', style: S.rowHead }, head),
        h('div', { key: 'meta', style: S.meta }, meta),
      ]

      if (typeof onUnbind === 'function') {
        children.push(
          h(
            'div',
            { key: 'actions', style: { marginTop: 7 } },
            h(
              'button',
              {
                type: 'button',
                className: 'dw-unbind',
                style: S.button,
                onClick: (event) => {
                  if (typeof event?.stopPropagation === 'function') event.stopPropagation()
                  onUnbind(project)
                },
              },
              t('unbind'),
            ),
          ),
        )
      }

      // A real button: the row is interactive, and a `div` with `onClick` cannot
      // be reached from the keyboard at all. `rowButton` resets the UA styling.
      return h(
        'button',
        {
          type: 'button',
          key: project.key,
          className: active === true ? 'dw-project dw-project-active' : 'dw-project',
          style: active === true ? { ...S.row, ...S.rowButton, ...S.rowActive } : { ...S.row, ...S.rowButton },
          disabled: typeof onSelect !== 'function',
          onClick: typeof onSelect === 'function' ? () => onSelect(project) : undefined,
        },
        children,
      )
    }

    /** The left column: the project list, plus whatever the caller adds below it. */
    function ProjectList(props) {
      const { projects, t, onUnbind, onSelect, activeKey, children } = props
      const rows = Array.isArray(projects) ? projects : []
      const body = rows.length === 0
        ? [h('p', { key: 'empty', style: S.muted }, t('noProjects'))]
        : rows.map((project) => h(ProjectRow, { key: project.key, project, t, onUnbind, onSelect, active: project.key === activeKey }))
      return h(
        'div',
        { className: 'dw-projects' },
        h('div', { style: S.sectionTitle }, t('projects')),
        ...body,
        children ?? null,
      )
    }

    /** The right column's artifact list, grouped the way the host grouped them. */
    function ArtifactGroups(props) {
      const { scan, t, selectedPath, onOpen, onResume } = props
      if (scan === null || scan === undefined) {
        return h('p', { style: S.muted }, t('artifactsLoading'))
      }
      const groups = Array.isArray(scan.groups) ? scan.groups : []
      if (groups.length === 0) {
        return h(
          'div',
          { className: 'dw-artifacts' },
          h('div', { style: S.sectionTitle }, t('artifacts')),
          h('p', { style: S.muted }, t('artifactsEmpty')),
        )
      }
      return h(
        'div',
        { className: 'dw-artifacts' },
        h('div', { style: S.sectionTitle }, t('artifacts')),
        ...groups.map((group) =>
          h(
            'div',
            { key: group.id, className: `dw-group dw-group-${group.id}` },
            h('div', { style: S.groupLabel }, group.label),
            ...group.items.map((item) =>
              h(
                'button',
                {
                  type: 'button',
                  key: item.path,
                  className: 'dw-artifact',
                  title: item.path,
                  style: item.path === selectedPath
                    ? { ...S.artifact, background: 'var(--dsw-alias-bg-layer-2)' }
                    : S.artifact,
                  onClick: () => onOpen(item),
                },
                h('span', { style: S.artifactName }, item.name),
                h('span', { style: S.artifactMeta }, `${formatBytes(item.bytes)} · ${formatWhen(item.mtime)}`),
                // Only a handoff can be resumed, and only while it is still there.
                item.kind === 'handoff' && typeof onResume === 'function'
                  ? h(
                      'button',
                      {
                        key: 'resume',
                        type: 'button',
                        className: 'dw-resume',
                        style: { ...S.button, padding: '1px 7px', fontSize: 10.5 },
                        onClick: (event) => {
                          if (typeof event?.stopPropagation === 'function') event.stopPropagation()
                          onResume(item)
                        },
                      },
                      t('actionResume'),
                    )
                  : null,
              ),
            ),
          ),
        ),
      )
    }

    /** The center column's read-only artifact preview. */
    function ArtifactPreview(props) {
      const { preview, t, onLoadMore, onClose } = props
      if (preview === null || preview === undefined) return null

      const item = preview.item
      const head = [
        h('span', { key: 'title', style: S.bannerTitle }, t('previewTitle')),
        h('span', { key: 'path', style: S.previewPath }, item?.path ?? ''),
        h(
          'button',
          { key: 'close', type: 'button', className: 'dw-preview-close', style: { ...S.button, marginLeft: 'auto' }, onClick: onClose },
          t('previewClose'),
        ),
      ]

      if (preview.status === 'loading') {
        return h('div', { className: 'dw-preview', style: S.card }, h('div', { style: S.previewHead }, head), h('p', { style: S.muted }, t('loading')))
      }

      if (preview.status === 'refused') {
        return h(
          'div',
          { className: 'dw-preview dw-preview-refused', style: { ...S.card, borderColor: 'var(--dsw-alias-state-warn-primary)' } },
          h('div', { style: S.previewHead }, head),
          h('p', { style: { ...S.bannerBody, color: 'var(--dsw-alias-state-warn-primary)' } }, describeRefusal(preview.code, preview.result, t)),
          h('p', { style: { ...S.bannerBody, marginTop: 5, opacity: 0.8 } }, preview.message ?? ''),
        )
      }

      const result = preview.result
      const shown = result.lines.length
      const footer = []
      footer.push(
        h('span', { key: 'progress', style: S.muted }, t('previewProgress', { shown, total: result.totalLines })),
      )
      if (result.hasMore === true) {
        footer.push(
          h(
            'button',
            { key: 'more', type: 'button', className: 'dw-preview-more', style: S.button, onClick: onLoadMore },
            t('previewMore', { n: result.totalLines - shown }),
          ),
        )
      } else {
        footer.push(h('span', { key: 'end', style: S.muted }, t('previewEnd')))
      }

      return h(
        'div',
        { className: 'dw-preview', style: S.card },
        h('div', { style: S.previewHead }, head),
        h('pre', { className: 'dw-preview-body', style: S.pre }, result.lines.join('\n')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 } }, footer),
      )
    }

    /**
     * The right column: the bundled-skill self-check.
     *
     * It renders four different claims that must never be confused: the skill is
     * there **and** DSH can see it; it is there but DSH cannot; it is there but
     * its frontmatter is broken (DSH skips it silently); or the catalog itself
     * could not be read, which is not a claim about the skills at all.
     */
    function SkillGrid(props) {
      const { status, t } = props
      if (status === null || status === undefined) {
        return h('p', { className: 'dw-skills', style: S.muted }, t('skillsLoading'))
      }

      const counts = status.counts ?? {}
      const rows = Array.isArray(status.rows) ? status.rows : []
      const other = Array.isArray(status.otherSkills) ? status.otherSkills : []
      const diagnosis = status.diagnosis ?? { code: 'ok', hint: null }

      const out = [
        h('div', { key: 'label', style: S.sectionTitle }, t('skillsTitle')),
        h(
          'div',
          { key: 'counts', style: S.counts },
          h('span', { key: 'total', style: S.muted }, t('skillsTotal', { n: counts.total ?? 0 })),
          h(
            'span',
            {
              key: 'discovered',
              style: { color: (counts.notDiscovered ?? 0) > 0 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)' },
            },
            t('skillsDiscovered', { n: counts.discovered ?? 0 }),
          ),
          h('span', { key: 'model', style: S.muted }, t('skillsModel', { n: counts.modelInvocable ?? 0 })),
          h('span', { key: 'human', style: S.muted }, t('skillsManual', { n: counts.humanOnly ?? 0 })),
        ),
      ]

      if (status.state !== undefined && status.state !== 'ready') {
        out.push(
          h(BoardNotice, {
            key: 'unavailable',
            tone: 'warn',
            title: t('skillsUnavailable'),
            detail: status.reason?.message ?? null,
          }),
        )
      }
      if (diagnosis.code !== 'ok' && diagnosis.hint !== null && diagnosis.hint !== undefined) {
        out.push(
          h(BoardNotice, {
            key: 'diagnosis',
            tone: diagnosis.code === 'none-discovered' || diagnosis.code === 'invalid-entries' ? 'error' : 'warn',
            title: t('skillsDiagnosis'),
            detail: diagnosis.hint,
          }),
        )
      }

      out.push(
        h(
          'div',
          { key: 'grid', style: S.grid },
          rows.map((row) => {
            const tone = row.status === 'discovered'
              ? row.modelInvocable
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-label-secondary)'
              : row.status === 'invalid'
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-state-warn-primary)'
            return h(
              'div',
              { key: row.name, className: `dw-skill dw-skill-${row.status}`, style: S.skillChip },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                h('span', { style: S.skillName }, row.name),
                h(
                  'span',
                  { style: { ...S.chip, marginLeft: 'auto', color: tone, borderColor: tone } },
                  row.status === 'discovered' ? (row.modelInvocable ? 'model' : 'human') : row.status,
                ),
              ),
              h('p', { style: S.skillDesc }, row.problems.length > 0 ? row.problems.join('; ') : row.description),
            )
          }),
        ),
      )

      if (other.length > 0) {
        out.push(
          h(
            'div',
            { key: 'other', style: { marginTop: 11 } },
            h('div', { style: { ...S.muted, fontSize: 10.5, marginBottom: 5 } }, t('skillsOther', { n: other.length })),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
              other.map((row) => h('span', { key: row.name, style: S.chip, title: `${row.source} / ${row.provider}` }, row.name)),
            ),
          ),
        )
      }

      out.push(h('p', { key: 'hint', style: { ...S.bannerBody, marginTop: 11 } }, t('skillsHint')))

      return h('div', { className: 'dw-skills', style: S.card }, out)
    }

    /** One step of the pipeline. */
    function StageStep(props) {
      const { entry, state, t } = props
      const color = state === 'done'
        ? 'var(--dsw-alias-state-success-primary)'
        : state === 'now'
          ? 'var(--dsw-alias-brand-primary)'
          : 'var(--dsw-alias-label-secondary)'
      return h(
        'span',
        {
          className: `dw-step dw-step-${state}`,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11.4,
            color,
            padding: '3px 7px',
            borderRadius: 7,
            border: state === 'now' ? `1px solid ${color}` : '1px solid transparent',
            fontWeight: state === 'now' ? 600 : 400,
            whiteSpace: 'nowrap',
          },
          title: t('stageSkill', { skill: entry.skill }),
        },
        h('span', { style: { fontSize: 10 } }, state === 'done' ? '✓' : state === 'now' ? '●' : '○'),
        stageLabel(entry.id, t),
      )
    }

    /**
     * The pipeline itself: what is done, what is current, what is next, and why —
     * plus the pin, which always shows the derivation it is overriding.
     */
    function StagePipeline(props) {
      const { stage, t, onOverride, onClearOverride, onDispatch, onHandoff } = props
      if (stage === null || stage === undefined) return h('p', { style: S.muted }, t('loading'))

      const steps = Array.isArray(stage.stages) ? stage.stages : []
      const completed = Array.isArray(stage.completed) ? stage.completed : []
      const evidence = Array.isArray(stage.evidence) ? stage.evidence : []
      const bypass = Array.isArray(stage.bypass) ? stage.bypass : []
      const current = stage.stage

      const head = [h('div', { key: 'label', style: { ...S.sectionTitle, marginBottom: 0 } }, t('stagePipeline'))]
      if (stage.overridden === true) {
        head.push(
          h(
            'span',
            {
              key: 'pin',
              style: {
                ...S.chip,
                marginLeft: 8,
                color: 'var(--dsw-alias-state-warn-primary)',
                borderColor: 'var(--dsw-alias-state-warn-primary)',
              },
            },
            t('stageOverridden'),
          ),
        )
        head.push(
          h('span', { key: 'derived', style: { ...S.muted, marginLeft: 8, fontSize: 11 } }, t('stageDerivedWas', { derived: stageLabel(stage.derived, t) })),
        )
      }

      const rows = [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', marginBottom: 9 } }, head),
        h(
          'div',
          { key: 'steps', className: 'dw-steps', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 } },
          ...steps.map((entry, index) => {
            const state = entry.id === current ? 'now' : completed.includes(entry.id) ? 'done' : 'pending'
            const node = h(StageStep, { key: entry.id, entry, state, t })
            if (index === steps.length - 1) return node
            return [node, h('span', { key: `${entry.id}-sep`, style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 10 } }, '›')]
          }),
        ),
      ]

      const currentEntry = steps.find((entry) => entry.id === current)
      if (currentEntry !== undefined) {
        const skill = currentEntry.alternative === undefined
          ? currentEntry.skill
          : `${currentEntry.skill} / ${currentEntry.alternative}`
        rows.push(h('div', { key: 'skill', style: { ...S.muted, marginTop: 8, fontSize: 11.6 } }, t('stageSkill', { skill })))
        if (typeof onDispatch === 'function' || typeof onHandoff === 'function') {
          const actions = []
          if (typeof onDispatch === 'function') {
            actions.push(
              h(
                'button',
                { key: 'dispatch', type: 'button', className: 'dw-dispatch-open', style: S.buttonPrimary, onClick: () => onDispatch(current) },
                `${t('dispatch')} · ${currentEntry.skill}`,
              ),
            )
          }
          if (typeof onHandoff === 'function') {
            actions.push(
              h(
                'button',
                { key: 'handoff', type: 'button', className: 'dw-handoff-open', style: S.button, onClick: () => onHandoff() },
                t('actionHandoff'),
              ),
            )
          }
          rows.push(h('div', { key: 'dispatch', style: { marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' } }, actions))
        }
      }

      for (const item of evidence) {
        rows.push(
          h('p', { key: `ev-${item.code}`, style: { ...S.muted, margin: '6px 0 0', fontSize: 11.6 } }, `${t('stageEvidenceNote')}：${item.note}`),
        )
      }

      for (const item of bypass) {
        rows.push(
          h(
            'div',
            { key: `by-${item.code}`, style: { ...S.banner, marginTop: 10, marginBottom: 0, borderLeftColor: 'var(--dsw-alias-state-warn-primary)' } },
            h('div', { style: S.bannerTitle }, `${t('stageBypass')} · ${item.skill}`),
            h('p', { style: S.bannerBody }, item.note),
          ),
        )
      }

      if (typeof onOverride === 'function') {
        const controls = steps.map((entry) =>
          h(
            'button',
            {
              key: entry.id,
              type: 'button',
              className: `dw-pin-${entry.id}`,
              style: { ...S.button, padding: '3px 8px', fontSize: 11 },
              onClick: () => onOverride(entry.id),
            },
            stageLabel(entry.id, t),
          ),
        )
        if (stage.overridden === true && typeof onClearOverride === 'function') {
          controls.push(
            h(
              'button',
              { key: 'clear', type: 'button', className: 'dw-pin-clear', style: { ...S.button, padding: '3px 8px', fontSize: 11 }, onClick: () => onClearOverride() },
              t('stageClearOverride'),
            ),
          )
        }
        rows.push(
          h(
            'div',
            { key: 'override', style: { marginTop: 12 } },
            h('div', { style: { ...S.muted, fontSize: 10.5, marginBottom: 5 } }, t('stageOverride')),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5 } }, controls),
          ),
        )
      }

      return h('div', { className: 'dw-pipeline', style: { ...S.card, marginTop: 14 } }, rows)
    }

    /** The middle column: heading, then the stage pipeline. */
    function StagePanel(props) {
      const { t, project, stage, onOverride, onClearOverride, onDispatch, onHandoff } = props
      return h(
        'div',
        { className: 'dw-stage' },
        h('h1', { style: S.h1 }, t('title')),
        h('p', { style: S.lead }, t('subtitle')),
        project === null || project === undefined
          ? h('p', { style: S.muted }, t('stageUnknown'))
          : h(StagePipeline, { stage, t, onOverride, onClearOverride, onDispatch, onHandoff }),
      )
    }

    /** Tracker picker shown when a project declares nothing, or disagrees. */
    function TrackerPicker(props) {
      const { pending, t, onChoose, busy } = props
      if (pending === null || pending === undefined) return null
      const body = []
      if (pending.conflict !== null && pending.conflict !== undefined) {
        body.push(
          h('div', { key: 'conflictTitle', style: S.bannerTitle }, t('trackerConflict')),
          h(
            'p',
            { key: 'conflictBody', style: S.bannerBody },
            t('trackerConflictHint', { declared: pending.conflict.declaredKind, mapped: pending.conflict.mappedKind }),
          ),
        )
      } else {
        body.push(
          h('div', { key: 'promptTitle', style: S.bannerTitle }, t('trackerPrompt')),
          h('p', { key: 'promptBody', style: S.bannerBody }, t('trackerPromptHint')),
        )
      }
      body.push(
        h(
          'div',
          { key: 'choices', style: S.picker },
          TRACKER_CHOICES.map((choice) =>
            h(
              'button',
              {
                key: choice.kind,
                type: 'button',
                className: `dw-choose-${choice.kind}`,
                style: S.buttonPrimary,
                disabled: busy === true,
                onClick: () => onChoose(choice.kind),
              },
              `${t('choose')} · ${choice.label}`,
            ),
          ),
        ),
      )
      return h('div', { className: 'dw-tracker-picker', style: { ...S.banner, borderLeftColor: 'var(--dsw-alias-state-warn-primary)' } }, body)
    }

    /** A tinted notice used by the board's non-ready states. */
    function BoardNotice(props) {
      const { tone, title, detail } = props
      const color = tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)'
      return h(
        'div',
        { className: 'dw-board-notice', style: { ...S.banner, borderLeftColor: color } },
        h('div', { style: S.bannerTitle }, title),
        detail === null || detail === undefined ? null : h('p', { style: S.bannerBody }, detail),
      )
    }

    /** One ticket card. */
    function TicketCard(props) {
      const { ticket, t } = props
      const tone = ticket.statusKind === 'done' ? 'done' : ticket.ready === true ? 'ready' : 'blocked'
      const toneColor = tone === 'ready'
        ? 'var(--dsw-alias-state-success-primary)'
        : tone === 'blocked'
          ? 'var(--dsw-alias-state-warn-primary)'
          : 'var(--dsw-alias-label-secondary)'

      const children = [
        h(
          'div',
          { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 7 } },
          h('span', { key: 'id', style: { ...S.mono, fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto' } }, `#${ticket.id}`),
          h('span', { key: 'title', style: { fontSize: 12.6, fontWeight: 600, minWidth: 0 } }, ticket.title),
          h(
            'span',
            { key: 'state', style: { ...S.chip, marginLeft: 'auto', color: toneColor, borderColor: toneColor } },
            tone === 'ready' ? t('boardReady') : tone === 'done' ? t('boardDone') : t('boardBlocked'),
          ),
        ),
        h(
          'div',
          { key: 'meta', style: S.meta },
          ticket.acceptance.total > 0
            ? h('span', { key: 'acceptance' }, t('boardAcceptance', { done: ticket.acceptance.done, total: ticket.acceptance.total }))
            : null,
          ticket.openBlockers.length > 0
            ? h(
                'span',
                { key: 'blockers', style: { color: 'var(--dsw-alias-state-warn-primary)' } },
                t('boardBlockedBy', { ids: ticket.openBlockers.map((id) => `#${id}`).join(', ') }),
              )
            : null,
          ticket.unknownBlockers.length > 0
            ? h(
                'span',
                { key: 'unknown', style: { color: 'var(--dsw-alias-state-warn-primary)' } },
                t('boardBlockedByUnknown', { ids: ticket.unknownBlockers.join(', ') }),
              )
            : null,
        ),
      ]

      if (ticket.acceptance.total > 0) {
        const percent = Math.round((ticket.acceptance.done / ticket.acceptance.total) * 100)
        children.push(
          h(
            'div',
            { key: 'bar', style: { height: 4, borderRadius: 3, background: 'var(--dsw-alias-border-l1)', marginTop: 6, overflow: 'hidden' } },
            h('i', { style: { display: 'block', height: '100%', width: `${percent}%`, background: toneColor } }),
          ),
        )
      }

      return h('div', { className: `dw-ticket dw-ticket-${tone}`, style: { ...S.row, marginBottom: 6 } }, children)
    }

    /**
     * The middle column's ticket board.
     *
     * Every non-ready state is rendered as its own explanation. A board that
     * silently shows nothing cannot be told apart from a project with no
     * tickets, which is exactly the confusion this surface exists to remove.
     */
    function TicketBoard(props) {
      const { board, t } = props
      if (board === null || board === undefined) {
        return h('p', { className: 'dw-board', style: S.muted }, t('loading'))
      }

      if (board.state === 'needs-tracker') {
        return h(
          'div',
          { className: 'dw-board' },
          h('div', { style: S.sectionTitle }, t('board')),
          h(BoardNotice, { tone: 'warn', title: t('boardNeedsTracker') }),
        )
      }
      if (board.state === 'unsupported') {
        return h(
          'div',
          { className: 'dw-board' },
          h('div', { style: S.sectionTitle }, t('board')),
          h(BoardNotice, { tone: 'warn', title: t('boardUnsupported', { kind: board.tracker?.kind ?? '?' }) }),
        )
      }
      if (board.state === 'unavailable') {
        return h(
          'div',
          { className: 'dw-board' },
          h('div', { style: S.sectionTitle }, t('board')),
          h(BoardNotice, {
            tone: 'warn',
            title: t('boardUnavailable', { reason: board.reason?.code ?? '?' }),
            detail: board.reason?.message ?? null,
          }),
        )
      }

      const tickets = Array.isArray(board.tickets) ? board.tickets : []
      const problems = Array.isArray(board.problems) ? board.problems : []

      const header = [h('div', { key: 'label', style: { ...S.sectionTitle, marginBottom: 0 } }, t('board'))]
      if (tickets.length > 0) {
        header.push(
          h(
            'span',
            {
              key: 'frontier',
              style: {
                ...S.chip,
                marginLeft: 8,
                color: 'var(--dsw-alias-state-success-primary)',
                borderColor: 'var(--dsw-alias-state-success-primary)',
              },
            },
            t('boardFrontier', { n: board.frontier?.length ?? 0 }),
          ),
        )
      }

      const cards = tickets.length === 0
        ? [h('p', { key: 'empty', style: S.muted }, t('boardEmpty'))]
        : tickets.map((ticket) => h(TicketCard, { key: ticket.id, ticket, t }))

      const warnings = []
      for (const problem of problems) {
        const ids = Array.isArray(problem.ids) ? problem.ids.join(', ') : ''
        if (problem.code === 'cycle') warnings.push(h('p', { key: 'cycle', style: { ...S.muted, color: 'var(--dsw-alias-state-warn-primary)' } }, t('boardProblemCycle', { ids })))
        else if (problem.code === 'self-blocked') warnings.push(h('p', { key: 'self', style: { ...S.muted, color: 'var(--dsw-alias-state-warn-primary)' } }, t('boardProblemSelf', { ids })))
        else if (problem.code === 'unknown-blocker') warnings.push(h('p', { key: 'unknown', style: { ...S.muted, color: 'var(--dsw-alias-state-warn-primary)' } }, t('boardProblemUnknown', { ids })))
        else if (problem.code === 'edges-unread') warnings.push(h('p', { key: 'unread', style: { ...S.muted, color: 'var(--dsw-alias-state-warn-primary)' } }, t('boardProblemUnread', { ids })))
      }

      return h(
        'div',
        { className: 'dw-board', style: { marginTop: 6 } },
        h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 9 } }, header),
        ...cards,
        ...warnings,
      )
    }

    /**
     * Short stand-in for a session id.
     *
     * The session list endpoint returns no title, so the picker shows a tail of
     * the id rather than inventing a name it cannot know.
     * @param sessionId - the full session id.
     * @returns the last segment, truncated.
     */
    function shortSessionId(sessionId) {
      const parts = String(sessionId ?? '').split('-')
      const tail = parts[parts.length - 1] ?? ''
      return tail.length > 8 ? tail.slice(0, 8) : tail
    }

    /**
     * The dispatch confirmation.
     *
     * Fully controlled — the container owns the draft, the choice, and the busy
     * state — which is what makes "what would be sent" assertable here without a
     * network or a reconciler.
     */
    function DispatchDialog(props) {
      const { prompt, draft, choice, sessions, busy, error, notice, t, onDraft, onChoice, onSend, onCopy, onClose } = props
      if (prompt === null || prompt === undefined) return null

      const targets = prompt.targets ?? {}
      const project = targets.project ?? {}
      const ticket = targets.ticket ?? null
      const handoff = targets.handoff ?? null
      const rows = []

      rows.push(
        h(
          'div',
          { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 12 } },
          h('div', { style: { ...S.bannerTitle, marginBottom: 0 } }, `${t('dispatchTitle')} · ${prompt.skill}`),
          h('button', { key: 'close', type: 'button', className: 'dw-dispatch-close', style: { ...S.button, marginLeft: 'auto' }, onClick: onClose }, t('dispatchCancel')),
        ),
      )

      rows.push(
        h(
          'div',
          { key: 'target', style: { marginBottom: 10 } },
          h('div', { style: { ...S.muted, fontSize: 10.5 } }, t('dispatchTarget')),
          h('div', { style: { fontSize: 12.4 } }, project.title ?? '—'),
          h('div', { style: { ...S.mono, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' } }, project.path ?? ''),
        ),
      )

      if (ticket !== null) {
        rows.push(
          h(
            'div',
            { key: 'ticket', style: { marginBottom: 10 } },
            h('div', { style: { ...S.muted, fontSize: 10.5 } }, t('dispatchTicket')),
            h('div', { style: { fontSize: 12.4 } }, `#${ticket.id} ${ticket.title}`),
          ),
        )
      }

      if (handoff !== null) {
        rows.push(
          h(
            'div',
            { key: 'handoff', style: { marginBottom: 10 } },
            h('div', { style: { ...S.muted, fontSize: 10.5 } }, t('dispatchHandoff')),
            h('div', { style: { ...S.mono, fontSize: 11, wordBreak: 'break-all' } }, handoff.path),
            h('div', { style: { ...S.muted, fontSize: 10.5, marginTop: 3 } }, handoff.exists === true ? t('dispatchHandoffResume') : t('dispatchHandoffNew')),
          ),
        )
      }

      const sessionControls = [
        h(
          'button',
          {
            key: 'new',
            type: 'button',
            className: choice === 'new' ? 'dw-choice-new dw-choice-on' : 'dw-choice-new',
            style: choice === 'new' ? S.buttonPrimary : S.button,
            onClick: () => onChoice?.('new'),
          },
          t('dispatchNew'),
        ),
      ]
      const sessionList = Array.isArray(sessions) ? sessions : []
      if (sessionList.length === 0) {
        sessionControls.push(h('span', { key: 'none', style: { ...S.muted, fontSize: 11 } }, t('dispatchNoSessions')))
      } else {
        for (const session of sessionList) {
          const active = choice === session.sessionId
          sessionControls.push(
            h(
              'button',
              {
                key: session.sessionId,
                type: 'button',
                className: active ? 'dw-choice-session dw-choice-on' : 'dw-choice-session',
                style: active ? S.buttonPrimary : S.button,
                title: session.sessionId,
                onClick: () => onChoice?.(session.sessionId),
              },
              `${shortSessionId(session.sessionId)}${session.running === true ? ' · running' : ''}`,
            ),
          )
        }
      }
      rows.push(
        h(
          'div',
          { key: 'session', style: { marginBottom: 10 } },
          h('div', { style: { ...S.muted, fontSize: 10.5, marginBottom: 5 } }, t('dispatchSession')),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' } }, sessionControls),
        ),
      )

      rows.push(
        h(
          'div',
          { key: 'prompt' },
          h('div', { style: { ...S.muted, fontSize: 10.5, marginBottom: 5 } }, t('dispatchPrompt')),
          h('textarea', {
            className: 'dw-dispatch-text',
            spellCheck: 'false',
            value: draft,
            onChange: (event) => onDraft?.(event?.target?.value ?? ''),
            style: S.textarea,
          }),
        ),
      )

      if (error !== null && error !== undefined) {
        rows.push(
          h('p', { key: 'error', style: { ...S.bannerBody, marginTop: 10, color: 'var(--dsw-alias-state-error-primary)' } }, t('dispatchFailed', { reason: error })),
        )
      }
      if (notice !== null && notice !== undefined) {
        rows.push(h('p', { key: 'notice', style: { ...S.muted, marginTop: 10 } }, notice))
      }

      const reusing = typeof choice === 'string' && choice !== 'new'
      rows.push(
        h(
          'div',
          { key: 'actions', style: { display: 'flex', gap: 7, marginTop: 13, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', { key: 'copy', type: 'button', className: 'dw-dispatch-copy', style: S.button, onClick: () => onCopy?.(draft) }, t('dispatchCopy')),
          h(
            'button',
            {
              key: 'send',
              type: 'button',
              className: 'dw-dispatch-send',
              style: S.buttonPrimary,
              disabled: busy === true,
              onClick: () => onSend?.(draft, choice),
            },
            busy === true ? t('dispatchSending') : reusing ? t('dispatchSendExisting') : t('dispatchSendNew'),
          ),
        ),
      )

      return h('div', { className: 'dw-dispatch', style: { ...S.card, borderColor: 'var(--dsw-alias-brand-primary)' } }, rows)
    }

    // ── session-side surfaces ────────────────────────────────────────────────
    //
    // Three additive seats in the official UI. None of them reaches into an
    // official control: each renders its own row or returns null, and all three
    // return null for a session that belongs to no registered project — so an
    // ordinary conversation is left exactly as DSH shipped it.

    /** Ambient bar under the composer card. */
    function SessionProjectBar(props) {
      const { project, stage, t, onAdvance, busy } = props
      if (project === null || project === undefined) return null
      return h(
        'div',
        {
          className: 'dw-session-bar',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 6,
            padding: '5px 10px',
            borderRadius: 8,
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
            fontSize: 12,
          },
        },
        h('span', { style: { fontSize: 12.4, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, project.title),
        stage === null || stage === undefined
          ? h('span', { style: { ...S.chip, color: 'var(--dsw-alias-label-secondary)' } }, t('stageUnknown'))
          : h('span', { style: { ...S.chip, color: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' } }, stageLabel(stage, t)),
        h(
          'button',
          {
            type: 'button',
            className: 'dw-session-advance',
            style: { ...S.button, marginLeft: 'auto', padding: '3px 10px', fontSize: 11.5 },
            disabled: busy === true,
            onClick: () => onAdvance?.(project),
          },
          t('sessionAdvance'),
        ),
      )
    }

    /** The three actions shown after a completed turn. */
    function TurnTailActions(props) {
      const { project, t, onRecord, onAdvance, onHandoff, busy } = props
      if (project === null || project === undefined) return null
      return h(
        'div',
        { className: 'dw-turn-tail', style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 } },
        h('button', { type: 'button', className: 'dw-turn-record', style: { ...S.button, padding: '3px 10px', fontSize: 11.5 }, disabled: busy === true, onClick: () => onRecord?.(project) }, t('sessionRecord')),
        h('button', { type: 'button', className: 'dw-turn-advance', style: { ...S.buttonPrimary, padding: '3px 10px', fontSize: 11.5 }, disabled: busy === true, onClick: () => onAdvance?.(project) }, t('sessionAdvanceNext')),
        h('button', { type: 'button', className: 'dw-turn-handoff', style: { ...S.button, padding: '3px 10px', fontSize: 11.5 }, disabled: busy === true, onClick: () => onHandoff?.(project) }, t('sessionHandoff')),
      )
    }

    /** One informational line in a session row's hover card. */
    function SessionHoverLine(props) {
      const { project, stage, t } = props
      if (project === null || project === undefined) return null
      return h(
        'div',
        {
          className: 'dw-hover-line',
          style: { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', padding: '2px 0' },
        },
        h('span', null, t('sessionProject')),
        h(
          'span',
          { style: { color: 'var(--dsw-alias-brand-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          stage === null || stage === undefined ? project.title : `${project.title} · ${stageLabel(stage, t)}`,
        ),
      )
    }

    /** Banner in the workbench explaining why a session-side action landed here. */
    function FocusBanner(props) {
      const { focus, t, onDismiss } = props
      if (focus === null || focus === undefined) return null
      const key = focus.kind === 'handoff' ? 'sessionFocusHandoff' : focus.kind === 'record' ? 'sessionFocusRecord' : 'sessionFocusAdvance'
      return h(
        'div',
        { className: 'dw-focus-banner', style: { ...S.banner, borderLeftColor: 'var(--dsw-alias-brand-primary)' } },
        h('div', { style: S.bannerTitle }, t(key, { title: focus.title ?? '—' })),
        h('p', { style: S.bannerBody }, t('sessionFocusHint')),
        h('button', { type: 'button', className: 'dw-focus-dismiss', style: { ...S.button, marginTop: 8 }, onClick: onDismiss }, t('sessionFocusDismiss')),
      )
    }

    /**
     * Wrap a pure session-side surface with project resolution.
     *
     * The wrapper owns the only async step and renders nothing until it settles,
     * so a session bound to no registered project never leaves a placeholder in
     * the DOM — and never flickers one in.
     *
     * @param Component - the pure surface to render.
     * @param mapProps - builds that surface's props from the resolved project.
     * @returns a slot occupant.
     */
    function makeSessionSurface(Component, mapProps, switchKey) {
      return function SessionSurface(props) {
        const { sessionId } = props
        const [project, setProject] = useState(null)
        const [settings, setSettings] = useState(currentSettings())
        useEffect(() => subscribeSettings(setSettings), [])
        useEffect(() => {
          let cancelled = false
          findProjectForSession(sessionId)
            .then((found) => {
              if (!cancelled) setProject(found)
            })
            .catch(() => {
              if (!cancelled) setProject(null)
            })
          return () => {
            cancelled = true
          }
        }, [sessionId])
        // Switched off is a decision, not an absence: render nothing at all.
        if (surfaceEnabled(switchKey, settings) !== true) return null
        if (project === null || project === undefined) return null
        return h(Component, { ...props, ...mapProps(project, props) })
      }
    }

    /**
     * Styles inline styles cannot express: focus rings, hover affordances, and
     * the reset a clickable row needs once it is a real button.
     *
     * Keyboard reachability is the point. Every interactive row is a real
     * `<button>`, and this makes its focus visible; the colours come from theme
     * tokens so nothing is pinned to one scheme.
     */
    const STYLE_ID = 'developer-workbench-styles'
    const STYLE_TEXT = [
      '.dw-artifact{display:flex;align-items:baseline;gap:7px;width:100%;text-align:left;background:transparent;border:0;font:inherit;color:inherit;cursor:pointer}',
      '.dw-artifact:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dw-project{cursor:pointer}',
      '.dw-project:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dw-settings-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}',
      '.dw-settings-row > label{display:flex;align-items:center;gap:7px;font-size:12.6px;cursor:pointer}',
      '.dw-settings-row .dw-settings-note{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto;max-width:54%}',
      '.dw-settings-row input[type="number"],.dw-settings-row select{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:4px 8px;font:inherit;font-size:12px}',
      '.dw-artifact:focus-visible,.dw-project:focus-visible,.dw-session-advance:focus-visible,.dw-turn-record:focus-visible,.dw-turn-advance:focus-visible,.dw-turn-handoff:focus-visible,.dw-dispatch-open:focus-visible,.dw-handoff-open:focus-visible,.dw-dispatch-send:focus-visible,.dw-dispatch-copy:focus-visible,.dw-dispatch-close:focus-visible,.dw-bind:focus-visible,.dw-unbind:focus-visible,.dw-resume:focus-visible,.dw-choice-new:focus-visible,.dw-choice-session:focus-visible,.dw-pin-clear:focus-visible,.dw-focus-dismiss:focus-visible,.dw-settings-row input:focus-visible,.dw-settings-row select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}',
    ].join('\n')

    /**
     * The settings page in the shell's Settings panel.
     *
     * Every row here changes something real. There is deliberately no "skills
     * install root": the skills are served from the plugin package, so such a
     * knob would control nothing — and the page says so rather than offering it.
     */
    function SettingsSection(props) {
      const { settings, t, busy, error, notice, onChange } = props
      const current = settings ?? SETTINGS_FALLBACK
      const rows = []

      const switchRow = (field, labelKey, noteKey) =>
        h(
          'div',
          { className: 'dw-settings-row', key: field },
          h(
            'label',
            null,
            h('input', {
              type: 'checkbox',
              className: `dw-setting-${field}`,
              checked: current[field] !== false,
              disabled: busy === true,
              onChange: (event) => onChange?.({ [field]: event.target.checked === true }),
            }),
            t(labelKey),
          ),
          h('span', { className: 'dw-settings-note' }, t(noteKey)),
        )

      rows.push(switchRow('sessionBar', 'settingSessionBar', 'settingSessionBarNote'))
      rows.push(switchRow('turnTail', 'settingTurnTail', 'settingTurnTailNote'))
      rows.push(switchRow('sessionHover', 'settingSessionHover', 'settingSessionHoverNote'))

      rows.push(
        h(
          'div',
          { className: 'dw-settings-row', key: 'wayfinderThreshold' },
          h('label', null, t('settingThreshold')),
          h('input', {
            type: 'number',
            className: 'dw-setting-wayfinderThreshold',
            min: 1,
            max: 200,
            value: String(current.wayfinderThreshold ?? SETTINGS_FALLBACK.wayfinderThreshold),
            disabled: busy === true,
            onChange: (event) => {
              const parsed = Number.parseInt(event?.target?.value ?? '', 10)
              if (Number.isInteger(parsed)) onChange?.({ wayfinderThreshold: parsed })
            },
          }),
          h('span', { className: 'dw-settings-note' }, t('settingThresholdNote')),
        ),
      )

      rows.push(
        h(
          'div',
          { className: 'dw-settings-row', key: 'promptLanguage' },
          h('label', null, t('settingPromptLanguage')),
          h(
            'select',
            {
              className: 'dw-setting-promptLanguage',
              value: current.promptLanguage ?? 'auto',
              disabled: busy === true,
              onChange: (event) => onChange?.({ promptLanguage: event.target.value }),
            },
            ['auto', 'zh', 'en'].map((value) =>
              h('option', { key: value, value }, value === 'auto' ? t('settingLanguageAuto') : value),
            ),
          ),
          h('span', { className: 'dw-settings-note' }, t('settingPromptLanguageNote')),
        ),
      )

      return h(
        'div',
        { className: 'dw-settings' },
        h('h2', { style: S.h1 }, t('settingsTitle')),
        h('p', { style: S.lead }, t('settingsLead')),
        ...rows,
        h('p', { style: { ...S.bannerBody, marginTop: 14 } }, t('settingsSkillsNote')),
        error === null || error === undefined ? null : h(BoardNotice, { tone: 'error', title: t('settingsFailed'), detail: error }),
        notice === null || notice === undefined ? null : h('p', { style: S.muted }, notice),
      )
    }

    /** Settings page container: owns loading, saving, and the notice. */
    function SettingsSectionContainer(props) {
      const t = typeof props?.t === 'function' ? props.t : makeTranslate(zh)
      const [settings, setSettings] = useState(currentSettings())
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)

      useEffect(() => {
        loadSettings(true)
        return subscribeSettings(setSettings)
      }, [])

      const onChange = useCallback(async (patch) => {
        if (typeof props?.saveSettings !== 'function') return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const next = await props.saveSettings(patch)
          // Publish immediately, so every other surface follows without a reload.
          if (next !== null && next !== undefined) applySettings(next)
          setNotice(t('settingsSaved'))
        } catch (nextError) {
          setError(nextError?.message ?? String(nextError))
        } finally {
          setBusy(false)
        }
      }, [props, t])

      return h(SettingsSection, { settings, t, busy, error, notice, onChange })
    }

    // ── container ────────────────────────────────────────────────────────────

    /**
     * The workbench page for the `main` key `developer-workbench`.
     *
     * Business props (`pickDirectory`, `bindProject`, `setProjectTracker`,
     * `unbindProject`) arrive from the slot's `inject`, so the pure components
     * above stay testable without a context or a network.
     */
    function WorkbenchPage(props) {
      const t = typeof props?.t === 'function' ? props.t : makeTranslate(zh)
      const [overview, setOverview] = useState(null)
      const [skillStatus, setSkillStatus] = useState(null)
      const [error, setError] = useState(null)
      const [pending, setPending] = useState(null)
      const [busy, setBusy] = useState(false)
      const [attempt, setAttempt] = useState(0)
      const [activeKey, setActiveKey] = useState(null)
      const [artifacts, setArtifacts] = useState(null)
      const [preview, setPreview] = useState(null)
      const [board, setBoard] = useState(null)
      const [stageInfo, setStageInfo] = useState(null)
      const [dispatchRequest, setDispatchRequest] = useState(null)
      const [dispatchDraft, setDispatchDraft] = useState('')
      const [dispatchChoice, setDispatchChoice] = useState('new')
      const [dispatchSessions, setDispatchSessions] = useState([])
      const [dispatchBusy, setDispatchBusy] = useState(false)
      const [dispatchError, setDispatchError] = useState(null)
      const [dispatchNotice, setDispatchNotice] = useState(null)
      const [focus, setFocus] = useState(null)
      const [settings, setSettings] = useState(currentSettings())

      useEffect(() => {
        loadSettings()
        return subscribeSettings(setSettings)
      }, [])

      // A session-side action lands the user here; the banner says why.
      useEffect(() => subscribeFocus(setFocus), [])

      useEffect(() => {
        let cancelled = false
        setError(null)
        getJson(`${ROUTE_BASE}/overview`)
          .then((nextOverview) => {
            if (cancelled) return
            setOverview(nextOverview)
          })
          .catch((nextError) => {
            if (cancelled) return
            setError(nextError?.message ?? String(nextError))
          })
        return () => {
          cancelled = true
        }
      }, [attempt])

      const projects = overview?.projects ?? []
      const activeProject = projects.find((row) => row.key === activeKey) ?? projects[0] ?? null
      const activePath = activeProject === null ? null : activeProject.path

      useEffect(() => {
        if (activePath === null) {
          setArtifacts(null)
          return undefined
        }
        let cancelled = false
        setArtifacts(null)
        setPreview(null)
        getJson(`${ROUTE_BASE}/artifacts?path=${encodeURIComponent(activePath)}`)
          .then((next) => {
            if (!cancelled) setArtifacts(next)
          })
          .catch(() => {
            // A project whose artifacts cannot be scanned is not an error worth a
            // banner: the group simply has nothing to show.
            if (!cancelled) setArtifacts({ groups: [] })
          })
        return () => {
          cancelled = true
        }
      }, [activePath, attempt])

      // The board has its own request: it is a different tracker, a different
      // failure mode, and a different refresh cadence from the artifact scan.
      useEffect(() => {
        if (activePath === null) {
          setBoard(null)
          return undefined
        }
        let cancelled = false
        setBoard(null)
        getJson(`${ROUTE_BASE}/tickets?path=${encodeURIComponent(activePath)}`)
          .then((next) => {
            if (!cancelled) setBoard(next)
          })
          .catch(() => {
            if (!cancelled) {
              setBoard({ state: 'unavailable', reason: { code: 'request-failed' }, tickets: [], frontier: [], problems: [] })
            }
          })
        return () => {
          cancelled = true
        }
      }, [activePath, attempt])

      // `/stage` is the one request that also writes on the host: it caches the
      // result so the left column's badge stays cheap.
      useEffect(() => {
        if (activePath === null) {
          setStageInfo(null)
          return undefined
        }
        let cancelled = false
        setStageInfo(null)
        getJson(`${ROUTE_BASE}/stage?path=${encodeURIComponent(activePath)}`)
          .then((next) => {
            if (!cancelled) setStageInfo(next)
          })
          .catch(() => {
            if (!cancelled) setStageInfo(null)
          })
        return () => {
          cancelled = true
        }
      }, [activePath, attempt])

      // The skill self-check is project-scoped: DSH resolves the catalog against
      // the project's cwd, so a project with its own skills reports them too.
      useEffect(() => {
        let cancelled = false
        setSkillStatus(null)
        const url = activePath === null
          ? `${ROUTE_BASE}/skills/status`
          : `${ROUTE_BASE}/skills/status?path=${encodeURIComponent(activePath)}`
        getJson(url)
          .then((next) => {
            if (!cancelled) setSkillStatus(next)
          })
          .catch(() => {
            if (!cancelled) setSkillStatus(null)
          })
        return () => {
          cancelled = true
        }
      }, [activePath, attempt])

      const reload = useCallback(() => setAttempt((value) => value + 1), [])

      const openArtifact = useCallback(async (item) => {
        setPreview({ status: 'loading', item })
        const response = await requestJson(`${ROUTE_BASE}/artifact?path=${encodeURIComponent(item.path)}`)
        if (response.ok === true) {
          setPreview({ status: 'ready', item, result: response.body })
          return
        }
        setPreview({
          status: 'refused',
          item,
          code: response.body?.code ?? 'unknown',
          result: response.body,
          message: response.body?.message ?? `HTTP ${response.status}`,
        })
      }, [])

      const loadMore = useCallback(async () => {
        if (preview?.status !== 'ready') return
        const loaded = preview.result.lines.length
        const response = await requestJson(
          `${ROUTE_BASE}/artifact?path=${encodeURIComponent(preview.item.path)}&offset=${loaded}`,
        )
        if (response.ok !== true) return
        setPreview({
          status: 'ready',
          item: preview.item,
          result: { ...response.body, lines: [...preview.result.lines, ...response.body.lines] },
        })
      }, [preview])

      const closeArtifact = useCallback(() => setPreview(null), [])

      /** Pin a stage. The derivation keeps running and is still reported. */
      const overrideStage = useCallback(async (stageId) => {
        if (activePath === null || typeof props?.setStageOverride !== 'function') return
        setBusy(true)
        try {
          await props.setStageOverride(activePath, stageId)
          reload()
        } catch (nextError) {
          setError(nextError?.message ?? String(nextError))
        } finally {
          setBusy(false)
        }
      }, [activePath, props, reload])

      /** Drop the pin and go back to whatever the facts say. */
      const clearStageOverride = useCallback(async () => {
        if (activePath === null || typeof props?.setStageOverride !== 'function') return
        setBusy(true)
        try {
          await props.setStageOverride(activePath, null)
          reload()
        } catch (nextError) {
          setError(nextError?.message ?? String(nextError))
        } finally {
          setBusy(false)
        }
      }, [activePath, props, reload])

      /** Ask the host what this step would say, then show it before sending it. */
      const openDispatch = useCallback(async (stageId, options = {}) => {
        if (activePath === null) return
        setDispatchError(null)
        setDispatchNotice(null)
        setDispatchBusy(true)
        try {
          let url = `${ROUTE_BASE}/prompt?path=${encodeURIComponent(activePath)}&stage=${encodeURIComponent(stageId)}`
          if (typeof options.handoff === 'string' && options.handoff.length > 0) {
            url += `&handoff=${encodeURIComponent(options.handoff)}`
          }
          // The prompt follows the interface unless a language is pinned.
          const lang = typeof props?.promptLang === 'function' ? props.promptLang() : null
          if (typeof lang === 'string' && lang.length > 0) url += `&lang=${encodeURIComponent(lang)}`
          const built = await getJson(url)
          setDispatchRequest(built)
          setDispatchDraft(built.text)
          setDispatchChoice('new')
          // The session list is a convenience: without it the dialog still offers
          // a new session, which is the path that always works.
          if (typeof props?.listSessions === 'function') {
            try {
              const listed = await props.listSessions()
              setDispatchSessions((Array.isArray(listed) ? listed : []).filter((row) => row.cwd === activePath))
            } catch (listError) {
              setDispatchSessions([])
            }
          } else {
            setDispatchSessions([])
          }
        } catch (nextError) {
          // A prompt that could not be generated is a page-level failure: there is
          // nothing to confirm, so the dialog must not open half-built.
          setError(nextError?.message ?? String(nextError))
        } finally {
          setDispatchBusy(false)
        }
      }, [activePath, props])

      const closeDispatch = useCallback(() => {
        setDispatchRequest(null)
        setDispatchError(null)
        setDispatchNotice(null)
      }, [])

      const sendDispatch = useCallback(async (text, choice) => {
        if (dispatchRequest === null || typeof props?.sendPrompt !== 'function') return
        setDispatchBusy(true)
        setDispatchError(null)
        setDispatchNotice(null)
        try {
          const sentTo = await performDispatch(props, {
            text,
            choice,
            project: dispatchRequest.targets?.project ?? {},
          })
          // Record the handoff when it is dispatched, not when it shows up on disk:
          // the workbench chose the path, so it already knows it — and a record
          // whose file is missing is a far better failure than a handoff nobody
          // can find again.
          const handoff = dispatchRequest.targets?.handoff ?? null
          if (dispatchRequest.stage === 'handoff' && handoff !== null && typeof props.recordHandoff === 'function') {
            await props.recordHandoff(dispatchRequest.targets.project.path, handoff.path, sentTo)
          }
          setDispatchRequest(null)
          reload()
        } catch (nextError) {
          // Keep the dialog open: a failed send must never look like a success.
          setDispatchError(nextError?.message ?? String(nextError))
        } finally {
          setDispatchBusy(false)
        }
      }, [dispatchRequest, props, reload])

      const copyDispatch = useCallback(async (text) => {
        if (typeof props?.copyText !== 'function') return
        try {
          await props.copyText(text)
          setDispatchNotice(t('dispatchCopied'))
        } catch (nextError) {
          setDispatchError(nextError?.message ?? String(nextError))
        }
      }, [props, t])

      // A session-side action opens the confirmation for what it asked for. The
      // intent object carries its own `handled` mark, so a later re-render cannot
      // open the same dialog twice.
      useEffect(() => {
        if (focus === null || focus.handled === true) return
        focus.handled = true
        if (focus.kind === 'handoff') {
          openDispatch('handoff')
        } else if (focus.kind === 'advance' && typeof stageInfo?.stage === 'string') {
          openDispatch(stageInfo.stage)
        }
      }, [focus, stageInfo, openDispatch])

      const onBind = useCallback(async () => {
        if (typeof props?.pickDirectory !== 'function') return
        setBusy(true)
        try {
          const chosen = await props.pickDirectory()
          if (chosen === null || chosen === undefined) return
          const result = await props.bindProject(chosen)
          if (result?.needsChoice === true) {
            setPending({ path: result.project?.path ?? chosen, conflict: result.conflict ?? null })
          }
          reload()
        } catch (nextError) {
          setError(nextError?.message ?? String(nextError))
        } finally {
          setBusy(false)
        }
      }, [props, reload])

      const onChoose = useCallback(async (kind) => {
        if (pending === null || typeof props?.setProjectTracker !== 'function') return
        setBusy(true)
        try {
          await props.setProjectTracker(pending.path, kind)
          setPending(null)
          reload()
        } catch (nextError) {
          setError(nextError?.message ?? String(nextError))
        } finally {
          setBusy(false)
        }
      }, [pending, props, reload])

      const onUnbind = useCallback(async (project) => {
        if (typeof props?.unbindProject !== 'function') return
        setBusy(true)
        try {
          await props.unbindProject(project.path)
          reload()
        } catch (nextError) {
          setError(nextError?.message ?? String(nextError))
        } finally {
          setBusy(false)
        }
      }, [props, reload])

      const left = h(
        ProjectList,
        {
          projects,
          t,
          activeKey: activeProject?.key ?? null,
          onSelect: (project) => setActiveKey(project.key),
          onUnbind,
          children: h(
            'div',
            { style: { marginTop: 10 } },
            h(
              'button',
              { type: 'button', className: 'dw-bind', style: S.buttonPrimary, disabled: busy, onClick: onBind },
              busy ? t('binding') : t('bind'),
            ),
            h('p', { style: { ...S.muted, marginTop: 9, fontSize: 11 } }, t('projectsHint')),
            h(TrackerPicker, { pending, t, onChoose, busy }),
          ),
        },
      )

      const middle = error !== null
        ? h(
            'div',
            { style: S.errBox },
            h('div', { style: S.bannerTitle }, t('errorTitle')),
            h('p', { style: S.bannerBody }, error),
            h('p', { style: { ...S.bannerBody, marginTop: 5, opacity: 0.85 } }, t('errorHint')),
            h('button', { type: 'button', style: { ...S.button, marginTop: 9 }, onClick: reload }, t('retry')),
          )
        : overview === null
          ? h('p', { style: S.muted }, t('loading'))
          : dispatchRequest !== null
            ? h(DispatchDialog, {
                prompt: dispatchRequest,
                draft: dispatchDraft,
                choice: dispatchChoice,
                sessions: dispatchSessions,
                busy: dispatchBusy,
                error: dispatchError,
                notice: dispatchNotice,
                t,
                onDraft: setDispatchDraft,
                onChoice: setDispatchChoice,
                onSend: sendDispatch,
                onCopy: copyDispatch,
                onClose: closeDispatch,
              })
            : preview !== null
              ? h(ArtifactPreview, { preview, t, onLoadMore: loadMore, onClose: closeArtifact })
              : h(
                  'div',
                  null,
                  h(FocusBanner, { focus, t, onDismiss: () => setFocus(null) }),
                  h(StagePanel, {
                    t,
                    project: activeProject,
                    stage: stageInfo,
                    onOverride: overrideStage,
                    onClearOverride: clearStageOverride,
                    onDispatch: openDispatch,
                    onHandoff: () => openDispatch('handoff'),
                  }),
                  h(TicketBoard, { board, t }),
                )

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.columns },
          h('div', { style: S.col }, left),
          h('div', { style: S.col }, middle),
          h(
            'div',
            { style: S.colLast },
            h(ArtifactGroups, { scan: artifacts, t, selectedPath: preview?.item?.path ?? null, onOpen: openArtifact, onResume: (item) => openDispatch('resume', { handoff: item.path }) }),
            h(SkillGrid, { status: skillStatus, t }),
          ),
        ),
      )
    }

    // ── sidebar glyph ────────────────────────────────────────────────────────

    /** Icon row glyph for the sidebar panel list. */
    function WorkbenchIcon(props) {
      const size = props?.size ?? 16
      const active = props?.active === true
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('rect', { x: 1.6, y: 1.6, width: 12.8, height: 12.8, rx: 3, stroke: 'currentColor', strokeWidth: 1.3, opacity: active ? 1 : 0.92 }),
        h('path', { d: 'M4.6 6.1h6.8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M4.6 8.8h6.8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', opacity: 0.72 }),
        h('path', { d: 'M4.6 11.5h3.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', opacity: 0.45 }),
      )
    }

    // ── plugin body ──────────────────────────────────────────────────────────

    /**
     * Register the sidebar entry and the panel it opens.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'developer-workbench: dictionaries')
      const t = ctx.locale.bind(NS)

      const workspaceNavigation = ctx.get('uiWorkspace')
      const layout = ctx.get('layout')

      // The icon row. `inject` is declaration-aware, so this activates whether
      // this plugin loads before or after the sidebar that declares the slot.
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            // Ascending order: the shipped Plugins page uses 0, New Session is
            // shell chrome above the whole list, so a negative value places this
            // row between them.
            order: -10,
            label: () => t('panel'),
            locale: NS,
          },
          WorkbenchIcon,
        ),
      )

      // The page, addressed by the same id through the layout's keyed slot.
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({
              pickDirectory: () => workspaceNavigation?.pickDirectory(),
              bindProject: (projectPath) => postJson(`${ROUTE_BASE}/projects/bind`, { path: projectPath }),
              setProjectTracker: (projectPath, kind) => postJson(`${ROUTE_BASE}/projects/tracker`, { path: projectPath, kind }),
              unbindProject: (projectPath) => postJson(`${ROUTE_BASE}/projects/unbind`, { path: projectPath }),
              setStageOverride: (projectPath, stageId) => postJson(`${ROUTE_BASE}/projects/stage`, { path: projectPath, stage: stageId }),
              recordHandoff: (projectPath, handoffPath, sessionId) =>
                postJson(`${ROUTE_BASE}/projects/handoff`, { path: projectPath, handoffPath, sessionId }),
              // Dispatch is the one place the workbench writes into a session, so
              // every step is explicit and every failure is surfaced.
              createSession: async (project) => {
                const request = project?.workspaceId ? { workspaceId: project.workspaceId } : { cwd: project?.path }
                const result = await ctx.remote.session.create(request)
                if (result?.ok !== true) throw new Error(describeRemoteFailure(result, 'could not create a session'))
                return result.value.sessionId
              },
              sendPrompt: async (sessionId, text) => {
                const result = await ctx.remote.session.prompt({
                  requestId: `dw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  sessionId,
                  mode: 'queue',
                  content: [{ type: 'text', text }],
                })
                if (result?.ok !== true) throw new Error(describeRemoteFailure(result, 'the session refused the prompt'))
                return result.value
              },
              openSession: (sessionId) => {
                workspaceNavigation?.openSession(sessionId)
              },
              listSessions: async () => {
                const result = await ctx.remote.session.list({})
                if (result?.ok !== true) return []
                return (result.value?.items ?? []).map((item) => ({
                  sessionId: item.sessionId,
                  cwd: item.cwd ?? null,
                  running: item.running === true,
                  blank: item.blank === true,
                }))
              },
              copyText: async (text) => {
                if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
                  throw new Error('the clipboard is unavailable in this context')
                }
                await navigator.clipboard.writeText(text)
              },
              promptLang: () => interfaceLanguage(ctx.locale),
            }),
          },
          WorkbenchPage,
        ),
      )

      // Three additive session-side seats. Each shows state and hands the user to
      // the one surface that confirms before sending; none of them dispatches, so
      // there is exactly one send path to review.
      const focusOn = (kind) => (project) => {
        requestFocus({ kind, path: project?.path ?? null, title: project?.title ?? null })
        try {
          layout?.selectPanel(PANEL_ID)
        } catch (error) {
          // A missing main panel must not turn a click into an exception.
        }
      }

      const SessionBarSurface = makeSessionSurface(SessionProjectBar, (project) => ({
        project,
        stage: project.stage?.id ?? null,
        onAdvance: focusOn('advance'),
      }), 'bar')
      const TurnTailSurface = makeSessionSurface(TurnTailActions, (project) => ({
        project,
        onRecord: focusOn('record'),
        onAdvance: focusOn('advance'),
        onHandoff: focusOn('handoff'),
      }), 'turnTail')
      const HoverSurface = makeSessionSurface(SessionHoverLine, (project) => ({
        project,
        stage: project.stage?.id ?? null,
      }), 'hover')

      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'developer-workbench.bar', order: 100, locale: NS },
          SessionBarSurface,
        ),
      )
      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          { name: 'conversation.chat.turnTail', id: 'developer-workbench.turnTail', order: 100, locale: NS },
          TurnTailSurface,
        ),
      )
      ctx.slots.inject('sidebar.session.row.hover', () =>
        ctx.slots.register(
          { name: 'sidebar.session.row.hover', id: 'developer-workbench.hover', order: 100, locale: NS },
          HoverSurface,
        ),
      )

      // Focus rings and hover affordances need a stylesheet: inline styles cannot
      // express a pseudo-class. The sheet carries no colours of its own — every
      // rule reads a theme token, so it follows a scheme switch.
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        if (document.getElementById(STYLE_ID) !== null) return () => {}
        const element = document.createElement('style')
        element.id = STYLE_ID
        element.textContent = STYLE_TEXT
        document.head.append(element)
        return () => {
          element.remove()
        }
      }, 'developer-workbench: styles')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: PANEL_ID,
            order: 40,
            label: () => t('settingsTitle'),
            locale: NS,
            inject: () => ({
              saveSettings: (patch) => postJson(`${ROUTE_BASE}/settings`, patch).then((body) => body?.settings ?? null),
            }),
          },
          SettingsSectionContainer,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'developer-workbench'
    exports.PANEL_ID = PANEL_ID
    exports.NS = NS
    /** Rendering seam for `scripts/verify.mjs`; not part of the plugin contract. */
    exports.__test = {
      WorkbenchPage,
      ProjectList,
      ProjectRow,
      TrackerChip,
      TrackerPicker,
      ArtifactGroups,
      ArtifactPreview,
      BoardNotice,
      TicketBoard,
      TicketCard,
      DispatchDialog,
      performDispatch,
      SessionProjectBar,
      TurnTailActions,
      SessionHoverLine,
      FocusBanner,
      makeSessionSurface,
      findProjectForSession,
      loadOverview,
      requestFocus,
      subscribeFocus,
      SettingsSection,
      SettingsSectionContainer,
      surfaceEnabled,
      interfaceLanguage,
      currentSettings,
      applySettings,
      subscribeSettings,
      loadSettings,
      SETTINGS_FALLBACK,
      STYLE_TEXT,
      STYLE_ID,
      shortSessionId,
      describeRemoteFailure,
      StagePipeline,
      StageStep,
      stageLabel,
      STAGE_LABEL_KEYS,
      SkillGrid,
      StagePanel,
      describeGit,
      describeTrackerSource,
      describeRefusal,
      formatWhen,
      formatBytes,
      translate,
      TRACKER_CHOICES,
      dicts: { zh, en },
    }

    return module.exports
  },
})
