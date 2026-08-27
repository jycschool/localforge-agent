# LocalForge

LocalForge 是一个独立运行的本地编程智能体桌面应用。它采用 Codex 风格的工作台：左侧显示项目结构与变更文件，中间提供只读代码和任务前后差异，右侧展示 Agent 任务时间线、命令审批和自然语言输入。

公开仓库：https://github.com/jycschool/localforge-agent

项目不依赖 VS Code，也不调用或封装现有 coding agent；Electron 只提供桌面窗口。模型消息循环、原生 tool calling 调度、上下文组织、文件工具、本地命令、停止条件、错误处理和变更跟踪均在本仓库内实现。

## 当前能力

- 打开本地项目并显示过滤后的目录结构，选择文件进行只读预览。
- 使用 OpenAI-compatible `/chat/completions` 和原生 tool calling 完成多轮任务。
- 列表、搜索、读取、精确替换和写入工作区文件。
- 对每条本地命令显示原因、命令和工作目录，并由用户逐次批准。
- 支持命令超时、输出截断、任务取消和最大步骤限制；在 Windows 上停止命令时清理整棵子进程树，并区分人工批准等待与真实执行耗时。
- 展示模型回合、工具结果、运行输出、变更文件及任务前后双栏 Diff。
- 从项目 `.localforge/skills/*.md` 发现可选 Skill，并在运行时注入选中的工作方法。
- 提供按项目隔离的 Memory；长期约定保存在 LocalForge 本地数据中，不污染 Git 仓库。
- 提供按项目隔离的任务历史；可回看状态、步骤、过程和改动文件，异常退出的任务会标记为意外中断。
- 严格校验模型响应与 tool call 协议；损坏调用会明确失败，429/常见 5xx 进行有限且可取消的重试。
- 大目录按展开状态延迟渲染，并限制界面中的历史输出，避免长任务拖慢前端。
- Agent 总结和历史结果以安全的轻量 Markdown 排版；只创建文本节点，不执行模型返回的 HTML。
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

开发冻结前可运行 `pnpm run verify` 完成类型检查、66 项测试和构建，再运行 `pnpm run verify:delivery` 检查 README.txt 长度、Git 历史凭据形态、禁入文件、文档链接和演示故障基线。

录制完成后运行 `pnpm run package:delivery -- -StudentName "姓名" -VideoPath "视频绝对路径.mp4"`。脚本会检查 MP4 签名、大小、README 长度，并生成只含 `README.txt` 与 `demo.mp4` 的姓名 zip；若本机安装了 ffprobe，还会自动检查两分钟时长。

启动后点击“打开项目”。需要免费模型时，在“设置”中选择 `ModelScope · Qwen3 Coder 30B` 预设并粘贴自己的 ModelScope Token；也可以填写其他 OpenAI-compatible API 地址、模型名称和 API Key。右侧的 `Skill` 用于选择项目工作方式，`Memory` 用于保存不进入仓库的长期上下文，然后即可输入任务。也可以先执行 `pnpm build`，只生成桌面程序的开发构建。

ModelScope 免费 API 的账号绑定条件和调用额度可能调整，请以控制台当日提示为准。Token 只保存在操作系统安全存储中；切换 API 服务时，LocalForge 不会把原服务的 Key 发送到新地址。

## 项目结构

```text
src/
  agent/       Agent 循环、工具注册与变更跟踪
  core/        模型消息和工具协议
  desktop/     桌面 IPC、配置、项目读取与任务历史服务
  model/       OpenAI-compatible 模型客户端
  renderer/    项目树、代码预览、时间线和审批界面
  tools/       受工作区边界保护的本地工具
  main.ts      Electron 主进程与任务编排
  preload.ts   最小权限的安全桥接
tests/         Agent、模型协议、历史、工具、路径和桌面服务测试
demo/          可重复恢复的真实 Agent 视频演示项目
docs/          软件生命周期文档、ADR 与界面原型
.localforge/skills/  项目可共享的 Skill Markdown（按需创建）
```

## 开发原则

1. 核心 Agent 逻辑自行实现，桌面框架不参与模型决策。
2. 文件和命令操作只针对用户明确打开的本地项目。
3. 默认可观察、可停止、可审查，不把模型文字直接当作成功证据。
4. 首版是 Agent 工作台，不追求完整编辑器、调试器或版本控制功能。

完整需求、用例、设计、计划和追踪关系见 [docs/README.md](docs/README.md)。真实 ModelScope 模型已完成三轮修改验证（10、10、9 步）和一轮 0 命令、0 改动的只读验证；另一次远端 429 已转化为有限重试和明确指引。计划于 2026 年 9 月 2 日前完成演示视频和最终材料。
