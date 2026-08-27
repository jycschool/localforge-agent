# LocalForge

LocalForge 是一个面向 Visual Studio Code 的本地编程智能体。它在编辑器侧边栏中接收任务，读取和修改当前工作区代码、执行本地命令与测试，并把过程和变更以可审查的方式呈现给用户。

项目不会调用或封装现有 coding agent，也不依赖 agent 框架。模型交互循环、上下文管理、工具协议、本地执行、停止条件和错误处理均在本仓库内实现。

## 当前阶段

- 已完成需求、用例、总体设计、界面原型、测试计划和风险分析。
- 已搭建 VS Code 扩展，并实现最小 agent 循环、本地文件工具、命令审批、停止与 Diff 入口。
- 计划于 2026 年 9 月 2 日前完成演示版本、视频和提交材料。

## 本地开发

要求：Node.js 20 或更高版本、pnpm、VS Code 1.95 或更高版本。

```powershell
pnpm install
pnpm run check
pnpm test
pnpm run build
```

在 VS Code 中打开本仓库，按 `F5` 启动 Extension Development Host。随后打开 LocalForge 侧边栏，通过 `LocalForge: Set API Key` 保存密钥，并在设置中确认 API Base URL 和模型名称。

当前模型层使用 OpenAI-compatible `/chat/completions` 与原生 tool calling，不依赖 agent SDK。

## 已实现的最小闭环

- 自动携带活动文件和选中代码。
- 文件列表、文本搜索、带行号读取、精确替换和写文件。
- 本地命令逐次确认、超时、输出截断和取消。
- 模型输出与工具结果循环、最大步骤限制和错误回传。
- 运行时间线、停止按钮、变更文件列表和任务前后 Diff。

## 文档

文档入口见 [docs/README.md](docs/README.md)。

## 预期体验

用户打开一个本地项目，在 LocalForge 侧边栏描述任务。智能体会展示正在读取的文件、计划执行的命令、产生的代码变更和测试结果；敏感命令需要用户确认，最终结果可以通过编辑器 Diff 检查。

## 开发原则

1. 核心 agent 逻辑自行实现。
2. 所有代码执行和文件操作均发生在用户选定的本地工作区。
3. 默认可观察、可停止、可审查，不把模型输出直接等同于成功。
4. API 凭据只通过环境变量或 VS Code SecretStorage 保存。
