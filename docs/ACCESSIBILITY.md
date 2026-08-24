# Accessibility and language

Total treats accessibility preferences as device presentation settings. They are stored in local storage on the Mac and never change company books, voucher values, tax calculations, exports, or saved invoice content.

## Reading preferences

- Text size: default, 112%, or 122%. The app rescales the full renderer while reports, tables, dialogs, and sidebars retain scroll containers.
- Motion: follows macOS by default. A manual reduced-motion setting removes transitions and animation without hiding information.
- Spaced text: switches the app interface to a wide, system-available sans stack with greater letter, word, and line spacing. Printed documents retain their configured design.
- Number grouping: Indian lakh/crore grouping is the default. International three-digit grouping is optional for the on-screen interface.

## Language

Hindi navigation is bilingual. Every translated screen name retains its standard English accounting term in brackets, so users can learn the terminology, search for it, and use existing training material. Keyboard shortcuts do not change with language.

Invoice print settings independently support customer-facing labels in English, Hindi, Marathi, Gujarati, and Tamil. Company names, customer names, item descriptions, GST acronyms, HSN codes, and accounting values are never translated or rewritten.

## Voice control

Sidebar and Gateway destinations expose stable accessible names and a stable English command identity. macOS Voice Control can target the visible screen name. Icon-only controls retain explicit names such as `Go back`, `Switch company`, and `Close`.

## PDF output

The common PDF renderer requests tagged PDFs and document outlines from Chromium. Invoice templates use semantic headings, labelled tables, column scopes, alt text, and source-order markup. Text remains selectable. PDF accessibility still depends on the capabilities of the installed Electron/Chromium release, so the release visual test should include VoiceOver or a PDF accessibility checker when the runtime changes.

## Accessibility reports

The Support dialog offers an Accessibility issue category and three independent payload choices:

1. Safe diagnostics: app version, operating system, and CPU architecture.
2. Focus context: tag, accessible name, role, test identity, and screen. Input values are never read.
3. Screenshot: captured only after a separate checkbox is selected, resized to a bounded JPEG, and shown in a preview. A screenshot can contain visible company data, which is stated beside the consent control.

The website support endpoint bounds and sanitizes each field before forwarding it to the configured HTTPS support service.
