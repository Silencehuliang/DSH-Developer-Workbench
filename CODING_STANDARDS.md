# Coding standards — 开发工作台

**这份文件是给评审读的，不是给实现读的。** 实现时不必通读：机械性的规则已经变成了检查（下表右列），
跑一次 `node plugin/scripts/verify.mjs` 就会拦住你。这里只留下**检查替代不了的判断题**，以及每条规则
对应的检查在哪里。

评审时逐条过。缺少「检查」一栏的，才是真正需要人来判断的。

## 机械性 —— 已有确定性检查，评审时不必重复判断

| 规则 | 检查 |
|---|---|
| 前端颜色一律用主题 token（`--dsw-alias-*`），不得出现 `#hex` / `rgb()` / `hsl()` | `verify.mjs`：`styles: no component renders a hardcoded colour`（遍历每个渲染树的 inline style）+ `no hardcoded colour anywhere in the sheet` |
| 可点击的元素必须是真实交互控件（`button` / `a` / `input` / `select` / `textarea`），否则键盘到不了 | `verify.mjs`：`no clickable element is unreachable from the keyboard` |
| `SKILL.md` 的 frontmatter 必须按行解析，不得按字符偏移（CRLF 会静默吃掉最后一行，而 `disable-model-invocation` 常正好在最后一行） | `verify.mjs`：`disable-model-invocation is read from the last frontmatter line`（对真实技能文件断言） |
| 中英字典键集必须逐键相等 | `verify.mjs`：`zh and en dictionaries define identical key sets` |
| 客户端与宿主对设置默认值的理解必须一致 | `verify.mjs`：`the client fallback matches the host defaults exactly` |
| 选择器提供的每种 tracker 都必须被宿主接受 | `verify.mjs`：`every tracker the picker offers is accepted by the host` |
| `plugin/package.json` 的 `files` 必须包含归属文件 | `verify.mjs`：`the attribution files ship with the package` |

## 判断题 —— 检查替代不了

### 架构

- **宿主半身零第三方依赖、浏览器半身手写无构建。** 理由在 `plugin/README.md`。引入任何一个依赖或打包器都要先改那条决策，不能顺手加。
- **宿主是唯一读磁盘的一方。** 浏览器半身只通过自己的 HTTP 路由取数据。`workspaceFiles` 需要会话作用域，读「还没建会话的项目」会很别扭 —— 所以文件读取不要在客户端做。
- **技能只发现一层**：`<root>/<name>/SKILL.md`。放两层等于没放。

### 语义 —— 这些是错的来源

- **「读不到」不等于「没有」。** 适配器读依赖失败时返回 `null`（未知），不是 `[]`（没有）。任何把读失败说成空集的改动都是缺陷：它会让看板把读不到的东西显示成「可开工」，让技能自检把读不到的目录说成「缺失」。
- **空看板/空分组不能被误读成「健康」。** 非 ready 的每一种状态都要有独立表达（`needs-tracker` / `unsupported` / `unavailable`）。
- **tracker 是项目的属性，不是工作台的全局设置。** 解析顺序：项目声明 → per-project 本地映射 → （不存在的第三层）。**永远不要把某个项目的选择提升成默认值。**
- **手动覆盖是补丁，不是替换。** 覆盖之后推导照常运行、照常上报；`stage`（生效）与 `derived`（推导）是两个字段。
- **只有一条发送路径。** 会话侧的动作只把用户送到工作台的派发确认框；它们自己不作任何修改。两条发送路径意味着两次可能绕过确认的发送。
- **工作台不替用户改 profile。** 诊断可以指出「去检查哪一行」，但不能动手。

### 文档

- **凡是注释里声称的不变式，代码必须真的守住。** 一条声称某件事的注释而代码没做到，算缺陷 —— 评审要抽验，不能只读注释。
- **README 的表格是地图，不是证据。** 断言要看代码。

### 接受过的取舍（评审时不要重新提出来）

- 阶段证据目前是散文一句，不可展开到具体文件（见 #? 未开单，属已知限制）。
- `review` / `pr` / `retro` 目前不可自动到达（见 #12）。
- `/probe` 定位待定（见 #19）。
- `WorkbenchPage` 的取数 effect 是显式重复的，因为 React 依赖数组必须显式（见 #20 的评估结论）。
