# Scheduled releases

Written 7 November 2026. How Total ships now, in plain words.

## When releases happen

Twice a day, at about **09:00 and 21:00 India time**, GitHub looks at `main` and decides whether
to release it. It runs on GitHub's computers, so your laptop can be off. GitHub sometimes starts a
scheduled job 5 to 30 minutes late; that is normal.

A release is always the next **small** version (0.12.0 → 0.12.1 → 0.12.2 …). Bigger steps, such
as 0.13 or 1.0, stay your decision: you still do those by hand. Once the version reaches 1.0, the
schedule stops releasing until a file named `.github/release-minor-approved` is added to the repo.

## What has to be true before it releases

All of these, every time:

1. **Something new.** At least one change since the last release that reaches users. Changes only
   to the docs, the website, the GitHub setup or the root notes (README, CHANGELOG, CLAUDE.md,
   to-do.md) do not count. If nothing counts, the slot skips quietly.
2. **The checks on `main` are green.** Every test job on the newest commit of `main` finished and
   passed, including the long Mac end-to-end tests and the speed tests. If they are still running,
   the slot waits for the next one.
3. **Old books still give the same figures.** GitHub installs the last release, makes two
   companies with it (the sample "Demo Traders" and a generated trading company with a few
   thousand entries), and notes every report: trial balance, profit and loss, balance sheet, who
   owes and whom you owe, stock summary, and GSTR-1 and GSTR-3B for every month. Then it opens the
   same books with the new version, which updates them, and notes the reports again. **If any
   figure moved, it does not release** (unless you approved it, below). It also checks that the
   update ran cleanly, that the file is not damaged, that the change history still verifies, and
   that a backup of the books restores and checks OK.
4. **Nobody asked to hold it.** No open pull request carries the label `release-blocker`.

When a slot skips for a reason (not the quiet kinds), GitHub opens one issue called
**"Scheduled release skipped"** with the reason, and adds a comment each time it skips again. The
issue closes itself after the next release goes out.

After a release, GitHub checks that the release page has the Mac and Windows files and that the
website's update feed (`devjindal.tech/api/latest`) shows the new version. Installed copies of
Total learn about updates from that feed.

## How to hold a release

Open (or pick) a pull request and add the label **`release-blocker`**. While that pull request is
open with the label, no scheduled release happens. Remove the label, or close the pull request, to
let releases go again.

## How to approve a change in figures

If a change is meant to move figures in existing books (for example a GST correction), add the
label **`figures-approved`** to that pull request. The next slot will then release even though the
figures moved. The run summary on GitHub lists every figure that changed (old value and new value),
so you can see exactly what you approved. One approved pull request covers every difference in that
release's batch, so look at the list.

## If a release breaks halfway

If building a release fails after its version tag was made, the release stays a draft and nobody
sees it. The next slots then skip and the issue says so. To finish it: **Actions → Release → Run
workflow**, type the tag (for example `v0.12.1`) and run it.

## Trying the gate without releasing

On GitHub: **Actions → Scheduled release → Run workflow**, keep **dry run** ticked. It runs every
check and shows the result in the run summary, but never changes the version or releases anything.
