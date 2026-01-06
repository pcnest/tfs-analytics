-- ============================================
-- TFS Work Items Analytics (Neon / Postgres)
-- Table: tfs_workitems_analytics
-- Safe to run multiple times.
-- ============================================

CREATE TABLE IF NOT EXISTS tfs_workitems_analytics (
  work_item_id        INTEGER PRIMARY KEY,

  type                TEXT NOT NULL,
  title               TEXT NOT NULL,
  state               TEXT NOT NULL,
  reason              TEXT,

  assigned_to         TEXT,
  assigned_to_upn     TEXT,

  project             TEXT,
  area_path           TEXT,
  iteration_path      TEXT,

  tags                TEXT,
  release             TEXT,

  created_by          TEXT,
  changed_by          TEXT,

  created_date        TIMESTAMPTZ,
  changed_date        TIMESTAMPTZ,
  state_change_date   TIMESTAMPTZ,
  closed_date         TIMESTAMPTZ,

  severity            TEXT,
  effort              DOUBLE PRECISION,

  parent_id           INTEGER,
  feature_id          INTEGER,
  feature             TEXT,

  dep_count           INTEGER NOT NULL DEFAULT 0,
  open_dep_count      INTEGER,  -- nullable: open counts computed only for active items
  related_link_count  INTEGER NOT NULL DEFAULT 0,
  open_related_count  INTEGER,  -- nullable: open counts computed only for active items

  source              TEXT,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted          BOOLEAN NOT NULL DEFAULT FALSE  -- FIX: Soft delete support
);

CREATE INDEX IF NOT EXISTS idx_tfs_analytics_project      ON tfs_workitems_analytics (project);
CREATE INDEX IF NOT EXISTS idx_tfs_analytics_release      ON tfs_workitems_analytics (release);
CREATE INDEX IF NOT EXISTS idx_tfs_analytics_assigned_upn ON tfs_workitems_analytics (assigned_to_upn);
CREATE INDEX IF NOT EXISTS idx_tfs_analytics_state        ON tfs_workitems_analytics (state);
CREATE INDEX IF NOT EXISTS idx_tfs_analytics_feature_id   ON tfs_workitems_analytics (feature_id);
CREATE INDEX IF NOT EXISTS idx_tfs_analytics_changed_date ON tfs_workitems_analytics (changed_date);
CREATE INDEX IF NOT EXISTS idx_tfs_analytics_synced_at    ON tfs_workitems_analytics (synced_at);
CREATE INDEX IF NOT EXISTS idx_tfs_analytics_is_deleted   ON tfs_workitems_analytics (is_deleted) WHERE is_deleted = FALSE;  -- FIX: Soft delete index

-- ============================================
-- Sync Runs Tracking
-- ============================================
CREATE TABLE IF NOT EXISTS tfs_sync_runs (
  run_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source            TEXT,
  item_count        INTEGER NOT NULL DEFAULT 0,
  metrics           JSONB,  -- FIX: Track inserted/updated/error counts
  last_changed_date TIMESTAMPTZ  -- FIX: Watermark for delta sync
);

CREATE INDEX IF NOT EXISTS idx_tfs_sync_runs_run_at ON tfs_sync_runs(run_at DESC);

-- ============================================
-- Snapshots for Burnup/Trends
-- ============================================
CREATE TABLE IF NOT EXISTS tfs_workitems_analytics_snapshots (
  run_id              UUID NOT NULL,
  snapshot_at         TIMESTAMPTZ NOT NULL,
  work_item_id        INTEGER NOT NULL,
  release             TEXT,
  type                TEXT,
  state               TEXT,
  severity            TEXT,
  effort              DOUBLE PRECISION,
  dep_count           INTEGER NOT NULL DEFAULT 0,
  open_dep_count      INTEGER,
  related_link_count  INTEGER NOT NULL DEFAULT 0,
  open_related_count  INTEGER,
  closed_date         TIMESTAMPTZ,
  
  CONSTRAINT tfs_workitems_analytics_snapshots_run_id_fkey 
    FOREIGN KEY (run_id) REFERENCES tfs_sync_runs(run_id) ON DELETE CASCADE,
  CONSTRAINT tfs_workitems_analytics_snapshots_pkey 
    PRIMARY KEY (run_id, work_item_id)
);

CREATE INDEX IF NOT EXISTS idx_snap_release_snapshot ON tfs_workitems_analytics_snapshots(release, snapshot_at);
CREATE UNIQUE INDEX IF NOT EXISTS tfs_workitems_analytics_snapshots_pkey ON tfs_workitems_analytics_snapshots(run_id, work_item_id);

-- ============================================
-- Sync Errors / Quarantine Table (P2)
-- ============================================
CREATE TABLE IF NOT EXISTS tfs_sync_errors (
  id            SERIAL PRIMARY KEY,
  run_id        UUID REFERENCES tfs_sync_runs(run_id) ON DELETE CASCADE,
  row_data      JSONB NOT NULL,
  error_message TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tfs_sync_errors_run_id ON tfs_sync_errors(run_id);
CREATE INDEX IF NOT EXISTS idx_tfs_sync_errors_created_at ON tfs_sync_errors(created_at DESC);
