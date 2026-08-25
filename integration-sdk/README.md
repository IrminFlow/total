# Total integration kit v1

Total integrations are declarative JSON manifests. They do not load executable code into the
desktop app and cannot access SQLite. The app resolves declarations to allow-listed import and
report primitives inside the signed main process.

Validate a manifest from the repository root:

```bash
npm run integration:validate -- integration-sdk/examples/partner.manifest.json
```

The gate rejects unknown keys, executable entrypoints, invalid compatibility metadata, duplicate
declaration IDs, unsupported report primitives and permissions that do not match the requested
capabilities. Use the fixtures in `fixtures/` to test integer-paise settlement, ecommerce and
shipment payloads. Full semantics and security boundaries are documented in
`docs/INTEGRATION_SDK_V1.md`.
