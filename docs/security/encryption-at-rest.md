# Company database encryption at rest — WP 7.2 spike and decision

Date: 2026-10-14 · Status: decided, implemented on `p7/wp7.2-security`

## Question

Total keeps each business as one SQLite file (`~/Documents/total/companies/<slug>/company.db`) plus
backups beside it. The roadmap (WP 7.2) asks for encryption at rest, with the design choice —
**a SQLCipher-compatible driver** vs **file-level encryption** — made by a time-boxed spike.

## Options

### A. SQLCipher-compatible driver: `better-sqlite3-multiple-ciphers`

The better-sqlite3 API (same author line; the package tracks better-sqlite3's versions — 12.11.1
here, identical to the one the app used) compiled over **SQLite3 Multiple Ciphers**, which adds
page-level encryption to SQLite. With `PRAGMA cipher = 'sqlcipher'; PRAGMA legacy = 4` the file is
in the **SQLCipher v4** format (AES-256-CBC per page, HMAC-SHA512 per page, a random salt in the
header), so it can also be opened by the stock SQLCipher tools with the same raw key.

### B. File-level: AES-256-GCM over the whole file

Keep plain better-sqlite3; encrypt `company.db` at rest with AES-256-GCM (key in safeStorage) and
decrypt it to a temporary / `userData` file while the business is open.

### C. `@journeyapps/sqlcipher`

A node-sqlite3 (callback, async) API, not better-sqlite3's synchronous one: every service in
`src/main/services/` would have to be rewritten. Rejected without a build.

## Evidence (spike)

| Check | A (multiple-ciphers) | B (file-level) |
|---|---|---|
| Electron ABI | `npx @electron/rebuild -f -w better-sqlite3-multiple-ciphers` builds in seconds (prebuilds published for Electron); `npm run test:db` (Electron-as-Node) passed **all 149 files / 1,558 tests** after swapping the import in 26 files — no other change | unchanged driver |
| API / types | identical (`Database`, `pragma`, `backup`, `transaction`; ships its own `index.d.ts`, the app typechecks clean) | unchanged |
| Plaintext files | open exactly as before (no key, no pragma) — the upgrade case | unchanged |
| Plaintext on disk while open | **never** — pages are encrypted in the file and the WAL | **yes** — the whole decrypted file sits on disk (temp / userData) for as long as the business is open, and after a crash |
| Crash safety | SQLite's own (WAL, atomic commits) | a crash between "write temp" and "re-encrypt" loses or exposes data; needs its own journal |
| Open cost (raw 32-byte key, no KDF per open) | see `src/main/db/encryption.perf.dbtest.ts` (100k vouchers, open + migrate check + quick_check + trial balance): measured on this (heavily loaded) laptop — see the PR for the printed figures; the guard is "encrypted ≤ 3× plaintext + 1 s" | decrypt the whole file on every open (O(file size)), re-encrypt on every close / backup |
| Backups | `VACUUM INTO` copies keep the key → every backup encrypted automatically; the online backup API refuses an encrypted source (uses `VACUUM INTO` instead) | every backup must be re-encrypted separately |
| `withMemberDb` (consolidation, read-only) | opens a member read-only with its key **if** that member was unlocked this session; otherwise skipped with "locked with a passphrase" | needs a decrypted copy of every member |
| MCP CLI (`total-cli`) | opens plaintext businesses as before; a locked one is refused with `db_locked` (deferred: `--passphrase`) | same refusal |
| e2e harness | unchanged; encryption in tests uses the insecure test cipher for the secret store and a cheap (still accepted) scrypt cost | — |
| CI (mac / win / linux) | native module like better-sqlite3 (`allowScripts` entry updated); `npm run build:mac` packages it | none |

The online backup API failure and `PRAGMA rekey` refusing WAL mode were found in the spike and
are handled in `db/encryption.ts` (`snapshotTo` → `VACUUM INTO`; `rekeyFile` switches to DELETE
journal first).

## Decision

**A — `better-sqlite3-multiple-ciphers`, SQLCipher v4 scheme, off by default, opt-in per business.**

B was rejected because it leaves the books in plaintext on disk the whole time the app is open (and
after a crash), turns every open / close / backup into a full-file crypto pass, and needs its own
crash-recovery journal — it protects a closed laptop only, which A also does, without those costs.
C was rejected because of its asynchronous API.

## Design

- **Keys.** A random 32-byte data key per business, used as SQLCipher's raw key (no KDF on each
  open). It is never stored as is: `db/keyEnvelope.ts` wraps it with AES-256-GCM under
  `scrypt(passphrase, salt; N = 2^17, r = 8, p = 1)` (the OWASP minimum for scrypt; the cost is
  bound into the GCM tag so a tampered envelope cannot lower it; at least 2^14 is accepted). The
  envelope is kept in `<company>/company.key.json` (so the folder still opens elsewhere with the
  passphrase) and mirrored in `<dataRoot>/secrets.json` under safeStorage (`company:<slug>` /
  `dbKeyEnvelope`). The passphrase is never stored; the unwrapped key lives in main's memory only
  while that business is open (`db/encryption.ts` folder-key map; forgotten on close).
