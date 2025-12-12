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
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tfs_analytics_project      ON tfs_workitems_analytics (project);
CREATE INDEX IF NOT EXISTS idx_tfs_analytics_release      ON tfs_workitems_analytics (release);
CREATE INDEX IF NOT EXISTS idx_tfs_analytics_assigned_upn ON tfs_workitems_analytics (assigned_to_upn);
CREATE INDEX IF NOT EXISTS idx_tfs_analytics_state        ON tfs_workitems_analytics (state);
CREATE INDEX IF NOT EXISTS idx_tfs_analytics_feature_id   ON tfs_workitems_analytics (feature_id);
CREATE INDEX IF NOT EXISTS idx_tfs_analytics_changed_date ON tfs_workitems_analytics (changed_date);
CREATE INDEX IF NOT EXISTS idx_tfs_analytics_synced_at    ON tfs_workitems_analytics (synced_at);
