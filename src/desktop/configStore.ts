import { app, safeStorage } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PublicSettings, SettingsInput } from "./contracts";

interface StoredSettings {
  apiBaseUrl: string;
  model: string;
  maxSteps: number;
  commandTimeoutMs: number;
  maxOutputChars: number;
  encryptedApiKey?: string;
  apiKeyBaseUrl?: string;
}

const DEFAULTS: StoredSettings = {
  apiBaseUrl: "https://api-inference.modelscope.cn/v1",
  model: "deepseek-ai/DeepSeek-V4-Pro",
  maxSteps: 12,
  commandTimeoutMs: 120_000,
  maxOutputChars: 20_000,
};

export class ConfigStore {
  private readonly filePath = path.join(app.getPath("userData"), "settings.json");

  public async publicSettings(): Promise<PublicSettings> {
    const stored = await this.read();
    const environmentKey = process.env.LOCALFORGE_API_KEY?.trim();
    const hasSavedKey = Boolean(
      stored.encryptedApiKey && stored.apiKeyBaseUrl === stored.apiBaseUrl,
    );
    return {
      apiBaseUrl: stored.apiBaseUrl,
      model: stored.model,
      maxSteps: stored.maxSteps,
      commandTimeoutMs: stored.commandTimeoutMs,
      maxOutputChars: stored.maxOutputChars,
      hasApiKey: Boolean(environmentKey || hasSavedKey),
      apiKeySource: environmentKey
        ? "environment"
        : hasSavedKey
          ? "saved"
          : "missing",
    };
  }

  public async apiKey(): Promise<string | null> {
    const environmentKey = process.env.LOCALFORGE_API_KEY?.trim();
    if (environmentKey) {
      return environmentKey;
    }
    const stored = await this.read();
    if (!stored.encryptedApiKey || stored.apiKeyBaseUrl !== stored.apiBaseUrl) {
      return null;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("当前系统无法安全解密已保存的 API Key。");
    }
    return safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, "base64"));
  }

  public async save(input: SettingsInput): Promise<PublicSettings> {
    const current = await this.read();
    const apiBaseUrl = validateApiBaseUrl(input.apiBaseUrl);
    const model = input.model.trim();
    if (!model) {
      throw new Error("模型名称不能为空。");
    }
    const next: StoredSettings = {
      apiBaseUrl,
      model,
      maxSteps: boundedInteger(input.maxSteps, 1, 50, "最大步骤数"),
      commandTimeoutMs: boundedInteger(input.commandTimeoutMs, 1_000, 600_000, "命令超时"),
      maxOutputChars: boundedInteger(input.maxOutputChars, 1_000, 200_000, "输出上限"),
      encryptedApiKey: current.encryptedApiKey,
      apiKeyBaseUrl: current.apiKeyBaseUrl,
    };
    const newKey = input.apiKey?.trim();
    if (newKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("当前系统不支持安全保存 API Key；请使用 LOCALFORGE_API_KEY 环境变量。");
      }
      next.encryptedApiKey = safeStorage.encryptString(newKey).toString("base64");
      next.apiKeyBaseUrl = apiBaseUrl;
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return this.publicSettings();
  }

  private async read(): Promise<StoredSettings> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<StoredSettings>;
      const apiBaseUrl =
        typeof raw.apiBaseUrl === "string"
          ? validateApiBaseUrl(raw.apiBaseUrl)
          : DEFAULTS.apiBaseUrl;
      return {
        apiBaseUrl,
        model: typeof raw.model === "string" ? raw.model : DEFAULTS.model,
        maxSteps: integerOr(raw.maxSteps, DEFAULTS.maxSteps),
        commandTimeoutMs: integerOr(raw.commandTimeoutMs, DEFAULTS.commandTimeoutMs),
        maxOutputChars: integerOr(raw.maxOutputChars, DEFAULTS.maxOutputChars),
        encryptedApiKey:
          typeof raw.encryptedApiKey === "string" ? raw.encryptedApiKey : undefined,
        apiKeyBaseUrl:
          typeof raw.apiKeyBaseUrl === "string"
            ? validateApiBaseUrl(raw.apiKeyBaseUrl)
            : typeof raw.encryptedApiKey === "string"
              ? apiBaseUrl
              : undefined,
      };
    } catch (error) {
      if (isMissingFileError(error) || error instanceof SyntaxError) {
        return { ...DEFAULTS };
      }
      throw error;
    }
  }
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

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return value;
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
