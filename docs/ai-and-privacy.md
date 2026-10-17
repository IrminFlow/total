# AI and privacy: what stays on your computer and what can leave

Earlier descriptions of Total said it is "fully offline" with "no internet". That is not accurate
any more. This page replaces that claim with the exact list. It is written so that you can check
each statement in the code; file paths are relative to the repository root.

**Short version.** Your books are stored on your computer only, in `~/Documents/total/` (or the folder
named by `TOTAL_DATA_DIR` for scripted runs). Total has no accounts, no cloud copy, no analytics and
no crash reporting that I could find (no such dependency is in `package.json`). Total is not
"fully offline": it can make network requests in the cases below. The update check runs by
default (and can be switched off); the AI helper and live filing only after you set them up; a link only when you click it:

| What | When | Where it goes | Needs you to opt in? |
|---|---|---|---|
| Update check | About 5 seconds after launch, once per launch, packaged app only, and only while "Check for updates automatically" is on; also Settings, About (or How Total looks in simple mode), "Check for updates" / "Check now" | At launch: GitHub's release feed for `IrminFlow/total` (electron-updater); and, if that errors, `devjindal.tech/api/latest`, then `api.github.com`. "Check now" / "Check for updates" asks `devjindal.tech/api/latest` (then `api.github.com`) only | It is on by default and you can turn it off: "Check for updates automatically" (app-wide, owner only where the business has users). With it off, Total makes no request at launch. Nothing is downloaded until you press "Download now". |
| AI helper | Only after you accept the data notice and add your own key | OpenAI (`https://api.openai.com/v1`) | Yes |
| Live e-invoice / e-way bill filing | Only when you press a live-filing button after entering credentials | The NIC API address you typed in | Yes |
| Opening a link | When you click a help link, a reminder's "Open in WhatsApp", "Email…" on a statement, or "Support" | Your browser or mail app, not Total | Only on click |

Everything else (bookkeeping, GST figures, reports, printing, the Hindi and Hinglish text, Ask
Total, backups, imports, exports) works with the network unplugged.

## 1. What never leaves your computer

- **The books.** Every company is one SQLite file under `~/Documents/total/companies/<name>/`,
  opened by `src/main/db/` through better-sqlite3 in the Electron main process. Nothing syncs it.
  Backups are copies in the same folder tree unless you export one yourself.
- **The screens cannot reach the network.** The window's Content-Security-Policy is
  `default-src 'self'` (`src/renderer/index.html`). `src/main/ai/networkBoundary.test.ts` fails the
  build if renderer, preload or shared code calls `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource` or `sendBeacon`, or imports the OpenAI SDK; inside main only `src/main/ai/provider.ts`
  may import it.
- **Ask Total** (`src/main/assist/`) is deterministic code: no model, no key, no network.
- **The help panel** (`src/renderer/src/help/`) is bundled into the app at build time. Help links to
  the GST portal and CBIC open in your browser only on click, and only for an allow-listed address
  (`help:openLink` in `src/main/ipc.ts`).
- **Secrets are not in your books.** Passwords and keys live in `<data folder>/secrets.json`,
  encrypted with Electron `safeStorage` (the macOS Keychain, Windows DPAPI or libsecret). There is
  no plain-text fallback: if the OS cannot encrypt, saving a secret fails
  (`src/main/services/secrets.ts`). Company files and company backups never contain them, so after
  restoring a backup on another computer you enter them again. One exception: backups taken
  **before 0.5.0** still contain NIC credentials in plain text (see the 0.5.0 entry in
  [CHANGELOG.md](../CHANGELOG.md)); take a fresh backup.

## 2. The update check

Code: `src/main/updater.ts`, started from `src/main/index.ts`. Only the packaged app does this.

1. About 5 seconds after launch, **only if "Check for updates automatically" is on** (the
   default), the app asks electron-updater to check the GitHub releases feed of `IrminFlow/total`
   (`build.publish` in `package.json`): electron-updater 6.8 reads
   `https://github.com/IrminFlow/total/releases.atom` (or `…/releases/latest`) and then the release's
   `latest-mac.yml` / `latest.yml`. electron-updater is set to `autoDownload = false` and
   `autoInstallOnAppQuit = false`: it only looks. If a newer version exists, an in-app notice says
   "Total 0.13.0 is available" with "Download now", "Later" and "Skip this version". Nothing is
   downloaded until you press "Download now". "Skip this version" is remembered (that version
   stays quiet on automatic checks; a newer one is shown, and "Check now" still shows it). "Later"
   hides the notice until Total restarts.
