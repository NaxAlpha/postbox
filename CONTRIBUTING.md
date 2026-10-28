# Contributing

Use Node.js 22.12+, install with `npm ci`, and work against the loopback preview with synthetic mail. Follow the project rule: use **cf CLI** for Cloudflare operations; this repository has `cloudflare.config.ts` and no Wrangler configuration.

```sh
npm run postbox -- start
npm run check
npm run format:check
# With the preview running:
npm run test:browser
npm run test:browser:security
```

Unit tests also cover guided CLI selection, cf command dispatch, domain/DNS plans, foreign-provider conflicts, idempotent onboarding, and private setup journals. They use synthetic accounts and fake cf commands, so they never change real DNS.

Unit tests cover identity/security and the installer using a mock CLI with no account calls. Integration tests use workerd, real local D1/R2, and queue processing; the outbound provider is simulated/test-doubled. The test-only endpoints live in `tests/integration-entry.ts`, which is never the production entrypoint.

Browser checks create synthetic drafts/aliases. Do not run them against a live installation. Google Chrome on macOS is supported automatically; elsewhere install Playwright Chromium or specify `CHROME_PATH`.

Add numbered SQL migrations for schema changes; keep installer migration tracking and local initialization aligned. Do not edit an already published migration. Preserve explicit alias identity, fail-closed auth, raw intake durability, and conservative unknown-send handling. Security-sensitive changes require meaningful regression tests.

Keep dependency versions pinned and update the lockfile together. Do not add external scripts/fonts/analytics to the mailbox or log mail content. Document platform/API limitations honestly, especially beta behavior that has not been verified against a live account.

## Screenshots

Capture only synthetic sample data. Start a fresh isolated preview:

```sh
POSTBOX_LOCAL_STATE=.postbox/screenshots npm run dev
# In another terminal:
npm run screenshots
```

The capture script refuses a non-local or modified address registry and writes retina images to `docs/images/`. Browser regression screenshots go to the ignored `test-results/` directory instead. Never use a production mailbox for repository images.

## Pull requests

Keep changes focused, explain the user-visible result, and include relevant validation. Use synthetic examples in issues and redact deployment details. Report unpatched vulnerabilities through the private channel in [SECURITY.md](SECURITY.md). Documentation starts at [docs/README.md](docs/README.md).
