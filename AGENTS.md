# dsh-developer-workbench

DSH 插件：左侧边栏的「开发工作台」+ 会话侧三处入口 + 设置页。工作台是**控制台**，它不自己跑 agent。

## 先看这三份

- **[plugin/README.md](plugin/README.md)** —— 它是什么、长什么样、怎么接线、怎么排障。**改代码前先读这一份。**
- **[CODING_STANDARDS.md](CODING_STANDARDS.md)** —— 评审时逐条过。**实现时不必读**：机械性规则已经变成检查，跑一次下面的命令就会拦住你。
- **[docs/slots.md](docs/slots.md)** —— 我们占用的每个插槽及其 ownerProps。**不要再去查询插槽契约**，答案在这里。

## 改完必跑

```bash
npm run check        # 浏览器半身，不需要服务（pre-commit 跑的就是这条）
npm run verify       # 加上宿主 HTTP 路由，需要 DSH 在跑
npm run acceptance   # 一个项目走完整条阶段阶梯，需要 DSH 在跑
```

## 一条硬约束

**宿主半身零第三方依赖；浏览器半身手写、无构建。** 理由在 `plugin/README.md` —— 想引入依赖或打包器就先改那条决策，不要顺手加。
