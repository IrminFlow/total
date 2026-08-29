# Human acceptance session kit

This kit turns v5 acceptance into repeatable work. It prepares the session but does not replace a
real participant. Use the exact release-candidate installers recorded in `human.template.json`.

## Session rules

- Give the participant the starting state and task, not click-by-click coaching.
- Use a fresh sample company for each role. Never use customer data.
- Record elapsed minutes, outcome, errors, workarounds and the participant's words.
- Treat an incorrect accounting result, unexplained data change or unrecoverable state as P0.
- Treat a blocked core workflow, keyboard trap or inaccessible required control as P1.
- Hash the sanitized note or recording manifest. Keep the underlying material outside the repository.
- Do not mark a scenario passed when the facilitator completed it for the participant.

## Bookkeeper session

Starting company: Retailer sample. Working period: current Indian financial year.

1. Create a credit sale, correct an unposted line, post it and find it from universal search.
   Expected: debit and credit agree, the invoice appears once, and the audit entry identifies the user.
2. Record the later receipt, allocate it to the invoice and reconcile a sample bank row.
   Expected: the bill closes once, bank evidence remains linked, and no unrelated row clears.
3. Open Sales register by month and quarter, drill to Day Book, save the report view and export CSV.
   Expected: monthly rows sum to quarterly rows and the exported total matches the screen.

## Business owner session

Starting company: Wholesaler sample.

1. Explain cash, receivables, payables and the most urgent action from Home without assistance.
   Expected: each figure drills to its supporting records and no generated statement is presented as fact without evidence.
2. Review an invoice, payment reminder and communication preview.
   Expected: nothing is sent automatically and delivery state does not claim success before provider acceptance.
3. Create a verified backup, inspect restore preview and produce a portable export.
   Expected: the original company remains unchanged and the artifacts identify the company and schema without secrets.

## Chartered accountant session

Starting company: Professional-services sample.

1. Trace a ledger balance to voucher lines, inspect a changed voucher and identify the reversal path.
   Expected: opening plus activity equals closing and the audit trail preserves before and after evidence.
2. Review GSTR-1, GSTR-3B and GSTR-2B exceptions using offline data only.
   Expected: every return total drills to posted entries and online filing remains an explicit separate action.
3. Run month close, review locks, build a CA pack and inspect its manifest.
   Expected: unresolved gates block close and the pack's files match its recorded hashes.

## Payroll operator session

Starting company: Service sample with Payroll enabled.

1. Add an employee, attendance and an effective-dated salary structure.
   Expected: missing statutory or attendance fields remain visible before calculation.
2. Calculate and approve payroll, then reconcile payroll totals to books.
   Expected: gross, deductions, employer cost and net pay tie to the posting preview.
3. Generate payslips and inspect statutory workspaces.
   Expected: employee files are separated correctly and the run cannot be silently rewritten after lock.

## Inventory and manufacturing session

Starting company: Manufacturer sample.

1. Receive a partial purchase with accepted and rejected quantities, then inspect stock movement.
   Expected: only accepted quantity becomes available and rejection evidence remains linked.
2. Create a BOM revision, manufacture a batch and inspect component consumption.
   Expected: stock value is conserved, insufficient components block posting and the active BOM revision is retained.
3. Perform a blind count, review the variance and post the approved physical-stock adjustment.
   Expected: the counter cannot see expected stock during entry and the final movement matches the approved difference.

## Observation record

For every scenario copy one object from `human-session.observation.template.json`. Write literal UI
labels in `pathTaken`, not interpretations. Record the first point of hesitation even when the task
eventually passes. A workaround is a finding, not a clean pass.

## Pass criteria

A cohort passes only when all three scenarios produce the expected accounting result, the participant
finishes without facilitator takeover, no P0 or unresolved P1 finding remains, and the artifact IDs
match the candidate. Product comprehension notes may remain as P2 or P3 follow-up work when they do
not hide, alter or block the required result.
