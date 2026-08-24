import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
    decryptString: (value: Buffer) =>
      value.toString("utf8").replace(/^sealed:/, ""),
  },
  app: { getPath: () => "/unused" },
}));

import { getConfig, setConfig, taskProviderConfig } from "./ai";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "total-ai-profiles-"));
  process.env.TOTAL_DATA_DIR = root;
});
afterEach(() => {
  delete process.env.TOTAL_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("AI provider profiles and task routes", () => {
  it("retains separately encrypted OpenAI and compatible profiles across provider switches", () => {
    setConfig({
      enabled: true,
      provider: "compatible",
      apiMode: "chat_completions",
      model: "local-vision",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "local-key",
    });
    setConfig({
      enabled: true,
      provider: "openai",
      apiMode: "responses",
      model: "gpt-5-mini",
      baseUrl: null,
      apiKey: "openai-key",
    });

    expect(getConfig()).toMatchObject({ provider: "openai", hasApiKey: true });
    expect(taskProviderConfig("compatible")).toMatchObject({
      provider: "compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local-vision",
      hasApiKey: true,
    });
    expect(taskProviderConfig("openai")).toMatchObject({
      provider: "openai",
      model: "gpt-5-mini",
      hasApiKey: true,
    });
  });

  it("rejects a task route whose provider profile has not been configured", () => {
    expect(() => taskProviderConfig("compatible")).toThrow(
      /Configure and save/,
    );
  });
});
