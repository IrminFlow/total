# Questions for your CA

Written 17 October 2026. One list you can hand to a chartered accountant. Each question has three
parts:

- **Today**: what Total does now.
- **Confirm**: the exact point the CA must say yes or no to.
- **In the code**: where it is written (file and the UNVERIFIED id), so Claude can change it as soon as you have the answer.

Why this list exists: Total's rule is that no tax rule is written from memory. Where the official
text could not be read, Total says so on screen and in the code. These are those points. If the CA
says "that is right", nothing changes except that we remove the UNVERIFIED label. If the answer is
different, tell Claude the answer and the source, and Claude fixes it. A fix that moves a figure
comes back to you first.

How to use it: read the **Ask first** section with your CA. The rest can be a second sitting, or
skipped for topics you do not sell into (for example TCS or payroll).

Note on three items: the e-invoice applicability (Q17), the e-invoice and e-way bill cancel rules (Q18) and the TCS
slabs (Q19 and Q20) are in pull requests #165, #164 and #163. Those are open,
not merged, when this was written. Their files and ids exist only after they merge. Their lines say
"open PR".

---

## Ask first (these change figures on a return)

1. **GST on sale of an asset: which rule governs?** (GST on sale of assets)
   - Today: Total works out the tax on a sale of a capital good two ways, rule 40(2) (5 points per quarter) and rule 44(6) (remaining months of a 60-month life). It uses the higher.
   - Confirm: is "the higher of the two" safe? Or does one rule govern?
   - In the code: `src/shared/fixedAssetSources.ts`, `cg-two-rules`.
2. **GST on sale of an asset: where does the extra tax go on GSTR-1?** (GST on sale of assets)
   - Today: the extra output tax is put on the same tax invoice, so the tax amount is above rate x taxable value. It is also in GSTR-3B 3.1(a). The rule does not name a GSTR-1 table.
   - Confirm: will the portal accept a B2B invoice like that? Or should the buyer be charged the full amount on the invoice instead?
   - In the code: `src/shared/fixedAssetSources.ts`, `cg-where`.
3. **GSTR-1 and GSTR-3B due dates** (GST returns and dates)
   - Today: GSTR-1 on the 11th (monthly) or 13th after the quarter. Quarterly GSTR-3B on the 22nd or 24th by state. Later amendments and one-off extensions are not read.
   - Confirm: are these the dates in force now? Any amendment to Notification 83/2020-CT that changes them?
   - In the code: `src/shared/gst/filing.ts` `GST_FILING_UNVERIFIED`; `src/shared/compliance.ts` `COMPLIANCE_UNVERIFIED`; `src/shared/assistantSources.ts` ids `gstr1-11th`, `gstr3b-qrmp`.
4. **The current GST rate slabs** (GST returns and dates)
   - Today: the 2025 and 2026 slabs (0, 5, 18, 40, and the older 12 and 28 up to 21 Sep 2025) come from secondary copies of Notification 9/2025 and 19/2025 (Central Tax, Rate). Services after 22 Sep 2025 are not reflected.
   - Confirm: are the slabs and dates right? Do any services still carry 12 or 28 percent?
   - In the code: `src/shared/gst/rateTable.ts` `GST_RATE_UNVERIFIED`.
5. **ITC and time bar** (GST returns and dates)
   - Today: the s.16(4) time bar uses 30 November after the financial year only. GSTR-3B rows 4(B) and 4(D) follow Circular 170. Interest on ITC reversal (s.50) is taken as 18 percent, assuming the credit was used.
   - Confirm: is 30 November enough, or is the annual-return limb needed too? Is 18 percent right for this case?
   - In the code: `src/shared/assistantSources.ts` id `s16-4-annual-return`; `src/shared/gst/sources.ts` ids `s50-rate`, `3b-labels`.
