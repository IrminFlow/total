# Hindi and Marathi invoice terminology review

Status: awaiting review by fluent accounting users. No wording in this sheet is approved merely
because it appears here. English always remains beside the translated label on the printed invoice.

## Reviewer instructions

Review the words as they would appear on a GST invoice used by an Indian shop or accounting office,
not as a literary translation exercise. For each row, mark exactly one decision:

- `KEEP` — current wording is natural and commercially familiar.
- `REPLACE` — write the exact approved replacement in “Approved wording”.
- `CONTEXT` — one label is not enough; describe the required context rule.

Please add reviewer name/initials, date, language fluency, accounting role, and—where possible—a
sanitized printed-invoice example. The implementation agent will change only rows with an explicit
decision and will retain this sheet as the approval record.

Reviewer: ____________________  Language: __________  Role: __________  Date: __________

## Hindi

| ID | English/context | Current wording | Alternative or concern already identified | Decision | Approved wording / rule |
|---|---|---|---|---|---|
| HI-01 | Delivery Challan | डिलीवरी चालान | Spoken loanword; some printers use `प्रदाय चालान`. | | |
| HI-02 | Round Off | पूर्णांकन | Mathematically correct; trade invoices commonly print `राउंड ऑफ`. | | |
| HI-03 | Other Details | अन्य विवरण | Trade sometimes prints `अन्य जानकारी`. | | |
| HI-04 | “For” before company/signature | कृते | Letterhead convention; plainer alternative is `के लिए`. | | |
| HI-05 | Brought Forward on a multi-page invoice | आगे लाया गया | The Hindi b/f–c/f pair is not standardized in ledgers. Review together with HI-06. | | |
| HI-06 | Carried Forward on a multi-page invoice | आगे ले जाया गया | Review together with HI-05 and a real multi-page invoice. | | |
| HI-07 | Page 1 of 3 (`of`) | में से | Produces `पृष्ठ 1 में से 3`; many printed documents use `/` instead. | | |
| HI-08 | Negative amount-in-words prefix | ऋण | Arithmetic term; ledgers often print the loanword `माइनस`. Example: `ऋण एक सौ रुपये मात्र`. | | |

## Marathi

| ID | English/context | Current wording | Alternative or concern already identified | Decision | Approved wording / rule |
|---|---|---|---|---|---|
| MR-01 | Delivery Challan | वितरण चलन | Spoken form is often `डिलिव्हरी चलन`. | | |
| MR-02 | Quantity | प्रमाण | Neutral across units; `नग` is common specifically for countable pieces. A context rule may be better than one replacement. | | |
| MR-03 | Round Off | पूर्णांकन | Same trade-vs-mathematical concern as HI-02; provide the Marathi invoice convention. | | |
| MR-04 | Other Details | इतर तपशील | Plain Marathi but not yet checked against a printed accounting sample. | | |
| MR-05 | Brought Forward on a multi-page invoice | मागील पानावरून आणलेले | Descriptive wording, not a confirmed fixed ledger term. Review together with MR-06. | | |
| MR-06 | Carried Forward on a multi-page invoice | पुढील पानावर नेलेले | Descriptive wording, not a confirmed fixed ledger term. | | |
| MR-07 | Hundreds in amount in words | separate digit + `शे` | The generator currently produces forms such as `दोन शे`; normal Marathi often fuses them (`दोनशे`, `तीनशे`) and uses `शंभर` standing alone. Decide whether all 1–9 hundreds must be explicit forms. | | |

## Amount-in-words samples to read aloud

These examples deliberately exercise the two open vocabulary/grammar questions. Amounts in the app
are integer paise; no arithmetic decision is under review here.

| Amount | Language | Current output to review |
|---:|---|---|
| ₹-100.00 | Hindi | ऋण एक सौ रुपये मात्र |
| ₹100.00 | Marathi | एक शे रुपये फक्त |
| ₹200.00 | Marathi | दोन शे रुपये फक्त |
| ₹12,345.67 | Marathi | बारा हजार तीन शे पंचेचाळीस रुपये आणि सदुसष्ट पैसे फक्त |

## Implementation sign-off

Approved rows implemented by: ____________________  Commit: ____________________  Date: __________

Regression evidence (tests/PDF samples): _________________________________________________