2. After a download finishes, a second notice offers "Restart to update", "Install when I quit" or
   "Later". The update is installed only on your action: restarting, or quitting after you chose
   "Install when I quit". After "Later" nothing is installed when you quit.
   Changing the setting or answering a notice follows the shared-API-key rule: in a business with
   users only the owner may; in a business without users it is refused while any other business on
   this computer has users, and otherwise needs an explicit confirmation. Every change is appended
   to `app-settings-audit.jsonl`.
3. If electron-updater reports an error (the usual case for today's unsigned macOS builds), a
   one-time fallback asks `https://devjindal.tech/api/latest` (`SITE_URL` in
   `src/shared/product.ts`) for the newest version, and if the site does not answer,
   `https://api.github.com/repos/IrminFlow/total/releases/latest`. "Check now" (simple Settings) and
   "Check for updates" (Settings, About) go straight to these two. Only if the version is newer
   does the same notice appear; "Download now" then opens the release page or download link in
   your browser and you install the new version yourself. If a download or an install through
   electron-updater fails (an unsigned macOS build cannot replace itself), the notice turns into
   the same browser download; "Install when I quit" is offered only after electron-updater itself
   finished a download. How far an unsigned macOS build gets before it fails is **unverified**
   (no signed or unsigned release was tested for this page).
4. The comparison with your version happens on your computer. What is requested is the version
   information at those addresses: plain GET requests with no body and no company data. As with
   any web request, the server sees your IP address and the request headers. electron-updater's
   requests (read in `node_modules/builder-util-runtime/out/httpExecutor.js` and
   `electron-updater/out/AppUpdater.js`, version 6.8) carry `User-Agent: electron-builder` (not
   your app version) and `Cache-Control: no-cache`, plus an `x-user-staging-id` header that
   electron-updater fills with a random id it keeps per installation (`.updaterId` in the app's
   user-data folder) for staged roll-outs. Total does not use staged roll-outs and overrides that
   header with a fixed all-zero value (`NEUTRAL_REQUEST_HEADERS` in `src/main/updaterCore.ts`), so
   the request carries no identifier of Total's or of the installation. The site / GitHub API
   requests use the default headers of Electron's built-in `fetch` (no identifier, no version of
   Total; the exact `User-Agent` string is **unverified**).

Where to turn it off: Settings, About, "Check for updates automatically" (full app), or Settings,
How Total looks, "Updates" (simple mode). It is one app-wide setting kept in
`<data folder>/app-settings.json` (not in any company file or backup; changes are appended to
`app-settings-audit.jsonl`); where a business has users, only an owner can change it. With it off
the app makes no request at launch; "Check now" still checks when you ask. A development run
(`npm run dev`) never checks. You can also block the app in a firewall; the app keeps working.

## 3. The AI helper (optional, off by default, your own key)

Code: `src/main/ai/` (settings in `ai/settings.ts`, the network call in `ai/provider.ts`, masking in
`ai/privacy.ts`, the outbound log written in `ai/agent.ts`). Shapes the screens need are in `src/shared/ai.ts`.

**It is off until you do four things:** open Settings, AI (or "AI helper" in simple mode), read and
accept the data notice, paste an OpenAI API key, and turn it on. It is off per company. If the
notice text changes, you must accept it again. You pay OpenAI directly; Total has no hosted service.

**What is sent when you use it.** Only what a question needs: your message, the screen you are on
(the panel shows the exact lines it will tell the model), and the results of the read-only tools the
model chose to call (for example a trial balance or an outstandings list). Tool results are
formatted by the app, and the app checks the figures in an answer against the tool results the model
saw, and flags any it cannot find (`ai/numbers.ts`).

**Masking.** Before sending, GSTINs, PANs, IFSC codes and account numbers are masked. Optionally,
customer and supplier names are replaced by stable aliases (answers show the real names again).
These are the toggles in Settings, AI. Details and limits:

- Masking looks for identifiers in text (`maskIdentifiers` in `ai/privacy.ts`). It does not know
  that a free-text note contains something private. Names of items, ledgers other than parties,
  narrations and amounts are sent as they are.
- **Photos of bills and PDFs sent as files cannot be masked.** The capture dialog tells you which
  files these are before you send them. A PDF with a readable text layer is sent as masked text.
  File names are never sent (`bill.pdf`).
- Nothing in the capture flow is sent until you confirm a cost estimate.

**What the assistant cannot do.** It reads and drafts. It never saves to your books: a draft opens
in the normal voucher editor and is saved only when you press Save, so roles, lock dates and credit
holds still apply (`ai_drafts`, `ai/drafting/`). Its "memory" holds no GSTINs, PANs, bank numbers,
phone numbers or e-mails.

