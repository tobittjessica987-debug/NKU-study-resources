# Runtime data and stable identifiers

## Course identity

Every course in `manifest.json` has two identifiers:

- `uid`: immutable UUID used as the current public API course `id` and canonical favorite identifier;
- `id`: existing human-readable website route key, retained for backward compatibility.

Changing a course title or website `id` must never change its `uid`. Current `mp_favorites.course_id` rows store the canonical UID and resolve current course data from the manifest. The favorites service accepts legacy manifest `id` inputs and normalizes them to UID; new callers must use UID. Review JSON still records `courseTitle` and may have unmatched historical titles, so do not assume every review has a course-UID foreign key.

For an in-place development-only UID backfill, the narrow command remains available:

```powershell
$env:DATA_DIR = "C:\authorized\runtime-data"
npm run migrate:course-uids
npm run migrate:course-uids -- --write --expected-sha256=<dry-run-sha256>
```

The first command is a dry run and prints the manifest hash. Stop the server and freeze administration before write mode. `--write` requires that hash, acquires an exclusive lock, validates existing values, creates a same-directory timestamped backup, assigns UUIDs only where missing, validates uniqueness, rechecks the hash, and atomically replaces the manifest. Re-running it is idempotent.

## One-time production data cutover

Do not keep compatibility branches for missing UIDs, Windows paths, backslashes, or non-canonical R2 paths. Correct the current data set once, review the report, and then enforce the schema.

With the service stopped and website administration frozen, plan a move from the old release-owned data directory into the persistent directory:

```bash
npm run migrate:runtime-data -- \
  --source-dir=/opt/nkustudy/src/data \
  --target-dir=/var/lib/nkustudy/json
```

The JSON report includes:

- course/review/resource counts before and after;
- every generated deterministic course UID;
- every normalized `basePath` and file path;
- preserves `repository`, global `hiddenMetaTags`, and per-course `hiddenMetaTags` because the website still uses them, while removing only the confirmed-unused per-course `source` field;
- every review whose `courseTitle` does not exactly match a current course;
- record deletion counts and schema problems requiring manual edits;
- hashes for every source file and the complete plan.

Every path change is treated as possible logical data loss: JSON records can
remain while their R2 objects become unreachable. Write mode therefore
requires both `--confirm-path-changes=<exact-count>` and a server-generated JSON
object inventory passed as `--r2-inventory=<path>`. Every normalized exact
`resources/<basePath>/<file.path>` key affected by a path change must exist in
that inventory. Missing keys cannot be overridden; correct the source JSON or
R2 layout and create a fresh plan.

Plan mode never writes. Before apply, review and retain the report. Any nonzero deletion or unmatched-review count requires an exact explicit confirmation; schema errors and duplicate normalized course titles cannot be overridden and must be fixed in source data. This is where a potentially large loss or remapping is reported before anything changes.

```bash
npm run migrate:runtime-data -- --write \
  --source-dir=/opt/nkustudy/src/data \
  --target-dir=/var/lib/nkustudy/json \
  --backup-dir=/root/nkustudy-backups/runtime-data-before-cutover-YYYYMMDD \
  --expected-plan-sha256=<planSha256> \
  --confirm-unmatched=<reviewed-count> \
  --confirm-deletions=<reviewed-count> \
  --confirm-path-changes=<reviewed-count> \
  --r2-inventory=/root/nkustudy-backups/r2-inventory-YYYYMMDD.json
```

Write mode takes an exclusive lock, rechecks every source hash, creates a private full JSON backup, stages mode-0600 files under a mode-0700 directory with the production sentinel, verifies record counts, and renames the new directory into place. It refuses to merge with or overwrite an existing target. After cutover, `uid` and canonical paths are required; fix invalid source data rather than adding fallback parsing.

## Runtime files

`DATA_DIR` defaults to `src/data` only for compatibility with an authorized local checkout. Production uses `DATA_DIR=/var/lib/nkustudy/json`. Core content (`manifest`, `about`, `home`, `participate`, `links`, and `footer`) fails closed when absent. Only explicitly allowlisted mutable state (`reviews`, `feedback`, `visit-stats`, `editor-settings`, and `backup-settings`) may be initialized by the server.

