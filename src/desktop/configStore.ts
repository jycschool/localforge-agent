import { randomUUID } from "node:crypto";
import { app, safeStorage } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ModelDiagnosticCheck,
  ModelDiagnosticResult,
  ModelProfileInput,
  ModelProfilesSnapshot,
  ModelProfileSummary,
  PermissionMode,
  PublicSettings,
  ResponseProfile,
  SettingsInput,
} from "./contracts";

export const MAX_MODEL_PROFILES = 12;
const DEFAULT_PROFILE_ID = "default";

interface StoredModelProfile {
  id: string;
  name: string;
  apiBaseUrl: string;
  model: string;
  maxSteps: number;
  commandTimeoutMs: number;
  maxOutputChars: number;
  permissionMode: PermissionMode;
  responseProfile: ResponseProfile;
  encryptedApiKey?: string;
  apiKeyBaseUrl?: string;
  lastDiagnostic?: ModelDiagnosticResult;
}

interface StoredConfig {
  version: 2;
  activeProfileId: string;
  profiles: StoredModelProfile[];
}

type LegacySettings = Partial<Omit<StoredModelProfile, "id" | "name">>;

const DEFAULT_PROFILE: StoredModelProfile = {
  id: DEFAULT_PROFILE_ID,
  name: "ModelScope · Qwen3 Coder 30B",
  apiBaseUrl: "https://api-inference.modelscope.cn/v1",
  model: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
  maxSteps: 12,
  commandTimeoutMs: 120_000,
  maxOutputChars: 20_000,
  permissionMode: "workspace",
  responseProfile: "balanced",
};

export class ConfigStore {
  private readonly filePath = path.join(app.getPath("userData"), "settings.json");

  public async publicSettings(): Promise<PublicSettings> {
    const config = await this.read();
    return this.toPublicSettings(activeProfile(config), true);
  }

  public async modelProfiles(): Promise<ModelProfilesSnapshot> {
    return this.toSnapshot(await this.read());
  }

  public async apiKey(): Promise<string | null> {
    const environmentKey = process.env.LOCALFORGE_API_KEY?.trim();
    if (environmentKey) {
      return environmentKey;
    }
    const profile = activeProfile(await this.read());
    if (!profile.encryptedApiKey || profile.apiKeyBaseUrl !== profile.apiBaseUrl) {
      return null;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("当前系统无法安全解密已保存的 API Key。");
    }
    return safeStorage.decryptString(Buffer.from(profile.encryptedApiKey, "base64"));
  }

  public async save(input: SettingsInput): Promise<PublicSettings> {
    const profile = activeProfile(await this.read());
    await this.saveModelProfile({ ...input, id: profile.id, name: profile.name });
    return this.publicSettings();
  }

  public async saveModelProfile(input: ModelProfileInput): Promise<ModelProfilesSnapshot> {
    const config = await this.read();
    const name = validateProfileName(input.name);
    const requestedId = input.id === undefined ? undefined : validateProfileId(input.id);
    const existingIndex = requestedId
      ? config.profiles.findIndex((profile) => profile.id === requestedId)
      : -1;
    if (requestedId && existingIndex < 0) {
      throw new Error("找不到要编辑的模型配置。");
    }
    if (existingIndex < 0 && config.profiles.length >= MAX_MODEL_PROFILES) {
      throw new Error(`最多保存 ${MAX_MODEL_PROFILES} 个模型配置。`);
    }
    if (
      config.profiles.some(
        (profile, index) => index !== existingIndex && profile.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new Error("模型配置名称不能重复。");
    }

    const existing = existingIndex >= 0 ? config.profiles[existingIndex] : undefined;
    const apiBaseUrl = validateApiBaseUrl(input.apiBaseUrl);
    const model = input.model.trim();
    if (!model) {
      throw new Error("模型名称不能为空。");
    }
    const profile: StoredModelProfile = {
      id: existing?.id ?? randomUUID(),
      name,
      apiBaseUrl,
      model,
      maxSteps: boundedInteger(input.maxSteps, 1, 50, "最大步骤数"),
      commandTimeoutMs: boundedInteger(input.commandTimeoutMs, 1_000, 600_000, "命令超时"),
      maxOutputChars: boundedInteger(input.maxOutputChars, 1_000, 200_000, "输出上限"),
      permissionMode: validatePermissionMode(input.permissionMode),
      responseProfile: validateResponseProfile(input.responseProfile),
      encryptedApiKey: existing?.encryptedApiKey,
      apiKeyBaseUrl: existing?.apiKeyBaseUrl,
      lastDiagnostic:
        existing?.apiBaseUrl === apiBaseUrl && existing.model === model
          ? existing.lastDiagnostic
          : undefined,
    };
    const newKey = input.apiKey?.trim();
    if (newKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("当前系统不支持安全保存 API Key；请使用 LOCALFORGE_API_KEY 环境变量。");
      }
      profile.encryptedApiKey = safeStorage.encryptString(newKey).toString("base64");
      profile.apiKeyBaseUrl = apiBaseUrl;
    }

    const profiles = [...config.profiles];
    if (existingIndex >= 0) {
      profiles[existingIndex] = profile;
    } else {
      profiles.push(profile);
    }
    await this.write({ version: 2, activeProfileId: profile.id, profiles });
    return this.modelProfiles();
  }

