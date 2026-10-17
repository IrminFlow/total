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
| `withMemberDb` (consolidation, read-only) | opens a member read-only with its key **if** that member is the open business or its passphrase was given for the run (PR #132); otherwise skipped with "locked with a passphrase" | needs a decrypted copy of every member |
| MCP CLI (`total-cli`) | opens plaintext businesses as before; a locked one opens with `TOTAL_PASSPHRASE` (PR #132), else it is refused | same refusal |
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
- **Opening.** `company:open` on an encrypted file without a key (in memory this session, or
  remembered on this computer — below) fails with `passphrase_required`; the picker asks (`simple/PassphrasePrompt.tsx`). Five wrong passphrases
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
- **Changing the passphrase** re-wraps the same data key: books, backups and files are not rewritten.
- **Files** (attachments in `attachments/`, their backup copies in `backups/attachments/`, captured
  bills in `capture/files/`; `db/fileCrypto.ts`). While the business is locked every stored file is
  `TLF1` | 12-byte random nonce | 16-byte GCM tag | AES-256-GCM ciphertext, under a per-file subkey
  HKDF-SHA256(data key, info = `total-file-v1` + the file's SHA-256) — the additional data is the
  magic + nonce. Files keep their content-addressed name (the PLAINTEXT's hash), so dedupe works as
  before; every read checks the tag and the plaintext hash, and takes either form (a plaintext file
  that happens to begin with `TLF1` is told apart by its own hash). Writes encrypt when the
  business's key is remembered for its folder (`db/folderKeys.ts`), plaintext otherwise. The key
  never leaves main: opening an attachment decrypts it into the session's private temp copy
  (as before, removed on quit / swept after a day); capture processing and the PDF worker get the
  decrypted bytes in memory; attaching a captured bill reads it decrypted and stores it under the
  attachment store's own subkey.
  - **Lock on** encrypts every file after the books are swapped; **lock off** decrypts them just
    before the swap (while the key is still in hand). Each file: a converted copy beside it
    (`<sha>.tlf-converting`, hash-checked), fsynced, renamed over it, the folder fsynced. A
    `.files-converting` marker is written before the swap and removed when every file is in the
    target form; every open of the business resumes a marked conversion toward the BOOKS' form
    (`resumeFileConversion`), and a file already in that form is skipped — so a crash between the
    swap and the files, or in the middle, is finished on the next open; a crash during lock off
    before the swap re-encrypts what was decrypted. Leftover `*.tlf-converting` / scratch files are
    swept with the other leftovers before the open. A file that cannot be converted (damaged) is
    left as it was and reported (`filesFailed`); taking the lock off keeps the key file while any
    file is still encrypted. Locking the business again (`security:passphrase:on`) uses that key
    file's key again when the passphrase opens it — so the leftover files (and backups) open as
    before — and refuses (`security_files_pending`) while a file still waits on a key the given
    passphrase does not open: a new key would lose it for good.
  - A backup copy of a stored file (`backups/attachments/`, same key) is the ciphertext copied as
    it is once it is known to open — never a plaintext scratch beside it; only a copy to ANOTHER
    key goes through one (removed at once, swept on the next open after a crash).
  - **Backups**: local backups copy files as stored (encrypted); the `.totalbak` export's plaintext
    snapshot carries the DECRYPTED files (it is protected by its own passphrase and imports
    anywhere); a restore writes each file in the live store's form — so a plaintext backup's files
    restored into a locked business come back encrypted. The data-folder move (PR #133) copies the
    files as they are.
  - **The capture inbox** (`capture-inbox/`, with its `processed/` and `failed/`) is the user's own
    drop folder and is NOT encrypted: a bill dropped there is plaintext until intake moves it, and
    the moved original stays in `processed/` as the user's file. Only the queued copy in
    `capture/files/` is encrypted.
- **Remember on this computer** — see the section below.
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
- **Not encrypted at all:** the capture inbox (`capture-inbox/` and its `processed/` / `failed/`,
  the user's own drop folder), an attachment's opened copy while the viewer has it (the session's
  temp folder), exports (CSV / XLSX / PDF / JSON), logs, and the temporary plaintext snapshot an encrypted export
  writes (`exports/.export-tmp-*.db`, removed when the export finishes, or on the next open after a
  crash). SQLite's own temporary files are not verified to be encrypted (`temp_store` default).
- **Turning the lock off** decrypts the books, every backup and every stored file; the key file
  stays only while some backup or file could not be converted (it would be unreadable without it)
  — `backupsFailed` / `filesFailed` say which.
- **While the business is open** the key is in the app's memory; anyone at the unlocked Mac can read
  the books (that is what the screen lock / auto-lock is for).
- **The screen lock without people** (PR #127): a business without users can lock its screen too
  (⌘L / the auto-lock). With the passphrase lock on, `session:unlock` needs the passphrase
  (throttled like opening); without it the lock is only a privacy screen — anyone can unlock it,
  and the screen says so. The key stays in memory while locked either way.
- **Capability flags** (PR #112, gaps closed in PR #127): main enforces every flag; `canSeeProfit:
  false` also redacts the trial balance (income / expense ledgers, the computed P&L row and the
  totals left out), refuses report-builder models and AI tools that show the profit, skips profit
  reports in report packs and answers Ask Total's profit questions with a note; the year-end
  close preview, consolidation runs, the CA pack and the agent mirror's trial balance (app export
  and MCP resource) follow the flag too. Deliberately not covered: the raw books (day book, ledger
  statements, registers, the books export, the voucher mirrors) — one side of the P&L at a time is
  allowed by design, so the profit stays derivable by anyone who may read every voucher. The renderer hides
  or disables export / Save / AI-settings buttons only for a flag set to false, so owners and
  unflagged users see what they always did. `canExport` covers `EXPORT_CHANNELS` (capabilities.ts:
  files of the books or a report of them, party statements included — `receivables:statementPdf`,
  `receivables:statementsBulk` — and the statutory / bank upload files, `payroll:ecr` / `payroll:esi`
  / `payroll:ptCsv`, `bulkPay:export`, the bank reconciliation PDF `banking:brsPdf`, report packs `pack:runNow` /
  `pack:save`); prints are not exports and stay ungated by decision — the
  invoice PDF (`invoice:pdf` / `invoice:pdfBatch`), the labels PDF (`stock:labelsPdf`), counter /
  trade-document / payslip / cheque prints and blank import templates (`NOT_EXPORTS`, each with its
  reason) follow their role only. Every channel
  audited as an export is in one of the two lists (securityReview.dbtest).

## Remember on this computer

Opt-in per business, off by default, never pre-ticked (`services/companyKeys.ts`
`storeRememberedKey` / `unlockWithRememberedKey`, `company:open` `remember`).

- **What is stored.** The passphrase prompt has "Remember on this computer". Ticked, and the
  passphrase right, main keeps the **data key** — never the passphrase — in the secret store under
  `company:<slug>` / `rememberedDataKey`. Like every secret there it is encrypted by safeStorage
  (macOS Keychain / Windows DPAPI, bound to this computer's login; the test cipher only in hermetic
  test runs) — there is no plaintext fallback: without secure storage the tick is refused, and so
  is storage not bound to this login (`SecretStore.strong()`: Linux safeStorage's `basic_text`
  backend — a hard-coded key anyone with the file undoes — or an `unknown` one; NIC / AI secrets
  keep using `available()`)
  (`remember_unavailable`, the open still succeeds). `security.dbtest.ts` checks `secrets.json`
  holds neither the passphrase nor the key in hex or base64.
- **Who decides.** The owner. In a business without people whoever opens it is its owner, so the key
  is stored at once. In a business with people the tick waits in memory until this open's first
  sign-in: an owner's keeps it (audited with the owner's name), anyone else's drops it.
- **Opening.** `company:open` without a passphrase tries the remembered key first and accepts it
  only once it opens the file (as `unlockKey` accepts an unwrapped key). A key that no longer opens
  it (`db_key_mismatch` — the lock was taken off and put on again: a new data key) is dropped and the
  prompt shown with a note (`remembered_key_stale`); any other read failure leaves it alone and asks
  for the passphrase this time. People's PINs are still asked after it opens. Deleting a business
  never uses it — the delete asks for the passphrase as before.
- **When it goes.** Forget in Settings → Security / Lock and safety (owner), Forget beside the
  business in the company picker and on the screen lock's passphrase prompt (forgetting only takes
  the convenience away, so the picker may do it before anyone signs in; in an open business with
  people only the owner may), taking the lock off (recorded in that conversion's audit row), and
  turning it on again (a new key; the old one could never open the file). A passphrase **change**
  keeps it: the data key is the same, so the remembered key still opens the books — forget it too if
  the change is because someone learned the passphrase. Deleting the business removes its whole
  secret-store scope.
- **Audit.** Remember / forget are `security` rows (`rememberedOnThisComputer` true / false, `from:
  'picker'` for the picker's Forget, written inside the books with the remembered key) — never the
  key.
- **Threat note.** That is the point of the option: **anyone who can sign in to this computer's
  user account opens these books without the passphrase**, and malware running as that user can ask
  the keychain for the key. It protects the books against a copy of the folder or the disk taken
  elsewhere (the key stays in this computer's keychain), not against this login. The screen lock
  (PR #127) still applies while the business is open — PINs when it has people; in a business
  without people the lock asks for the passphrase, but quitting and reopening the app opens it with
  the remembered key, so a real lock needs people with PINs. Use it only on a computer that only
  you use.
- **Not used by `total-cli` / MCP** — they read `TOTAL_PASSPHRASE` only (and have no safeStorage
  under Electron-as-Node anyway); consolidation reads a locked member with the open business's key
  or a passphrase given for the run, never a remembered key.

## CLI, MCP and consolidation access (PR #132)

- **`total-cli` and the MCP server** (`src/main/cli/unlock.ts`). Every command that opens a
  business (`--company`: `post`, `import-masters`, `trial-balance`, `next-number`, `export`,
  `inbox`, `mcp`) unlocks a locked one from the environment variable **`TOTAL_PASSPHRASE`**.
  - **Never a flag.** A process's command line is readable by every user of the computer (`ps`,
    Activity Monitor, Task Manager) and lands in shell history; its environment is readable only by
    the same user (and an administrator). The CLI reads the variable once, at start — before it
    starts anything (on Windows the data-root lookup runs `reg` / `powershell`) — and deletes it
    from its own environment, so nothing it starts afterwards (worker threads included: they copy
    the environment when they are created) inherits it. What deleting cannot reach: the
    `scripts/total-cli.mjs` launcher (the process the MCP client starts, which then starts
    Electron-as-Node) keeps the variable in its environment while the command runs, and on Linux
    `/proc/<pid>/environ` keeps showing a process's ORIGINAL environment to the same user and root.
    Neither widens who can read it — the same user can read the client's configuration file anyway.
  - **Same unlock as the app.** `companyKeys.unlockCompanyKey` → `unlockKey`: every envelope
    (folder copy, then the secret-store mirror where the CLI can read it — under Electron-as-Node
    there is no safeStorage, so normally only `company.key.json`), a key accepted only once it opens
    the file. Missing, wrong or throttled prints the app's message (`That passphrase is not right`
    for a wrong one) and **exits with code 2** (other failures stay 1). A plaintext business ignores
    a passphrase given for it.
  - **The throttle.** The wrong-passphrase counter (5 wrong → 30 s) is one per-process map keyed by
    slug in `companyKeys.ts`, shared by `company:open` / `company:delete` / `session:unlock`,
    consolidation runs and the CLI. The app never persisted it and neither does the CLI: a CLI
    process tries once and exits, so its counter never reaches the limit. That is acceptable
    because the counter is not the defence against guessing — the envelope's scrypt cost
    (N = 2^17, ~0.5 s and 128 MB a try) is, and anyone who can start a process as this user can
    copy `company.key.json` and guess offline at that same cost. A persisted counter would be a
    file that same user can delete.
  - **The key is forgotten** when the command ends (`forgetFolderKey`) and again on process exit
    (`forgetAllKeys`); the unwrapped buffer is zeroed after it is remembered, and the remembered
    copy is zeroed when the command's handle has closed (`forgetCliKey`). For `mcp` the
    session's database handle holds the key for as long as the server runs, so the per-request
    re-checks (kill switch, user still active, same PIN) work exactly as on a plaintext file.
  - **Never stored.** The passphrase is not logged, audited or written to `mcp_log` (sizes and a
    hash of each request only — the passphrase is never part of a request); `mcp.dbtest.ts` checks
    the log, the audit log and the files.
  - **Client configuration.** Settings → Agent access adds a `TOTAL_PASSPHRASE` placeholder to the
    copied Claude Code / Claude Desktop snippets for a locked business, with a warning: the client's
    configuration file holds it in plain text, and anyone who can read that file can open the books.
    Prefer a viewer session, and keep that file private.
- **Consolidation** (`services/consolidated.ts`). `withMemberDb` reads a locked member with its
  folder's remembered key — the open business; keys are forgotten when a business closes, so "opened
  earlier this session" does not count — or with a key unwrapped for **one run** from the optional
  `memberPassphrases: { [slug]: passphrase }` of `consolGroup:run` (Zod-strict payload). Each one goes
  through the same throttled unlock (a wrong one refuses the run, naming the member); members of
  other groups, plaintext members and the open business ignore their entry; the keys are never
  remembered and are zeroed when the run ends (`dropMemberKeys`); the passphrases are never stored,
  logged or audited. A locked member with no key is skipped exactly as before ("locked with a
  passphrase — skipped …"), so no figure changes. The renderer does not ask for member passphrases
  yet (the payload field is there for it); member charts and pair suggestions still skip a locked
  member that is not open.

## Not covered (deferred)

- Exports, logs, the capture inbox and the temporary plaintext snapshot inside an encrypted export
  are not encrypted (attachments and captured bills are, since the files follow-up — see Design).
- The consolidation screen does not ask for member passphrases yet (the run payload takes them,
  PR #132); member charts / pair suggestions skip a locked member that is not open.
