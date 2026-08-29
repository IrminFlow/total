# Physical release validation checklists

Use the exact release commit and record OS/build identifiers, display scaling, app version, artifact
SHA-256, timestamp and pass/fail evidence. Never place customer books, credentials, licence private
keys, OTPs or unredacted statutory identifiers in screenshots.

## Windows laptop (1366×768 at 125%)

1. Install the signed installer on a clean standard-user account; capture signature and SmartScreen
   status, first launch, install path and app version.
2. Create a company, reopen it offline, restore a sanitized `.totalbak`, and run integrity check.
3. Complete voucher entry using keyboard only; inspect every modal at the target resolution for
   clipping, trapped focus, visible focus rings and a usable primary action.
4. Open Gateway, Day Book, Trial Balance, Stock, Banking, Payroll, GSTR-1, GSTR-3B, e-docs, TDS,
   Settings and print preview. Run all 54 E2Es without retry and attach `results.json`.
5. Upgrade N-1 to N, verify the same company and reports, uninstall, reinstall, and prove the books
   under Documents survive. Record updater and offline behavior separately.

## Thermal and dot-matrix printers

1. Record printer model, driver version, connection, roll/paper width and app template.
2. Print the same invoice on 58 mm and 80 mm thermal widths; verify no clipped GSTIN, number, date,
   item, quantity, tax, total, QR or footer and confirm the cut occurs after the final line.
3. Print the ESC/P job on continuous stationery; verify page breaks, perforation alignment, rupee
   fallback, columns, copies and the final form feed. Compare every printed amount to the A4 PDF.
4. Photograph the complete output beside a ruler, plus close-ups of header, totals and page break.

## WhatsApp PDF handoff

1. Use an explicitly approved recipient and sanitized demo invoice. Confirm the recipient and file
   immediately before sending.
2. From the installed app, reveal/share the generated PDF, paste or attach it in WhatsApp, and check
   filename, preview, page count and message text before the human performs or approves Send.
3. On the receiving device, open the PDF and compare invoice number, party, total, QR and page count.
   Record delivery/open evidence without exposing personal chat history.

## Evidence return

Return a short manifest containing commit, artifact hashes, hardware/OS/driver versions, checklist
step, verdict and sanitized evidence path. The agent will triage every failure, implement reproducible
fixes, and rerun the applicable automated and physical checks.