- **Two envelope copies.** They can disagree (the folder put back from an older copy after a
  passphrase change, a keychain write that failed): an unlock tries each distinct envelope and
  accepts a key only once it opens the file; a mirror that cannot take a new envelope is cleared so
  an old passphrase does not survive in it. The envelope's associated data binds its version and
  scrypt cost, not the business: binding the folder name would break a folder imported under a new
  name, and an envelope of another business only unwraps a key that does not open this file.
- **Opening.** `company:open` on an encrypted file without a remembered key fails with
  `passphrase_required`; the picker asks (`simple/PassphrasePrompt.tsx`). Five wrong passphrases
  lock the prompt for 30 s. A plaintext business opens exactly as before — no prompt, nothing asked.
- **Turning it on / off** (`security:passphrase:on` / `off`, owner; `services/dbEncryption.ts`):
  a normal backup first, then a compacted copy with the target key beside the file, opened and
  compared fact by fact with the live books (every table's row count, the migration count, the
  audit chain's head and verdict, the trial balance's movement totals); the change is audited
  inside the copy (entity `security`), the live handle closed and the copy renamed over the
  original (same directory — atomic), then every backup converted the same way (copy, rekey,
  quick_check, rename). Any difference: the copy is deleted and nothing changes. Re-runnable: a
  crash before the rename leaves the original; after it the file is the verified copy. Review
  hardening (`db/encryptionCrash.dbtest.ts` simulates a crash at each step): background checks are
  stopped first; the copy is fsynced (F_FULLFSYNC on macOS) before the rename and the folder after;
  the swap is refused while the original still has WAL frames (they would be read as pages of the
  new file); a failed swap reopens the original; a leftover `company.db.converting` (plaintext when
  the lock was being taken off) is removed before the next open.
- **Changing the passphrase** re-wraps the same data key: books and backups are not rewritten.
- **Backups** of a locked business are encrypted with its key (`VACUUM INTO`). The encrypted export
  (`.totalbak`) contains a *plaintext* copy wrapped in its own passphrase file, so a recovery copy
  imports anywhere — the UI offers one right after locking.
- **Warning.** The screen says, in plain words, that a lost passphrase means lost books, and the
  lock button needs an "I understand" tick.

## What the lock does NOT protect (read this before relying on it)

- **A lost passphrase means lost books.** There is no recovery key, no back door and no support
  route: the data key exists only inside the envelope, wrapped by the passphrase. The recovery copy
  (`.totalbak`, offered right after locking) is the only way back — keep it, and its own passphrase,
  somewhere else. The screen says this and the lock button needs an "I understand" tick.
- **Copies made before the lock.** Backups inside the business's `backups/` folder are converted
  when the lock goes on, but any copy the user made elsewhere (a USB stick, a cloud folder, Time
  Machine / APFS local snapshots of `~/Documents/total/`) stays plaintext. So does the disk space the
  plaintext `company.db` used to occupy: the converted copy replaces it by a rename, the old file is
  deleted, never overwritten — secure erase is not possible on APFS / SSDs. Locking protects what is
  written from now on.
- **Recovery copies import unlocked.** A `.totalbak` holds a plaintext copy under its own passphrase;
  importing it creates a business WITHOUT the passphrase lock (turn it on again there).
- **A backup file alone cannot be opened.** Its key is in `company.key.json` beside the books (and in
  this Mac's keychain-protected `secrets.json`); there is no in-app way to open an encrypted backup
  `.db` copied away on its own — copy the whole business folder, or use the `.totalbak`.
- **Not encrypted at all:** attachments (`attachments/`, `backups/attachments/`), capture files,
  exports (CSV / XLSX / PDF / JSON), logs, and the temporary plaintext snapshot an encrypted export
  writes (`exports/.export-tmp-*.db`, removed when the export finishes, or on the next open after a
  crash). SQLite's own temporary files are not verified to be encrypted (`temp_store` default).
- **Turning the lock off** decrypts the books and every backup; the key file stays only while some
  backup could not be converted (it would be unreadable without it) — `backupsFailed` says which.
- **While the business is open** the key is in the app's memory; anyone at the unlocked Mac can read
  the books (that is what the screen lock / auto-lock is for).

## Not covered (deferred)

- Attachments (`attachments/`, `backups/attachments/`), capture files, exports, logs and the
  temporary plaintext snapshot inside an encrypted export are not encrypted.
- The MCP CLI and `total-cli` refuse a locked business (no `--passphrase` yet).
- Consolidation reads a locked member only while that member is the open business.
- "Remember on this Mac" (keychain-held key, no prompt) is not offered: the passphrase is asked on
  every open.
