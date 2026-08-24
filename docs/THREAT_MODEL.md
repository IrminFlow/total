# Total desktop threat model

Last reviewed for release: 0.5.0 · 24 August 2026

## Assets and trust boundaries

The primary assets are company SQLite databases, document attachments, local PIN hashes, provider
credentials, NIC credentials, webhook secrets, MCP tokens, signing identities, backups and exported
reports. The renderer is untrusted relative to the Electron main process. Imported files, MCP
clients, AI providers, bank feeds, webhook receivers, integration manifests and opened URLs are
external inputs. A signed-in user is still constrained by role, department and export policies.

## Required release controls

- Renderer: sandbox enabled, context isolation enabled, Node integration disabled, external
  navigation denied, permission requests denied, and only the narrow preload invoke bridge exposed.
- IPC: every `total:*` channel is Zod-validated at its handler, role/permission checked in the main
  process, department scoped, and logged without payloads. File reads require a native chooser or
  safe contained path.
- Filesystem: databases use WAL-safe snapshots, restore uses read-only preview plus atomic swap and
  rollback, JSON configuration uses crash-safe atomic writes, and managed attachment/MCP paths use
  containment checks and byte limits.
- Updates: production packages use the release contract, public non-draft releases, signature and
  notarization gates, and a constrained update feed. The app never executes an update payload as a
  plugin.
- MCP and integrations: tokens are one-company/scope/expiry bound and hash-only at rest; proposals
  and refreshes require human approval. Plugin manifests are strict data-only declarations and
  receive no code execution, SQLite, ambient filesystem, network or cross-company access.
- Providers and outbound network: AI and bank provider endpoints require HTTPS except loopback,
  credentials are platform encrypted, responses have time/size limits, webhook payloads are visible
  and HMAC signed, and all optional network surfaces are summarized in the Privacy centre.
- Recovery: automatic backups are opened read-only and verified, destination copies are verified
  again, encrypted portable backups have authenticated encryption, and recovery drills retain
  evidence without overwriting live books.

## Explicit non-goals and residual risks

Total does not protect a company from an attacker who already controls the signed-in operating
system account and can read process memory. Platform key-store envelopes may require secret
re-entry after moving data to another computer. User-mounted cloud folders can be unavailable or
sync slowly; the app therefore verifies the local destination copy but cannot promise provider-side
durability. Clipboard clearing only occurs if Total's copied value remains current so it does not
destroy unrelated user clipboard data. Offline operation reduces remote exposure but does not
replace endpoint security, disk encryption or tested off-device backups.

## Release review procedure

Run `npm run security:threat-model`. Any boundary change must update this document, the secret
inventory, relevant tests and the automated gate before release. Reviewers must inspect new IPC
channels, new URL/file operations, credential storage, network destinations, MCP tools, plugin
permissions and updater configuration. Security-sensitive exceptions are release blockers.

