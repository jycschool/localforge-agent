# LocalForge

LocalForge 是一个独立运行的本地编程智能体桌面应用。它采用 Codex 风格的工作台：左侧显示项目结构与变更文件，中间提供只读代码和任务前后差异，右侧展示 Agent 任务时间线、命令审批和自然语言输入。

公开仓库：https://github.com/jycschool/localforge-agent

项目不依赖 VS Code，也不调用或封装现有 coding agent；Electron 只提供桌面窗口。模型消息循环、原生 tool calling 调度、上下文组织、文件工具、本地命令、停止条件、错误处理和变更跟踪均在本仓库内实现。

## 当前能力

- 打开本地项目并显示过滤后的目录结构，选择文件进行只读预览。
- 使用 OpenAI-compatible `/chat/completions` 和原生 tool calling 完成多轮任务。
- 列表、搜索、读取、精确替换和写入工作区文件。
- 对每条本地命令显示原因、命令和工作目录，并由用户逐次批准。
- 支持命令超时、输出截断、任务取消和最大步骤限制。
- 展示模型回合、工具结果、运行输出、变更文件及任务前后双栏 Diff。
- API Key 使用操作系统安全存储加密，也可通过 `LOCALFORGE_API_KEY` 提供。
- 内置 ModelScope 的 Qwen3 Coder 30B 免费推理预设；模型针对代码 Agent 和工具调用，免费额度适合课程演示。

## 本地运行

要求：Node.js 22.12 或更高版本、pnpm。

```powershell
pnpm install
pnpm run check
pnpm test
pnpm start
```

启动后点击“打开项目”。需要免费模型时，在“设置”中选择 `ModelScope · Qwen3 Coder 30B` 预设并粘贴自己的 ModelScope Token；也可以填写其他 OpenAI-compatible API 地址、模型名称和 API Key。然后在右侧输入任务。也可以先执行 `pnpm build`，只生成桌面程序的开发构建。

ModelScope 免费 API 需要账号绑定已实名认证的阿里云账号，当前通常为每天 2,000 次总调用、单模型最多 200 次，大模型可能另有限额且会动态调整。Token 只保存在操作系统安全存储中；切换 API 服务时，LocalForge 不会把原服务的 Key 发送到新地址。

## 项目结构

```text
src/
  agent/       Agent 循环、工具注册与变更跟踪
  core/        模型消息和工具协议
  desktop/     桌面 IPC、配置与项目读取服务
  model/       OpenAI-compatible 模型客户端
  renderer/    项目树、代码预览、时间线和审批界面
  tools/       受工作区边界保护的本地工具
  main.ts      Electron 主进程与任务编排
  preload.ts   最小权限的安全桥接
tests/         Agent、工具、路径和桌面项目服务测试
docs/          软件生命周期文档、ADR 与界面原型
```

## 开发原则

1. 核心 Agent 逻辑自行实现，桌面框架不参与模型决策。
2. 文件和命令操作只针对用户明确打开的本地项目。
3. 默认可观察、可停止、可审查，不把模型文字直接当作成功证据。
4. 首版是 Agent 工作台，不追求完整编辑器、调试器或版本控制功能。

完整需求、用例、设计、计划和追踪关系见 [docs/README.md](docs/README.md)。计划于 2026 年 9 月 2 日前完成真实模型端到端验证、演示视频和最终材料。
