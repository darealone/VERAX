# VERAX MERIDIAN — launch readiness gate

**Check first. Then launch.** VERAX MERIDIAN is a small self-hosted tool that tells a team whether a campaign, form, or process handover can go live: **GO**, **BLOCKED**, or **NEEDS REVIEW**. The answer comes from deterministic checks, a named human approval, and an audit trail. It is not a forecast.

[Deutsche Version](README.de.md) · [Product page & interactive simulation](https://darealone.github.io/aether-hive/verax/) · Part of [Aether Hive](https://darealone.github.io/aether-hive/)

- **Zero dependencies.** Node.js 22.13+ and its built-in SQLite. No `npm install`, no native modules.
- **Self-hosted.** Your data stays on your server. There are no telemetry calls and no external services.
- **Deterministic rules.** The same inputs with the same rules version always give the same status. The rules are in [`src/rules.js`](src/rules.js) and are short enough to read in a few minutes.
- **Bilingual UI.** English and German, switchable per user.
- **Personalisable.** Name, colour, language, rule settings and check templates are set in one JSON file.

## Quick start

```bash
git clone https://github.com/darealone/VERAX.git && cd VERAX
node bin/verax.js serve --demo
```

Open http://127.0.0.1:8080. The demo creates three users (password `demo-password-123`) and a sample launch. Its fake CRM drops a required field, so the launch starts **BLOCKED**. Click "Toggle demo CRM mapping" and then "Run all automated checks" to watch it change to **NEEDS REVIEW**. Log in as `sam@example.test` (approver) to approve it and get **GO**.

### Real installation

```bash
node bin/verax.js init                      # writes verax.config.json
node bin/verax.js serve --config verax.config.json --host 0.0.0.0 --port 8080
```

The first visit asks you to create the admin account. Afterwards, add your team under **Settings → Team**.

### Docker

```bash
cp examples/verax.config.example.json verax.config.json   # edit it
docker compose up -d
```

Data is stored in the `verax-data` volume as one SQLite file. To back up, copy `/data/verax.db` while the container is stopped, or use `sqlite3 .backup`.

Put VERAX MERIDIAN behind HTTPS (for example with Caddy or nginx) and set `VERAX_SECURE_COOKIES=1`.

## How the decision works

| Priority | Rule | Result |
|---|---|---|
| 1 | A critical check failed, could not be verified, was never run, or its result is older than `maxCheckAgeHours` | **BLOCKED** |
| 1 | The launch has no critical checks at all | **BLOCKED** |
| 2 | The latest decision for this exact launch version is a rejection | **BLOCKED** |
| 3 | A non-critical check is not passing and has no documented, unexpired exception | **NEEDS REVIEW** |
| 4 | There is no valid approval: it is missing, stale, expired, or given by the owner when the four-eyes rule is on | **NEEDS REVIEW** |
| — | Otherwise | **GO** |

Some details:

- **Reviews cannot override blockers.** Approvers cannot approve a blocked launch, and critical checks cannot be waived.
- **Approvals are bound to a fingerprint.** The fingerprint is calculated from the launch scope and every check definition. If anyone edits a check or the scope after approval, the approval becomes stale. Re-running checks does not change the fingerprint.
- **NEEDS REVIEW is never a silent GO.** You can assign a review to a named person with a concrete question and a deadline. An overdue review is flagged; it does not approve anything.
- **The audit log is append-only and hash-chained.** Run `verax verify-audit` to detect edits or deletions.

## Check types

| Type | What it proves | Example |
|---|---|---|
| `http` | A page is reachable, lands on the right URL and contains the expected text | CTA → landing page |
| `json` | An API returns the expected values | The routing preview returns `queue = inbound-sales` |
| `roundtrip` | A synthetic test record goes in at one end and arrives with all expected fields at the other | Form submit → CRM record |
| `manual` | A named person confirms the result with written evidence | Tracking checked in the analytics debug view |

Configuration notes:

- `{{testId}}` is replaced with a unique id on every run, so test records can be found and cleaned up.
- `${ENV:NAME}` reads a secret from the server environment when the check runs. Secrets are never stored in the database.
- Any error, timeout or unexpected response gives the result `unknown`, never `pass`.
- Paths in `expect` support nesting, for example `results[0].email`. The value `"*"` means "any non-empty value".

See [`examples/verax.config.example.json`](examples/verax.config.example.json) for complete templates. One of them uses manual checks only, for teams that start without API access.

## CI / pipeline gate

Create a token under **Settings → API tokens**, then:

```bash
VERAX_URL=https://verax.example.com VERAX_TOKEN=vxm_xxx node bin/verax.js run 12
# exit 0 = GO, 1 = BLOCKED, 2 = NEEDS_REVIEW, 3 = error
```

## Configuration (`verax.config.json`)

| Key | Default | Meaning |
|---|---|---|
| `org.name`, `org.productName`, `org.logoText`, `org.accent` | `Your team`, `VERAX MERIDIAN`, initials, `#b9fa65` | Branding |
| `language` | `en` | Default UI language (`en` or `de`). Each user can switch. |
| `rules.maxCheckAgeHours` | `24` | Check results older than this count as not verified |
| `rules.approvalValidDays` | `14` | Approvals expire after this many days |
| `rules.fourEyes` | `true` | The launch owner cannot approve their own launch |
| `rules.reviewDefaultDays` | `3` | Default deadline for new reviews |
| `scheduler.recheckMinutes` | `0` (off) | Re-run automated checks of all active launches on an interval |
| `templates[]` | — | Reusable check sets offered when someone creates a launch |

## Roles

| Role | Can |
|---|---|
| Member | Create launches, define and run checks, confirm manual checks, assign reviews |
| Approver | Everything a member can do, plus approve or reject launches and accept non-critical gaps |
| Admin | Everything an approver can do, plus manage users |

## Security notes

- Passwords are hashed with scrypt. Sessions use HttpOnly, SameSite=Strict cookies, and API calls must send JSON, which protects against CSRF. Logins are rate-limited.
- The Content-Security-Policy allows only the app's own scripts. All user text is rendered as text, never as HTML.
- Free text from notes, evidence or API responses is stored and shown as data. It never changes rules or permissions.
- Checks can call any http(s) URL that you configure. Only let trusted team members define checks, and run VERAX MERIDIAN in a network segment that suits this.

## Development

```bash
npm test            # node:test, no dependencies
npm run dev         # demo mode
```

Project layout: `src/rules.js` (decision rules), `src/checks/` (check runners), `src/service.js` (permissions, approvals, audit), `src/server.js` (HTTP API), `public/` (web UI), `bin/verax.js` (CLI).

## Status

Version 0.1, an early release. Planned next: an optional read-only AI investigator that explains findings but cannot change any state, notifications (email/Slack webhooks), ready-made adapters for common CRMs, and SSO.

## License

Apache-2.0. See [LICENSE](LICENSE) and [docs/PROVENANCE.md](docs/PROVENANCE.md).
