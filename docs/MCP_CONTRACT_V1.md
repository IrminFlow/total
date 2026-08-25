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

Every authenticated tool and company-bearing resource also performs a fresh app-presence check.
The desktop app listens only on an owner-private Unix domain socket (mode `0600`) or a Windows
named pipe derived from the local data-root digest; it never opens a TCP/network port. The MCP
process sends the token's SHA-256 digest, company, required scope and a one-use nonce—not the
plaintext token. The app independently rechecks device enablement, expiry, revocation and scope,
then requires the same company to be active and the current signed-in role to meet the operation's
minimum role. Closing Total, locking the session, switching companies or disabling MCP therefore
fails subsequent calls closed. A company without configured users follows Total's existing local
implicit-owner session behavior while it is open.

## Units and safety boundary

- Money is always integer paise. Quantities are integer thousandths.
- MCP never opens a company SQLite database.
- Read tools consume only generated mirror files.
- `propose_voucher` writes an inert proposal capped at 512 KB. A signed-in person must approve it
  in Total, where current schemas, accounting validation, permissions and period locks run again.
- `propose_master_change` stores a review-only ledger or item proposal separately. MCP cannot apply
  it, and v5.0 deliberately reports `approvalAvailable: false` until an in-app master-review path
  performs entity-specific validation.
- Proposal listing and discard require separate scopes and only expose records created by the exact
  paired token. Discard archives an inert file; it never deletes or changes an accounting record.
- `request_mirror_refresh` creates a request. It does not regenerate data until a signed-in owner
  approves the request in Total.
- `read_attachment` is limited to files inside the company's managed attachments directory after
  real-path containment checks, and rejects files larger than 2 MB.

## Capability discovery

`get_capabilities` is the only unauthenticated tool. It returns the contract and product versions,
supported mirror schemas, units, scopes, tool metadata and stable error catalogue. The same
machine-readable contract is exposed as the MCP resource `total://contract/v1`.

Mirror schema v2 keeps the v1 `meta.json.files` string array and direct payload filenames for old
clients. It additionally publishes a generation ID, explicit integer unit metadata, stable schema
IDs, a machine-readable JSON Schema, and SHA-256 plus byte length for every payload. Total builds a
complete generation in a private staging directory, verifies it, and promotes it as one directory;
a failed refresh leaves the preceding verified generation intact. SQLite remains authoritative and
files under `agent/` are read-only projections. Files under `proposals/` remain inert until a person
approves them through Total's normal validation and audit path.

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
`SCOPE_DENIED`, `COMPANY_DENIED`, `COMPANY_NOT_FOUND`, `MCP_DISABLED`, `APP_UNAVAILABLE`,
`APP_SESSION_REQUIRED`, `COMPANY_INACTIVE`, `ROLE_DENIED`, `MIRROR_MISSING`, `INVALID_RESOURCE`,
`RESOURCE_LIMIT` and `INTERNAL_ERROR`.

## Permission matrix

| Tool | Required scope | Effect |
|---|---|---|
| `get_capabilities` | none | Describes this contract; reads no company data |
| `list_companies` | `companies:list` | Returns only the company bound to the token |
| `get_mirror_status` | `mirror:read` | Returns generation time, schema, manifest and staleness |
| `get_book_snapshot` | `mirror:read` | Reads an allow-listed mirror view |
| `search_books` | `mirror:read` | Runs bounded search over generated mirror data |
| `get_voucher` | `mirror:read` | Reads one stable voucher ID from generated FY mirrors |
| `get_ledger` | `mirror:read` | Reads one ledger by stable ID or exact name |
| `run_report` | `mirror:read` | Returns a generated Trial Balance or Outstandings snapshot |
| `list_outstandings` | `mirror:read` | Returns bounded receivable/payable snapshots |
| `list_exceptions` | `mirror:read` | Derives bounded imbalance, bill-reference and overdue exceptions |
| `read_attachment` | `attachment:read` | Reads one managed, contained attachment |
| `request_mirror_refresh` | `mirror:refresh` | Queues an owner approval request |
| `propose_voucher` | `proposal:create` | Creates an inert draft for in-app review |
| `propose_master_change` | `proposal:create` | Stores an inert ledger/item proposal; never applies it |
| `validate_proposal` | `proposal:create` | Checks shape and voucher balance without writing |
| `list_proposals` | `proposal:read` | Lists this exact token's bounded inert proposals |
| `discard_proposal` | `proposal:discard` | Archives this exact token's inert proposal |

Tokens are bound to exactly one company. Omitting `company` uses the token's company; naming a
different company returns `COMPANY_DENIED`. A mirror is reported stale when it is missing or more
than ten minutes old.

The resource catalogue exposes `total://company/current`, `total://docs/accounting-schema`,
`total://mirror/manifest`, `total://reports/definitions`, `total://schema/voucher`, and
`total://help/product`. Company metadata and the mirror manifest enforce the same paired-token
company and scopes as tools. Static schema/help resources contain no company data.

## Audit evidence

Each scoped call appends a JSON Lines event under the company MCP directory. Events contain only
timestamp, bounded client name, tool, company, outcome, proposal ID when applicable, and an error
code. Arguments, attachment contents, local paths and token values are never logged. The active log
rotates after 5 MB and the Settings screen exposes recent evidence to the signed-in user.
