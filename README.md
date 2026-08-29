# RepoForge · 代码锻造智能体

[![Windows 质量门禁](https://github.com/jycschool/localforge-agent/actions/workflows/windows-quality-gate.yml/badge.svg)](https://github.com/jycschool/localforge-agent/actions/workflows/windows-quality-gate.yml)

RepoForge，中文名“代码锻造”，是一个独立运行的项目编程智能体桌面应用。它采用 Codex 风格的工作台：左侧显示项目结构与变更文件，中间提供代码预览、轻量手动编辑和任务前后差异，右侧以连续可滚动会话展示用户问题、Agent 流式回复、工具时间线和命令审批。

公开仓库：https://github.com/jycschool/localforge-agent

项目不依赖 VS Code，也不调用或封装现有 coding agent；Electron 只提供桌面窗口。模型消息循环、原生 tool calling 调度、上下文组织、文件工具、本地命令、停止条件、错误处理和变更跟踪均在本仓库内实现。

## 当前能力

- 打开本地项目并显示过滤后的目录结构；重启后安全恢复上次授权项目和按项目隔离的未发送草稿。
- 支持 `Ctrl+P` 按文件名或路径快速打开；预览带行号，并可复制项目内路径或文件内容。
- 可在 FILE 模式手动编辑文本并用 `Ctrl+S` 保存，也可在已有目录中新建文本文件；保存前校验内容摘要，外部冲突不会被覆盖，手动修改不冒充 Agent Diff。
- 在 FILE 预览或编辑区选中代码后，可一键生成“解释、查错、修改、生成测试”任务草稿；任务完成后显示基于真实事件和文件快照的成果卡，历史详情还能无副作用回放执行过程。
- 使用 OpenAI-compatible `/chat/completions`、SSE 流式输出和原生 tool calling 完成多轮任务；不支持 SSE 的兼容服务仍可返回完整 JSON。
- 列表、搜索、读取、精确替换和写入工作区文件。
- 对每条本地命令显示原因、命令和工作目录，并由用户逐次批准。
- 支持命令超时、输出截断、任务取消和最大步骤限制；达到步骤上限时给出中文说明和显式继续入口，不自动扩大上限；在 Windows 上停止命令时清理整棵子进程树，并区分人工批准等待与真实执行耗时。
- 实时展示模型生成内容和工具结果；本次变更按新增/修改、文件类型、增删行与已审查进度呈现，运行输出按命令折叠并用真实测试结果展示首次/最终验证进展，仍可进入任务前后双栏 Diff。
- Diff 支持单文件或全部撤销；恢复前二次确认并校验当前内容摘要，任务结束后若文件又被外部修改则拒绝覆盖。
- 发送任务前可打开“发送清单”，查看模型、权限、历史消息、Skill、Memory、附件、工具数量和预计输入 Token；预览只在本地生成，不调用模型。
- 从项目 `.localforge/skills/*.md` 发现可选 Skill；可在界面新建、编辑、删除并选择本次注入的工作方法。
- 提供按项目隔离的 Memory；可创建、修改、导入、导出、明确删除并独立选择本次是否注入，同时展示更新时间、字符数和实际注入预览。
- 提供按项目隔离的任务历史；可回看状态、步骤、过程和改动文件，也可继续、删除完整会话或导出不含隐藏 reasoning 的 Markdown 证据报告；异常退出的任务会标记为意外中断。
- 同一会话中的后续问题自动继承上一轮用户/Agent 文本；“新会话”会切断上下文链，但不会删除历史记录。
- 可为任务添加当前项目内最多 8 个文本附件；发送前可逐个移除，内容经过单文件与总量限制后才进入模型上下文。
- 严格校验模型响应与 tool call 协议；损坏调用会明确失败，429/常见 5xx 进行有限且可取消的重试。
- 大目录按展开状态延迟渲染，并限制界面中的历史输出，避免长任务拖慢前端。
- Agent 总结和历史结果以安全的轻量 Markdown 排版；只创建文本节点，不执行模型返回的 HTML。
- API Key 使用操作系统安全存储加密，也可通过 `LOCALFORGE_API_KEY` 提供；本地命令子进程会剥离常见 Key、Token、Secret 等敏感环境变量。
- 内置 ModelScope 的 Qwen3 Coder 30B 免费推理预设；模型针对代码 Agent 和工具调用，免费额度适合课程演示。
- 设置页提供“保存并测试”，分别检查认证、文本、流式响应、Token usage 与原生工具调用，避免只凭“你好”判断模型是否适合 Agent。
- 支持最多 12 个模型配置：顶栏快速切换，配置可新建、重命名和二次确认删除；每个配置使用自己的加密 Key 与能力自检记录，运行期间锁定切换。

## 本地运行

要求：Node.js 22.12 或更高版本、pnpm。

```powershell
pnpm install
pnpm run check
pnpm test
pnpm start
```

首次完成安装与构建后，可以创建不经过 `pnpm start` 的 Windows 桌面快捷方式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-desktop-shortcut.ps1
```

此后双击桌面的 `RepoForge 代码锻造` 即可直接启动现有 `dist` 构建，不会弹出命令行窗口。源码变化后先运行一次 `pnpm run build`；如果移动项目目录或重新安装依赖，应重新创建快捷方式。该方式依赖本机项目目录与 `node_modules`，不是可分发安装包。

开发冻结前可运行 `pnpm run verify` 完成类型检查、135 项测试和构建，再运行 `pnpm run verify:delivery` 检查 README.txt 长度、Git 历史凭据形态、禁入文件、文档链接和演示故障基线。

仓库同时配置了 Windows GitHub Actions 质量门禁：推送到 `main`、提交 Pull Request 或手动触发时，会在不注入真实模型 Token 的干净环境中安装锁定依赖，并依次执行类型检查、自动化测试、构建和交付检查。

质量门禁通过后，`main` 和手动运行会继续生成保留 14 天的 Windows x64 可运行制品；推送 `v*` 标签时，同一份已验证制品会自动压缩并发布到 GitHub Releases。发布写权限只授予标签触发的 Release 作业，普通 CI 与制品构建保持只读。标签本身是人工发布门禁，例如 `git tag -s v0.1.0 -m "发布 v0.1.0"` 后推送该标签即可触发正式发布。

本地需要生成不依赖项目目录和 `node_modules` 的 Windows 应用时，可运行：

```powershell
pnpm run package:win
```

输出位于 `release\RepoForge-win32-x64\RepoForge.exe`。这是免安装应用目录，尚未购买 Windows 代码签名证书，因此首次从网络下载时可能出现系统信誉提示；Git 提交的 SSH 签名不能替代可执行文件代码签名。

录制完成后运行 `pnpm run package:delivery -- -StudentName "姓名" -VideoPath "视频绝对路径.mp4"`。脚本会检查 MP4 签名、大小、README 长度，并生成只含 `README.txt` 与 `demo.mp4` 的姓名 zip；若本机安装了 ffprobe，还会自动检查两分钟时长。

启动后点击“打开项目”。需要免费模型时，在“设置”中选择 `ModelScope · Qwen3 Coder 30B` 预设并粘贴自己的 ModelScope Token；也可以填写其他 OpenAI-compatible API 地址和 Model-Id。设置同时提供只读/工作区读写权限与快速/标准/深入响应档位；Agent 标题旁显示本次任务累计 Token，接口未返回 usage 时以 `≈` 标明本地估算。右侧的 `Skill` 可新建、编辑、删除和选择项目工作方式；`Memory` 可维护不进入仓库的长期上下文；“附件”会把明确选择的项目文本文件发送给当前模型服务。连续输入会自动保留同一会话上下文；点击“新会话”可从空白上下文开始，旧记录可从“历史”中切换、继续或整段删除。也可以先执行 `pnpm run build`，只生成桌面程序的开发构建。

ModelScope 免费 API 的账号绑定条件和调用额度可能调整，请以控制台当日提示为准。Token 只保存在操作系统安全存储中；切换 API 服务时，RepoForge 不会把原服务的 Key 发送到新地址。

## 项目结构

```text
src/
  agent/       Agent 循环、工具注册与变更跟踪
  core/        模型消息和工具协议
  desktop/     桌面 IPC、配置、项目读取与任务历史服务
  model/       OpenAI-compatible 模型客户端
  renderer/    项目树、代码预览/轻量编辑、时间线和审批界面
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
4. 首版是 Agent 工作台，只提供受限文本编辑，不追求语言服务、调试器或版本控制功能。

完整需求、用例、设计、计划和追踪关系见 [文档索引](docs/文档索引.md)。真实 ModelScope 模型已完成三轮修改验证（10、10、9 步）和一轮 0 命令、0 改动的只读验证；另一次远端 429 已转化为有限重试和明确指引。计划于 2026 年 9 月 2 日前完成演示视频和最终材料。
