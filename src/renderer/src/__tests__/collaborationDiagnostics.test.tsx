import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CollaborationSection } from "../screens/settings/CollaborationSection";
import { useSession } from "../state/stores";

const invoke = vi.fn();

beforeEach(() => {
  useSession.setState({ user: null });
  invoke.mockImplementation(async (channel: string) => {
    if (channel === "collaboration:status") return {
      ok: true,
      data: {
        phase: "error",
        configured: true,
        enabled: true,
        endpoint: "https://sync.example.test",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        deviceId: "22222222-2222-4222-8222-222222222222",
        pending: 3,
        conflicts: 1,
        cursor: "opaque-cursor",
        lastAttemptedAt: "2026-08-28T01:00:00.000Z",
        lastSyncedAt: "2026-08-27T23:00:00.000Z",
        lastError: "Network request timed out",
      },
    };
    if (channel === "collaboration:invitations:list") return { ok: true, data: [] };
    return { ok: false, error: `unmocked channel ${channel}` };
  });
  window.total = { platform: "test", invoke };
});

afterEach(() => cleanup());

describe("encrypted collaboration diagnostics", () => {
  it("shows the local phase, queue, attempt, success and bounded last error", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CollaborationSection />
      </QueryClientProvider>,
    );

    expect((await screen.findByText(/Local state:/)).textContent).toContain("Needs attention");
    expect(screen.getByText(/3 pending/).textContent).toContain("1 conflicts");
    expect(screen.getByText(/Last attempt/).textContent).toContain("Last success");
    expect(screen.getByText("Last error: Network request timed out")).toBeTruthy();
    expect(screen.queryByText("opaque-cursor")).toBeNull();
  });
});
