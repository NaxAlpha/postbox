# Documentation

Start with the [project README](../README.md) for a local preview and guided deployment.

| Guide                                      | What it covers                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| [CLI](cli.md)                              | Setup, authentication, mail commands, JSON mode, TUI, and safe agent workflows        |
| [Deployment and operations](deployment.md) | Prerequisites, configuration, domain routing, upgrades, backups, restore, and cleanup |
| [Architecture](architecture.md)            | Worker entry points, identity, storage, intake, sending, and system boundaries        |
| [Security](../SECURITY.md)                 | Trust model, protections, CLI credentials, and private vulnerability reporting        |
| [Contributing](../CONTRIBUTING.md)         | Development, tests, migrations, screenshots, and pull requests                        |

## Validation and security records

- [Local validation](validation/local.md)
- [Live validation](validation/live-2026-10-28.md) — anonymized results from a private deployment
- [Security review](security/review-2026-10-28.md) and [review evidence](security/review-evidence-2026-10-28.json) — historical pre-fix findings
- [Security remediation](security/remediation-2026-10-28.md) and [remediation evidence](security/remediation-evidence-2026-10-28.json) — fixes and regression checks

## Design research

[Email Service research](research/email.md) and [Access research](research/access.md) preserve the original design investigation. They are historical context; the implementation guides and architecture describe current behavior.
