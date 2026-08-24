# Secret inventory and handling

Total is offline-first. This inventory is the release checklist for every credential-like value;
no new secret may be introduced without adding its storage, encryption, exposure and rotation path
here.

| Secret | Storage | Protection at rest | Renderer exposure | Backup / diagnostics behavior | Rotation |
|---|---|---|---|---|---|
| Local user PIN | Company SQLite `users.pin_hash` | Salted password hash; original PIN is never retained | PIN input only; never returned | Hash is present in database backups; excluded from diagnostics, logs, mirrors and exports | Owner sets a new PIN |
| AI provider API key | Device-level `ai-provider.json` | Electron OS-backed `safeStorage`; file mode `0600`; crash-safe atomic write | Only `hasApiKey`; key is never returned | Excluded from company backups, mirrors, logs and support diagnostics | Replace or clear in Settings → AI copilot |
| Local MCP access token | Device-level `mcp-access.json` | One-time 256-bit random secret; only its SHA-256 hash is retained in a crash-safe file | Plaintext is returned exactly once at issue time; later views show metadata only | Excluded from company backups, mirrors, diagnostics and MCP audit arguments | Revoke or let expire in Settings → Agent access, then issue a replacement |
| Integration webhook signing secret | Encrypted envelope in company SQLite `webhook_endpoints.encrypted_secret` | Electron OS-backed `safeStorage`; only decrypted in the main process for an attempted delivery | Password input only; endpoint lists return `hasSecret`, never the secret | Company backups contain only the OS-protected envelope; outbox payloads, logs, audits, mirrors and diagnostics exclude it | Pause the endpoint and create a replacement endpoint with a new secret |
| Attachment vault key | Encrypted envelope in company SQLite `meta['attachments.encryption.key']` | Random 256-bit AES key protected by Electron OS-backed `safeStorage`; documents use AES-256-GCM | Never exposed; renderer sees only enabled state and migrated-file count | Encrypted attachments and the protected key envelope are included in company backups; excluded from diagnostics and mirrors | Turn encryption off to decrypt while the current platform key is available, or re-encrypt after restoring |
| Export-signing private key | Device-level `export-signing.json` | Ed25519 private key protected by Electron OS-backed `safeStorage`; public key and fingerprint remain public | Renderer sees status, key ID and public key only | Excluded from company backups and diagnostics; public key is embedded in signature sidecars | Create a new device identity; existing signatures remain verifiable with their embedded public key |
| NIC API password and client secret | Encrypted envelope in company SQLite `meta.nic` | Entire credential object encrypted with Electron OS-backed `safeStorage`; legacy plaintext is upgraded on read | Both secret fields return only `••••••••` | Backups contain only the OS-protected envelope; diagnostics, logs, audit rows and mirrors exclude values | Re-enter in Settings → NIC live filing; another Mac may require re-entry |
| Encrypted-backup passphrase | Process memory during one export/import | Never persisted | Password input for the active operation only | Not included in the resulting archive, logs or diagnostics | Create a new encrypted export with a new passphrase |
| Support webhook bearer secret | Vercel environment (`SUPPORT_WEBHOOK_SECRET`) | Hosting provider secret store | Never reaches browser or desktop app | Not part of app data or diagnostics | Rotate in hosting and receiver environments |
| Private support-store credential | Vercel project (`BLOB_READ_WRITE_TOKEN` / short-lived OIDC) | Hosting provider secret store; private Mumbai-region Blob store | Server routes only; private objects cannot be read by public URL | Never reaches the browser, desktop app, logs or diagnostic bundles | Rotate or disconnect in Vercel Storage; verify case intake after rotation |

Support diagnostics are deliberately allow-listed, not redacted after collection: only app version,
OS platform and CPU architecture are constructed. The in-app support dialog shows the exact JSON
before submission. IPC logging records channel names and sanitized error messages, never payloads.
