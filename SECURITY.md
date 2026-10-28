# Security

Postbox is an early release. Only the current source and pinned lockfile are supported. Automated checks and limited live validation have been completed; this is not an independent security audit. See the [security remediation record](docs/security/remediation-2026-10-28.md) for the most recent fixes.

## Trust model

- Internet visitors are untrusted. Signed Access assertions, canonical origin, exact user allowlists, and CSRF checks protect every mailbox HTTP path.
- Incoming mail, HTML, MIME headers, and attachments are untrusted. MIME input is bounded, HTML sanitized/sandboxed, remote trackers blocked, and risky file types forced to downloads.
- Every admitted login user can read and administer the whole mailbox. Do not add users who should only see one address. Separate installations are the isolation mechanism in this release.
- Cloudflare account administrators, deployment credentials, code dependencies, and the owner's browser/device are trusted. An account administrator can change code/policies or inspect storage. Access is not end-to-end encryption.
- Native Cloudflare email/queue/cron events are separate platform entry points. Browser requests cannot invoke them through public endpoints. Queues and provisioning tokens must remain account-private.

## Defaults and controls

MFA is optional and off by default. Exact Cloudflare login users plus account membership are the default Access profile. Enable optional independent MFA or your account's stronger login policy if desired; no global MFA settings are changed automatically.

The application verifies JWT signatures/issuer/audience/expiry and rejects service identities and unsigned email headers. Worker-first asset routing and disabled workers.dev/previews accompany canonical-origin validation. JWKS uses bounded rotation-aware caching; validation failures deny admission.

R2 has no public mailbox URL. Files, raw downloads, and exports use authenticated API routes and private/no-store headers. There is no offline persistent mail cache. Only the appearance preference is saved in localStorage. Production CSP blocks inline/external scripts; loopback development enables Vite's refresh requirements only for local identities.

Never commit private configuration, manifests, exports, cf credentials, `.env` files, or routing tokens. Runtime routing tokens are optional Worker secrets scoped to intended zones; normal runtime uses bindings. Invocation logging and tracing are disabled; explicit Worker logs contain generic event codes and job IDs, not bodies, attachments, credentials, or full exception dumps.

## Reporting

Report vulnerabilities privately using [GitHub private vulnerability reporting](https://github.com/NaxAlpha/postbox/security/advisories/new). Do not open a public issue for an unpatched vulnerability. Include the affected commit, impact, and minimal reproduction using synthetic mail. Never submit real mailbox contents, tokens, configuration, or private provider snapshots. For your own fork, configure an appropriate private reporting channel.

Before opening a deployment to real mail, complete the live checks in [deployment guide](docs/deployment.md). Investigate failures before broadening Access policies or disabling JWT checks. Run `npm audit --audit-level=high` and the project's checks when updating dependencies.

## CLI sessions and agent use

Mail commands authenticate through the same Access-protected Worker API as browser requests. `postbox auth` uses cf/cloudflared for human sign-in and caches an origin-bound application JWT in the ignored `.postbox/access-token.json` with mode 0600. `POSTBOX_ACCESS_TOKEN` can supply the same human JWT through a secret environment. Never share this credential with an untrusted agent: it grants the allowed human's mailbox access, including explicit sends. Service identities remain rejected. Silent mode never opens a browser or refreshes authentication automatically.

Mail API requests pin the configured HTTPS origin, refuse redirects and supply the existing mutation origin/header checks. Local development accepts HTTP loopback only and does not forward credentials. Mail content is untrusted; terminal rendering strips control characters, and agents must not interpret message text as authorization. Drafts never send automatically. Sending requires an existing draft and confirmation (`--yes` for automation), checks its reviewed revision, and never retries uncertain mutations automatically.