  public async activateModelProfile(id: string): Promise<PublicSettings> {
    const profileId = validateProfileId(id);
    const config = await this.read();
    if (!config.profiles.some((profile) => profile.id === profileId)) {
      throw new Error("找不到这个模型配置。");
    }
    await this.write({ ...config, activeProfileId: profileId });
    return this.publicSettings();
  }

  public async deleteModelProfile(id: string): Promise<ModelProfilesSnapshot> {
    const profileId = validateProfileId(id);
    const config = await this.read();
    if (!config.profiles.some((profile) => profile.id === profileId)) {
      throw new Error("找不到这个模型配置。");
    }
    if (config.profiles.length === 1) {
      throw new Error("至少需要保留一个模型配置。");
    }
    const profiles = config.profiles.filter((profile) => profile.id !== profileId);
    const activeProfileId = config.activeProfileId === profileId
      ? profiles[0]!.id
      : config.activeProfileId;
    await this.write({ version: 2, activeProfileId, profiles });
    return this.modelProfiles();
  }

  public async recordActiveDiagnostic(result: ModelDiagnosticResult): Promise<void> {
    const config = await this.read();
    const profiles = config.profiles.map((profile) =>
      profile.id === config.activeProfileId
        ? { ...profile, lastDiagnostic: normalizeDiagnostic(result) }
        : profile,
    );
    await this.write({ ...config, profiles });
  }

  private toSnapshot(config: StoredConfig): ModelProfilesSnapshot {
    return {
      activeProfileId: config.activeProfileId,
      profiles: config.profiles.map((profile) =>
        this.toPublicSettings(profile, profile.id === config.activeProfileId),
      ),
      maxProfiles: MAX_MODEL_PROFILES,
    };
  }

  private toPublicSettings(
    profile: StoredModelProfile,
    active: boolean,
  ): ModelProfileSummary {
    const environmentKey = active ? process.env.LOCALFORGE_API_KEY?.trim() : "";
    const hasSavedKey = Boolean(
      profile.encryptedApiKey && profile.apiKeyBaseUrl === profile.apiBaseUrl,
    );
    return {
      profileId: profile.id,
      profileName: profile.name,
      apiBaseUrl: profile.apiBaseUrl,
      model: profile.model,
      maxSteps: profile.maxSteps,
      commandTimeoutMs: profile.commandTimeoutMs,
      maxOutputChars: profile.maxOutputChars,
      permissionMode: profile.permissionMode,
      responseProfile: profile.responseProfile,
      hasApiKey: Boolean(environmentKey || hasSavedKey),
      apiKeySource: environmentKey
        ? "environment"
        : hasSavedKey
          ? "saved"
          : "missing",
      lastDiagnostic: profile.lastDiagnostic,
    };
  }

  private async read(): Promise<StoredConfig> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      return isRecord(raw) && raw.version === 2
        ? normalizeStoredConfig(raw)
        : migrateLegacy(isRecord(raw) ? raw as LegacySettings : {});
    } catch (error) {
      if (isMissingFileError(error) || error instanceof SyntaxError) {
        return defaultConfig();
      }
      throw error;
    }
  }

  private async write(config: StoredConfig): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function defaultConfig(): StoredConfig {
  return {
    version: 2,
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [{ ...DEFAULT_PROFILE }],
  };
}

function migrateLegacy(raw: LegacySettings): StoredConfig {
  const legacyName =
    raw.apiBaseUrl === DEFAULT_PROFILE.apiBaseUrl && raw.model === DEFAULT_PROFILE.model
      ? DEFAULT_PROFILE.name
      : typeof raw.model === "string" && raw.model.trim()
        ? raw.model.trim().slice(0, 40)
        : "旧模型配置";
  const profile = normalizeProfile({
    ...raw,
    id: DEFAULT_PROFILE_ID,
    name: legacyName,
  }, DEFAULT_PROFILE_ID);
  return { version: 2, activeProfileId: profile.id, profiles: [profile] };
}

function normalizeStoredConfig(raw: Record<string, unknown>): StoredConfig {
  const rawProfiles = Array.isArray(raw.profiles) ? raw.profiles : [];
  const profiles: StoredModelProfile[] = [];
  const ids = new Set<string>();
  for (const [index, value] of rawProfiles.slice(0, MAX_MODEL_PROFILES).entries()) {
    if (!isRecord(value)) {
      continue;
    }
    const profile = normalizeProfile(value, index === 0 ? DEFAULT_PROFILE_ID : randomUUID());
    if (!ids.has(profile.id)) {
      ids.add(profile.id);
      profiles.push(profile);
    }
  }
  if (profiles.length === 0) {
    return defaultConfig();
  }
  const requestedActive = typeof raw.activeProfileId === "string" ? raw.activeProfileId : "";
  return {
    version: 2,
    activeProfileId: profiles.some((profile) => profile.id === requestedActive)
      ? requestedActive
      : profiles[0]!.id,
    profiles,
  };
}

