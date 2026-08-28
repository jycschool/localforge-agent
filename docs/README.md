# LocalForge 文档索引

本目录覆盖需求、设计、实现、验证和交付的软件生命周期。编号表示推荐阅读顺序，不表示所有文件都要持续追加“当前状态”。重要技术取舍使用 ADR 保留真实演进历史。

## 快速阅读路径

- **了解产品**：[01 产品需求](product/01-product-requirements.md) → [02 用例](product/02-use-cases.md) → [04 界面原型](architecture/04-ui-prototype.md)。
- **理解 Agent 如何运行**：[03 总体设计](architecture/03-system-design.md) → [11 数据流](architecture/11-agent-data-flow.md) → [17 修改说明](changes/17-manual-editing-change-note.md) → [ADR](architecture/decisions/)。
- **检查项目过程**：[05 项目计划](process/05-project-plan.md) → [09 开发日志](process/09-development-log.md) → [16 中期快照](archive/16-midterm-lifecycle-baseline.md)。
- **检查质量与证据**：[06 测试计划](quality/06-test-plan.md) → [07 风险与质量](quality/07-risk-and-quality.md) → [08 追踪矩阵](quality/08-traceability.md) → [14 真实模型验证](quality/14-real-model-validation.md)。
- **准备交付与答辩**：[12 视频脚本](delivery/12-demo-video-script.md) → [13 考核核对](delivery/13-assessment-compliance.md) → [15 答辩提纲](delivery/15-interview-defense.md)。

## 生命周期导航与唯一职责

| 阶段 | 权威文档 | 唯一职责 | 补充文档 |
| --- | --- | --- | --- |
| 需求 | [01-product-requirements.md](product/01-product-requirements.md) | FR/NFR、范围和验收标准的唯一清单 | [02-use-cases.md](product/02-use-cases.md)、[04-ui-prototype.md](architecture/04-ui-prototype.md) |
| 架构 | [03-system-design.md](architecture/03-system-design.md) | 总体结构、模块职责和安全边界 | [11-agent-data-flow.md](architecture/11-agent-data-flow.md)、[decisions/](architecture/decisions/) |
| 计划 | [05-project-plan.md](process/05-project-plan.md) | 截止日期、里程碑、冻结点和每日节奏 | [10-optimization-roadmap.md](process/10-optimization-roadmap.md) 只保留尚未完成工作 |
| 实施 | [09-development-log.md](process/09-development-log.md) | 已完成事项、提交和验证结果的唯一动态记录 | [16-midterm-lifecycle-baseline.md](archive/16-midterm-lifecycle-baseline.md) 是 08-28 评审快照 |
| 测试 | [06-test-plan.md](quality/06-test-plan.md) | 测试层次、用例、门禁和当前自动化口径 | [14-real-model-validation.md](quality/14-real-model-validation.md) 保存真实服务验证记录 |
| 质量 | [07-risk-and-quality.md](quality/07-risk-and-quality.md) | 风险登记、质量目标、缺陷等级和发布门禁 | [08-traceability.md](quality/08-traceability.md) 负责需求—代码—测试—演示映射 |
| 合规 | [13-assessment-compliance.md](delivery/13-assessment-compliance.md) | 题目原文到交付证据的逐条核对 | [12-demo-video-script.md](delivery/12-demo-video-script.md)、[15-interview-defense.md](delivery/15-interview-defense.md) |

## 全部文档

| 编号 | 文档 | 内容 |
| --- | --- | --- |
| 01 | [产品需求](product/01-product-requirements.md) | 产品边界、功能/非功能需求、成功标准 |
| 02 | [用例](product/02-use-cases.md) | 正常流程、异常流程、演示用例 |
| 03 | [总体设计](architecture/03-system-design.md) | 桌面架构、AgentLoop、工具、安全和错误处理 |
| 04 | [界面原型](architecture/04-ui-prototype.md) | 三栏工作台、状态和交互 |
| 05 | [项目计划](process/05-project-plan.md) | 08-27 至 09-02 的里程碑和冻结计划 |
| 06 | [测试计划](quality/06-test-plan.md) | 单元、集成、桌面和人工验收 |
| 07 | [风险与质量](quality/07-risk-and-quality.md) | 风险、安全、质量门禁和交付合规 |
| 08 | [追踪矩阵](quality/08-traceability.md) | 需求、源码、测试和演示证据 |
| 09 | [开发日志](process/09-development-log.md) | 真实进展、验证证据和计划偏差 |
| 10 | [剩余路线图](process/10-optimization-roadmap.md) | 截止前尚未完成的工作与退出条件 |
| 11 | [Agent 数据流](architecture/11-agent-data-flow.md) | 任务、模型、工具、历史和 Diff 的详细时序 |
| 12 | [演示视频脚本](delivery/12-demo-video-script.md) | 演示项目、分镜、台词和录制检查 |
| 13 | [考核核对](delivery/13-assessment-compliance.md) | 考核要求到实现与材料的映射 |
| 14 | [真实模型验证](quality/14-real-model-validation.md) | ModelScope 读、改、测闭环和限流记录 |
| 15 | [答辩提纲](delivery/15-interview-defense.md) | 常见追问、源码带看和表述边界 |
| 16 | [中期生命周期基线](archive/16-midterm-lifecycle-baseline.md) | 08-28 裁剪瀑布、PERT、质量/效能评审快照 |
| 17 | [轻量手动编辑修改说明](changes/17-manual-editing-change-note.md) | 编辑/新建范围、数据流、安全边界与验收 |

## 目录职责

| 目录 | 内容规则 |
| --- | --- |
| `product/` | 当前有效的产品需求与用户用例 |
| `architecture/` | 当前设计、数据流、原型和不可改写的 ADR |
| `process/` | 计划、真实开发日志和仍未完成的路线图 |
| `quality/` | 测试、风险、需求追踪和真实模型验证证据 |
| `delivery/` | 视频、考核核对和答辩材料 |
| `changes/` | 已批准范围变更的原因、边界和验收说明 |
| `archive/` | 已冻结的阶段快照；只补勘误，不更新为当前状态 |
| `assets/` | 文档引用的图片与其他静态资源 |

## 维护规则

- 需求变化时同步更新 FR/NFR、用例、设计、测试和追踪矩阵。
- 架构级调整新增 ADR，不覆盖先前真实决策。
- 已完成事实只追加到 `process/09-development-log.md`；路线图完成后删除对应待办并链接日志，不复制功能清单。
- 测试数量以测试计划为当前口径；历史日志和中期快照保留当时数字，不反向改写。
- 发布前检查文档链接、占位符、凭据、视频和答辩表述是否一致。
- 提交与推送按真实里程碑进行，不伪造日期或用空提交制造开发周期。
