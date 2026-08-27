# LocalForge 文档索引

本目录覆盖需求、设计、实现、测试与交付的软件生命周期。重要技术取舍使用 ADR 保留演进历史。

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [01-product-requirements.md](01-product-requirements.md) | 产品边界、功能/非功能需求和成功标准 | 已更新 |
| [02-use-cases.md](02-use-cases.md) | 参与者、正常流程、异常流程与演示用例 | 已更新 |
| [03-system-design.md](03-system-design.md) | 桌面架构、AgentLoop、工具、安全和错误处理 | 已更新 |
| [04-ui-prototype.md](04-ui-prototype.md) | 独立桌面原型、状态与交互 | 已更新 |
| [05-project-plan.md](05-project-plan.md) | 08-27 至 09-02 的开发、里程碑和冻结计划 | 执行中 |
| [06-test-plan.md](06-test-plan.md) | 单元、集成、桌面和人工验收计划 | 执行中 |
| [07-risk-and-quality.md](07-risk-and-quality.md) | 风险、安全、质量门禁和交付合规 | 已更新 |
| [08-traceability.md](08-traceability.md) | 需求、源码、测试和演示证据追踪 | 已更新 |
| [09-development-log.md](09-development-log.md) | 实际进展、验证证据、偏差与待办 | 持续更新 |
| [10-optimization-roadmap.md](10-optimization-roadmap.md) | 截止前的优化优先级、实施阶段和验收标准 | 执行中 |
| [decisions/0001-vscode-extension.md](decisions/0001-vscode-extension.md) | 初始 VS Code 形态决策 | 已被取代 |
| [decisions/0002-standalone-desktop.md](decisions/0002-standalone-desktop.md) | 改为独立桌面 Agent 的决策 | 已接受 |

## 维护规则

- 需求变化时同步更新编号、用例、设计、测试与追踪矩阵。
- 架构级调整新增 ADR，不覆盖先前真实决策。
- 每日收尾更新计划状态、日志、验证证据与剩余风险。
- 发布前清理占位符，并确保文档、源码、视频和答辩表述一致。
- 提交和推送按真实里程碑进行，不伪造日期或用空提交制造开发周期。
