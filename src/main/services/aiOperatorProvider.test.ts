import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^sealed:/, ""),
  },
  app: { getPath: () => "/unused" },
}));

import { planOperator, setConfig } from "./ai";

let root = "";
const originalFetch = globalThis.fetch;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "total-operator-provider-"));
  process.env.TOTAL_DATA_DIR = root;
  setConfig({
    enabled: true,
    provider: "compatible",
    apiMode: "chat_completions",
    model: "operator-test",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "test-only-key",
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.TOTAL_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function providerResponse(content: string): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "operator-test",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("AI Operator provider plans", () => {
  it("accepts a valid bounded plan from a compatible Chat Completions provider", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => providerResponse(JSON.stringify({
      summary: "Open Day Book",
      actions: [{ kind: "navigate", screen: "day-book", reason: "Review entries" }],
    })));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(planOperator("Show the day book", "{}")) .resolves.toMatchObject({
      summary: "Open Day Book",
      actions: [{ kind: "navigate", screen: "day-book" }],
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.response_format).toEqual({ type: "json_object" });
    expect(request.messages[0].content).toContain("Allowed action kinds");
  });

  it.each([
    ["non-JSON content", "This endpoint cannot return JSON"],
    ["an unsupported response shape", JSON.stringify({ result: "unsupported" })],
    ["an action outside the operator contract", JSON.stringify({ summary: "Run it", actions: [{ kind: "shell", command: "ls", reason: "Inspect" }] })],
  ])("rejects %s", async (_label, content) => {
    globalThis.fetch = vi.fn(async () => providerResponse(content)) as typeof fetch;
    await expect(planOperator("Do the work", "{}")) .rejects.toThrow(/invalid operator plan/);
  });

  it("propagates cancellation to the compatible provider request", async () => {
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
    const controller = new AbortController();
    const pending = planOperator("Build a plan", "{}", controller.signal);
    controller.abort(new Error("operator plan cancelled"));
    await expect(pending).rejects.toThrow(/cancel|abort/i);
  });
});
