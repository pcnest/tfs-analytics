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
- `PGSSLMODE=disable`: for local Postgres without SSL, if needed.

## Data ingest notes
- `sync-tfs-lean.ps1` expects `TFS_PAT`, `SYNC_API_KEY`, and `INGEST_URL` in the shell environment.
- The ingest endpoint expects normalized fields; see `buildUpsert`/`buildSnapshotInsert` in `server.js`.

## Conventions and guardrails
- When adding queries for active items, include `is_deleted = FALSE` to avoid soft-deleted data.
- Keep SQL parameterized; avoid string interpolation for query values.
- Frontend updates belong in `public/app.js` and `public/index.html`.

## Tests
- No automated tests are configured. If you add any, keep them lightweight and update this file.
