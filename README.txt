项目名称：LocalForge

Git 仓库：https://github.com/jycschool/localforge-agent

LocalForge 是一个运行在 Visual Studio Code 侧边栏中的本地编程智能体。它参考编辑器内 coding agent 的交互方式，但不封装现有 agent 产品，也不使用 LangChain、Agents SDK 等 agent 框架。模型消息循环、原生 tool calling 调度、上下文组织、文件工具、命令执行、停止条件和错误处理均自行实现。

运行方法：安装 Node.js 20、pnpm 和 VS Code 1.95 或更高版本；在仓库目录执行 pnpm install、pnpm run check、pnpm test、pnpm run build；使用 VS Code 打开仓库并按 F5 启动扩展开发窗口。在命令面板运行“LocalForge: Set API Key”，再在设置中填写 OpenAI-compatible API 地址和模型名称，即可在 LocalForge 侧边栏提交任务。

特色功能：自动携带活动文件和选中代码；支持工作区文件列表、文本搜索、带行号读取、精确替换和写文件；本地命令逐次确认并具有超时、输出截断和取消能力；所有路径限制在工作区内；运行过程以时间线展示；任务结束后列出变更文件并打开任务前后的 VS Code Diff；模型不能仅凭文字宣称成功，最终说明必须区分已通过测试和未验证内容。

项目文档包括需求、用例、总体设计、界面原型、开发计划、测试计划、风险分析、需求追踪矩阵和开发日志。计划在 2026 年 9 月 2 日截止前完成真实模型端到端验证、演示项目、两分钟视频和最终回归测试。
