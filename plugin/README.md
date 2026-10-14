# dsh-developer-workbench

在 DSH 左侧「新会话」下方、「插件」上方新增一个 **开发工作台** 入口：绑定本地项目、按磁盘产物推导工作流走到哪一步、把下一步连同上下文派发给对应的工作区会话。

工作流引擎是 [Matt Pocock 的 27 个技能](https://github.com/mattpocock/skills)（MIT，已随包内置）。工作台是**控制台**：它不自己跑 agent。

---

## 目录

- [它长什么样](#它长什么样)
- [验证](#验证)
- [从零复现](#从零复现)
- [工作流是怎么被管起来的](#工作流是怎么被管起来的)
- [技能：随包供给，不往项目里拷](#技能随包供给不往项目里拷)
- [设置](#设置)
- [已知问题](#已知问题)
- [排障](#排障)
- [归属](#归属)

## 它长什么样

**左侧边栏**：`新会话 → 开发工作台 → 插件 → 计划`（`sidebar.panellist`，`order: -10`）。

**主面板**（同一个 id 寻址 `main` 的 key）三栏：

| 左栏 | 中栏 | 右栏 |
|---|---|---|
| 项目（＝已注册工作区）：标题、tracker 徽章、阶段徽章、分支、未提交数、会话数；「＋ 绑定本地项目」；选中态 | 阶段流水线（已完成 / 当前 / 未开始 + 依据 + 技能）、「派发 · 技能」与「生成交接文档」、工单看板（可开工 / 被阻塞 / 验收进度） | 产物（spec / ADR / 术语表 / 交接文档，可只读预览）、技能自检、以及交接文档的「继续这个交接」 |

**会话侧**（三处都是追加，不覆盖官方条目，`order: 100`）：

| 插槽 | 表现 |
|---|---|
| `conversation.composer.dock` | 输入框卡片下方：`项目 · 阶段` + 「推进」 |
| `conversation.chat.turnTail` | 每轮回答后：记录到工作台 / 推进到下一阶段 / 生成交接文档 |
| `sidebar.session.row.hover` | 悬停卡里一行 `项目 · 阶段` |

**三处在会话不属于任何已登记项目时返回 `null`** —— 官方界面保持原样，不留占位、不闪。

**设置** → 「开发工作台设置」（`settings.section`）。

## 验证

```bash
npm run check        # 浏览器半身，密封，不需要服务（pre-commit 钩子跑的就是这条）
npm run verify       # 加上宿主 HTTP 路由，需要 DSH 在跑
npm run acceptance   # 一个项目走完整条阶段阶梯，需要 DSH 在跑
```

**`verify.mjs` 的两条缝**，都不需要浏览器：

1. **浏览器半身**：用桩 `window` 与桩 React 加载 `client.js`，物化 factory、对假 ctx 跑 `apply`，断言**注册项**（插槽名、id、`order`、locale）与**渲染结果**（纯组件 + 桩渲染）。其中两条审计遍历每个渲染树：**可点击元素是否键盘可达**、**颜色是否全是主题 token**。
2. **宿主半身**：对着脚本自己创建的真实目录断言 HTTP 接口 —— 真实 git 仓库、真实的 tracker 声明文件、真实的工单文件。一次预检决定可达性：**可达服务器抛出的异常是 FAIL，不是 skip**。

**`acceptance.mjs` 测的是逐路由断言测不到的东西**：同一个项目在产物逐件增加时，阶段是否真的自己往前走。

```
→ grill      a tracker declaration        (nothing-sharpened)
→ spec       an ADR                       (design-docs-only)
→ tickets    a spec                       (spec-without-tickets)
→ implement  the first ticket             (tickets-open)
→ review     every ticket finished        (no-review)
```

它也会**如实报告链路在哪里停下**（见「已知问题」），而不是假装走完了。

**`ui-probe.mjs` 用真浏览器验收界面** —— 前两条缝都覆盖不到的一层：

```bash
npm run ui           # 需要 DSH 在跑，且机器上有 Edge 或 Chrome
```

它开一个无头 Chromium，点侧边栏入口，等面板渲染，点项目行，然后断言：入口可见、面板真的渲染出来、项目行有真实数据、**恰好一个**项目被选中、点第二个会把选中移过去（且选中的就是点的那行）、阶段流水线出内容、页面上不再有「正在读取」、产物栏与技能自检都出内容、**控制台零错误**，最后截图。

### 为什么探针要自己签一个 cookie

`dsh web` 用**每进程随机生成、从不落盘**的令牌守着首页，所以从进程外面读不到。但磁盘上有那把 32 字节签名密钥，于是探针用它签出宿主本该在令牌交换后签发的那个 cookie（见 `ui-probe.mjs` 的 `mintSessionCookie`）。这是从外部打开界面的**唯一**一条路；探针不做其他认证动作，也不碰 profile。

| 环境变量 | 用途 |
|---|---|
| `DSH_WEB_URL` | 界面地址，默认 `http://127.0.0.1:19387` |
| `DSH_HOME` | DSH 主目录，默认 `~/.dsh`（读签名密钥） |
| `DSH_BROWSER` | 指定 Chromium；不设则自动找 Edge / Chrome |
| `DSH_CDP_PORT` | 调试端口，默认 9333 |

**每改必跑**：改完不跑等于没改 —— 结构上由 `.githooks/pre-commit` 兜底（`git config core.hooksPath .githooks`）。**改界面则必须跑 `npm run ui`。**

## 文档地图

| 文件 | 读它的时机 |
|---|---|
| `plugin/README.md`（本文） | 改代码前 |
| [`CODING_STANDARDS.md`](./CODING_STANDARDS.md) | **评审时**。机械性规则已变成检查，评审可跳过那些 |
| [`docs/slots.md`](../docs/slots.md) | 涉及插槽时。**不要再去查询插槽契约** |
| [`docs/reviews/`](../docs/reviews/) | 两轴评审报告与复盘 |
| [`AGENTS.md`](../AGENTS.md) | 导航指针与那条硬约束 |

## 从零复现

1. **把包放进 profile**（本机已完成）：

   ```jsonc
   // <profile>/package.json
   "dsh": { "profile": { "bundles": ["…", "dsh-developer-workbench"] } },
   "dependencies": { "dsh-developer-workbench": "link:<此目录>/plugin" }
   ```

2. **让 HMR 监听本目录**（改宿主半身即生效，无需重启）：

   ```yaml
   - id: hmr
     config:
       root: [".", "<此目录>/plugin"]
   ```

3. **配置数据目录**（留空＝profile 下的 `.developer-workbench`）：

   ```yaml
   - id: developer-workbench
     config:
       dataDir: ''
   ```

4. 保存 profile 的 `cordis.patch.yml` 触发 profile 重组合，然后：

   ```bash
   curl http://127.0.0.1:19387/api/developer-workbench/health
   ```

   返回里应包含 `packageDir` 指向本包、`skills: 27`、以及解析出的 `dataDir`。

包内**不需要构建**：宿主半身是纯 ESM，浏览器半身是手写的 `window.__ModuleLoader__.load({ id, factory })` bundle，只用外壳基线表里的 `react`。没有第三方依赖要装。

## 工作流是怎么被管起来的

**阶段是产物的函数，不是一个人手维护的字段。** `lib/stage.js` 是纯函数：不读磁盘、不调 CLI，所有事实都是参数。

```
setup → grill → spec → tickets → implement → review → pr → retro
```

| 判定依据（事实） | 阶段 |
|---|---|
| 项目没有 tracker 声明 | `setup` |
| 没有 spec，也没有设计文档 | `grill` |
| 没有 spec，但有 ADR / 术语表（`grilling` 的产物） | `spec` |
| 有 spec / 有工单但工单为空 | `tickets` |
| 有未完成工单 → 取 frontier | `implement` |
| 工单全完成、无评审记录 | `review` |
| 有评审、无 PR | `pr` |
| 有 PR | `retro` |

一条关键推断：**工单蕴含 spec**。`to-tickets` 消费 spec，所以 tracker 上有工单就是「spec 这一步发生过」的证据 —— 哪怕 spec 本身在 issue tracker 上、不在项目里。

**手动覆盖是补丁，不是替换**：`stage`（生效）与 `derived`（推导）是两个字段，覆盖之后推导照常运行并照常上报。

**派发**：点「派发」→ 工作台生成提示词 → 确认框显示目标工作区、目标工单、以及**可编辑的提示词全文** → 新建会话或复用已有会话 → 发送 → 跳过去。发送失败时对话框保持打开并显示原因；**失败之后绝不跳转**。

**交接**：上游 `handoff` 技能规定文档写到系统临时目录，但**不规定文件名** —— 那样工作台无法可靠地列出或链接它。所以工作台自己定路径：

```
<系统临时目录>/developer-workbench/<项目 slug>/handoff-YYYYMMDD-HHMMSS.md
```

并把该路径写进提示词。记录发生在**派发那一刻**（路径是工作台选的，它已经知道），所以列表里立刻有这一条；文件后来被删掉时明确标「文件不见了」，而不会假装还能继续。

## 技能：随包供给，不往项目里拷

27 个技能在 `plugin/skills/`，由插件**自己的** `skill-filesystem` 行提供服务（`includeDefaultRoots: true`）—— 所以技能随插件走，同时项目/用户技能根也照常扫描。

**27 个里只有 11 个能被 `skill` 工具加载**；16 个带 `disable-model-invocation: true`，而工作流的闸门技能（`to-spec`、`to-tickets`、`wayfinder`、`implement`、`handoff`）**全在这 16 个里**。

所以派发提示词的**主路径是给出技能文件的绝对路径**，`skill` 工具只是捷径。提示词里两条路都写明。

**技能自检**（右栏）用 DSH 的技能注册表（`ctx.skills.snapshot()`，也就是 `skill` 工具读的同一个源）对照包内文件，分四种状态：`discovered` / `not-discovered` / `invalid`（frontmatter 坏，DSH 会静默跳过）/ `unknown`（目录读不到 —— 这是「我没看到」，不是「它不在」）。失败时给出可操作的话并点名具体技能，但**不会替你去改 profile**。

## 设置

| 设置 | 作用 |
|---|---|
| 会话侧三处开关 | 关掉即完全不渲染（官方界面回到原样） |
| 旁路建议阈值 | 开放工单达到这个数就建议走 `wayfinder` |
| 派发提示词语言 | 跟随界面，或固定 zh / en |

改动立即生效（设置是全局的，客户端有一份共享缓存 + 订阅）。

**这里没有「技能安装位置」**：技能由插件包直接供给，旋钮如果控制不了任何东西就不该出现在设置里。技能是否真的被 DSH 看到，看右栏的技能自检。

## 已知问题

### 技能发现曾整体失效（本机，2026-10-14 已修）

**现象**：`skill` 工具能调用，但目录永远是空的 —— 连 DSH 随 `@deepseek-ai/dsh-agent-preset` 自带的 4 个技能都报 `unknown`。

**原因**：技能注册表在宿主平面，但**文件系统提供方由每个 agent 预设自己挂载**；`dsh-web-app` 又把宿主平面那一行显式关掉了。而本机 profile 里预设作用域那一行没有生效（`@deepseek-ai/dsh-agent-preset` 从 profile 目录 `MODULE_NOT_FOUND`），于是当前会话作用域内一个技能提供方都没有。

**修法**：不改 DSH 内部、不动预设声明 —— 本插件自带的 `cordis.patch.yml` 插一行自己的 `skill-filesystem`（`providerName` 独立、`includeDefaultRoots: true`、`customSkillDirs` 指向包内 `skills/`）。注册表是宿主 + 作用域分层的，全局层会合并进每个 agent 的目录。

**连带效果**：`includeDefaultRoots: true` 让用户自己的 `~/.agents/skills` 与 `~/.dsh/skills` 也一并恢复。自检把「我们的技能」和「DSH 看到的别的技能」分开列。

**回退**：把 `plugin/cordis.patch.yml` 里 `developer-workbench-skills` 那一行 `disabled: true`。profile 改动前有备份：`cordis.patch.yml.bak-dw-*`。

### 前端热更

宿主半身改完保存即生效（HMR 已监听本目录）。客户端 bundle 改动后如未生效，刷新页面即可。

## 排障

```bash
curl http://127.0.0.1:19387/api/developer-workbench/health
curl http://127.0.0.1:19387/api/developer-workbench/skills/status
curl "http://127.0.0.1:19387/api/developer-workbench/tickets?path=<项目>"
curl "http://127.0.0.1:19387/api/developer-workbench/stage?path=<项目>"
curl "http://127.0.0.1:19387/api/developer-workbench/prompt?path=<项目>&stage=tickets&lang=zh"
curl http://127.0.0.1:19387/api/developer-workbench/settings
```

几个容易误判的地方：

- **「缺失」的三种含义**：`not-discovered`（发现没生效）、`invalid`（frontmatter 坏）、`unknown`（目录读不到）。自检分得很清，别把它们当成同一件事。
- **空看板 ≠ 没有工单**：tracker 未初始化是 `needs-tracker`，没有适配器是 `unsupported`，读不到是 `unavailable`。
- **「读不到依赖」不等于「没被阻塞」**：读依赖失败时看板按**不可开工**处理，并报 `edges-unread`。

## 归属

`plugin/skills/` 的技能由 **Matt Pocock** 创作，MIT 许可，见 [`ATTRIBUTION.md`](./ATTRIBUTION.md) 与 [`LICENSE-mattpocock-skills`](./LICENSE-mattpocock-skills)。
