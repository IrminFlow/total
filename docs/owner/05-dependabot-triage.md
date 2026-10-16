# Total: the security alerts and Dependabot PRs, sorted

**16 October 2026.** Written for the owner. "Dependabot" is GitHub's helper that watches the
libraries Total is built from and warns when one has a known weakness (an "alert"). It also opens
"PRs" (proposed changes, reviewed before they go in) that bump a library to a fixed version.
Numbers below were read live from GitHub on 16 October 2026.

---

## 1. The short version

- **56 alerts are open.** 44 are about the app (`package-lock.json`), 12 are about the website (`site/package-lock.json`).
- **None of them is a hole in your books.** Total keeps everything on your own computer, loads only its own screens, and does not open web pages or accept outside connections. The alerts are about library code that could be misused by a hostile web page or file, and Total does not give it one.
- **The big one is Electron (36 of 44 app alerts).** Electron is the engine that lets Total run as a Mac and Windows program. It is inside every download, so it does reach users. The fix is a big version jump (37 to 43), which needs its own piece of work and a full re-test.
- **The website alerts are the only ones on a public server** (3 critical). A small patch bump fixes all 12. Merging means the live website redeploys, so it is your call (see 4.3).
- **6 open Dependabot PRs:** #3 Electron, #7 and #14 test tool, #13, #16 and #63 website.

---

## 2. Which alerts reach a shop owner?

GitHub labels most of the app alerts "development", because the library is listed as a build-time tool. That label is misleading for Electron, so here is the real split.

| Where it runs | Reaches users? | Examples |
|---|---|---|
| **Inside the downloaded app** | Yes | Electron (the engine) |
| **Only on the developer's machine or in the automatic tests** | No | vitest, tinypool, extract-zip (unpacks Electron while building), http-cache-semantics (used by the build tooling), sprintf-js (used by a build helper) |
| **On the public website server (Vercel)** | Not the app, but visitors to the website | next, sharp, source-map-js |

---

## 3. The groups, one by one

### 3.1 App: Electron (36 alerts: 11 high, 19 medium, 6 low, 0 critical)

- **What it is:** the browser-like engine Total's screens run in. We ship version 37.10.3. The advisories are for window and permission handling (sandbox escapes, use-after-free crashes, path checks), mostly needing a hostile web page or a hostile local program to trigger.
- **Does it affect an offline shop owner?** Little in practice. Total opens no remote pages, refuses embedded web views, blocks navigation away from its own screens and only opens a short list of links in your browser. A few are Windows- or Mac-specific (installer and update paths). Still, it is the engine inside the app, so it should not stay old for long.
- **Which PR:** **#3** (Electron 37.10.3 to 43.4.1, open since 24 August). Fixed versions named in the alerts go up to 41.10.6, so 43 covers all 36. Version 37 itself has no patched release, so there is no small fix.
- **Recommendation: after 1.0, as its own work package, first in the queue.** It must rebuild the database driver, re-run all end-to-end tests on Mac and Windows, and check the installers. Do not squeeze that in before 1.0.

### 3.2 App: no fix exists yet (4 alerts: 3 high, 1 medium)

| Library | Severity | What it is | Reaches users? |
|---|---|---|---|
| extract-zip (2 alerts) | high | Unpacks zip files; can write outside its folder from a hostile zip | No. Used only while Electron is being fetched for the build. |
| http-cache-semantics | high | Web cache helper; can mix up cached replies between users | No. Build tooling; Total makes no such cached requests. |
| sprintf-js | medium | Text formatting helper; huge precision numbers can hang it | No. A build helper. |

- **Which PR:** none. GitHub lists no fixed version for any of them.
- **Recommendation: ignore with reason, re-check after the Electron upgrade.** They arrive through Electron's and the build tools' own parts, so moving Electron may drop or fix them. If they are still open then, dismiss them in GitHub with the reason "only used while building, not shipped".

### 3.3 App: test tools (4 alerts: 2 critical, 2 medium)

| Library | Severity | What it is |
|---|---|---|
| tinypool (2 alerts) | **critical** | Helper that runs tests in parallel. A crafted option could run code. |
| vitest | medium | The test runner. A crafted mock could read a file. |
| @vitest/mocker | medium | Part of the test runner. Same path problem. |

