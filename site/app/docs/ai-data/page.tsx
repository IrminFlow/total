import type { Metadata } from "next";
import FunnelBeacon from "@/components/FunnelBeacon";

export const metadata: Metadata = {
  title: "AI and data use - Docs",
  description: "What Total sends to AI providers, what stays local and how MCP access is controlled.",
  alternates: { canonical: "/docs/ai-data" },
};

export default function AiDataPage(): React.JSX.Element {
  return (
    <>
      <FunnelBeacon event="ai_data_view" />
      <h1 className="serif">AI and your accounting data</h1>
      <p className="sub">AI is optional. The books, calculations and reports do not depend on it.</p>

      <h2>Before anything is sent</h2>
      <p>
        Total does not enable an AI provider on its own. You choose OpenAI, an HTTPS OpenAI-compatible
        provider or a compatible service running on this computer. For each request, Total shows the
        context that will be included. Nothing is sent until you approve that context.
      </p>

      <h2>What the provider receives</h2>
      <p>
        The provider receives your instruction and only the context selected for that request. Its own
        privacy and retention terms apply. Total sends requests directly from the desktop app; the Total
        website does not receive or relay the prompt, response or provider key.
      </p>

      <h2>Keys and local records</h2>
      <p>
        Provider keys are encrypted with the operating system&rsquo;s secure storage. They are not included
        in company backups, accounting mirrors or support diagnostics. AI conversation history and review
        evidence stay in Total&rsquo;s local data folder unless you export them.
      </p>

      <h2>What AI cannot do</h2>
      <p>
        AI does not calculate ledger balances, GST totals, payroll or financial reports. Suggested entries
        remain drafts and must pass Total&rsquo;s deterministic validation and human approval before they can be
        posted. You should still check every suggestion against the source document and your accounting policy.
      </p>

      <h2>Local MCP access</h2>
      <p>
        Total&rsquo;s MCP server reads bounded JSON or CSV mirrors; it does not open the live company database.
        Access uses a one-time token limited to one company, selected actions and an expiry date. Only the
        token hash is retained. Agent-created changes enter the proposal queue and cannot post directly.
      </p>

      <p className="muted">
        Change or remove a provider in Settings → AI copilot. Revoke MCP access in Settings → Agent access.
        The <a href="/privacy">privacy page</a> covers support, website and integration data.
      </p>
    </>
  );
}