function normalizeProfile(raw: Record<string, unknown>, fallbackId: string): StoredModelProfile {
  const apiBaseUrl = safeApiBaseUrl(raw.apiBaseUrl, DEFAULT_PROFILE.apiBaseUrl);
  return {
    id: typeof raw.id === "string" && /^[a-z0-9_-]{1,80}$/i.test(raw.id)
      ? raw.id
      : fallbackId,
    name: typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim().slice(0, 40)
      : DEFAULT_PROFILE.name,
    apiBaseUrl,
    model: typeof raw.model === "string" && raw.model.trim()
      ? raw.model.trim().slice(0, 300)
      : DEFAULT_PROFILE.model,
    maxSteps: boundedOr(raw.maxSteps, DEFAULT_PROFILE.maxSteps, 1, 50),
    commandTimeoutMs: boundedOr(raw.commandTimeoutMs, DEFAULT_PROFILE.commandTimeoutMs, 1_000, 600_000),
    maxOutputChars: boundedOr(raw.maxOutputChars, DEFAULT_PROFILE.maxOutputChars, 1_000, 200_000),
    permissionMode: isPermissionMode(raw.permissionMode)
      ? raw.permissionMode
      : DEFAULT_PROFILE.permissionMode,
    responseProfile: isResponseProfile(raw.responseProfile)
      ? raw.responseProfile
      : DEFAULT_PROFILE.responseProfile,
    encryptedApiKey: typeof raw.encryptedApiKey === "string"
      ? raw.encryptedApiKey
      : undefined,
    apiKeyBaseUrl: typeof raw.apiKeyBaseUrl === "string"
      ? safeOptionalApiBaseUrl(raw.apiKeyBaseUrl)
      : typeof raw.encryptedApiKey === "string"
        ? apiBaseUrl
        : undefined,
    lastDiagnostic: normalizeDiagnostic(raw.lastDiagnostic),
  };
}

function normalizeDiagnostic(value: unknown): ModelDiagnosticResult | undefined {
  if (!isRecord(value) || typeof value.ok !== "boolean" || typeof value.model !== "string") {
    return undefined;
  }
  const checks = Array.isArray(value.checks)
    ? value.checks.map(normalizeDiagnosticCheck).filter((check): check is ModelDiagnosticCheck => Boolean(check))
    : [];
  return {
    ok: value.ok,
    model: value.model.slice(0, 300),
    latencyMs: boundedOr(value.latencyMs, 0, 0, 300_000),
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : new Date(0).toISOString(),
    checks: checks.slice(0, 5),
  };
}

function normalizeDiagnosticCheck(value: unknown): ModelDiagnosticCheck | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const ids = new Set(["connection", "text", "streaming", "toolCalling", "usage"]);
  const statuses = new Set(["passed", "failed", "skipped"]);
  if (
    typeof value.id !== "string" || !ids.has(value.id) ||
    typeof value.status !== "string" || !statuses.has(value.status) ||
    typeof value.detail !== "string"
  ) {
    return undefined;
  }
  return {
    id: value.id as ModelDiagnosticCheck["id"],
    status: value.status as ModelDiagnosticCheck["status"],
    detail: value.detail.slice(0, 500),
  };
}

function activeProfile(config: StoredConfig): StoredModelProfile {
  return config.profiles.find((profile) => profile.id === config.activeProfileId)
    ?? config.profiles[0]
    ?? { ...DEFAULT_PROFILE };
}

function validateProfileName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 40) {
    throw new Error("模型配置名称必须为 1 到 40 个字符。");
  }
  return name;
}

function validateProfileId(value: string): string {
  if (!/^[a-z0-9_-]{1,80}$/i.test(value)) {
    throw new Error("模型配置 ID 无效。");
  }
  return value;
}

function validateApiBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("API 地址不是有效 URL。");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("API 地址必须使用 HTTP 或 HTTPS。");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function safeApiBaseUrl(value: unknown, fallback: string): string {
  try {
    return typeof value === "string" ? validateApiBaseUrl(value) : fallback;
  } catch {
    return fallback;
  }
}

function safeOptionalApiBaseUrl(value: string): string | undefined {
  try {
    return validateApiBaseUrl(value);
  } catch {
    return undefined;
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return value;
}

function boundedOr(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function validatePermissionMode(value: unknown): PermissionMode {
  if (!isPermissionMode(value)) {
    throw new Error("Agent 权限必须是只读或工作区读写。");
  }
  return value;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "readOnly" || value === "workspace";
}

function validateResponseProfile(value: unknown): ResponseProfile {
  if (!isResponseProfile(value)) {
    throw new Error("响应档位必须是快速、标准或深入。");
  }
  return value;
}

function isResponseProfile(value: unknown): value is ResponseProfile {
  return value === "fast" || value === "balanced" || value === "thorough";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
