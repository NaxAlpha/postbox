# Local validation record

Verified on 14 October 2026 with Node.js 22.23.1 and the pinned dependency lockfile.

| Check                                                                                | Result                         |
| ------------------------------------------------------------------------------------ | ------------------------------ |
| Production Worker/client build and TypeScript                                        | Passed                         |
| Security and installer unit tests                                                    | 22 passed                      |
| workerd + local D1/R2 integration                                                    | Passed                         |
| Desktop Chrome, 1440 × 960                                                           | Passed                         |
| Mobile Chrome viewport, 390 × 844                                                    | Passed; no horizontal overflow |
| Reply identity, autosaved draft, explicit alias creation, keyboard focus containment | Passed                         |
| Browser page errors                                                                  | None in final run              |
| Formatting                                                                           | Passed                         |
| npm dependency audit                                                                 | 0 reported vulnerabilities     |

The integration suite also exercises immutable draft revisions, send idempotency and undo, simulated queue processing, MIME intake, recipient-scoped deduplication/threading, Reply-To parsing, attachment forwarding copies, provider request shape using a test double, recipient event ordering/deduplication, unknown-send resolution, poison MIME bounds with retained raw originals, pause/unknown recipient rejection, trash deletion, streamed metadata export, and unsigned/CSRF rejection.

Installer tests use a fake cf executable and temporary directories. They check narrow policy creation before deployment, exact ownership IDs, upgrades with session revocation, collision refusal, offline removal plans, retained mail, prefix-confirmed deletion, renamed-resource refusal, shared-policy retention, and removal of retained storage. They perform no live Cloudflare API calls.

The production client bundle is approximately 82.74 KiB gzip; CSS is approximately 4.83 KiB gzip; the Worker bundle is approximately 203.10 KiB gzip. Browser screenshots use synthetic preview data and are under `docs/images/`.

No live deployment, real email send, or external recipient contact occurred. Account provisioning, signed-in Access/Static Assets behavior, maximum-size mail behavior, domain eligibility/DNS, real SMTP delivery, and Email Sending event subscription/correlation remain live acceptance checks after configuration. The local preview was stopped after validation.

## Postbox CLI update — 28 October 2026

The source now includes the `postbox` executable with interactive `init`, `start`, `deploy`, domain inspection/onboarding, and existing operations. Validation for this update:

- 40 tests passed: original security/installer checks plus domain/account selection, apex/subdomain DNS onboarding, DNS/route conflicts, no-write dry runs, idempotency, private operation journaling, owned-policy repair, noninteractive import, unknown-flag rejection, and deploy orchestration.
- Production build/TypeScript and workerd/D1/R2 integration passed.
- `postbox start` launched the actual loopback cf preview; bootstrap confirmed local mode and sample addresses. The preview was then stopped.
- Actual interactive cf account/domain discovery was exercised against the logged-in account and canceled before changes.
- `postbox deploy --dry-run` recognized the existing two-domain installation with ready sending/receiving and no DNS changes.
- `npm link` installed the executable locally; `postbox help` worked.
- Package dry run and ZIP checks excluded private configuration, install state, and generated build files.

No live DNS mutation or Worker redeployment was performed by this CLI update. Earlier live mail verification remains documented separately.

## Catch-all aliases, dark mode, and full destruction — 28 October 2026

- Production build/TypeScript, 51 unit/CLI/installer/teardown tests, and workerd/D1/R2 integration passed.
- Integration verifies catch-all address creation, CLI-only domain rejection without a database write, and bootstrap capabilities for each domain.
- Browser checks verify dark preference persistence, System/Light/Dark behavior, formatted email contrast, responsive desktop/mobile layouts, and local alias creation.
- Live deployment updated at `mail.example.com`; both apex domains have owned catch-alls while existing literal/existing-route routes remain preserved. Unknown recipients still require an explicit active address record.
- The live Add address form shows both domains as Ready · catch-all; eligibility was checked without creating a fifth live test address.
- Full `postbox destroy` previews include core compute/storage/queues/Access, owned domain onboarding/DNS, and the owned IdP. Prefix confirmation, shared/edited-resource refusal, deletion order, retained-mail option, and resume behavior were tested with fake provider resources. No live teardown was executed.
- Existing exact creation snapshots were migrated to the private setup journal so older live resources remain identifiable for later cleanup. Shared account, zones, Zero Trust organization, reused domain setup, and unrelated routes remain outside destructive ownership.

## Agent CLI and terminal mailbox — 28 October 2026

- Production build/TypeScript, 66 unit/CLI/security/installer/teardown tests, formatting, and workerd/D1/R2 integration passed.
- CLI tests cover no-send draft creation, explicit sending confirmation, reviewed revision submission, paused/unconfigured sender refusal, draft replacement safeguards, attachment/reply preservation, pagination, strict flags, JSON envelopes, no-prompt setup, quiet foreground startup, Access cookie/CSRF headers, redirects, no automatic mutation retries, loopback credential isolation, and private origin-bound session caching.
- Integration runs draft/list/view/send through real Worker/D1/R2 handlers and rejects a stale reviewed revision without moving the draft. Sending remains simulated in local tests.
- Actual local terminal sessions exercised guided drafting, draft review/confirmation, queued-to-simulated status, TUI message selection/viewing, normal exit, and Ctrl-C terminal restoration. JSON subprocess commands were exercised against the cf local preview. The preview was stopped afterward.
- The production draft revision guard was deployed through `postbox deploy --yes --silent`. Unsigned requests to `/` and `/api/bootstrap` still return Access login redirects. No live email was sent during this update.
- Authenticated remote CLI mail operations have not been exercised with a human Access session. `postbox auth` is intentionally left to the allowed human; it uses cf/cloudflared and caches a private application JWT. Unit tests cover token handling with fake credentials; existing signed-browser live validation is documented separately.
- Source archive excludes private config, sessions, journals, local mail, credentials, dependencies and generated deployment artifacts.

### Embedded agent help

The CLI now embeds the safe workflow in `postbox help agents` and command-specific help. Offline JSON discovery was exercised for all commands and the agent topic, alongside existing CLI/mail-command tests. This help-only update does not change the deployed Worker or authentication policies.

## Security findings remediation — 28 October 2026

R1–R4 are addressed. Patched parser/sanitizer and Cloudflare toolchain dependencies give a clean full npm audit. Build, 72 unit/CLI/security/installer/backup checks, real workerd integration, normal browser checks, and the browser concurrent-edit regression pass. The updated Worker and browser were deployed through Postbox; forged/anonymous live HTTP probes remain Access protected. Legacy bucket deletion fails closed without creation identity and an installation marker; no live storage was adopted or removed. See [remediation record](../security/remediation-2026-10-28.md).
