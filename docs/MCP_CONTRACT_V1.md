# Total MCP contract v1

Total ships a local stdio MCP server for bounded access to generated accounting mirrors and
human-reviewed proposals. The contract version is independent of the desktop app version:
compatible app releases may add optional fields or tools to v1, but cannot rename fields, change
units, broaden permissions, or change an existing tool's posting behavior. A breaking change
requires a new contract version.

Run the source server with `npm run mcp`. The packaged macOS server is
`/Applications/Total.app/Contents/Resources/total-mcp.mjs` and can be launched with Node.

## Authentication and client identity

Issue a token in **Settings → Agent access**. Configure the client process with:

```text
TOTAL_MCP_TOKEN=total_mcp_...
TOTAL_MCP_CLIENT=descriptive-client-name
```

The token value is shown once. Total stores only its SHA-256 hash, its company, explicit scopes,
expiry, creator and revocation state. `TOTAL_DATA_DIR` may point a development or test server at a
different Total data root; production clients should use the normal app data root.

## Units and safety boundary

- Money is always integer paise. Quantities are integer thousandths.
- MCP never opens a company SQLite database.
- Read tools consume only generated mirror files.
- `propose_voucher` writes an inert proposal capped at 512 KB. A signed-in person must approve it
  in Total, where current schemas, accounting validation, permissions and period locks run again.
- `request_mirror_refresh` creates a request. It does not regenerate data until a signed-in owner
  approves the request in Total.
- `read_attachment` is limited to files inside the company's managed attachments directory after
  real-path containment checks, and rejects files larger than 2 MB.

## Capability discovery

`get_capabilities` is the only unauthenticated tool. It returns the contract and product versions,
supported mirror schemas, units, scopes, tool metadata and stable error catalogue. The same
machine-readable contract is exposed as the MCP resource `total://contract/v1`.

Successful tools return a structured envelope:

```json
{
  "contractVersion": 1,
  "company": "demo-traders"
}
```

Errors use a stable envelope and set the MCP error flag:

```json
{
  "contractVersion": 1,
  "error": {
    "code": "SCOPE_DENIED",
    "message": "The token does not grant the scope required by this tool.",
    "retryable": false
  }
}
```

The v1 error codes are `AUTH_REQUIRED`, `AUTH_INVALID`, `TOKEN_EXPIRED`, `TOKEN_REVOKED`,
`SCOPE_DENIED`, `COMPANY_DENIED`, `COMPANY_NOT_FOUND`, `MIRROR_MISSING`, `INVALID_RESOURCE`,
`RESOURCE_LIMIT` and `INTERNAL_ERROR`.

## Permission matrix

| Tool | Required scope | Effect |
|---|---|---|
| `get_capabilities` | none | Describes this contract; reads no company data |
| `list_companies` | `companies:list` | Returns only the company bound to the token |
| `get_mirror_status` | `mirror:read` | Returns generation time, schema, manifest and staleness |
| `get_book_snapshot` | `mirror:read` | Reads an allow-listed mirror view |
| `search_books` | `mirror:read` | Runs bounded search over generated mirror data |
| `read_attachment` | `attachment:read` | Reads one managed, contained attachment |
| `request_mirror_refresh` | `mirror:refresh` | Queues an owner approval request |
| `propose_voucher` | `proposal:create` | Creates an inert draft for in-app review |

Tokens are bound to exactly one company. Omitting `company` uses the token's company; naming a
different company returns `COMPANY_DENIED`. A mirror is reported stale when it is missing or more
than ten minutes old.

## Audit evidence

Each scoped call appends a JSON Lines event under the company MCP directory. Events contain only
timestamp, bounded client name, tool, company, outcome, proposal ID when applicable, and an error
code. Arguments, attachment contents, local paths and token values are never logged. The active log
rotates after 5 MB and the Settings screen exposes recent evidence to the signed-in user.
