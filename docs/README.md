# Total documentation index

Last updated: 28 August 2026.

Use this index instead of guessing which similarly named roadmap or runbook is current.

## Source-of-truth order

1. Architecture, invariants, coding rules, and release boundaries: [../CLAUDE.md](../CLAUDE.md)
2. Current product scope and status: [../ROADMAP.md](../ROADMAP.md)
3. Agent-owned execution: [../TASKS.md](../TASKS.md)
4. Product-owner actions: [../HUMAN.md](../HUMAN.md)
5. Exact release mechanics: [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md)
6. Service deployment: [ENCRYPTED_COLLABORATION.md](ENCRYPTED_COLLABORATION.md) and [../site/INTAKE_OPERATIONS.md](../site/INTAKE_OPERATIONS.md)
7. Historical feature catalogue and implementation narrative: [BACKLOG_300.md](BACKLOG_300.md) and [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)

If two documents conflict, follow the higher source in this list and update the lower document in the same change.

## Current service boundary

The isolated Supabase staging project `cewz…qmlx` and staging site are configured. Migrations through
`collaboration_invitation_history` are applied, `total-sync` v13 and `total-intake` v10 are active,
unauthenticated sync returns HTTP 401, a distinct-user signed relay exercise passed with exact
cleanup, and staging support/private-token tracking plus feedback idea/vote/follow checks passed.
Production is untouched and pending. Installed-device collaboration, representative customer
migration exports, signing and human acceptance remain pending; final review and release have not
started.

## Product and design

- [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md): detailed v5 completion history and the older numbered rollout narrative. Use root [ROADMAP.md](../ROADMAP.md) for current status.
- [BACKLOG_300.md](BACKLOG_300.md): exhaustive catalogue of 300 product and technical opportunities. It is a catalogue, not the active sprint board.
- [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md): historical mapping of implemented backlog items and remaining acceptance work.
- [DESIGN_SYSTEM_V05.md](DESIGN_SYSTEM_V05.md): visual tokens, density, typography, color, states, and interaction patterns.
- [ACCESSIBILITY.md](ACCESSIBILITY.md): keyboard, focus, contrast, language, reduced-motion, and acceptance requirements.
- [COMMERCIAL_LAUNCH_OPTIONS.md](COMMERCIAL_LAUNCH_OPTIONS.md): recommended free-beta and later commercial choices.
- [COMMERCIAL_POLICY.md](COMMERCIAL_POLICY.md): current pricing, licence, refund, and support policy draft.

## AI, agents, and integrations

- [AI_OPERATIONS.md](AI_OPERATIONS.md): provider, context, retained-plan approval binding,
  evaluation, proposal, and AI release rules.
- [MCP_CONTRACT_V1.md](MCP_CONTRACT_V1.md): local MCP tools, resources, permissions, and no-write guarantees.
- [INTEGRATION_SDK_V1.md](INTEGRATION_SDK_V1.md): partner adapter and plugin contract.
- [ENCRYPTED_COLLABORATION.md](ENCRYPTED_COLLABORATION.md): Supabase encrypted-sync protocol,
  device signatures, quarantine, session refresh, deployment, and invitation model.
- [PORTABLE_FORMAT.md](PORTABLE_FORMAT.md): versioned portable company and agent-readable JSON format.

## Security and privacy

- [THREAT_MODEL.md](THREAT_MODEL.md): desktop, data, renderer, IPC, import, AI, network, and release threats.
- [SECURITY_SECRET_INVENTORY.md](SECURITY_SECRET_INVENTORY.md): every credential class, storage location, exposure boundary, and rotation expectation.
- [DEPENDENCY_EXCEPTIONS.md](DEPENDENCY_EXCEPTIONS.md): reviewed transitive deprecation exceptions and owners.

## Support and service operations

- [SUPPORT_OPERATIONS.md](SUPPORT_OPERATIONS.md): support triage, response, diagnostics, retention, and deletion operations.
- [../site/INTAKE_OPERATIONS.md](../site/INTAKE_OPERATIONS.md): exact Vercel Blob, private support
  tracking, Supabase intake, Resend, secret, retention, and synthetic-test deployment procedure.
- [STAGED_UPDATES.md](STAGED_UPDATES.md): update channels, deterministic cohorts, kill switches, and branch test artifacts.

## Acceptance and release

- [STAGING_READINESS_CHECKLIST.md](STAGING_READINESS_CHECKLIST.md): fail-closed admission checklist for an isolated v5 staging environment; platform verification is deliberately outside its scope.
- [ACCEPTANCE_RUNBOOK.md](ACCEPTANCE_RUNBOOK.md): application and role-based acceptance procedure.
- [acceptance/HUMAN_SESSION_KIT.md](acceptance/HUMAN_SESSION_KIT.md): scripts and evidence template for real human sessions.
- [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md): signing secrets, candidate build, acceptance binding, and immutable promotion.
- [PRODUCTION_CUTOVER.md](PRODUCTION_CUTOVER.md): final deployment, service, download, updater, and go/no-go sequence.

## Other repository guides

- [../integration-sdk/README.md](../integration-sdk/README.md): integration SDK packaging and validation.
- [../agent-skill/SKILL.md](../agent-skill/SKILL.md): bundled Total agent skill.
- [../agent-skill/AGENTS.md](../agent-skill/AGENTS.md): instructions scoped to the bundled skill directory.
- [../site/AGENTS.md](../site/AGENTS.md): website-specific instructions.
- [../site/CLAUDE.md](../site/CLAUDE.md): website tool indirection; preserve its generated convention.
- [../test/fixtures/migrations/README.md](../test/fixtures/migrations/README.md): migration fixture definitions.

## Documentation maintenance rules

- Put a last-updated date on status and operating documents.
- Do not copy secrets or real customer data into examples.
- Distinguish implemented, configured, accepted, signed, and released.
- Link to exact commands and source files instead of restating fragile implementation details repeatedly.
- Update root `ROADMAP.md`, `TASKS.md`, and `HUMAN.md` when status changes.
- New Markdown files must be added to this index.
- Preserve historical evidence as historical; never present dated evidence as acceptance for a new revision.
