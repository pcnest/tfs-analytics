-- Create table for lean TFS work items + dependency/related metrics.
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS tfs_workitems_lean (
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
  open_dep_count      INTEGER, -- nullable because we compute open counts only for active items
  related_link_count  INTEGER NOT NULL DEFAULT 0,
  open_related_count  INTEGER, -- nullable because we compute open counts only for active items

  source              TEXT,
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tfs_lean_project       ON tfs_workitems_lean (project);
CREATE INDEX IF NOT EXISTS idx_tfs_lean_release       ON tfs_workitems_lean (release);
CREATE INDEX IF NOT EXISTS idx_tfs_lean_assigned_upn  ON tfs_workitems_lean (assigned_to_upn);
CREATE INDEX IF NOT EXISTS idx_tfs_lean_state         ON tfs_workitems_lean (state);
CREATE INDEX IF NOT EXISTS idx_tfs_lean_feature_id    ON tfs_workitems_lean (feature_id);
CREATE INDEX IF NOT EXISTS idx_tfs_lean_changed_date  ON tfs_workitems_lean (changed_date);
CREATE INDEX IF NOT EXISTS idx_tfs_lean_synced_at     ON tfs_workitems_lean (synced_at);
