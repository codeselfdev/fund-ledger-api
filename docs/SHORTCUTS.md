# Personal mobile shortcuts

The mobile home design has separate creation actions, up to eight personal pins, and a grouped searchable tool catalogue. The API owns role/project availability and stores ordered pins per authenticated user, tenant and project.

## Rollout

Generate Prisma, apply `20261015110000_shortcut_preferences` with the normal deployment migration process, and build/start the API. The migration is additive and never rewrites project portal settings. It creates `shortcut_preferences` with user/project foreign keys, a scoped unique key, a revision and database checks for the eight-pin capacity and positive stored revisions. No production migration is performed by the implementation task.

## Endpoints

Send bearer auth and `X-Project-Id`. The normal authentication, subscription and active-project membership middleware runs before this router.

`GET /v1/shortcuts` returns:

```json
{
  "groups": [{ "key": "money", "label": "Money", "color": "#0F7A6C", "soft": "#E4F4EF" }],
  "tools": [{ "key": "assets", "group": "money", "label": "Fixed assets", "description": "Equipment & depreciation", "icon": "...", "keywords": "equipment depreciation" }],
  "quick_add": [{ "key": "add_member", "label": "Member", "group": "people", "icon": "..." }],
  "pinned": ["members", "income", "expenses", "schedules", "notices", "reports", "accounts", "assets"],
  "defaults": ["members", "income", "expenses", "schedules", "notices", "reports", "accounts", "assets"],
  "version": 0,
  "max_pins": 8
}
```

The example is abbreviated; actual tools depend on roles and project type. Catalogue metadata never grants feature API permissions. Quick add keys cannot be pinned.

`PUT /v1/shortcuts/preferences` accepts exactly `{ "pinned": ["assets", "income"], "version": 0 }`. Arrays may be empty. Order is preserved. More than eight entries, duplicates, unknown keys, unavailable roles/project tools, extra fields and invalid revisions return 400. Tenant/user/project identity comes only from authenticated context.

`POST /v1/shortcuts/reset` accepts exactly `{ "version": 1 }` and restores current defaults. Both mutations return `{ pinned, version }` in the existing success envelope.

## Defaults, concurrency and scope

A missing row has revision zero. Initial defaults depend on project type and current roles. Existing configured accountant/member lists seed users with no personal row, including intentionally empty lists. Legacy `fixed_assets` maps to `assets`, and accounting `commerce` maps to `inventory`. Saved layouts take precedence over future changes to project defaults.

Reads remove unknown or no-longer-authorized keys. Writes reject them. A role change does not expose previously pinned administrative tools. Preferences belonging to another tenant, user or project are never read or written. Deleting a user/project cascades its personal layout.

Mutations run in serializable transactions. First save creates revision one; later saves increment it. A stale revision returns 409 without overwriting the current layout. An identical request retried against exactly the next revision returns the saved result, allowing safe recovery from a lost response. The client reloads after a conflict and requires another deliberate save.

## Catalogue

`src/modules/shortcuts/catalog.json` mirrors the mobile catalogue. Update its source in `FundLedgerMobile/src/domain/shortcutCatalog.json`, then run `node scripts/sync-shortcut-catalog.cjs` in that repository. Keep keys stable. The mobile client filters out tools without navigation callbacks and uses the bundled catalogue only as a read-only fallback while preferences are unavailable.

## Validation

`npm run build && node --test tests/shortcuts.routes.test.mjs tests/migration-integrity.test.mjs` tests defaults, ordering, empty pins, resets, duplicate/unknown/capacity validation, extra fields, cross-user/project/tenant boundaries, role changes, project-specific tools, legacy defaults, identical retries and competing stale-device writes. It uses an isolated transactional adapter for real router/auth code and never connects to production data.
