import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CopilotPanel } from "../components/CopilotPanel";
import { useSession } from "../state/stores";

const conversationId = "00000000-0000-4000-8000-000000000010";
const requestId = "00000000-0000-4000-8000-000000000020";
const invoke = vi.fn();

function renderPanel(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CopilotPanel onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useSession.setState({
    from: "2026-04-01",
    to: "2027-03-31",
    user: { id: 1, name: "Owner", role: "owner" },
  });
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(requestId);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Copilot conversation and cancellation UI", () => {
  it("restores local history and cancels the exact in-flight request without dropping the conversation", async () => {
    let rejectAsk: ((reason: Error) => void) | null = null;
    let cancelled = false;
    invoke.mockImplementation(async (channel: string, payload?: unknown) => {
      const immediate: Record<string, unknown> = {
        "device-safety:get": { aiCopilot: true, mcpAccess: false, supportUploads: false, telemetry: false },
        "ai:getConfig": { enabled: true, provider: "openai", apiMode: "responses", model: "gpt-test", baseUrl: null, hasApiKey: true },
        "ai:conversations:list": [{
          id: conversationId,
          title: "August close",
          createdBy: "Owner",
          createdAt: "2026-08-25T10:00:00.000Z",
          updatedAt: "2026-08-25T10:01:00.000Z",
        }],
      };
      if (channel === "ai:conversations:messages") {
        return { ok: true, data: cancelled ? [
          { id: 1, conversationId, requestId, role: "assistant", content: "Request cancelled before an answer was completed.", citations: [], provider: null, model: null, usage: null, status: "cancelled", createdAt: "2026-08-25T10:02:00.000Z" },
        ] : [
          { id: 1, conversationId, requestId: null, role: "assistant", content: "Prior local answer", citations: [], provider: "openai", model: "gpt-test", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, status: "completed", createdAt: "2026-08-25T10:01:00.000Z" },
        ] };
      }
      if (channel === "ai:ask") {
        return await new Promise((_resolve, reject) => { rejectAsk = reject; });
      }
      if (channel === "ai:cancel") {
        cancelled = true;
        rejectAsk?.(new Error("AI request cancelled"));
        return { ok: true, data: { cancelled: true } };
      }
      return channel in immediate
        ? { ok: true, data: immediate[channel] }
        : { ok: false, error: `unmocked channel ${channel} ${JSON.stringify(payload)}` };
    });
    window.total = { platform: "test", invoke };

    renderPanel();
    expect(await screen.findByText("Prior local answer")).toBeTruthy();
    expect(screen.getByText("10 in · 4 out · 14 total tokens")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Ask about your books…"), {
      target: { value: "Explain this quarter" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText(/You can cancel/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("ai:cancel", { requestId }));
    expect(await screen.findByText("Request cancelled before an answer was completed.")).toBeTruthy();
    expect(screen.getByText("cancelled")).toBeTruthy();
    expect((screen.getByLabelText("Copilot conversation") as HTMLSelectElement).value).toBe(conversationId);
  });
});
