# AGENTS

## Project overview
- Node/Express API in `server.js` serves the dashboard UI in `public/` and provides data/AI endpoints.
- PostgreSQL schema lives in `schema.sql`; migrations are in `migration-*.sql`.
- Data ingestion comes from `sync-tfs-lean.ps1` which POSTs to `/api/tfs-weekly-sync`.

## Key commands
- `npm install`
- `npm start`

## Environment variables
- `DATABASE_URL`: Postgres connection string (required).
- `SYNC_API_KEY`: shared secret for ingest endpoints (required).
- `OPENAI_API_KEY`: enables AI endpoints (optional).
- `TFS_WORKITEM_URL_TEMPLATE`: optional per-environment URL template for linking work items.
- `ENABLE_XLSX_REPORTS=true`: enables the authenticated Agent7 XLSX pilot endpoint; disabled by default.
- `ENABLE_WEEKLY_REPORT_PREVIEW=true`: enables the authenticated read-only v2 placement-preview endpoint; disabled by default. Apply `migration-add-weekly-report-placement-overrides.sql` before enabling it.
- `ENABLE_WEEKLY_REPORT_V2_XLSX=true`: enables the authenticated validation-gated v2 XLSX endpoint; disabled by default and uses the same migration and v2 definition as placement preview.
- `PGSSLMODE=disable`: for local Postgres without SSL, if needed.

## Data ingest notes
- `sync-tfs-lean.ps1` expects `TFS_PAT`, `SYNC_API_KEY`, and `INGEST_URL` in the shell environment.
- The ingest endpoint expects normalized fields; see `buildUpsert`/`buildSnapshotInsert` in `server.js`.

## Conventions and guardrails
- When adding queries for active items, include `is_deleted = FALSE` to avoid soft-deleted data.
- Keep SQL parameterized; avoid string interpolation for query values.
- The v2 weekly-report definition is `config/weekly-report-definition.v2.json`; placement exceptions are stored in `weekly_report_placement_overrides`.
- Frontend updates belong in `public/app.js` and `public/index.html`.

## Tests
- `npm test`
- Tests use Node's built-in test runner and should remain lightweight.
