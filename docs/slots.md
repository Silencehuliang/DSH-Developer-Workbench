# 我们占用的插槽

**不要再去查询插槽契约** —— 这里已经记录了我们占用的每一个，以及宿主传给它的东西。

需要重新核实时的查询方式：

```
cordis_inspect_query(platform="client", provider="Slots", method="listSubTree", input={"root":"<插槽名>"})
```

## 侧边栏与主面板

| 插槽 | scope | 我们注册的 | order | 传给我们的 |
|---|---|---|---|---|
| `sidebar.panellist` | root | `id: developer-workbench` | **-10** | `{ size, active }`（图标行） |
| `main` | root | `key: developer-workbench` | — | 五份框架 share；业务 share 来自我们的 `inject` |

`sidebar.panellist` 按 `order` **升序**排列。内置「插件」是 `0`、「计划」是 `10`，所以 `-10` 落在「新会话」与「插件」之间。

## 会话侧三处（都是追加，order 100，排在官方条目之后）

| 插槽 | scope | 我们注册的 | 传给我们的 |
|---|---|---|---|
| `conversation.composer.dock` | session | `id: developer-workbench.bar` | `sessionId`（standardProps） |
| `conversation.chat.turnTail` | session | `id: developer-workbench.turnTail` | `sessionId` + ownerProps `{ turn, seq, openFile }` |
| `sidebar.session.row.hover` | root | `id: developer-workbench.hover` | ownerProps `{ sessionId }` |

三处的 `replaceRisk` 都是 `none`。三处都必须**在会话不属于任何已登记项目时返回 `null`**。

## 设置

| 插槽 | scope | 我们注册的 | order | 传给我们的 |
|---|---|---|---|---|
| `settings.section` | root | `id: developer-workbench` | 40 | ownerProps `{ close }` |

## 宿主侧会用到的服务

| 服务 | 我们用它做什么 |
|---|---|
| `webServer` | 注册 `/api/developer-workbench/*` |
| `workspaceRegistry` | 读工作区列表（`list` / `create` / `get` / `delete` / `resolveByPath`） |
| `skills` | `snapshot({ cwd })` —— 技能自检用它证伪「DSH 到底看不看得到」 |
| `hmr` | 从 `baseDir` 推出 profile 目录，用来定位数据目录 |

客户端侧：`ctx.remote.session.{create,list,prompt}`（每个返回 `{ok,value}|{ok,error}`，要显式拆）、
`ctx.remote.workspace.follow`、`ctx.uiWorkspace.{pickDirectory,openSession}`、
`ctx.layout.selectPanel`、`ctx.locale.{register,bind,getSnapshot}`。
