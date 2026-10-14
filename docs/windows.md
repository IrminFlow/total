# Total on Windows (WP 7.3)

Total ships a Windows build (NSIS installer, `Total-Setup-<version>.exe`) from the same sources as
the macOS app. This page lists what is verified on Windows, how to run the tests there, and what
differs from macOS. The user-facing version is the in-app help article **Total on Windows**
(`src/renderer/src/help/{en,hi,hinglish}/windows.md`).

## Verification matrix

"CI" = the `build-win` job in `.github/workflows/ci.yml` on `windows-latest` (every push and PR),
and `release-win` in `release.yml` on tags. "Unit" = a vitest test that runs on every OS.

| Area | How it is verified on Windows |
| --- | --- |
| Typecheck, engine tests (`npm test`) | CI |
| Renderer tests (`npm run test:renderer`) | CI (new in WP 7.3) |
| DB-layer tests (`npm run test:db`, Electron-as-Node, better-sqlite3 Electron ABI) | CI |
| Build (`npm run build`, both main entries incl. `out/main/pdfWorker.js`) | CI |
| Headless CLI (`total-cli`: esbuild bundle, Electron-as-Node, data dir with a space) | CI (`help`, `create-company`, `companies`) |
| App launch + IPC round trip (company → ledger → voucher → TB → bin/restore) | CI smoke against `out/` |
| Backup → change → restore (file swap with every handle closed — Windows EPERM path) | CI smoke |
| Encrypted backup (`.totalbak`) | CI smoke |
| PDF worker thread loads (from `app.asar` in the packaged build) | CI smoke (unpackaged + packaged) |
| Devanagari print font found (`resources/fonts` via `extraResources`) | CI smoke (unpackaged + packaged) |
| Secret store: DPAPI available (`safeStorage.isEncryptionAvailable()`) | CI smoke (packaged; asserted on win32) |
| UI flows: onboarding, voucher lifecycle, unregistered sale, setup wizard presets | CI e2e subset `01 03 46 48` |
| NSIS build; `latest.yml` names the uploaded installer exactly (auto-update) | CI + release |
| Packaged `Total.exe` launches and passes the smoke | CI + release |
| Tally XML in UTF-16LE (with / without BOM), UTF-8 BOM, CRLF | Unit (`src/shared/windowsImport.test.ts`, fixtures in `src/shared/fixtures/windows/`) |
| Bank statements (CSV / TXT / MT940 / CAMT.053 / Excel "Unicode Text") with BOM + CRLF | Unit (same file) |
| Reserved names (CON, NUL, COM1 …), invalid characters, MAX_PATH | Unit (`src/shared/fileNames.test.ts`) |
| CLI's Documents folder (registry known folder, OneDrive redirect) | Unit (`src/shared/windowsPaths.test.ts`) |
| Temp-file rename retry (EPERM / EACCES / EBUSY) | Unit (`src/main/fsRetry.test.ts`, injected) |
| Shortcut labels Ctrl / Alt | Unit (`src/shared/shortcutLabels.test.ts`, `src/renderer/src/lib/platform.test.ts`) |
| Updater text (SmartScreen, `Documents\total`, `/api/download?platform=win`) | Unit (`src/shared/updateText.test.ts`) |

Not verified without a real Windows machine (CI runners have no interactive user, no OneDrive,
no SmartScreen, no installed update to replace): the NSIS installer actually installing and
uninstalling, an in-place update from a previous version, SmartScreen's dialog, Explorer reveals and
the default PDF viewer opening a file, the capture-inbox watcher with a file another program holds
open, DPAPI after a password reset or a roaming profile, OneDrive-redirected Documents, HiDPI
scaling, and printing to a physical printer. Check these by hand on a Windows 10 / 11 machine
before a release that changes them.

## Running the tests on Windows

PowerShell, from a checkout (Node 22, `npm ci`; `postinstall` rebuilds better-sqlite3 for Electron):

