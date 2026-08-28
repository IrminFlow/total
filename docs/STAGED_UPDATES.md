# Staged desktop updates

Before any branch candidate enters a shared staging environment, complete
[the v5 staging readiness checklist](STAGING_READINESS_CHECKLIST.md). That checklist covers source,
accounting, data, services, security, privacy, AI, collaboration, operations and rollback admission;
platform verification remains part of the later release process.

Total assigns each installation to a stable bucket from 0-99. The installation identifier stays in
the Electron user-data directory and is never sent to the website. A release is offered only when
the device's channel matches and its bucket is below the published percentage.

The website `/api/latest` route reads these server-side environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `UPDATE_ROLLOUT_PERCENTAGE` | `100` | Default percentage for every channel. Invalid values fail closed to `0`. |
| `UPDATE_ROLLOUT_PERCENTAGE_STABLE` | inherited | Stable-channel override. `BETA` and `INTERNAL` variants are also supported. |
| `UPDATE_ROLLOUT_SALT` | channel + version | Changes deterministic cohort membership. Channel-specific suffixes are supported. |
| `UPDATE_KILL_SWITCH` | `false` | Set to `true` to stop all update offers immediately. |
| `UPDATE_AUTO_DOWNLOAD` | `true` | Set to `false` to prevent automatic downloads while retaining an approved manual offer. |
| `UPDATE_MANUAL_DOWNLOAD` | `true` | Set to `false` to stop manual download offers too. |

Roll a release from 10 to 50 to 100 by changing only its percentage. Keep the salt unchanged so
each wave is a superset of the previous wave. The desktop updater treats a missing or malformed
website manifest as no update; it does not bypass rollout controls through GitHub.

## Branch packages

The `v5 cloud-agent-sync branch packages` workflow runs on every push to
`v5-cloud-agent-sync`. It can also be dispatched manually with a channel and test percentage:

```bash
gh workflow run v5-cloud-agent-sync.yml \
  --ref v5-cloud-agent-sync \
  -f channel=internal \
  -f rollout_percentage=25
```

The workflow has read-only repository permissions, disables signing and notarization, passes
`--publish never`, and uploads test artifacts for 14 days. Every platform bundle contains a
content-addressed manifest marked `signed: false` and `publishable: false`. It does not alter the
reviewer-protected release-candidate or promotion workflows.
