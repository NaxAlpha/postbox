# Security remediation — 28 October 2026

This update addresses R1–R4 from the [security review](review-2026-10-28.md). The original review and its evidence describe the pre-fix snapshot.

| Finding                                               | Change                                                                                                                                                                                                                                                | Verification                                                                                                                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1: MIME decoder complexity and nested header budgets | Pinned `postal-mime` 4.1.4; retained explicit byte, nesting and part bounds                                                                                                                                                                           | Real workerd intake rejects the formerly accepted aggregate nested-header payload                                                                                                                                   |
| R2: sanitizer recursion                               | Pinned `sanitize-html` 2.18.1                                                                                                                                                                                                                         | The discarded-iframe payload sanitizes without stack exhaustion; real workerd intake indexes the synthetic mail without active iframe markup                                                                        |
| R3: browser reviewed-revision race                    | Browser submits the exact revision returned by its own final save; new submissions without a revision return 400; stale revisions return 409                                                                                                          | Browser test interleaves another editor's recipient/body change before submission: no send is queued. Normal browser submission still succeeds and is undone locally. Existing queued-job replay remains idempotent |
| R4: replacement bucket deletion                       | New installations record the bucket creation timestamp returned by creation, verify it against current metadata, and write an installation-bound ownership marker. Cleanup checks both before any resource deletion and again before draining objects | Fake-provider tests reject same-name replacements, altered markers and missing legacy metadata before deletion. Backup/restore tests preserve destination ownership                                                 |

The Cloudflare toolchain was also updated together to `cf` 1.0.0-beta.24, `@cloudflare/vite-plugin` 2.0.0-beta.v.6 and `miniflare` 5.20261023.1-beta. The full dependency audit now reports zero vulnerabilities, including production and development dependencies. This avoids the audit tool's suggested major downgrade.

## Bucket ownership and older installations

The ownership marker is `__postbox/ownership.json`. It contains the account, installation ID, bucket name, normalized creation time and an installation marker value. It is not a login credential. It stays in R2 during ordinary mail processing and object draining; cleanup removes it only immediately before removing the verified empty bucket. Backups exclude it, and restoration into a fresh bucket preserves that destination's marker instead of copying ownership from the source installation. Restores reject nonempty storage beyond the destination marker.

Older manifests, including this deployment's original manifest, do not contain trustworthy historical bucket creation metadata. Upgrading does **not** silently infer ownership from the current bucket name or create a marker in a possibly unrelated replacement bucket. Destructive mail cleanup fails closed. `destroy --apply --confirm-prefix=PREFIX --keep-mail` can still remove the application while preserving its D1/R2 mail. Permanent removal of legacy storage requires explicit operator reconciliation of the original bucket identity; there is no automatic adoption or force bypass. No live bucket was adopted, emptied or deleted for this update.

Deployment and doctor verify the marker for installations that have it; doctor explains the cleanup restriction for legacy buckets. Exact prefix checks and other resource ownership checks remain in force.

## Validation

- Production build and generated binding types pass.
- 72 unit/CLI/security/installer/backup tests pass.
- Real workerd/D1/R2 integration passes, including missing/stale send revisions, queued-send replay, poison HTML and nested header budgets.
- The new `npm run test:browser:security` passes against the loopback cf preview. It checks a recipient/body edit during browser submission and ordinary revision-bearing submission; the successful local submission is undone.
- Existing responsive/theme/reply/address browser checks pass.
- Formatting and `npm audit --audit-level=high` pass; audit reports zero vulnerabilities.
- Destructive tests use fake provider resources only. All mail tests use synthetic local data; no real recipient was contacted.

## Live rollout

`postbox deploy --yes --silent` completed successfully at `https://mail.example.com`. Post-deployment anonymous requests carrying forged identity/assertion headers to the UI, bootstrap, export and attachment paths all received Access login redirects. No live malformed mail, send or destructive cleanup was used to test the release. The local preview was stopped after validation.

The HTTP send API now requires the reviewed revision for a new submission. Existing tabs or clients that omit it fail safely and should refresh/update. The CLI already supplies it. A deployment may revoke Access sessions; sign in again if prompted.
