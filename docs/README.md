# LocalForge 文档索引

本目录覆盖从需求到交付的软件生命周期。文档会随实现持续修订，重要技术选择记录在决策文档中。

| 文档 | 内容 | 当前状态 |
| --- | --- | --- |
| [01-product-requirements.md](01-product-requirements.md) | 背景、范围、功能与非功能需求、验收标准 | 基线版 |
| [02-use-cases.md](02-use-cases.md) | 主要参与者、正常流程和异常流程 | 基线版 |
| [03-system-design.md](03-system-design.md) | 架构、agent 循环、工具协议、上下文与安全设计 | 基线版 |
| [04-ui-prototype.md](04-ui-prototype.md) | 界面原型、状态与关键交互 | 基线版 |
| [05-project-plan.md](05-project-plan.md) | 2026-08-27 至 2026-09-02 的开发与交付计划 | 执行中 |
| [06-test-plan.md](06-test-plan.md) | 单元、集成、端到端和人工验收计划 | 基线版 |
| [07-risk-and-quality.md](07-risk-and-quality.md) | 风险、质量门禁、安全与提交合规 | 基线版 |
| [08-traceability.md](08-traceability.md) | 需求、模块、测试和演示之间的追踪关系 | 基线版 |
| [09-development-log.md](09-development-log.md) | 每日进展、验证证据和计划偏差 | 持续更新 |
| [decisions/0001-vscode-extension.md](decisions/0001-vscode-extension.md) | 采用 VS Code 扩展形态的决策记录 | 已接受 |

## 文档维护规则

- 需求发生变化时，同步更新需求编号、追踪矩阵和相关测试。
- 架构级取舍使用 ADR 记录，不直接覆盖原有结论。
- 每日收尾时更新计划中的实际进展、偏差和次日重点。
- 发布前检查所有“待定”项、占位符和演示依赖。
