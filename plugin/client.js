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
      skillsTitle: 'Matt Pocock 技能自检',
      skillsTotal: '共 {n} 个',
      skillsModel: '可被模型加载 {n} 个',
      skillsManual: '仅人工调用 {n} 个',
      skillsHint: '带「仅人工」的技能设置了 disable-model-invocation，skill 工具加载不到；派发提示词会给出绝对路径让会话直接读取，两种方式都能跑通。',
      selfCheckFailed: '技能自检暂不可用',
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
      stageUnknown: 'Stage arrives next',
      stageBody: 'The project list is wired to real data. Next are the ticket board and stage derivation.',
      skillsTitle: 'Matt Pocock skill self-check',
      skillsTotal: '{n} total',
      skillsModel: '{n} model-loadable',
      skillsManual: '{n} human-only',
      skillsHint: 'Skills marked human-only set disable-model-invocation, so the skill tool cannot load them. Dispatch prompts pass the absolute path instead, so both paths work.',
      selfCheckFailed: 'Self-check unavailable',
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
        color: '#fff',
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
      picker: { display: 'grid', gap: 6, marginTop: 9 },
    }

    /**
     * Human text for a git overview result.
     * @param git - the overview from the host.
     * @param t - translate function.
     * @returns the text to show.
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
     * @returns the label.
     */
    function describeTrackerSource(source, t) {
      if (source === 'project-declaration') return t('trackerSourceDeclaration')
      if (source === 'workbench-mapping') return t('trackerSourceMapping')
      if (source === 'user-choice') return t('trackerSourceUser')
      if (source === 'global-default') return t('trackerSourceDefault')
      return null
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
      const { project, t, onUnbind } = props
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
      // The real stage derivation lands in its own ticket; until then the badge
      // says so rather than showing a stage nobody computed.
      head.push(
        h(
          'span',
          {
            key: 'stage',
            className: 'dw-stage-badge',
            style: { ...S.chip, color: 'var(--dsw-alias-label-secondary)' },
          },
          project.stage ?? t('stageUnknown'),
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
                onClick: () => onUnbind(project),
              },
              t('unbind'),
            ),
          ),
        )
      }

      return h('div', { key: project.key, className: 'dw-project', style: S.row }, children)
    }

    /** The left column: the project list, plus whatever the caller adds below it. */
    function ProjectList(props) {
      const { projects, t, onUnbind, children } = props
      const rows = Array.isArray(projects) ? projects : []
      const body = rows.length === 0
        ? [h('p', { key: 'empty', style: S.muted }, t('noProjects'))]
        : rows.map((project) => h(ProjectRow, { key: project.key, project, t, onUnbind }))
      return h(
        'div',
        { className: 'dw-projects' },
        h('div', { style: S.sectionTitle }, t('projects')),
        ...body,
        children ?? null,
      )
    }

    /** The right column: the bundled-skill self-check. */
    function SkillGrid(props) {
      const { inventory, t } = props
      if (inventory === null || inventory === undefined) {
        return h('p', { style: S.muted }, t('selfCheckFailed'))
      }
      const rows = Array.isArray(inventory.skills) ? inventory.skills : []
      const modelCount = rows.filter((row) => row.modelInvocable).length
      return h(
        'div',
        { style: S.card, className: 'dw-skills' },
        h('div', { style: S.sectionTitle }, t('skillsTitle')),
        h(
          'div',
          { style: S.counts },
          h('span', { key: 'total', style: S.muted }, t('skillsTotal', { n: rows.length })),
          h('span', { key: 'model', style: { color: 'var(--dsw-alias-state-success-primary)' } }, t('skillsModel', { n: modelCount })),
          h('span', { key: 'manual', style: S.muted }, t('skillsManual', { n: rows.length - modelCount })),
        ),
        h(
          'div',
          { style: S.grid },
          rows.map((row) =>
            h(
              'div',
              { key: row.name, className: 'dw-skill', style: S.skillChip },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                h('span', { style: S.skillName }, row.name),
                h(
                  'span',
                  {
                    style: {
                      ...S.chip,
                      marginLeft: 'auto',
                      color: row.modelInvocable ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
                    },
                  },
                  row.modelInvocable ? 'model' : 'human',
                ),
              ),
              h('p', { style: S.skillDesc }, row.description),
            ),
          ),
        ),
        h('p', { style: { ...S.bannerBody, marginTop: 11 } }, t('skillsHint')),
      )
    }

    /** The middle column's placeholder until the stage derivation lands. */
    function StagePanel(props) {
      const { t } = props
      return h(
        'div',
        { className: 'dw-stage' },
        h('h1', { style: S.h1 }, t('title')),
        h('p', { style: S.lead }, t('subtitle')),
        h('div', { style: S.banner }, h('div', { style: S.bannerTitle }, t('stageUnknown')), h('p', { style: S.bannerBody }, t('stageBody'))),
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
      const [inventory, setInventory] = useState(null)
      const [error, setError] = useState(null)
      const [pending, setPending] = useState(null)
      const [busy, setBusy] = useState(false)
      const [attempt, setAttempt] = useState(0)

      useEffect(() => {
        let cancelled = false
        setError(null)
        Promise.all([
          getJson(`${ROUTE_BASE}/overview`),
          getJson(`${ROUTE_BASE}/skills`).catch(() => null),
        ])
          .then(([nextOverview, nextInventory]) => {
            if (cancelled) return
            setOverview(nextOverview)
            setInventory(nextInventory)
          })
          .catch((nextError) => {
            if (cancelled) return
            setError(nextError?.message ?? String(nextError))
          })
        return () => {
          cancelled = true
        }
      }, [attempt])

      const reload = useCallback(() => setAttempt((value) => value + 1), [])

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
          projects: overview?.projects ?? [],
          t,
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
          : h(StagePanel, { t })

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.columns },
          h('div', { style: S.col }, left),
          h('div', { style: S.col }, middle),
          h('div', { style: S.colLast }, h(SkillGrid, { inventory, t })),
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
            }),
          },
          WorkbenchPage,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'developer-workbench'
    exports.PANEL_ID = PANEL_ID
    exports.NS = NS
    /** Rendering seam for `scripts/verify.mjs`; not part of the plugin contract. */
    exports.__test = { WorkbenchPage, ProjectList, ProjectRow, TrackerChip, TrackerPicker, SkillGrid, StagePanel, describeGit, describeTrackerSource, translate, TRACKER_CHOICES, dicts: { zh, en } }

    return module.exports
  },
})