6. **TDS: rounding and the 194Q base** (TDS)
   - Today: TDS is rounded to the nearest rupee. Section 194Q is charged on the amount above Rs 50 lakh, and the GST in the base is treated as per the seeded rule.
   - Confirm: round to the nearest rupee, or to Rs 10 as s.288B and s.516 suggest? Does the 194Q base include GST? Is the Rs 10 crore turnover condition read correctly?
   - In the code: `src/main/db/migrations.ts` (the TDS section and rate seed near the `194Q` rows); to-do.md section 5 "TDS (WP 3.1 / 3.2)".
7. **Payroll: the PF wage ceiling and salary TDS rounding** (Payroll)
   - Today: EPF ceiling of Rs 25,000 from 17 September 2026, with the September split-month proration. Salary TDS is rounded to the nearest rupee.
   - Confirm: is the ceiling and its start date right, and how is September prorated? Rupee or Rs 10 rounding for salary TDS?
   - In the code: `src/shared/payrollStatutory.ts` `UNVERIFIED_WP37` (lines on EPF and salary TDS).
8. **Is a composition dealer's treatment right?** (GST returns and dates)
   - Today: only a regular registration charges GST. A composition dealer prints a Bill of Supply. Reverse-charge purchases by a composition dealer are not handled, and only one registration change is remembered.
   - Confirm: is that enough for your customers? Is the reverse-charge gap acceptable?
   - In the code: `src/shared/gst/registration.ts` `GST_REGISTRATION_UNVERIFIED`.

---

## GST on sale of assets

(Q1 and Q2 above, plus these.)

9. **Counting quarters** 
   - Today: "quarter or part" is counted in three-month blocks from the invoice date, not calendar quarters. A sale on the invoice date is in the first quarter.
   - Confirm: is that the usual reading?
   - In the code: `src/shared/fixedAssetSources.ts`, `cg-quarters`.
10. **Comparing the two amounts**
    - Today: "whichever is higher" is compared on the total of CGST, SGST and IGST. Cess is separate. The extra tax is paid under the sale's own heads.
    - Confirm: is a total comparison right, or head by head?
    - In the code: `src/shared/fixedAssetSources.ts`, `cg-compare`.
11. **How much credit was taken**
    - Today: the credit is taken from the tax lines of the asset's purchase bill, in the asset's share. Credit on later additions is not counted. You can type it in by hand.
    - Confirm: is that a safe starting point?
    - In the code: `src/shared/fixedAssetSources.ts`, `cg-itc`.
12. **HSN on the sale invoice**
    - Today: the sale posts to one "Sale of Fixed Assets" account with no HSN. GSTR-1's HSN summary flags it until you set one.
    - Confirm: which HSN or SAC would you put on a used machine, vehicle or furniture sale?
    - In the code: `src/shared/fixedAssetSources.ts`, `cg-hsn`.

## E-invoicing and e-way bill

13. **Invoice number format** 
    - Today: Total warns if the invoice number is not 1 to 16 characters of letters, digits, "/" and "-", not starting with 0, "/" or "-" (NIC schema, Validations item 8). It warns only when e-invoicing is on.
    - Confirm: does your experience match the IRP? Any other number rules?
    - In the code: `src/shared/gst/sources.ts` source `einvoiceDocNo`; `src/shared/gst/einvoiceSchema.ts` (header note UNVERIFIED).
14. **The IRP's checks**
    - Today: the e-invoice file follows the NIC page's patterns and tolerances ("rupee part minus 1 to next rupee plus 1"). Nobody has tested them against the real IRP.
    - Confirm: any case where the IRP rejects a file that follows these?
    - In the code: `src/shared/gst/einvoiceSchema.ts` header "UNVERIFIED (no sandbox credentials)".
15. **TCS on an e-invoice**
    - Today: income-tax TCS goes into the e-invoice's "other charges" field, not into the taxable value or GST.
    - Confirm: is OthChrg the right place? Is TCS outside the GST value (Circular 76/50/2018)?
    - In the code: `src/shared/gst/edocs.ts` (comment on `OthChrg`); `src/main/services/tcs.ts` (header, circular 76/50/2018 note).
