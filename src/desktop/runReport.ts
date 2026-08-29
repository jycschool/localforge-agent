import type { AgentEvent } from "../core/protocol";
import type { RunHistoryDetail } from "./contracts";

export function formatRunReport(projectName: string, run: RunHistoryDetail): string {
  const changedFiles = run.changedFiles.length > 0
    ? run.changedFiles.map((file) => `- \`${escapeInline(file)}\``).join("\n")
    : "- 无";
  const attachments = run.attachmentPaths.length > 0
    ? run.attachmentPaths.map((file) => `- \`${escapeInline(file)}\``).join("\n")
    : "- 无";
  const skills = run.skillIds.length > 0
    ? run.skillIds.map((skill) => `- \`${escapeInline(skill)}\``).join("\n")
    : "- 无";
  const evidence = run.events.length > 0
    ? run.events.map((event, index) => formatEvent(event, index + 1)).join("\n")
    : "- 无可用事件";
  const plan = run.plan
    ? [
        `- 修订版本：${run.plan.revision}`,
        `- 状态：${planStateLabel(run.plan.state)}`,
        ...run.plan.items.map(
          (item) => `- ${planStatusSymbol(item.status)} ${escapeText(item.title)}`,
        ),
        ...(run.plan.verification.length
          ? ["", "### 完成核验", "", ...run.plan.verification.map((item) => `- ${escapeText(item)}`)]
          : []),
        ...(run.plan.remaining.length
          ? ["", "### 遗留事项", "", ...run.plan.remaining.map((item) => `- ${escapeText(item)}`)]
          : []),
      ].join("\n")
    : "- 本任务未使用结构化计划";

  return [
    `# RepoForge 代码锻造智能体任务证据报告`,
    "",
    `- 项目：${escapeText(projectName)}`,
    `- 任务 ID：\`${run.id}\``,
    `- 状态：${statusLabel(run.status)}`,
    `- 创建时间：${run.createdAt}`,
    `- 完成时间：${run.updatedAt}`,
    `- 模型：${escapeText(run.model ?? "历史版本未记录")}`,
    `- 模型配置：${escapeText(run.modelProfileName ?? "历史版本未记录")}`,
    `- 权限：${escapeText(run.permissionMode ?? "历史版本未记录")}`,
    `- 响应档位：${escapeText(run.responseProfile ?? "历史版本未记录")}`,
    `- 执行模式：${run.executionMode === "plan" ? "先规划" : "直接执行"}`,
    `- 执行步数：${run.steps}`,
    "",
    "## 用户任务",
    "",
    run.task || "（空）",
    "",
    "## 执行结果",
    "",
    run.summary || "（无摘要）",
    "",
    "## 执行计划",
    "",
    plan,
    "",
    "## 上下文清单",
    "",
    `- 当前文件：${run.selectedFile ? `\`${escapeInline(run.selectedFile)}\`` : "无"}`,
    `- 使用 Memory：${run.memoryUsed ? "是" : "否"}`,
    `- 延续自历史任务：${run.continuedFromRunId ? `\`${run.continuedFromRunId}\`` : "否"}`,
    "",
    "### 附件",
    "",
    attachments,
    "",
    "### Skills",
    "",
    skills,
    "",
    "## 文件变更",
    "",
    changedFiles,
    "",
    "## 执行证据",
    "",
    evidence,
    "",
    `> 本报告由 RepoForge 于 ${new Date().toISOString()} 从本地任务历史生成。报告不包含模型隐藏思考过程。`,
    "",
  ].join("\n");
}

function formatEvent(event: AgentEvent, index: number): string {
  switch (event.type) {
    case "run_started":
      return `${index}. 开始任务：${oneLine(event.task)}`;
    case "model_started":
      return `${index}. 第 ${event.step} 步：请求模型`;
    case "model_usage":
      return `${index}. 第 ${event.step} 步：${event.totalTokens} Token（输入 ${event.promptTokens}，输出 ${event.completionTokens}${event.estimated ? "，本地估算" : ""}）`;
    case "assistant_message":
      return `${index}. 模型消息：${oneLine(event.text)}`;
    case "tool_started":
      return `${index}. 调用工具 \`${escapeInline(event.name)}\``;
    case "tool_finished":
      return `${index}. 工具 \`${escapeInline(event.name)}\` ${event.result.isError ? "失败" : "完成"}（${event.durationMs} ms）`;
    case "plan_updated":
      return `${index}. 计划更新：修订 ${event.plan.revision}，${planStateLabel(event.plan.state)}`;
    case "completion_blocked":
      return `${index}. 第 ${event.step} 步未通过完成门禁：${oneLine(event.message)}`;
    case "run_completed":
      return `${index}. 任务完成（${event.steps} 步）：${oneLine(event.summary)}`;
    case "run_cancelled":
      return `${index}. 任务已取消（${event.steps} 步）`;
    case "run_failed":
      return `${index}. 任务失败（${event.steps} 步）：${oneLine(event.message)}`;
    case "assistant_delta":
      return `${index}. 流式文本片段（未展开）`;
  }
}

function planStateLabel(state: NonNullable<RunHistoryDetail["plan"]>["state"]): string {
  return {
    awaiting_approval: "等待确认",
    active: "执行中",
    ready_to_finish: "等待完成核验",
    completed: "已完成",
    rejected: "未获批准",
  }[state];
}

function planStatusSymbol(status: NonNullable<RunHistoryDetail["plan"]>["items"][number]["status"]): string {
  return {
    pending: "○",
    in_progress: "◐",
    completed: "●",
    skipped: "－",
  }[status];
}

function oneLine(value: string): string {
  return escapeText(value.replace(/\s+/g, " ").trim().slice(0, 500) || "（空）");
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()#+.!|])/g, "\\$1");
}

function escapeInline(value: string): string {
  return value.replace(/`/g, "\\`");
}

function statusLabel(status: RunHistoryDetail["status"]): string {
  return {
    running: "运行中",
    completed: "已完成",
    cancelled: "已取消",
    failed: "失败",
    interrupted: "中断",
  }[status];
}
