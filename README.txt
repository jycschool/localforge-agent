项目名称：LocalForge

Git 仓库：https://github.com/jycschool/localforge-agent

LocalForge 是一个独立运行、Codex 风格的本地编程智能体桌面应用，不依赖 VS Code，也不封装现有 coding agent 或 agent 框架。Electron 只负责桌面窗口；模型消息循环、原生 tool calling 调度、文件工具、本地命令、停止条件、错误处理和变更跟踪均自行实现。

运行方法：安装 Node.js 22.12 或更高版本和 pnpm，在仓库目录执行 pnpm install、pnpm run check、pnpm test、pnpm start。首次构建后可运行 scripts/create-desktop-shortcut.ps1 创建桌面快捷方式，此后无需 pnpm start；源码更新后先执行 pnpm run build。启动后打开本地项目，在设置中保存 OpenAI-compatible 模型配置和对应 API Key，即可从顶栏安全切换并提交任务。

特色功能：左侧显示过滤后的项目结构和变更文件；中间可预览、受限手动编辑/新建文本文件并查看任务前后双栏 Diff，保存会检测外部冲突；右侧以连续会话实时展示双方消息、工具时间线、输入和停止操作。同一会话自动继承上一轮，也可新建空白会话或从本机历史继续；Skill、Memory 和项目内文本附件均可按任务选择。支持文件列表、搜索、读取、精确替换、写入；命令逐次审批并具有超时、输出截断和取消能力；所有路径限制在所选项目内；API Key 使用系统安全存储加密且不会传给命令子进程；模型协议损坏时明确失败；最终结果区分已验证与未验证内容。

项目文档覆盖需求、用例、总体设计、数据流、界面原型、计划、测试、风险、追踪矩阵、ADR 和开发日志。真实 ModelScope 模型已完成三轮读、改、测闭环；计划在 2026 年 9 月 2 日前完成两分钟演示视频和最终回归测试。
