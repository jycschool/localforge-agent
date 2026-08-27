# 需求追踪矩阵

该矩阵把需求、实现、测试和视频证据连接起来，防止文档与成品脱节。

| 需求 | 设计/实现 | 计划测试 | 演示证据 |
| --- | --- | --- | --- |
| FR-01 打开项目 | `main.ts`、`desktop/projectService.ts` | 项目扫描、目录选择人工测试 | 打开演示目录并显示项目名 |
| FR-02 查看代码 | `renderer/app.ts`、`readProjectFile` | UTF-8、大小和越界测试 | 从目录树打开源文件 |
| FR-03 提交任务 | `renderer/app.ts`、`main.ts` | 空任务、并发任务和无项目测试 | 在独立窗口提交真实任务 |
| FR-04 检索读取 | `tools/workspaceTools.ts` | `workspaceTools.test.ts`、路径测试 | 时间线展示搜索和读取 |
| FR-05 修改文件 | WorkspaceTools、ChangeTracker | 精确替换、新建、含糊匹配 | 源文件和测试文件产生变更 |
| FR-06 执行命令 | `run_command`、主进程审批、审批/执行分段计时 | 批准、拒绝、超时、取消 | 展示审批框、真实退出码与独立执行耗时 |
| FR-07 工具循环 | `agent/agentLoop.ts` | `agentLoop.test.ts` | 失败输出进入下一轮 |
| FR-08 停止条件 | AgentLoop、AbortController | 取消和最大步骤测试 | 展示停止按钮和步骤设置 |
| FR-09 过程观察 | AgentEvent、Renderer timeline | 事件映射和桌面人工测试 | 时间线展示读、改、测 |
| FR-10 变更审查 | ChangeTracker、Renderer Diff | 首次快照和双栏渲染 | 从变更列表打开 Diff |
| FR-11 验证证据 | `run_command`、output panel、`14-real-model-validation.md` | exit code、stdout/stderr | 真实模型首测 2/6、二测 6/6、外部复核 6/6 |
| FR-12 模型配置 | ConfigStore、ModelClient | URL/数值验证、Key 隔离 | 展示模型名，不展示 Key |
| FR-13 项目 Skill | ProjectContextStore、systemPrompt、上下文弹窗 | `projectContextStore.test.ts`、`systemPrompt.test.ts` | 勾选 Skill 后执行任务 |
| FR-14 项目 Memory | ProjectContextStore、Memory 弹窗 | 保存、更新、长度、项目隔离测试 | 保存后重新打开并执行任务 |
| FR-15 任务历史 | RunHistoryStore、历史弹窗、历史 IPC | `runHistoryStore.test.ts`、桌面窗口人工检查 | 打开历史并回看状态、事件和改动文件 |
| FR-16 严格模型协议 | OpenAICompatibleClient | `openAICompatibleClient.test.ts` | 注入损坏响应时明确失败，不显示完成 |

## 非功能追踪

| 非功能需求 | 实现证据 | 验证 |
| --- | --- | --- |
| NFR-01 路径安全 | lexical + realpath 检查、跳过符号链接 | `pathSafety.test.ts`、`projectService.test.ts` |
| NFR-02 最小权限 | sandbox、contextIsolation、Preload 白名单 | `preload.test.ts`、桌面启动检查、源码评审 |
| NFR-03 可控 | 最大步骤、AbortSignal、逐次审批、进程树终止 | Agent 取消/步数单测、命令超时/取消/子进程清理测试 |
| NFR-04 可观察 | AgentEvent、timeline、output panel、任务历史 | 窗口检查、真实模型 38 条事件和端到端视频 |
| NFR-05 可靠 | 严格响应解析、结构化工具错误和持久化 run 状态 | ModelClient、AgentLoop、RunHistoryStore 测试 |
| NFR-06 性能 | 目录过滤、2,000 文件/1 MB 上限、目录懒渲染、UI 输出上限 | 项目服务单测、大项目人工检查 |
| NFR-07 可维护 | contracts、ModelClient、ToolRegistry 接口 | 模块依赖评审、类型检查 |
| NFR-08 可测试 | 核心模块与 Preload/配置/富文本/路径脱敏边界可隔离验证 | 当前 58 项自动化测试 |

## 交付追踪

| 交付物 | 来源 | 完成检查 |
| --- | --- | --- |
| 公开 Git 仓库 | 全部源码与文档 | URL 可访问，历史真实，截止后无推送 |
| README.txt | README 与最终实现摘要 | 少于 1000 汉字，含 URL、运行和特色 |
| 两分钟视频 | UC-01、UC-02、UC-04 | MP4 小于 200 MB，无凭据，展示完整闭环 |
