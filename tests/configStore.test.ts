import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigStore } from "../src/desktop/configStore";
import type { SettingsInput } from "../src/desktop/contracts";

const electronMocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`, "utf8")),
  decryptString: vi.fn((value: Buffer) =>
    value.toString("utf8").replace(/^encrypted:/, ""),
  ),
}));

vi.mock("electron", () => ({
  app: { getPath: electronMocks.getPath },
  safeStorage: {
    isEncryptionAvailable: electronMocks.isEncryptionAvailable,
    encryptString: electronMocks.encryptString,
    decryptString: electronMocks.decryptString,
  },
}));

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "localforge-config-"));
  electronMocks.getPath.mockReturnValue(root);
  vi.stubEnv("LOCALFORGE_API_KEY", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("ConfigStore", () => {
  it("returns safe defaults without exposing a key", async () => {
    const settings = await new ConfigStore().publicSettings();

    expect(settings).toMatchObject({
      apiBaseUrl: "https://api-inference.modelscope.cn/v1",
      model: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      maxSteps: 12,
      commandTimeoutMs: 120_000,
      maxOutputChars: 20_000,
      hasApiKey: false,
      apiKeySource: "missing",
    });
    expect(settings).not.toHaveProperty("apiKey");
  });

  it("encrypts a saved key and only exposes its presence", async () => {
    const store = new ConfigStore();
    const input = settingsInput({ apiKey: "test-private-token" });

    const publicSettings = await store.save(input);
    const storedText = await readFile(path.join(root, "settings.json"), "utf8");

    expect(publicSettings).toMatchObject({ hasApiKey: true, apiKeySource: "saved" });
    expect(publicSettings).not.toHaveProperty("apiKey");
    expect(storedText).not.toContain("test-private-token");
    expect(storedText).toContain(Buffer.from("encrypted:test-private-token").toString("base64"));
    await expect(store.apiKey()).resolves.toBe("test-private-token");
  });

  it("does not reuse a saved key after the API service changes", async () => {
    const store = new ConfigStore();
    await store.save(settingsInput({ apiKey: "service-a-token" }));

    const next = await store.save(
      settingsInput({ apiBaseUrl: "https://service-b.example/v1", apiKey: undefined }),
    );

    expect(next).toMatchObject({ hasApiKey: false, apiKeySource: "missing" });
    await expect(store.apiKey()).resolves.toBeNull();
  });

  it("prefers an environment key and validates unsafe settings", async () => {
    vi.stubEnv("LOCALFORGE_API_KEY", "environment-token");
    const store = new ConfigStore();

    await expect(store.apiKey()).resolves.toBe("environment-token");
    await expect(store.publicSettings()).resolves.toMatchObject({
      hasApiKey: true,
      apiKeySource: "environment",
    });
    await expect(
      store.save(settingsInput({ apiBaseUrl: "file:///tmp/model" })),
    ).rejects.toThrow("HTTP 或 HTTPS");
    await expect(store.save(settingsInput({ maxSteps: 0 }))).rejects.toThrow("最大步骤数");
  });
});

function settingsInput(overrides: Partial<SettingsInput> = {}): SettingsInput {
  return {
    apiBaseUrl: "https://api-inference.modelscope.cn/v1",
    model: "test-model",
    maxSteps: 12,
    commandTimeoutMs: 120_000,
    maxOutputChars: 20_000,
    ...overrides,
  };
}
