# AI operations and release policy

Last updated: 28 August 2026.

Total’s accounting engine does not depend on AI. AI may extract, classify, search, explain and
prepare proposals; it cannot post vouchers, change report calculations or bypass approval.

## Provider setup

- OpenAI: enter a project API key in Settings → AI. The key is encrypted with the operating
  system credential facility and is never written to the JSON mirror.
- OpenAI-compatible cloud: use an HTTPS base URL and a provider-specific key.
- Local model: use a loopback endpoint such as `http://127.0.0.1:11434/v1` or
  `http://localhost:1234/v1`. Total deliberately rejects clear-text non-loopback endpoints.
- Route OCR, classification, analysis and writing separately. A small local model may be suitable
  for classification while a stronger reviewed provider handles variance narratives.

Before sharing context, the app shows the exact categories selected. No-context questions must
return no book citations. Contextual claims must cite only resources present in that request.

## Codex and ChatGPT device authentication

The “Sign in with ChatGPT” control starts the installed Codex CLI's official device-auth flow.
Codex owns the credential. Total reads only bounded process output and `codex login status`; it does
not read, copy, persist, refresh or include the ChatGPT credential in diagnostics. If Codex CLI is
not installed, ordinary provider-key configuration and every non-AI workflow remain available.

## AI Operator boundary

Operator is disabled by default. An owner must enable it and select specific workspace directories.
The filesystem root, home directory, Total data root, symlinks, binary files and text files over 2 MB
are rejected. The current action allowlist is navigation, bounded book search, voucher proposal,
text-file read and text-file write. It provides no shell, arbitrary process, credential, SQL or
unrestricted network tool.

The user sees the generated plan before running actions. File changes either require approval for
every change or follow the owner-selected approved-folder policy. Accounting always creates a
proposal and always requires review inside Total, regardless of file approval mode.

## Offline OCR

The document inbox can use bundled Tesseract English data without an AI provider. OCR output is
parsed into a review record and never posts a voucher. Low-confidence, missing or unreadable fields
remain visible warnings. Additional language claims require a reviewed language-specific corpus and
recorded accuracy evidence.

Offline OCR is evaluated separately from cloud/provider OCR. The hermetic
`offline-ocr-reviewed-text-v1` corpus covers clean recognition output, phone-like whitespace,
rotated recognition order, low contrast, mixed GST rates and unreadable fields. Its 42 reviewed
parser fields currently pass exactly. This is a post-recognition parser baseline, not a claim about
camera recognition accuracy: release acceptance still requires reviewed, synthetic or consented
image samples run through the packaged Tesseract engine.

## Release evaluation

The fixed evaluation harness scores three dimensions independently:

1. extraction equals the reviewed expected structured document in integer paise;
2. every citation belongs to the explicitly shared context (and no citation appears without it);
3. voucher proposals pass the IPC schema and are exactly balanced in double-entry terms.

Release thresholds are at least 95% extraction accuracy, 100% citation validity and 100% balanced
draft validity on the reviewed corpus. A provider/model change requires a new recorded run. Never
lower a threshold to make a release pass; inspect the failed fixtures, prompt, parser or model.

## Production review

- Treat low-confidence extraction, ambiguous dates, missing GSTINs and arithmetic mismatches as a
  manual-review queue, not an automatic fallback.
- Test English plus the invoice languages actually used by the acceptance cohort.
- Use synthetic or consented redacted documents in evaluation evidence.
- Record provider, endpoint class (cloud or loopback), model, prompt version, fixture-set version,
  scores and reviewer. Do not record API keys or unredacted customer documents.
- Roll back a model route independently if extraction or evidence quality regresses; core books and
  reports remain available while AI is disabled.
