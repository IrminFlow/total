# Dependency deprecation exceptions

The dependency gate rejects every deprecated direct dependency and every new, unreviewed
transitive deprecation. Six transitive exceptions remain because their current direct owners
still publish them. They are build-time or bounded import/update paths, not code selected by
untrusted input without Total's own validation and size limits.

| Deprecated package | Current owner path | Resolution |
| --- | --- | --- |
| `boolean` | electron-builder 26.15.3 -> @electron/get -> global-agent | Await upstream replacement; packaging only. |
| `fstream` | exceljs 4.4.0 -> unzipper | Await ExcelJS archive-stack upgrade; XLSX input is capped and fuzzed. |
| `glob` 7 | ExcelJS archive helpers and electron-builder -> @electron/asar | Await both upstream owners; no application glob API is exposed. |
| `inflight` | glob 7 | Removed with the owning glob upgrade. |
| `lodash.isequal` | electron-updater 6.8.9 and exceljs -> fast-csv | Both direct owners are already at their current registry releases. |
| `rimraf` 2 | ExcelJS -> unzipper -> fstream and Windows packaging | Await upstream archive/packaging upgrades; never called by app data-deletion flows. |

`better-sqlite3` was upgraded from 12.11.1 to 13.0.3 for v0.5. This removed deprecated
`prebuild-install` and its obsolete helper chain while retaining the reviewed native-runtime
allow-list, Electron smoke coverage, backup/restore soak coverage and the complete DB suite.

Review this table before each release. `scripts/dependency-policy.mjs` fails automatically if
the lockfile introduces any deprecated package not listed here.