**What is recorded locally.** Settings, AI shows an outbound log (`ai_outbound_log`): when, how
large, which tools were offered, whether masking was on, and a hash. The content itself is not
stored. Costs go to `ai_usage` and show once you fill in the price table. "Delete all AI data"
removes conversations, drafts, memory and usage for the company.

**Your key.** Stored with `safeStorage` under the app-wide scope (`secrets.json`), never in a company
file or backup. Screens only ever show its last four characters. In a company with users, only the
owner can change it; every change is also written to `<data folder>/ai-key-audit.jsonl`
(append-only).

**What needs the key.** The chat panel, "Explain this", drafting from plain language, bill capture,
the model step of statement categorisation, "Run with AI" on the assistants, and asking for a report
in words. **Works without a key:** the Assistants screen (close checklist, GSTR-2B mismatches,
anomalies), the rule-based steps of statement categorisation, the phrase-based report reader, memory
suggestions from the books, Ask Total, and the MCP server (the MCP client brings its own model).

**Unverified.**

- The default model names `gpt-6.1-sol` and `gpt-6-luna` were never checked against a live account.
  Use Settings, AI, "Test connection" to list the models your key can use; the simple-mode helper
  picks from that list.
- What OpenAI does with the data on its side (retention, training) is governed by your agreement with
  OpenAI and is not something this app can verify. Read their terms for your account type.
- The evaluation suite (`docs/ai-evals.md`) checks Total's own behaviour (masking, refusals) with a
  scripted model in CI. Live-model runs are a manual workflow and are reported, not enforced.

## 4. Live e-invoice and e-way bill filing (optional)

Code: `src/main/services/nic.ts`. By default Total only writes the JSON files for the government's
offline tools. If you enter NIC API credentials (e-Invoice, "Set up live filing"), Total calls the
address you typed (`baseUrlEinvoice`) to authenticate and to generate IRNs and e-way bills.

- Credentials are encrypted with `safeStorage` under that company's scope (see section 1).
- The client is built from NIC's published API pages (listed in the file's header) and tested against
  a fake sandbox only. **It has never run against the real portal** (no credentials were available).
  Treat it as experimental and try the NIC sandbox first.

## 5. The MCP server (optional, local, off by default)

Code: `src/main/mcp/`, started with `npm run cli -- mcp` from a source checkout of the repository
(the installed app does not include `total-cli`).

- It speaks **stdio only**: the AI client you configure starts it as a child process on your own
  computer. It opens no network port and makes no network call itself (`mcpBoundary.test.ts` keeps the
  SDK out of the app bundle).
- It is switched on per company by the owner (Settings, "Agent access"; stored as meta `mcp`,
  default off), read-only by default; drafting needs an accountant or owner role and, in a company
  with users, a user name and PIN.
- Identifiers are masked by field by default. Every request is logged by size and a hash, never the
  content (`mcp_log`).
- A business locked with a passphrase opens only with the passphrase in the environment variable
  `TOTAL_PASSPHRASE` (never a command-line flag, which other users of the computer can see). It sits
  in your MCP client's configuration in plain text; it is never logged or stored by Total
  (docs/security/encryption-at-rest.md, "CLI, MCP and consolidation access").
- **What you connect to it is your choice, and that client may send what it reads to its own
  provider.** Total cannot see or limit that.

## 6. Links that open outside the app

Clicking "Support" opens a small dialog where you can copy the address or launch your mail app
(`SUPPORT_EMAIL`, `src/renderer/src/components/SupportLink.tsx`). A link in the app opens in your
default browser (`setWindowOpenHandler` in `src/main/index.ts`); help links are limited to the GST
portal and CBIC. On a statement, "Email…" saves a PDF and opens a mail draft; on a reminder in
People, "Open in WhatsApp" opens a `wa.me` link in your browser with the reminder text in it
(`src/renderer/src/simple/people/ReminderPanel.tsx`). Those texts leave the app only when you
click, and then go to whatever app or site handles the link. Total does not append anything about
you to them.

## What to do if your policy is stricter than this

- Leave the AI helper off (the default) and never enter NIC credentials.
- Turn off "Check for updates automatically" (Settings, About), or block the app's outbound traffic in your
  firewall. Everything except the optional features above keeps working.
- Run `npm run test:db` and `npm test` from a source checkout; the boundary tests above run there.

If you find a statement here that the code does not support, please open an issue on
<https://github.com/IrminFlow/total/issues>.
