# Deployment and operations

The normal setup path is the [Postbox CLI](cli.md): `postbox init` discovers domains and prepares DNS, `postbox start` runs locally, and `postbox deploy` provisions or updates the installation. The commands below document the lower-level installer and advanced/manual configuration.

## Prerequisites

1. Node.js 22.12+ and `npm ci` from the pinned lockfile.
2. Your own Workers Paid account, R2 enabled, and relevant Cloudflare DNS zones.
3. Zero Trust onboarding completed, with the Cloudflare identity provider available. The default profile requires exact allowed emails **and membership in your deployment account**. A separately configured IdP can be selected with `access.identityProviderId`.
4. Email Service eligibility and domain onboarding. Receiving and sending are separate capabilities. Validate the documented transactional-mail scope for your intended usage. [Email Service](https://developers.cloudflare.com/email-service/)
5. cf credentials with only the account/zone permissions needed to manage Workers, D1, R2, Queues, Access apps/policies, and selected Email Routing rules. Keep provisioning credentials on the operator machine, outside the application.

The installer reuses the organization and IdP. It never creates public signup or changes shared organization MFA settings. MFA is disabled by default; `access.mfa=true` opts into independent MFA after organization enrollment is enabled.

## Configuration

Run `npm run mailbox -- init` and edit the generated configuration. Start with a unique lowercase prefix, exact login emails, and a browser hostname. A prefix is 3–30 characters; letters, digits, and hyphens are accepted. Every optional resource override must start with that prefix plus `-` and fit the resource naming rules.

Example mail domain and address entries (replace the example zone ID):

```json
{
  "domains": [
    {
      "name": "example.com",
      "zoneId": "00000000000000000000000000000000",
      "sending": true,
      "receiving": true,
      "catchAll": true
    },
    {
      "name": "mail.example.net",
      "zoneId": "11111111111111111111111111111111",
      "sending": true,
      "receiving": true,
      "catchAll": false
    }
  ],
  "addresses": [
    {
      "email": "hello@example.com",
      "name": "Personal",
      "color": "#8272d5",
      "signature": "Best,\nAlex"
    },
    { "email": "work@mail.example.net", "name": "Work", "color": "#42a697", "signature": "" }
  ]
}
```

Merge these fields into the full generated configuration. `sending:true` records an intended, already verified capability; it does not verify the domain itself. Use ASCII local parts and punycode domain names. Initial addresses must belong to configured receiving domains. Domains may also be receive-only or send-only.

The installer fills `access.teamDomain`, `access.identityProviderId`, and `access.audience`. Keep them pinned afterward. Runtime authorization independently checks `access.allowedUsers`. Resource renaming after installation is rejected; use a new installation/prefix and backup/restore for a move.

`limits.sendsPerHour` defaults to 100; spam/trash retention defaults to 30 days. These are application limits, independent of provider quotas. Aliases share the same workspace and quota.

## Install and connect

```sh
npx cf auth login
npm run mailbox -- plan
npm run mailbox -- install --apply
npm run mailbox -- doctor
```

Install refuses name/hostname collisions rather than adopting existing resources. It records each created resource immediately in a mode-0600 manifest, applies numbered SQL migrations, creates/attaches a narrow Access policy, builds, and deploys. The canonical hostname is a Worker Custom Domain; workers.dev and previews are disabled. All HTTP paths pass through application auth, including assets and downloads.

Before routing real mail, verify login as an allowed owner and rejection as an unlisted account. Check `/api/bootstrap`, an attachment URL, exports, and static assets while signed out. Review overlapping Access apps and every enabled Worker URL. `doctor` synchronizes owned runtime route IDs for a later offline removal plan and checks resource names, audience/hostname, exact policy admission, and an unsigned API probe; it does not replace those live browser checks.

Onboard each domain in Cloudflare Email Service. Review existing MX records deliberately; this tool does not replace another provider's MX records or perform a DNS migration. Verify SPF/DKIM/DMARC and sender eligibility. Then:

```sh
npm run mailbox -- connect-mail --apply
```

For an apex domain with `catchAll:true`, one owned catch-all sends mail to the Worker; the Worker accepts only **explicitly registered, active addresses**. An unrelated existing enabled catch-all is refused. Unknown recipients are rejected rather than silently creating mailboxes.

For subdomains or `catchAll:false`, the command creates literal routing rules for addresses in D1. It verifies that the configured domain belongs to the zone and refuses conflicting rules. Cloudflare receiving subdomains must be onboarded separately. [Subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/)

If using plus addresses, register the exact `name+tag@domain` identity and configure provider subaddressing/rules as appropriate. The Worker preserves literal envelope recipients and does not automatically expand `name@domain` into every possible tag. [Subaddressing](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/#subaddressing)

## Creating more aliases

Apex catch-all installations can create new explicit aliases in Settings immediately. Unknown catch-all recipients remain rejected.

For literal-route domains, choose either:

- Add the address to private configuration, run `upgrade --apply`, then `connect-mail --apply`.
- Enable optional `providerRoutingTokenEnabled`, store `ROUTING_TOKEN` as a **Worker secret** in the Cloudflare dashboard, and redeploy with the secret reference enabled. Use a token limited to Email Routing rule management for only the intended zones. UI creation then creates a literal rule server-side and stores its exact ID/body in D1 for later cleanup. The token is never sent to the browser.

For the secret path, deploy initially with the flag off, add the secret to that Worker, set the flag true, then upgrade. Do not put token values in `mailbox.config.json` or commit them. If secret provisioning is incomplete, choose the configuration/installer path until it is fixed.

Pausing an address preserves its history and reserved name; inbound mail is rejected and new sends are prevented. Receive-only mode keeps inbound mail while disabling sends. An address cannot be changed to another email identity in place.

## Delivery events

The current cf beta schema has no typed Email Sending source. In Cloudflare's **Event Subscriptions** dashboard, create a subscription for each verified sending domain, destination the installation's `PREFIX-jobs` queue, and select the documented `cf.email.sending.message.*` events. Name it with your installation prefix.

Then explicitly give the installer ownership of the exact subscription ID:

```sh
npm run mailbox -- register-events --apply --subscription=SUBSCRIPTION_ID
```

Registration verifies source domain and destination queue and records the exact ID/name. If the beta API returns a different source shape, registration fails closed; retain the ID and inspect it before any deletion. Do not silently edit ownership metadata to bypass that check. [Sending events](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)

Without a subscription, successful provider submissions remain `accepted`. With events, the reader shows recipient outcomes; one recipient's success never implies success for every recipient. Event IDs deduplicate redelivery, terminal outcomes resist late deferred events, and events arriving before the send response are reconciled afterward.

## Upgrade and troubleshooting

Back up mail and the manifest first, update the source/lockfile, then:

```sh
npm ci
npm run check
npm run mailbox -- upgrade --apply
npm run mailbox -- doctor
```

Upgrade retains storage IDs and the Access audience. It updates the installation's policy/app and revokes old application sessions; users sign in again. Keep the private configuration and manifest intact. It inserts missing configured addresses but does not overwrite existing UI-edited addresses or delete addresses removed from configuration.

The hourly send cap and queue delay are visible through API errors/status. Known provider rejection is marked failed. An ambiguous transport failure is marked `unknown` and **never automatically sent again**. Inspect Cloudflare Email Sending logs, then record accepted/failed in the reader; an optional provider ID can be attached. Recording a result does not resend mail.

Malformed mail receives three bounded processing attempts. The original stays private in R2. Settings → Mail processing provides raw download and manual retry. Inspect parser/storage failures before retrying. MIME limits are 32 levels, 256 parts, 256 KiB headers, and five nested RFC822 messages; very large text/HTML previews are truncated, preserving the raw message.

The five-minute sweep recovers unrecorded raw objects, requeues persisted work, resolves interrupted submissions conservatively, clears detached/orphaned objects after 24 hours, and purges expired spam/trash. Dead-letter queues and failed intake should be monitored in the account. Logs omit bodies/tokens; do not enable request-header/body logging for this application.

## Export and restore

```sh
npm run mailbox -- export
```

The private export contains D1 records plus every R2 object and SHA-256 checksums. It is stored under `.postbox/export-TIMESTAMP`, mode 0700 with mode-0600 files. Browser metadata export is not a complete backup. Protect exports like the mailbox itself.

A live export is not a transactionally consistent snapshot across D1/R2. For a consistent backup, deliberately pause receiving routes and stop composing, allow queued jobs to drain, then export. Re-enable only after the backup finishes. Large exports keep D1 metadata in operator-machine memory; ensure sufficient space/RAM. Restore validates paths/checksums/referenced objects before modifying resources.

Restore into a **new empty installation**, using an empty initial `addresses` array and no connected mail routes:

```sh
npm run mailbox -- restore --backup=/private/path/backup.json
npm run mailbox -- restore --backup=/private/path/backup.json --apply
```

Restore refuses an installation that contains addresses, messages, or R2 objects. It uploads objects, restores records with bound SQL, and excludes old provider route IDs/cursors. Pending outbound submissions become `unknown` so restore cannot duplicate delivery. Raw recovery metadata is not recreated, but imported intake records preserve the original raw objects. Check the restored mailbox, resolve pending send results, then connect its routes. If restore fails partway through, preserve the backup and start again with a new empty installation rather than merging partial data blindly.

## Remove

For complete teardown through the new CLI, use `postbox destroy` to preview, then `postbox destroy --apply --confirm-prefix=YOUR_PREFIX`. This includes owned mail storage and recorded DNS/domain/IdP resources; add `--keep-mail` to retain D1/R2. Shared/pre-existing infrastructure is preserved. The lower-level installer commands below retain their older mail-preserving defaults.

Keep `.postbox/install.json`; prefix matching alone is never ownership proof.

```sh
npm run mailbox -- uninstall
npm run mailbox -- uninstall --apply
```

The first command prints a plan without provider calls. Default removal removes owned routes, compute, queues, registered subscriptions, Access app, and policy while **retaining D1/R2 mail**. Access stays in place until Worker removal succeeds. Updated runtime-created routes are synchronized into the local manifest before deletion. Changed route/resource names or shared policy references stop cleanup; successfully removed resources are recorded so it can resume.

Permanent deletion requires a matching prefix confirmation:

```sh
npm run mailbox -- uninstall --apply --delete-mail --confirm-prefix=YOUR_PREFIX
```

It empties the owned R2 bucket before deletion. Provider failures/retention locks produce incomplete cleanup; Access is preserved if application removal failed. Shared domains, MX/DKIM/DMARC, Zero Trust organizations, IdPs, and local backups are retained. Review Cloudflare-managed Custom Domain/DNS leftovers in the dashboard after Worker removal.

Use dedicated resources for this installation. Do not bind its D1/R2/queues to other applications without revising the removal plan: a local ownership manifest cannot independently prove every other application's current dependency. The tool refuses forced Worker deletion with foreign references and does not automatically delete any pre-existing same-prefix resource. Manually created event subscriptions must be registered or removed explicitly before deleting their destination queue.
