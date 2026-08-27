# 需求追踪矩阵

该矩阵用于防止文档、实现、测试和视频演示相互脱节。模块与测试文件会在实现提交后补充精确路径。

| 需求 | 设计模块 | 计划测试 | 演示证据 |
| --- | --- | --- | --- |
| FR-01 任务提交 | AgentPanel、ExtensionController | 扩展消息测试 | 在侧边栏发送真实任务 |
| FR-02 工作区上下文 | ContextBuilder | 活动文件与选区测试 | 选中代码后直接提问 |
| FR-03 检索和读取 | WorkspaceTools | T-02、路径安全单测 | 时间线展示读取相关文件 |
| FR-04 修改文件 | WorkspaceTools、ChangeTracker | T-03、T-04 | 源文件和测试文件产生 Diff |
| FR-05 执行命令 | CommandTool、ApprovalController | T-05、T-06、T-07 | 审批并运行测试 |
| FR-06 工具循环 | AgentLoop | 模拟多回合集成测试 | 失败结果进入下一轮修复 |
| FR-07 停止条件 | AgentLoop、Cancellation | T-08、T-09 | 展示停止按钮和最大步数配置 |
| FR-08 过程观察 | RunEvent、AgentPanel | UI 状态测试 | 时间线展示读、改、测过程 |
| FR-09 变更审查 | ChangeTracker、DiffProvider | T-11 | 打开任务前后 Diff |
| FR-10 验证实现 | CommandTool、FinalSummary | T-12 | 首测失败、二测通过 |
| FR-11 密钥安全 | SecretStorage | T-10、提交扫描 | 使用设置命令录入，不出现在视频 |
| FR-12 模型配置 | ModelConfig、ModelClient | 配置解析测试 | 展示模型名称，不展示密钥 |

## 交付追踪

| 交付物 | 来源 | 完成检查 |
| --- | --- | --- |
| 公开 Git 仓库 | 全部源码与文档 | URL 可访问，提交历史真实，截止后无新推送 |
| README.txt | README 与最终实现摘要 | 不超过 1000 汉字，包含 URL、运行方法、特色 |
| 2 分钟视频 | UC-01/UC-03 演示用例 | MP4，小于 200 MB，不泄露密钥，展示完整闭环 |

