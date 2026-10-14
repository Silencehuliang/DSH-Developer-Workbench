# dsh-developer-workbench

在 DSH 左侧「新会话」下方、「插件」上方新增一个 **开发工作台** 入口：绑定本地项目、看清工作流走到哪一步、把下一步连同上下文派发给对应的工作区会话。

工作流引擎是 [Matt Pocock 的 27 个技能](https://github.com/mattpocock/skills)（MIT，已随包内置）。

---

## 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | 包体骨架、profile 接线、侧边栏入口、主面板占位、技能供给与自检 | ✅ 已验证 |
| **P1** | 宿主数据面：工作区与 git、产物扫描、工单解析、阶段推导 | 进行中 · #2 项目列表与 tracker 初始化已完成 |
| P2 | 主面板三栏界面（项目 / 流水线 / 看板 / 产物 / 自检 / Git） | 待做 |
| P3 | 派发与交接：创建会话、发送提示词、handoff 接力 | 待做 |
| P4 | 会话侧三处入口 + 设置页 | 待做 |
| P5 | 双语、可访问性、端到端验收 | 待做 |

设计稿见 [`docs/design-preview.html`](../docs/design-preview.html)（可直接用浏览器打开）。

## 验证

```bash
node plugin/scripts/verify.mjs
```

浏览器半身用桩 `window` + 桩 React 加载 `client.js`，断言「入口落在哪、id/order 对不对」；宿主路由断言实时 HTTP API。服务未启动时路由部分会跳过但客户端部分照常断言。

`node plugin/scripts/verify.mjs --client-only` 只跑客户端部分。

## 它是怎么挂上去的

```
profiles/desktop/package.json
  dsh.profile.bundles          ── 已含 dsh-developer-workbench
  dependencies                 ── link:…/Developer Workbench/plugin
profiles/desktop/cordis.patch.yml
  - id: developer-workbench    ── 覆盖 dataDir（'' = 用 profile 下的数据目录）
  - id: hmr  config.root       ── 已含本插件目录，改宿主半身即热替换
plugin/
  package.json                 ── dsh.bundle.patch + dsh.client
  cordis.patch.yml             ── 插两行：插件宿主半身 + 技能供给
  index.js                     ── 宿主半身（ESM，零第三方依赖）
  client.js                    ── 浏览器半身（手写 ModuleLoader bundle，零构建）
  skills/                      ── 内置 27 个 Matt Pocock 技能（已拍平）
```

**零构建**是刻意的：官方插件前端都是同一种 `window.__ModuleLoader__.load({id, factory})` 手写格式，基线只提供 `react` 等少数模块，所以这个包不需要 tsdown/vite，也没有依赖要装。

### 入口为什么在「新会话下方、插件上方」

侧边栏顶部渲染顺序是固定的：品牌行 → 新会话按钮 → `sidebar.panellist`（全局面板列表，按 `order` 升序）→ 工作区浏览器 → 页脚。内置「插件」页注册 `order: 0`，本插件注册 `order: -10`，于是顺序为：

```
新会话 → 开发工作台 (-10) → 插件 (0) → 计划 (10)
```

可以用宿主检查确认：

```
cordis_inspect_query(platform="client", provider="Slots", method="listSubTree", input={"root":"sidebar.panellist"})
```

## 技能供给：随插件走，不往项目里拷

`plugin/skills/` 内置 27 个技能，由本插件自己的 `skill-filesystem` 行直接提供服务（`cordis.patch.yml` 里 `customSkillDirs` 指向包内目录）。所以：

- 任何项目、任何会话都能看到这 27 个技能，**不需要往用户仓库里写文件**；
- `includeDefaultRoots: true`，所以 `<项目>/.dsh/skills`、`<项目>/.agents/skills`、`~/.dsh/skills` 这些常规根也一并恢复扫描。

### 技能发现只认一层

DSH 只发现 `<root>/<name>/SKILL.md`（或顶层 `<name>.md`），**不递归**。上游是 `skills/engineering/<name>/` 两层，所以内置副本被**拍平**成 `skills/<name>/`，每个技能自带的 `references/`、`scripts/`、`assets/` 原样留在旁边。

### 11 个能加载，16 个不能 —— 这是上游的设计

| | 数量 | 技能 |
|---|---|---|
| 模型可直接加载 | 11 | `code-review` `codebase-design` `diagnosing-bugs` `domain-modeling` `grilling` `pr` `prototype` `research` `tdd` `wizard` `writing-for-agents` |
| 仅人工调用（`disable-model-invocation: true`） | 16 | `to-spec` `to-tickets` `wayfinder` `implement` `implement-spec` `handoff` `triage` `setup-matt-pocock-skills` `retro` `ask-matt` `grill-me` `grill-with-docs` `improve-codebase-architecture` `teach` `to-questionnaire` `wait-what` |

后 16 个是**工作流的闸门**，`skill` 工具读不到。因此工作台的派发提示词**主路径是给出 `SKILL.md` 的绝对路径**让会话用 `read` 直接读，工具可用时再作为捷径 —— 两条路都通。

## Known issues

### 技能发现曾整体失效（2026-10-14 已修）

**现象**：`skill` 工具能调用，但目录永远是空的 —— 连 DSH 随 `@deepseek-ai/dsh-agent-preset` 自带的 4 个技能（`agent-experience`、`cordis-plugin-development`、`cordis-composition-reference`、`editing-cordis-compositions`）都报 `unknown or no longer available`。

**原因**：技能注册表在宿主平面，但**文件系统提供方由每个 agent 预设自己挂载**；`dsh-web-app` 又把宿主平面的 `skill-filesystem` 行显式关掉了（见其 `cordis.patch.yml` 注释：host row disabled, presets own local discovery）。而本机 profile 里那个预设作用域的行没有生效（`@deepseek-ai/dsh-agent-preset` 从 profile 目录 `MODULE_NOT_FOUND`），于是当前会话作用域内一个技能提供方都没有。

**修法**：不改 DSH 内部、不动预设声明。让本插件自带的 `cordis.patch.yml` 插一行自己的 `skill-filesystem`（`providerName` 独立、`includeDefaultRoots: true`、`customSkillDirs` 指向包内 `skills/`）。注册表是宿主 + 作用域分层的，全局层的提供方会合并进每个 agent 的目录，因此技能供给和项目/用户技能根一起恢复。

**验证**：`skill(grilling)` 能返回正文；`GET /api/developer-workbench/skills` 返回 27 项、0 问题。

**回退**：删除 `plugin/cordis.patch.yml` 里的 `developer-workbench-skills` 那一行，或把该行 `disabled: true`。profile 改动前有备份：`profiles/desktop/cordis.patch.yml.bak-dw-*`。

### 前端热更

宿主半身改完保存即生效（profile 的 `hmr.root` 已含本目录）。客户端 bundle 改动后如需看到效果，刷新页面即可。

## 排障

```bash
# 宿主半身活着吗、技能目录解析到哪
curl http://127.0.0.1:19387/api/developer-workbench/health

# 27 个技能、哪些能被模型加载、有没有会让 DSH 跳过的 frontmatter 问题
curl http://127.0.0.1:19387/api/developer-workbench/skills
```

`problems` 非空的技能会被 DSH 静默跳过（只留一条 warning），自检接口就是为了让这件事可见。

## 归属

`plugin/skills/` 的技能由 Matt Pocock 创作，MIT 许可，见 [`ATTRIBUTION.md`](./ATTRIBUTION.md) 与 [`LICENSE-mattpocock-skills`](./LICENSE-mattpocock-skills)。
