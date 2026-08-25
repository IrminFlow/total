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

## Abuse cases and required responses

| Abuse case | Boundary response | Verification |
| --- | --- | --- |
| A renderer sends malformed or oversized IPC data | Zod rejects the payload before company or actor state is read. The central permission gate still applies to valid data. | IPC handler validation tests and `ipcPermissions.test.ts` |
| A copied MCP request is replayed | The app-presence broker binds authorization to a scoped token hash and rejects a reused nonce during the broker session. | `mcpPresenceBroker.test.ts` |
| Several MCP clients pair while the broker starts or stops | Concurrent starts share one readiness promise. Shutdown destroys open local sockets and removes the Unix socket. | `mcpPresenceBroker.test.ts` |
| A support retry contains corrupt ciphertext or loses its device key | The outbox retains the encrypted item, records the failed attempt, and does not send an unvalidated body. Attachment retries require fresh consent. | `supportHandlers.test.ts` and `supportOutbox.test.ts` |
| A backup, portable package or JSON mirror is truncated or tampered with | Integrity, schema, path, count and digest checks run before live company data is replaced or adjacent files are read. | backup, complete-backup, migration-tools and agent-mirror DB tests |
| A spreadsheet, image, XML file or plugin manifest is hostile | Size, container, nesting, schema and path bounds reject unsafe input. Parsed text remains inert. | XLSX safety, boundary fuzz and integration manifest tests |
| A credential is committed to the repository | CI scans tracked text for private-key blocks and common provider token formats. Environment files with literal secret assignments are rejected. | `npm run security:audit` |

## Evidence and incident handling

Run `npm run security:evidence` from the candidate revision. It writes a JSON record containing the
revision, dirty-tree state, threat-model result, tracked-file scan result and SHA-256 digests of this
document and the secret inventory. Candidate evidence must come from the reviewed clean revision;
locally generated dirty-tree evidence is diagnostic only.

If a credential may have leaked, revoke it at the provider before removing it from source history.
Preserve only redacted logs and file digests needed to establish scope. Disable the affected feature
with its device or release flag, test the replacement credential, rerun the security evidence command
and record which release first contains the correction.

## Release review procedure

Run `npm run security:threat-model` and `npm run security:audit`. Any boundary change must update this document, the secret
inventory, relevant tests and the automated gate before release. Reviewers must inspect new IPC
channels, new URL/file operations, credential storage, network destinations, MCP tools, plugin
permissions and updater configuration. Security-sensitive exceptions are release blockers.
