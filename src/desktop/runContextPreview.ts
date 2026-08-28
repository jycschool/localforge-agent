import type { AgentTool, ChatMessage } from "../core/protocol";
import type { ProjectSkillDefinition, ProjectMemoryRecord } from "./projectContextStore";
import type {
  FileSnapshot,
  PublicSettings,
  RunContextPreview,
  RunRequest,
} from "./contracts";
import { buildSystemPrompt } from "../agent/systemPrompt";
import { buildContextualTask } from "../agent/taskContext";
import { estimateTokenCount } from "../model/openAICompatibleClient";

export interface RunContextPreviewInput {
  request: RunRequest;
  settings: PublicSettings;
  memory: ProjectMemoryRecord;
  skills: readonly ProjectSkillDefinition[];
  attachments: readonly FileSnapshot[];
  previousMessages: readonly ChatMessage[];
  tools: readonly AgentTool[];
}

export function buildRunContextPreview(input: RunContextPreviewInput): RunContextPreview {
  const memory = input.request.useMemory ? input.memory.memory : "";
  const systemPrompt = buildSystemPrompt({
    memory,
    skills: input.skills,
    permissionMode: input.settings.permissionMode,
    responseProfile: input.settings.responseProfile,
    executionMode: input.request.executionMode ?? "direct",
  });
  const task = buildContextualTask(
    input.request.task.trim(),
    input.request.selectedFile,
    input.attachments,
  );
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...input.previousMessages,
    { role: "user", content: task },
  ];
  const schemas = input.tools.map((tool) => tool.schema);
  const estimatedInputTokens = estimateTokenCount(JSON.stringify({ messages, tools: schemas }));
  const requestedSkillIds = new Set(input.request.skillIds ?? []);
  const selectedSkillIds = new Set(input.skills.map((skill) => skill.id));
  const warnings: string[] = [];
  const missingSkills = [...requestedSkillIds].filter((id) => !selectedSkillIds.has(id));
  if (missingSkills.length > 0) {
    warnings.push(`${missingSkills.length} 个已选 Skill 不存在或超出注入上限。`);
  }
  if (estimatedInputTokens > 100_000) {
    warnings.push("预计输入超过 100,000 Token，模型可能截断较早的上下文。");
  } else if (estimatedInputTokens > 50_000) {
    warnings.push("预计输入较大，响应速度和费用可能增加。");
  }

  return {
    profileName: input.settings.profileName,
    model: input.settings.model,
    permissionMode: input.settings.permissionMode,
    responseProfile: input.settings.responseProfile,
    executionMode: input.request.executionMode ?? "direct",
    selectedFile: input.request.selectedFile,
    skills: input.skills.map((skill) => ({
      name: skill.name,
      relativePath: skill.relativePath,
      contentChars: skill.content.length,
    })),
    memoryChars: memory.length,
    memoryUpdatedAt: input.request.useMemory ? input.memory.updatedAt : null,
    memoryPreview: compactPreview(memory, 240),
    attachments: input.attachments.map((attachment) => ({
      relativePath: attachment.relativePath,
      contentChars: attachment.content.length,
    })),
    conversationMessageCount: input.previousMessages.length,
    conversationChars: input.previousMessages.reduce(
      (total, message) => total + messageContentChars(message),
      0,
    ),
    toolCount: schemas.length,
    estimatedInputTokens,
    warnings,
  };
}

function compactPreview(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

function messageContentChars(message: ChatMessage): number {
  if (message.role === "assistant") {
    return (message.content?.length ?? 0) + (message.reasoning_content?.length ?? 0);
  }
  return message.content.length;
}
