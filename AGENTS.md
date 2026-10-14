# dsh-developer-workbench

DSH 插件：在左侧边栏加入「开发工作台」入口（**新会话下方、插件上方**），绑定本地项目、按磁盘产物推导工作流阶段、把下一步连同 Matt Pocock 技能的绝对路径派发给对应的工作区会话。工作台是**控制台**：它不自己跑 agent。

## 架构

两个半身，各自零构建 —— 这是硬约束，不是偏好：

| 半身 | 文件 | 约束 |
|---|---|---|
| 宿主 | `plugin/index.js` | ESM，只用 `ctx` 与 `node:*`。**不要引入第三方依赖** |
| 浏览器 | `plugin/client.js` | 手写 `window.__ModuleLoader__.load({ id, factory })`。只能用外壳基线模块（`react` 等）。**不要引入打包器** |

- 宿主注册 `/api/developer-workbench/*`；浏览器半身只通过自己的路由取数据。
- 浏览器半身注册 `sidebar.panellist`（`order: -10`）与 `main`（key `developer-workbench`）。
- 技能在 `plugin/skills/`，由本插件自己的 `skill-filesystem` 行直接供给，见 `plugin/cordis.patch.yml`，机制见 `plugin/README.md`。

## 每改必跑

```bash
node plugin/scripts/verify.mjs
```

断言覆盖浏览器半身的注册项（id / order / key）与宿主的实时 HTTP 路由。**改完不跑等于没改。**

## 约定

- **入口顺序**：`order` 升序。内置插件页是 `0`，本插件 `-10`。要重排只改这一个数字。
- **宿主读文件用 `node:fs`**，不要用 `workspaceFiles` —— 它需要一个会话 id 作作用域，读「还没建会话的项目」会很别扭。
- **技能只发现一层**：`<root>/<name>/SKILL.md`。别把技能放进子目录。
- **`skills/` 顶层不要放没有 frontmatter 的 `.md`** —— 顶层 `<name>.md` 会被当成技能，缺 frontmatter 会被静默跳过。
- **前端颜色一律用主题 token**（`--dsw-alias-*`、`--dsh-frame-top-clearance`），不要写死。
- **tracker 是「项目」的属性，不是工作台的全局设置。** 解析优先级固定为：项目自己的 `docs/agents/issue-tracker.md` → 工作台的 per-project 本地映射 → 全局默认兜底。绑定项目时初始化（读到就采用、不提问；读不到才问用户），结果落进本地映射，之后以映射为准。同一个工作台里 A 项目用 GitHub、B 项目用本地 markdown 是正常的 —— **永远不要把某个项目的选择提升成工作台默认值**。
- **不要修改 `plugin/skills/` 里的技能正文**：那是 Matt Pocock 的上游内容（MIT）。本地适配另开目录。

## 已知坑（踩过，别再踩）

- **CRLF 陷阱**：`plugin/skills/` 下的 `SKILL.md` 是 CRLF。解析 frontmatter **必须按行扫描**，用字符偏移找闭合 `---` 会静默吃掉最后一行 —— 而 `disable-model-invocation` 常常正是最后一行。`verify.mjs` 里有专门断言钉住这一点。
- **技能分两类**：27 个里 11 个可被 `skill` 工具加载，16 个带 `disable-model-invocation: true` 只能人工 `/name` 调用或直接读文件。工作流的闸门技能（`to-spec`、`to-tickets`、`handoff`…）全在后一类，所以派发提示词**必须**给出 `SKILL.md` 的绝对路径。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `Silencehuliang/DSH-Developer-Workbench`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
