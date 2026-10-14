/**
 * dsh-developer-workbench — browser half.
 *
 * Hand-written ModuleLoader bundle: no build step, no install. The only modules
 * it requires are the ones the shell guarantees in its frozen baseline table
 * (`react` today; the official component library later as the UI grows).
 *
 * P0 scope:
 *   1. the sidebar entry — `sidebar.panellist` with `order: -10`, which lands it
 *      below New Session and above Plugins (the shipped Plugins page uses 0 and
 *      the shell sorts ascending);
 *   2. the page that same id addresses in the layout's keyed `main` slot, showing
 *      the host half's health and the bundled skill inventory.
 *
 * Colours come from theme alias tokens so the page survives a scheme switch.
 */

window.__ModuleLoader__.load({
  id: 'dsh-developer-workbench',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useCallback } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'developerWorkbench'
    /** Sidebar panel id: addresses both the icon row and the `main` key. */
    const PANEL_ID = 'developer-workbench'
    /** Base path of the host half's routes. */
    const ROUTE_BASE = '/api/developer-workbench'

    /** Services this plugin's browser half needs. */
    const inject = ['slots', 'locale']

    const zh = {
      panel: '开发工作台',
      title: '开发工作台',
      subtitle: '绑定本地项目，看清走到哪一步，把下一步派发给工作区会话',
      loading: '正在读取…',
      errorTitle: '读不到宿主半身',
      errorHint: '宿主路由没有响应。可能插件刚装载、宿主半身未激活，或 web 载体未就绪。',
      retry: '重试',
      stage: '当前阶段：骨架就绪（P0）',
      stageBody: '入口与页面已经挂上。下一步做宿主数据面：工作区与 git、产物扫描、工单解析、阶段推导。',
      hostInfo: '宿主半身',
      packageDir: '包目录',
      skillsDir: '技能目录',
      dataDir: '数据目录',
      skillsTitle: 'Matt Pocock 技能自检',
      skillsTotal: '共 {n} 个',
      skillsModel: '可被模型加载 {n} 个',
      skillsManual: '仅人工调用 {n} 个',
      skillsHint: '带「仅人工」的技能设置了 disable-model-invocation，skill 工具加载不到；派发提示词会给出绝对路径让会话直接读取，两种方式都能跑通。',
      bytes: '{n} B',
    }

    const en = {
      panel: 'Workbench',
      title: 'Developer Workbench',
      subtitle: 'Bind a local project, see which step it is on, dispatch the next step to a workspace session',
      loading: 'Reading…',
      errorTitle: 'Host half is not answering',
      errorHint: 'The host route did not respond. The plugin may have just loaded, the host half may be inactive, or no web carrier is ready.',
      retry: 'Retry',
      stage: 'Stage: skeleton ready (P0)',
      stageBody: 'The entry and the page are wired. Next is the host data plane: workspaces and git, artifact scan, ticket parsing, stage derivation.',
      hostInfo: 'Host half',
      packageDir: 'Package',
      skillsDir: 'Skills',
      dataDir: 'State',
      skillsTitle: 'Matt Pocock skill self-check',
      skillsTotal: '{n} total',
      skillsModel: '{n} model-loadable',
      skillsManual: '{n} human-only',
      skillsHint: 'Skills marked human-only set disable-model-invocation, so the skill tool cannot load them. Dispatch prompts pass the absolute path instead, so both paths work.',
      bytes: '{n} B',
    }

    /** Resolve one dictionary key, falling back to the key itself. */
    function makeTranslate(dictFallback) {
      return (key, params) => {
        let text = dictFallback[key] ?? key
        if (params) {
          for (const name of Object.keys(params)) text = text.replace(`{${name}}`, String(params[name]))
        }
        return text
      }
    }

    /** Fetch one JSON route and fail loudly on a non-2xx response. */
    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`)
      return await response.json()
    }

    // ── sidebar glyph ────────────────────────────────────────────────────────

    /** Icon row glyph for the sidebar panel list. */
    function WorkbenchIcon(props) {
      const size = props?.size ?? 16
      const active = props?.active === true
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('rect', {
          x: 1.6,
          y: 1.6,
          width: 12.8,
          height: 12.8,
          rx: 3,
          stroke: 'currentColor',
          strokeWidth: 1.3,
          opacity: active ? 1 : 0.92,
        }),
        h('path', {
          d: 'M4.6 6.1h6.8',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M4.6 8.8h6.8',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          opacity: 0.72,
        }),
        h('path', {
          d: 'M4.6 11.5h3.6',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          opacity: 0.45,
        }),
      )
    }

    // ── panel page ───────────────────────────────────────────────────────────

    const S = {
      page: {
        height: '100%',
        overflow: 'auto',
        paddingTop: 'var(--dsh-frame-top-clearance, 0px)',
        color: 'var(--dsw-alias-label-primary)',
      },
      inner: { maxWidth: 1080, margin: '0 auto', padding: '28px 32px 64px' },
      h1: { fontSize: 24, lineHeight: 1.25, margin: '0 0 6px', letterSpacing: '-.3px' },
      lead: { margin: '0 0 22px', fontSize: 13.5, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        padding: '16px 18px',
        marginBottom: 16,
      },
      banner: {
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderLeft: '3px solid var(--dsw-alias-brand-primary)',
        borderRadius: 10,
        padding: '13px 16px',
        marginBottom: 18,
      },
      bannerTitle: { fontSize: 13.5, fontWeight: 600, marginBottom: 4 },
      bannerBody: { fontSize: 12.8, color: 'var(--dsw-alias-label-secondary)', margin: 0, lineHeight: 1.6 },
      sectionTitle: {
        fontSize: 11,
        letterSpacing: '1.1px',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
        fontWeight: 700,
        margin: '0 0 10px',
      },
      kv: {
        display: 'flex',
        gap: 12,
        fontSize: 12.4,
        padding: '4px 0',
        alignItems: 'baseline',
      },
      kvKey: { color: 'var(--dsw-alias-label-secondary)', minWidth: 84 },
      kvVal: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.8, wordBreak: 'break-all' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8 },
      chip: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: 9,
        padding: '9px 11px',
      },
      chipHead: { display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 4 },
      chipName: { fontSize: 12.8, fontWeight: 600, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
      chipDesc: {
        fontSize: 11.6,
        color: 'var(--dsw-alias-label-secondary)',
        lineHeight: 1.5,
        margin: 0,
        display: '-webkit-box',
        WebkitLineClamp: 3,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      pill: { fontSize: 10, padding: '1px 6px', borderRadius: 5, whiteSpace: 'nowrap', marginLeft: 'auto' },
      muted: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
      errBox: {
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        borderRadius: 10,
        padding: '14px 16px',
      },
      button: {
        marginTop: 10,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '6px 13px',
        fontSize: 12.5,
        cursor: 'pointer',
        font: 'inherit',
      },
      counts: { display: 'flex', gap: 14, fontSize: 12.4, marginBottom: 12, flexWrap: 'wrap' },
      dot: { display: 'inline-block', width: 6, height: 6, borderRadius: 3, marginRight: 6 },
    }

    /** Badge telling whether the `skill` tool can load this skill. */
    function InvocabilityPill(props) {
      const { modelInvocable, label } = props
      return h(
        'span',
        {
          style: {
            ...S.pill,
            background: modelInvocable ? 'var(--dsw-alias-bg-base)' : 'transparent',
            color: modelInvocable
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-label-secondary)',
            border: `1px solid ${modelInvocable ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l2)'}`,
          },
        },
        label,
      )
    }

    /** The workbench page for the `main` key `developer-workbench`. */
    function WorkbenchPage(props) {
      const t = typeof props?.t === 'function' ? props.t : makeTranslate(zh)
      const [health, setHealth] = useState(null)
      const [inventory, setInventory] = useState(null)
      const [error, setError] = useState(null)
      const [attempt, setAttempt] = useState(0)

      useEffect(() => {
        let cancelled = false
        setError(null)
        Promise.all([getJson(`${ROUTE_BASE}/health`), getJson(`${ROUTE_BASE}/skills`)])
          .then(([nextHealth, nextInventory]) => {
            if (cancelled) return
            setHealth(nextHealth)
            setInventory(nextInventory)
          })
          .catch(nextError => {
            if (cancelled) return
            setError(nextError?.message ?? String(nextError))
          })
        return () => {
          cancelled = true
        }
      }, [attempt])

      const retry = useCallback(() => setAttempt(value => value + 1), [])

      const skills = inventory?.skills ?? []
      const modelCount = skills.filter(row => row.modelInvocable).length
      const manualCount = skills.length - modelCount

      const body = []

      body.push(
        h('h1', { key: 'h1', style: S.h1 }, t('title')),
        h('p', { key: 'lead', style: S.lead }, t('subtitle')),
      )

      body.push(
        h(
          'div',
          { key: 'stage', style: S.banner },
          h('div', { style: S.bannerTitle }, t('stage')),
          h('p', { style: S.bannerBody }, t('stageBody')),
        ),
      )

      if (error !== null) {
        body.push(
          h(
            'div',
            { key: 'err', style: S.errBox },
            h('div', { style: S.bannerTitle }, t('errorTitle')),
            h('p', { style: S.bannerBody }, `${error}`),
            h('p', { style: { ...S.bannerBody, marginTop: 6, opacity: 0.8 } }, t('errorHint')),
            h('button', { type: 'button', style: S.button, onClick: retry }, t('retry')),
          ),
        )
      } else if (health === null) {
        body.push(h('p', { key: 'loading', style: S.muted }, t('loading')))
      } else {
        body.push(
          h(
            'div',
            { key: 'host', style: S.card },
            h('div', { style: S.sectionTitle }, t('hostInfo')),
            h('div', { style: S.kv }, h('span', { style: S.kvKey }, t('packageDir')), h('span', { style: S.kvVal }, health.packageDir)),
            h('div', { style: S.kv }, h('span', { style: S.kvKey }, t('skillsDir')), h('span', { style: S.kvVal }, health.skillsDir)),
            h('div', { style: S.kv }, h('span', { style: S.kvKey }, t('dataDir')), h('span', { style: S.kvVal }, health.dataDir?.dir ?? '—')),
          ),
        )

        body.push(
          h(
            'div',
            { key: 'skills', style: S.card },
            h('div', { style: S.sectionTitle }, t('skillsTitle')),
            h(
              'div',
              { style: S.counts },
              h('span', { style: S.muted }, t('skillsTotal', { n: skills.length })),
              h(
                'span',
                { style: { color: 'var(--dsw-alias-state-success-primary)' } },
                h('span', { style: { ...S.dot, background: 'var(--dsw-alias-state-success-primary)' } }),
                t('skillsModel', { n: modelCount }),
              ),
              h(
                'span',
                { style: S.muted },
                h('span', { style: { ...S.dot, background: 'var(--dsw-alias-label-secondary)' } }),
                t('skillsManual', { n: manualCount }),
              ),
            ),
            h(
              'div',
              { style: S.grid },
              skills.map(row =>
                h(
                  'div',
                  { key: row.name, style: S.chip },
                  h(
                    'div',
                    { style: S.chipHead },
                    h('span', { style: S.chipName }, row.name),
                    h(InvocabilityPill, {
                      modelInvocable: row.modelInvocable,
                      label: row.modelInvocable ? 'model' : 'human',
                    }),
                  ),
                  h('p', { style: S.chipDesc }, row.description),
                ),
              ),
            ),
            h('p', { style: { ...S.bannerBody, marginTop: 12 } }, t('skillsHint')),
          ),
        )
      }

      return h('div', { style: S.page }, h('div', { style: S.inner }, body))
    }

    // ── plugin body ──────────────────────────────────────────────────────────

    /**
     * Register the sidebar entry and the panel it opens.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'developer-workbench: dictionaries')
      const t = ctx.locale.bind(NS)

      // The icon row. `inject` is declaration-aware, so this activates whether
      // this plugin loads before or after the sidebar that declares the slot.
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            // Ascending order: the shipped Plugins page uses 0, New Session is
            // shell chrome above the whole list, so a negative value is what
            // places this row between them.
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

    return module.exports
  },
})