16. **Delivery challans on e-way bills**
    - Today: a challan for a sale goes out as supply type Others, sub-supply "Supply on challan" (code 8). Job work, approval and inter-State job-work cases follow our reading.
    - Confirm: is that what officers expect? Is an "approval" a supply here?
    - In the code: `src/shared/gst/edocs.ts` (`challanSubSupply`, UNVERIFIED comment); `src/shared/voucherEdit/stockNote.ts`.
17. **Who needs e-invoicing, and when** (open PR #165)
    - Today (in the PR): thresholds Rs 500 cr, 100, 50, 20, 10 and 5 cr, each from its dated notification. The year's turnover counts from the next 1 April. A 30-day reporting window applies from 1 April 2025 at Rs 10 cr and above.
    - Confirm: any amendment to 13/2020-CT after 10/2023-CT? Which year's turnover counts for the 30 days? Do OIDAR and rule-14 classes matter to you?
    - In the code: after merge, `src/shared/gst/einvoiceApplicability.ts` `EINVOICE_APPLICABILITY_UNVERIFIED`.
18. **Cancelling an IRN and e-way bill** (open PR #164)
    - Today (in the PR): cancel is refused after 24 hours from the acknowledgement time, or while an e-way bill is live. Extending an e-way bill is allowed only from 8 hours before to 8 hours after expiry. The portal's times are read as IST.
    - Confirm: do the 24 hours count from the acknowledgement or from the Part B entry? Is the remark required on cancel?
    - In the code: after merge, `src/shared/gst/nicRecord.ts` `NIC_UNVERIFIED`.

## TCS

19. **Tour packages (s.206C(1G))** (open PR #163)
    - Today (in the PR): 5 percent up to Rs 10 lakh for the year per buyer, 20 percent above. A collection that crosses the limit is split in two parts. FY 2026-27 is a flat 2 percent.
    - Confirm: is the slab right for FY 2025-26? Is the flat 2 percent for FY 2026-27 right (Finance Act 2026 s.85(f))? The 1961 text could not be opened.
    - In the code: after merge, `src/shared/tcsSources.ts` and `src/main/services/tcs.ts`.
20. **Parking, toll and mining (s.206C(1C))** (open PR #163)
    - Today (in the PR): 2 percent each, no-PAN 5 percent. The 1C rate came from a search index, not the Act text.
    - Confirm: rate and no-PAN rate. Return codes F, G, H (27EQ) and 1090 to 1092 (Form 143).
    - In the code: after merge, `src/shared/tcsSources.ts`.
21. **TCS base and codes**
    - Today: for sales outside 206C(1H), GST in the base follows the seeded rule. Collectee codes 01, 05, 06 and due at receipt versus invoice (1F) are our reading.
    - Confirm: does the base include GST? Are the codes and timing right?
    - In the code: `src/main/db/migrations.ts` (TCS rate seed, comment "UNVERIFIED list in the WP 3.3 report"); to-do.md section 5 "TCS (WP 3.3)".

## TDS

22. **Interest for late deduction (s.201(1A))**
    - Today: "month or part of a month" counts calendar months, first and last both counted (the TRACES reading). A bill that became liable when a later bill crossed the threshold is treated as deductible on that later date. Bills from an earlier year are not followed.
    - Confirm: calendar months or periods from the date? Is the threshold treatment right?
    - In the code: `src/shared/tdsInterest.ts` `TDS_INTEREST_UNVERIFIED`.
23. **TDS deposit date under the new rules**
    - Today: 7th of the next month, 30 April for March, from rule 30(2) of the 1962 Rules. The Income-tax Rules 2026 (rule 218) were read only in secondary sources.
    - Confirm: same dates under rule 218?
    - In the code: `src/shared/compliance.ts` `COMPLIANCE_UNVERIFIED`.
24. **Senior citizens, 194N and old years**
    - Today: the senior-citizen age under the 2025 Act, section 194N and rates before FY 2026 are partly not seeded or only as read.
    - Confirm: what should be seeded for your clients?
    - In the code: to-do.md section 5 "TDS (WP 3.1 / 3.2)"; `src/main/db/migrations.ts` (TDS seed).
25. **Return and certificate layouts**
    - Today: 26Q reason codes, the Form 16A layout and TRACES month counting follow practice, not the current notification.
    - Confirm: anything the TRACES utility rejects?
    - In the code: `src/main/services/tdsWorkbench.ts` (comments "UNVERIFIED against the current utility" and Form 16A).

## GST returns and dates

(Q3 to Q5 and Q8 above, plus these.)

26. **Quarterly GSTR-3B, special states**
    - Today: a state in neither list of rule 61(1)(ii), such as code 97 or a missing state, is dated the 22nd and flagged.
    - Confirm: which date for those?
    - In the code: `src/shared/gst/filing.ts` `GST_FILING_UNVERIFIED`.
27. **Quarterly filers and the offline tools**
    - Today: Total prepares GSTR-1 and 3B files month by month for a quarterly filer. IFF (invoice furnishing facility) and the monthly PMT-06 amount are not modelled.
    - Confirm: does the portal want one file per quarter named by its last month? Do you need IFF or PMT-06 amounts?
    - In the code: `src/shared/gst/filing.ts` `GST_FILING_UNVERIFIED` (lines on QRMP files, IFF, PMT-06).
28. **ARN format and portal wording**
    - Today: an ARN is accepted as 10 to 20 letters or digits. Menu wording on gst.gov.in is as read.
    - Confirm: the real ARN format.
    - In the code: `src/shared/simple/taxes.ts` (comment on the ARN check).
29. **GSTR-2B file fields**
    - Today: field names (reverse charge, ITC available, amended notes) follow real downloads, not the official schema.
    - Confirm: are there other flags that should block or reverse ITC?
    - In the code: `src/shared/assistantSources.ts` ids `gstr2b-schema`, `gstr2b-flags`.
30. **GSTR-9, ITC-04 and IMS**
    - Today: GSTR-9 labels come from a secondary copy, and the Rs 2 crore exemption (Notification 15/2025). The JSON files for GSTR-9, ITC-04 and IMS are Total's own layout, for review, not upload.
    - Confirm: labels and the exemption. How is an IMS record identified?
    - In the code: `src/shared/gst/sources.ts` ids `gstr9-layout`, `gstr9-json`, `gstr9-exempt`, `itc04-json`, `ims-json`, `ims-key`.
31. **Interest charged on overdue bills**
    - Today: the interest debit note carries GST. GST on interest is due when the interest is received, but Total puts it on the note by default (paid early, never late). It reports through the interest ledger with no HSN. The SAC is left blank.
    - Confirm: charge GST when claimed or when received? Which SAC (9971)? Which HSN in Table 12?
    - In the code: `src/shared/receivables/sources.ts` ids `cgst-12-6`, `hsn-of-interest`, `sac-of-interest`.
32. **Amount-only bills and the rate**
    - Today: when a sales bill has no item and its account has no rate, the rate is worked back from the tax posted. Some old months show more GST payable after this change.
    - Confirm: is that the right way to report it? Anything to tell clients with old months?
    - In the code: `src/shared/gst/postedRate.ts`. Also see 04 section 3.1, items 2 and 3.

## MSME

33. **Bank rate history**
    - Today: the RBI bank-rate rows before October 2025 are not read from the official text. Total uses 3 times the bank rate for the s.16 interest.
    - Confirm: the rate and its dates (6 Jun 2025, 7 Feb 2025, 9 Apr 2025, 8 Feb 2023).
    - In the code: `src/shared/payables/msmeSources.ts` (note on the bank-rate rows).
34. **Traders and s.43B(h)**
    - Today: a trader supplier is excluded from s.43B(h), as a reading of an office memorandum. Finance Act 2026 changes to s.37 are not read.
    - Confirm: are traders out? Anything new in FA 2026?
    - In the code: `src/shared/payables/msmeSources.ts` (notes on s.37 and s.43B(h)).
35. **Form 1 and Udyam number**
    - Today: the MSME Form 1 has the S.O. number from a secondary source. The Udyam number is read as state code then district code, no official text.
    - Confirm: the S.O. number and the layout.
    - In the code: `src/shared/payables/msmeSources.ts` (Form 1 and Udyam notes).
36. **MSME bills in the cash forecast** (merged PR #156)
    - Today: if you tick the option, bills of registered micro and small suppliers move to their s.15 date in the forecast. The interest is listed separately and never posted.
    - Confirm: is the s.15 deadline (45 days with a written agreement, 15 without) used correctly, and is interest 3 times the bank rate compounded monthly or simple?
    - In the code: `src/main/services/cashForecast.ts` (`withMsmeFacts`); `src/shared/payables/msme.ts`.

## Payroll

(Q7 above, plus these. Ideally also ask an HR or payroll adviser.)

37. **EPF admin charge and EDLI**
    - Today: admin charge 0.5 percent with a Rs 500 minimum. EDLI 0.5 percent on the Rs 25,000 ceiling. The notification numbers are not confirmed.
    - Confirm: both rates and notifications.
    - In the code: `src/shared/payrollStatutory.ts` `UNVERIFIED_WP37` (first EPF lines); `src/main/db/migrations.ts` (the EDLI and admin rows).
38. **ECR file**
    - Today: the ECR text file uses "#~#" between fields.
    - Confirm: is that the separator the EPFO portal takes?
    - In the code: `src/shared/payrollStatutory.ts` `UNVERIFIED_WP37` (line on the ECR separator).
39. **ESI ceilings under the Code**
    - Today: Rs 21,000 (Rs 25,000 for persons with disability), the Rs 176 exemption and staying covered to the end of the contribution period, as ESIC applies them. The upload template columns are not confirmed.
    - Confirm: legal basis under the Code on Social Security, and the template.
    - In the code: `src/shared/payrollStatutory.ts` `UNVERIFIED_WP37` (ESI lines); `src/main/db/migrations.ts` (ESI rows).
40. **Professional tax**
    - Today: slabs for West Bengal, Tamil Nadu (Chennai), Andhra Pradesh and Madhya Pradesh, and every state's due date except Telangana, are from secondary sources.
    - Confirm: the slabs and due dates for the states you serve.
    - In the code: `src/shared/payrollStatutory.ts` `UNVERIFIED_WP37` (PT line); `src/main/db/migrations.ts` (PT rows, comments `[PT-WB]`, `[PT-AP]`, `[PT-MP]`).
41. **Gratuity, bonus and Form 16**
    - Today: gratuity ceiling Rs 20 lakh and bonus Rs 21,000 / Rs 7,000 as under the new Codes. The Form 16 Part B row list follows the 1962 Rules.
    - Confirm: the figures and the row list.
    - In the code: `src/shared/payrollStatutory.ts` `UNVERIFIED_WP37` (last two lines); `src/shared/print/form16.ts`.
42. **Income-tax sections cited for salary**
    - Today: the 1961 texts for ss.16, 80C, 80CCD, 80D, 10(13A), 24(b), 87A, 192, 288A and 288B were not re-read. The 2025-Act equivalents carry the same figures.
    - Confirm: same figures in the year you file?
    - In the code: `src/shared/payrollStatutory.ts` `UNVERIFIED_WP37` (Income tax line).

## Fixed assets

43. **Hotel and school furniture life**
    - Today: 8 years, from the Schedule II appendix. The MCA e-book copy says 10.
    - Confirm: 8 or 10.
    - In the code: `src/main/db/migrations.ts` (row `V(ii)` and the comment "Hotel / school furniture life").
44. **Income-tax rates and Finance Act 2026**
    - Today: only FY 2025-26 income-tax block rates were read. Earlier years are seeded from FY 2017-18 with unconfirmed start dates. Finance Act 2026 is assumed to change nothing in s.33, s.41, s.74 or Appendix I.
    - Confirm: both points.
    - In the code: `src/main/db/migrations.ts` (comment "UNVERIFIED (kept editable"; rows `BLD5` onwards); `src/shared/depreciation.ts`.
45. **Sale proceeds and half-rate additions**
    - Today: sale proceeds reduce the full-rate block before the half-rate additions (ICAI Illustration 4). The Act's text does not say so.
    - Confirm: is that the order?
    - In the code: `src/main/db/migrations.ts` (same UNVERIFIED comment); `src/shared/fixedAssetSources.ts` id `s50-text` (s.50 and s.43(6)(c) not re-read).
46. **Partial disposal**
    - Today: a part sold takes a pro-rata share of cost, additions and depreciation. A part of a different value (one machine of a set) needs its cost typed in.
    - Confirm: is pro-rata fine for identical units?
    - In the code: `src/shared/fixedAssetSources.ts` ids `part-split`, `part-undo`.
47. **Concessional regime, 40 percent cap**
    - Today: rule 25(2) cap of 40 percent of WDV, and no additional depreciation, applies to 2025-Act years only (FY 2026-27 on). The 1961 equivalent was not re-read.
    - Confirm: is the 1961 rule the same for FY 2025-26 and earlier? Is additional depreciation nil in this regime?
    - In the code: `src/shared/fixedAssetSources.ts` ids `r25-1961`, `r25-regime`.
48. **Extra-shift depreciation and components**
    - Today: double shift +50 percent and triple +100 percent, pro rata by days, averaged over the period. Only the seeded classes are checked for "no extra shift". A component with its own life is split off only before the first depreciation run.
    - Confirm: the formula, and whether components can change later.
    - In the code: `src/shared/fixedAssetSources.ts` ids `shift-formula`, `shift-user-class`, `component-when`.

## Other

49. **Loans, EMI and forecast dates**
    - Today: EMI rounding, broken-period conventions and the statutory due dates in the cash forecast were written from memory.
    - Confirm: your bank's convention and the dates.
    - In the code: `src/shared/loanSchedule.ts`; `src/main/services/cashForecast.ts` (UNVERIFIED comments).
50. **Foreign exchange**
    - Today: revaluation follows AS 11 / Ind AS 21. Paragraph numbers and quotations are as recalled.
    - Confirm: the paragraph citations and treatment.
    - In the code: `src/shared/forex.ts` (header comment).
51. **Consolidation**
    - Today: unrealised profit is a proportionate estimate. Uniform policies, acquisition book values, minority-loss reallocation and AS 23 are simplified.
    - Confirm: is that acceptable for a group of small companies?
    - In the code: `src/shared/consolidation/sources.ts`.
52. **Audit trail**
    - Today: the edit log follows s.128(5), Income-tax rule 6F and the 2025 Act (s.62, rule 46(9)) retention. The exact wording was not re-read.
    - Confirm: retention period and what the log must show.
    - In the code: `src/main/services/audit.ts` (header comments).
53. **State codes**
    - Today: the GST state-code list was not re-read against the latest list.
    - Confirm: any state or code added or changed.
    - In the code: `src/shared/gst/states.ts`.
54. **Applicability and advance GST** 
    - Today: the GPT review left these for a CA: when e-invoicing applies, GST on advances, and the MSME acceptance date.
    - Confirm: your view on each (the first is also Q17).
    - In the code: to-do.md section 5, last line ("GST calendar items from the GPT review").
55. **Import file formats (not a tax point)**
    - Today: Busy and Zoho import headers and XML roots are guessed from public information. A CA who uses those programs can send a sample export.
    - Confirm: only if your CA uses them.
    - In the code: `src/shared/dataImport/busy.ts`, `src/shared/dataImport/zoho.ts`.

---

When the CA has answered, send Claude the question number, the answer, and the source (notification,
section or screenshot). Claude will update the code, remove the UNVERIFIED label, and tell you
if any figure moved.
