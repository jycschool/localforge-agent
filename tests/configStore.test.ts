import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      profileId: "default",
      profileName: "ModelScope · Qwen3 Coder 30B",
      apiBaseUrl: "https://api-inference.modelscope.cn/v1",
      model: "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      maxSteps: 20,
      commandTimeoutMs: 120_000,
      maxOutputChars: 20_000,
      permissionMode: "workspace",
      responseProfile: "balanced",
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
    await expect(
      store.save(settingsInput({ permissionMode: "invalid" as never })),
    ).rejects.toThrow("Agent 权限");
  });

  it("keeps encrypted keys isolated while switching between saved profiles", async () => {
    const store = new ConfigStore();
    await store.save(settingsInput({ apiKey: "service-a-token" }));
    const created = await store.saveModelProfile({
      ...settingsInput({
        apiBaseUrl: "https://service-b.example/v1",
        model: "service-b-model",
        apiKey: "service-b-token",
      }),
      name: "Service B",
    });
    const serviceBId = created.activeProfileId;

    await expect(store.apiKey()).resolves.toBe("service-b-token");
    await store.activateModelProfile("default");
    await expect(store.apiKey()).resolves.toBe("service-a-token");

    const snapshot = await store.modelProfiles();
    expect(snapshot.profiles).toHaveLength(2);
    expect(snapshot.profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: "default", hasApiKey: true }),
      expect.objectContaining({ profileId: serviceBId, hasApiKey: true }),
    ]));
    expect(JSON.stringify(snapshot)).not.toContain("service-a-token");
    expect(JSON.stringify(snapshot)).not.toContain("service-b-token");
  });

  it("records diagnostics per profile and protects the final profile", async () => {
    const store = new ConfigStore();
    await store.recordActiveDiagnostic({
      ok: true,
      model: "test-model",
      latencyMs: 120,
      checkedAt: "2026-08-28T00:00:00.000Z",
      checks: [{ id: "toolCalling", status: "passed", detail: "ok" }],
    });

    await expect(store.modelProfiles()).resolves.toMatchObject({
      profiles: [{ lastDiagnostic: { ok: true, latencyMs: 120 } }],
    });
    await expect(store.deleteModelProfile("default")).rejects.toThrow("至少需要保留一个");
  });

  it("reads the previous single-profile settings format without losing its key", async () => {
    await writeFile(path.join(root, "settings.json"), JSON.stringify({
      apiBaseUrl: "https://legacy.example/v1",
      model: "legacy-model",
      maxSteps: 9,
      commandTimeoutMs: 30_000,
      maxOutputChars: 9_000,
      permissionMode: "readOnly",
      responseProfile: "fast",
      encryptedApiKey: Buffer.from("encrypted:legacy-token").toString("base64"),
      apiKeyBaseUrl: "https://legacy.example/v1",
    }), "utf8");
    const store = new ConfigStore();

    await expect(store.publicSettings()).resolves.toMatchObject({
      profileId: "default",
      apiBaseUrl: "https://legacy.example/v1",
      model: "legacy-model",
      hasApiKey: true,
    });
    await expect(store.apiKey()).resolves.toBe("legacy-token");
  });
});

function settingsInput(overrides: Partial<SettingsInput> = {}): SettingsInput {
  return {
    apiBaseUrl: "https://api-inference.modelscope.cn/v1",
    model: "test-model",
    maxSteps: 12,
    commandTimeoutMs: 120_000,
    maxOutputChars: 20_000,
    permissionMode: "workspace",
    responseProfile: "balanced",
    ...overrides,
  };
}