- **Does it affect a shop owner?** No. These run only when a developer or GitHub runs the tests, on test code we wrote ourselves. "Critical" here means critical for a machine running untrusted tests, which we do not do. None of this is in the download.
- **Which PRs:** **#14** (tinypool and vitest) and **#7** (@vitest/mocker and vitest), both a major jump (vitest 3 to 5).
- **Recommendation: after 1.0, as its own work package.** The database tests run in an unusual way (inside Electron acting as plain Node), so a test-runner jump can break them. Merge #14 and #7 together after the Electron upgrade, or at the same time.

### 3.4 Website (12 alerts: 3 critical, 4 high, 4 medium, 1 low)

| Library | Alerts | Worst | What it is | PR |
|---|---|---|---|---|
| next | 9 | critical | The website framework. Three remote-code issues (image handling, `next/og`, Windows hosting), one server-request issue, cache mix-ups. | **#63** (16.3.1 to 16.3.8) |
| sharp | 2 | high | Image resizer; two bugs in image-reading parts. | **#16** (0.35.3 to 0.35.5) |
| source-map-js | 1 | high | Build-time helper; can be made to stall. | **#13** (1.2.1 to 1.2.2) |

- **Does it affect a shop owner using Total offline?** No. The website is separate from the app. It matters for visitors to the site and for you as its owner, because next runs on a public server.
- **Recommendation: merge #63, #16 and #13 together, before the 1.0 announcement at the latest (plan step 12).** They are small patch bumps within the same version line. Each should show a green Vercel preview first. Merging to `main` redeploys the live website (nothing visible should change), so this is your call, in line with your "nothing goes out before you say go" rule.

---

## 4. Where this differs from `to-do.md` section 7

The conclusions hold. Three details differ from the live data:

1. **Electron alert count.** to-do.md says "fixes ~50 alerts". GitHub now shows **36** Electron alerts open (11 high, 19 medium, 6 low). Probably the older figure counted alerts since closed or merged.
2. **Test tools.** to-do.md says "tinypool (critical, dev-only), vitest / @vitest/mocker alerts". Live: tinypool is 2 critical alerts, vitest 1 medium, @vitest/mocker 1 medium. Same conclusion.
3. **Website urgency.** to-do.md says to merge the website PRs "when the site work resumes". The live data shows #63 clears 3 critical and 1 high alert on a public server, so I would merge it before the announcement, not leave it open. Your call; it changes nothing in the app.

The "no fix published" list (sprintf-js, http-cache-semantics, extract-zip) matches exactly. The PRs superseded and closed earlier (#6, #10, #11, #15, #17, #62) are all gone from the open list.

---

## 5. One-screen summary

| Group | Where | Alerts (crit / high / med / low) | Reaches users? | Fixed by | Recommendation |
|---|---|---|---|---|---|
| Electron | app | 36 (0 / 11 / 19 / 6) | Yes, it is the engine | PR #3 | After 1.0, own work package, first |
| No fix published (extract-zip, http-cache-semantics, sprintf-js) | app | 4 (0 / 3 / 1 / 0) | No, build only | none | Ignore with reason, re-check after Electron |
| Test tools (tinypool, vitest, @vitest/mocker) | app | 4 (2 / 0 / 2 / 0) | No, tests only | PRs #14, #7 | After 1.0, own work package |
| next | website | 9 (3 / 1 / 4 / 1) | Website visitors only | PR #63 | Merge before the announcement |
| sharp | website | 2 (0 / 2 / 0 / 0) | Website only | PR #16 | Merge with #63 |
| source-map-js | website | 1 (0 / 1 / 0 / 0) | Website build only | PR #13 | Merge with #63 |
| **Total** | | **56 (5 / 18 / 26 / 7)** | | | |

**By file:** app `package-lock.json` 44 (2 / 14 / 22 / 6), website `site/package-lock.json` 12 (3 / 4 / 4 / 1).
**Open Dependabot PRs: 6** (#3, #7, #13, #14, #16, #63).
