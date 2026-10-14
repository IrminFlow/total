# Moving from 0.10 or 0.11 to simple mode

**Short answer: nothing changes unless you ask it to.** A company created before simple mode opens in
the full accountant view, with the same sidebar and the same figures, after you upgrade. This is a
rule in the code: a company with no `ui` setting is an accountant-mode company
(`src/shared/simple/uiMode.ts`), and a gate test on a sample company showed identical trial balance, balance sheet, P&L, stock and Outstandings after the upgrade (the one exception is below).

Simple mode was added in 0.11.0. The simple screens for selling, buying, money, stock, people,
reports and taxes are in the build after 0.11.0 ("Unreleased" in [CHANGELOG.md](../../CHANGELOG.md)).

## Before you upgrade

1. **Back up.** Settings, Backups (or copy `~/Documents/total/`).
2. Opening an existing company in a newer version runs database updates automatically. 0.11.0 ran
   four (undo groups, account categories, phone numbers on parties, bill-wise opening balances);
   the build after it adds one more (a record that stops a retried simple entry posting twice).
3. **There is no downgrade.** Once a company has been opened in a newer version, do not open it in an
   older one; restore your backup instead. Older versions do not check for the newer database.

## One thing that does change figures

If you made sales by typing only an amount and the GST ledgers (accounting mode, no items), and the
Sales ledger has no GST rate, 0.11.0 and earlier reported those sales as nil-rated in GSTR-1 and
GSTR-3B even though tax was posted. The newer build reports them at the rate the posted tax implies.
Item invoices are unchanged. Re-check the returns for those months. Details: the "For accountants"
part of Unreleased in the changelog (PR #93).

## How to switch

- **The whole company:** Settings, "How Total looks" (owner only). Choose simple or accountant. It is audited, and a choice that changes nothing writes
  nothing. Switching back is the same action.
- **One screen:** on any simple screen, **Accountant view** opens the full screen for the same thing.
  **Back to simple** returns. The choice "Always open the full app for this" is remembered per
  screen and per user, on this computer only.
- A screen that has no simple version yet opens in the full app with a "Full app" tag.

## What "Accountant view" means

It is not a different set of books. Both views read and write the same vouchers.

- A simple "Make a bill" saves the same sales voucher the full voucher editor would, with the same
  GST, stock, lock-date and credit-hold checks. Nothing is stored twice and no balance is stored.
- An unsaved simple form hands what you typed to the full editor ("Accountant view" on a form you
  have typed into), and you save it there as usual. The details of the mapping are in CLAUDE.md
  (WP 9.1 and 9.10).
- Reports are the same in both views. Simple screens show fewer columns and a "Why?" sentence.
- The accountant sidebar does not change when you switch a screen; switch the company to see the
  simple sidebar.

## What simple mode adds that you may want in an existing company

- **Features**: Settings, "Features" shows plain "Turn on" cards. Existing companies keep the features
  they had.
- **Day-one openings**: Settings, "What you had on day one" is always reachable. It enters customer and
  supplier openings bill by bill; the full Masters editor edits the same figures.
- **Language**: Settings, "How Total looks", Language: English, Hindi or Hinglish for simple-mode
  text (the Hindi and Hinglish text is machine-drafted and awaiting native review). Accountant screens
  stay in English.

## Who it is for

An owner who does not want to learn ledgers can use simple mode alone. An accountant can leave the
company in accountant view and ignore the simple screens. A mixed team can keep the company in simple
mode and give the accountant an "Accountant view" on each screen.

Related: [features](../features.md), [for a CA](for-a-ca.md).