```powershell
npm run typecheck
npm test
npm run test:renderer
npm run test:db
npm run build
$env:TOTAL_DATA_DIR = "$env:TEMP\Total smoke"; npm run smoke
node scripts/run-e2e.mjs 01 03 46 48
npx electron-builder --win --publish never
$env:TOTAL_APP_EXECUTABLE = "$PWD\dist\win-unpacked\Total.exe"; npm run smoke   # the packaged app
```

The harness (`scripts/lib/harness.mjs` `launchTarget` / `launchEnv`) launches
`node_modules\electron\dist\electron.exe` with the checkout as its app, or the packaged exe when
`TOTAL_APP_EXECUTABLE` is set; it drops `ELECTRON_RUN_AS_NODE` (any casing) and sets
`TOTAL_NO_UPDATE_CHECK=1`. `TOTAL_INSECURE_TEST_SECRETS` only applies to an unpackaged build; a
packaged Windows run uses DPAPI, which needs no prompt.

`TOTAL_DATA_DIR` is used verbatim — drive letters, spaces and 8.3 short names (`RUNNER~1`) all work
(the CI job uses `…\Total smoke data`).

### DB-test hook timeouts

The Windows DB job used to fail now and then with `Hook timed out in 10000ms` (stockCostIpc and
others). Measured locally, about 95 % of those IPC tests' `beforeAll` was `await import('./ipc')` —
the whole main-process module graph — not the fixture (2.4 s import vs 0.14 s company create /
open). The import now happens at collection (top-level await before the hooks), where vitest has no
hook timeout. The job also excludes the workspace and temp folders from Defender's real-time scan
(every new SQLite file and `-wal`/`-shm` write was scanned). `hookTimeout` is unchanged (10 s).

## Known differences from macOS

- **Keys**: shortcuts accept Ctrl as well as ⌘ everywhere (`e.metaKey || e.ctrlKey`). Labels are
  written ⌘ / ⌥ in the sources; on Windows `installPcShortcutLabels` (lib/platform.ts) rewrites
  the text on screen to Ctrl+ / Alt+ / Shift+.
- **Data folder**: `app.getPath('documents')\total`. With OneDrive folder backup (default on many
  Windows 11 machines) that is `…\OneDrive\Documents\total` and the sync-folder warning shows at
  start. The CLI reads the Documents known folder from the registry so it opens the same books.
- **Installer**: per-user (`perMachine: false`), no administrator rights, no file associations.
  Unsigned, so SmartScreen warns on first run ("More info → Run anyway"); the updater dialog says so.
- **Updates**: electron-updater installs in place on quit (no `publisherName`, so no signature
  check); the manual fallback opens `/api/download?platform=win`. `nsis.artifactName` is
  `${productName}-Setup-${version}.${ext}` — no spaces, so the GitHub asset name equals the one in
  `latest.yml` (0.11.0 shipped `Total.Setup.0.11.0.exe` while `latest.yml` named
  `Total-Setup-0.11.0.exe`, so Windows auto-update could not download it).
- **File names**: company slugs and export names that are device names get a suffix
  (`con` → `con-company`, `nul.csv` → `nul-export.csv`); an opened attachment copy is renamed for
  Windows (invalid characters, reserved stems, MAX_PATH). The stored name never changes.
- **File locks**: a rename over a file a scanner holds open is retried briefly (`fsRetry.ts`); the
  capture inbox leaves a file another program holds open for the next scan.
- **Text files**: user files (Tally XML, bank CSV, CSV masters, GSTR-2B / template JSON) are read
  through `decodeTextFile` (BOM / UTF-16 aware).
- **Exports keep LF**: CSV and JSON written by Total use `\n` line endings on every platform (Excel,
  the GST offline tools and every importer read them); they are not converted to CRLF.
- **Secrets**: DPAPI ties them to the Windows account; the "secure storage unavailable" message
  says so on Windows.
- **MCP**: the copied `claude mcp add` / Claude Desktop config uses a backslash path for a Windows
  checkout; the single-quoted form is for PowerShell / Git Bash.