The current learning-compass public API reads the versioned `server/data/learning-compass-snapshot.json` through `server/learning-compass-service.mjs`, not optional runtime `guides.json`. The snapshot has `version/content_updated_at/categories/guides/sources`; the public service projects summaries, sections, sources and variants, excluding private retrieval/conflict fields. Use its category facets and the [API contracts](API.md#公共小程序-apiapiv1), not the retired four-category runtime schema. A legacy `guides.json` may still be copied by the old cutover utility; that does not make it the active API source. No guide management route is exposed under `/api/v1`.

Optional course search metadata is stored directly on each manifest course as `shortName: string` and `aliases: string[]`. The website course editor preserves and edits both fields. Empty values are explicit and no compatibility parser derives aliases from a title.

JSON mutations use a per-file queue and same-directory atomic replacement. Updaters re-read inside that queue, preventing concurrent review, feedback, and visit writes from overwriting each other.

## Persistent state and privacy

In local development, `STATE_DB_PATH` defaults to `${DATA_DIR}/miniprogram.sqlite`. Production explicitly sets a private database and secret outside the release tree, for example `STATE_DB_PATH=/var/lib/nkustudy/miniprogram.sqlite` and `ADMIN_SECRET_FILE=/var/lib/nkustudy/admin-secret`. SQLite is excluded from Git and contains account, session, favorite, avatar, payment, rate-limit, audit and deletion-progress tables, not just rate counters.

| Location | Actual data and access boundary |
| --- | --- |
| `mp_users` | Internal ID, OpenID, nickname, avatar URL, optional email, phone and verification time, web-password hash, registration/login metadata and blocked/deleted state. `accountUserDto` returns only `id/nickname/avatar_url/email/has_web_password/phone_verified/created_at/last_login_at`; the admin user list masks OpenID, while controlled account queries/exports can include raw OpenID and phone. |
| User/admin sessions and scan tickets | User token hashes and account/time association; admin HMAC token hashes and username/time association; scan tickets are temporary in-memory state. User Bearer/web sessions default to 30-day absolute validity, scan tickets to 5 minutes. The actual admin server defaults both absolute and idle expiry to 7 days; its environment overrides differ from the session class's standalone 8h/30min defaults. |
| `mp_favorites`, `avatars`, R2 avatar objects | User/course UID and favorite creation time; avatar ownership, moderation/upload/cleanup state and a public object URL. Public avatar links and object/cache lifecycle are distinct from the private ownership registry. |
| `reviews.json`, `feedback.json` | Text, score/tags, original state, publication and handling decisions, replies and restricted server provenance; logged-in submissions also carry `user_id` and may carry contact/IP hash/UA. Public DTOs exclude direct account/contact/network fields, but text may itself identify a person. Anonymous complaints have no account credential for reading replies. |
| Payment orders and `donate.json` | Orders contain payment/transaction facts and optional account, nickname/remark; current public donation records use an exact internal order key for cleanup, excluded from public DTOs. Older records without that key cannot be assigned by guessing a nickname. |
| `rate_limits` and `visit-stats.json` | Rate-limit actors use HMAC hashes; this does not mean all stored data is anonymous. Recent visit rows retain raw `ip`, `actorHash/userAgentHash/lastSeen`, cleaned on later writes after 24 hours and capped at 5000. Day statistics retain at most 400 date keys per dimension. Legacy visit IPs are supplemented with a hash, not stripped. |
| Security/admin/law logs, queues and archives | Restricted records include account/actor, time, action/target/result and network metadata; user and admin logs retain raw IP/UA. Law queries can associate retained evidence even after business identity cleanup. Current log maintenance uses the existing 400-day engineering configuration; this is not a universal statutory period. |
| Runtime backups and deletion ledger | Encrypted complete snapshots include SQLite (committed WAL), runtime JSON, queues, local archives and necessary secret/config files; external resource/avatar bytes are excluded. S5 snapshots carry a deletion-ledger head, never the independent authoritative ledger. Historical snapshots can still contain old identities. |

New course reviews use enabled rules: `moderationRequired=true` or an enabled keyword/contact match leaves them pending; otherwise they can be automatically public with recorded rule provenance. New ordinary feedback is pending until an explicit administrator publication decision. Private complaints never become public. S3 preserves verified legacy public content and existing public replies without inventing historical human approval; later hiding/revocation still applies.

S5's confirmed policy retains content and its original visibility while removing business identity/contacts, the subject's reactions, account credentials and favorites; payment facts remain with business identity cleared. The account row retains an internal tombstone and placeholder nickname, rather than being physically absent. Restricted logs and minimal deletion ledger/jobs remain linkable; text self-disclosures are not automatically removed. Avatar source deletion, uncertain uploads, old CDN caches and unregistered historical objects have separate completion limits. See [S5 policy](compliance/S5_POLICY.md) for classification and exceptions.

`DELETION_LEDGER_DIR` is a separate private authority outside `DATA_DIR` and any restore destination. It records event/account instance, request time, policy/mode and hash-chain sequence, without original nickname, phone or credentials; jobs additionally preserve progress and necessary processing keys. Existing encrypted backups are not rewritten. Restore stays quarantined, invalidates old sessions, and requires replay/verification against the independently retained latest ledger; a valid hash chain or backup watermark alone cannot establish external freshness. See [S5 operations](compliance/S5_OPERATIONS.md).

Data-class retention, authority-ledger retention, private remote backup expiry and real operator arrangements still require recorded operational decisions; do not replace them with one invented period. S3/S4/S5 candidate behavior and local evidence do not establish production deployment, cache removal or a completed production restore.

The server trusts `X-Forwarded-For` only when the direct peer matches an explicit production `TRUSTED_PROXIES` address or CIDR. For loopback Caddy use `127.0.0.1/32,::1/128`. Invalid and overlong forwarding chains fail closed.
