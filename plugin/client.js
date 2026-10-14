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

      return h(
        'div',
        {
          key: project.key,
          className: active === true ? 'dw-project dw-project-active' : 'dw-project',
          style: active === true ? { ...S.row, ...S.rowActive } : S.row,
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
      const { scan, t, selectedPath, onOpen } = props
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
                'div',
                {
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

    /** The right column's bundled-skill self-check. */
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
      const { t, project } = props
      return h(
        'div',
        { className: 'dw-stage' },
        h('h1', { style: S.h1 }, t('title')),
        h('p', { style: S.lead }, t('subtitle')),
        h(
          'div',
          { style: S.banner },
          h('div', { style: S.bannerTitle }, project === null || project === undefined ? t('stageUnknown') : project.title),
          h('p', { style: S.bannerBody }, t('stageBody')),
        ),
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
      const [activeKey, setActiveKey] = useState(null)
      const [artifacts, setArtifacts] = useState(null)
      const [preview, setPreview] = useState(null)

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
          : preview !== null
            ? h(ArtifactPreview, { preview, t, onLoadMore: loadMore, onClose: closeArtifact })
            : h(StagePanel, { t, project: activeProject })

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
            h(ArtifactGroups, { scan: artifacts, t, selectedPath: preview?.item?.path ?? null, onOpen: openArtifact }),
            h(SkillGrid, { inventory, t }),
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
    exports.__test = {
      WorkbenchPage,
      ProjectList,
      ProjectRow,
      TrackerChip,
      TrackerPicker,
      ArtifactGroups,
      ArtifactPreview,
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
