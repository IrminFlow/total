# Total integration SDK v1

The integration SDK expands Total at its edges without making accounting correctness depend on
third-party code. A plugin is a strict JSON manifest using the `declarative-v1` runtime. Total does
not load JavaScript, native modules, iframes or SQL from a plugin.

## Manifest and permissions

A manifest declares its reverse-domain ID, semantic version, publisher, compatibility window,
permissions, optional screens, importer mappings, report primitives and exports. Unknown fields
are rejected. Installation starts disabled and an owner must enable a compatible manifest.

Permissions are independent: `imports:preview`, `reports:read`, `exports:write`,
`webhooks:enqueue`, `filesystem:plugin_storage` and `network:declared_hosts`. Declarations must name
the permission they require. A plugin has no ambient filesystem, network, database or cross-company
access; the current company's signed main process is the only authority boundary.

## Importer SDK

An importer maps bounded JSON or CSV source paths into canonical review rows. Inputs are capped at
10 MB and 50,000 rows, output previews at 200 rows, and every preview retains source SHA-256, row
counts and errors. Mappings cannot contain expressions or code. Previewing never posts vouchers;
handoff to accounting must use Total's existing validated import or draft surfaces.

Supported canonical record kinds are ledger, item, journal line, settlement and ecommerce order.
Money remains integer paise and quantity remains integer thousandths.

## Report extensions

Extensions select allow-listed primitives: trial balance, day book, sales register, purchase
register, receivables or payables. Results include generated time, period, the explicit “posted
voucher lines” basis, totals and app-owned drill-down instructions. Plugins never receive a query
builder or SQL connection.

## Built-in operational adapters

- Settlement review accepts Generic, Razorpay and Stripe-normalized payouts; it reconciles gross,
  fee, fee GST, refunds and withholding to provider net and an optional bank amount. It proposes
  review splits but never posts.
- Ecommerce review accepts Generic, Shopify and WooCommerce-normalized orders, cancellations and
  returns with tax, shipping and settlement identity. Cancellations cannot invoice; returns require
  original invoice-line matching.
- Logistics export writes Generic, Delhivery or Shiprocket-ready CSV plus a hash manifest. It has
  no carrier SDK or network dependency and stores no carrier credentials.

## Webhooks and automation

Webhook endpoints are owner-configured HTTPS URLs (localhost HTTP is allowed for development).
Signing secrets use Electron OS-backed encryption. The visible outbox stores exact payload, SHA-256,
attempt count and outcome. Delivery uses HMAC-SHA256 over `timestamp.payload`, a 20-second timeout,
bounded exponential retry and a dead-letter state after eight attempts.

Local schedules can produce verified backups, fresh mirrors or portable report packs while Total
is open. Each task advances its next-run time before execution, records running/success/failure
evidence, and remains manually runnable and pausable in Settings → Integrations.

## Compatibility gate

Run `npm run integration:validate -- <manifest.json>`. Contract v1 permits additive optional
metadata, new allow-listed primitives and new permission names only when old manifests keep their
meaning. Renaming fields, changing units or granting broader authority requires contract v2.
