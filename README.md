# TFS Analytics Dashboard (Starter)

This project:
- Receives lean work item rows from a PowerShell sync script
- Upserts into Neon Postgres
- Serves a simple dashboard + CSV export

## Files
- `schema.sql`  -> run in Neon once
- `server.js`   -> Render API + dashboard
- `public/`     -> dashboard UI
- `sync-tfs-lean.ps1` -> run on your Windows machine (VPN) to fetch from TFS and post to Render

## Environment Variables (Render)
- `DATABASE_URL`   = your existing Neon connection string
- `SYNC_API_KEY`   = random secret string

## Environment Variables (Windows machine)
- `TFS_PAT`      = your TFS PAT
- `SYNC_API_KEY` = must match Render
- `INGEST_URL`   = https://<your-render-app>.onrender.com/api/tfs-weekly-sync

