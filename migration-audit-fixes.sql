-- ============================================
-- Migration: Apply Audit Fixes
-- Run this in Neon SQL Editor to apply all schema changes
-- Safe to run multiple times (idempotent)
-- ============================================

-- FIX P0: Add soft delete support
ALTER TABLE tfs_workitems_analytics 
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_tfs_analytics_is_deleted 
  ON tfs_workitems_analytics (is_deleted) 
  WHERE is_deleted = FALSE;

-- FIX P2: Add metrics and watermark to sync runs
ALTER TABLE tfs_sync_runs 
  ADD COLUMN IF NOT EXISTS metrics JSONB;

ALTER TABLE tfs_sync_runs 
  ADD COLUMN IF NOT EXISTS last_changed_date TIMESTAMPTZ;

-- FIX P2: Create quarantine table for invalid rows
CREATE TABLE IF NOT EXISTS tfs_sync_errors (
  id            SERIAL PRIMARY KEY,
  run_id        UUID REFERENCES tfs_sync_runs(run_id) ON DELETE CASCADE,
  row_data      JSONB NOT NULL,
  error_message TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tfs_sync_errors_run_id 
  ON tfs_sync_errors(run_id);

CREATE INDEX IF NOT EXISTS idx_tfs_sync_errors_created_at 
  ON tfs_sync_errors(created_at DESC);

-- Done!
SELECT 'Migration completed successfully!' AS status;

-- Verify changes
SELECT 
  'tfs_workitems_analytics has is_deleted column' AS check,
  EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'tfs_workitems_analytics' 
    AND column_name = 'is_deleted'
  ) AS result
UNION ALL
SELECT 
  'tfs_sync_runs has metrics column' AS check,
  EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'tfs_sync_runs' 
    AND column_name = 'metrics'
  ) AS result
UNION ALL
SELECT 
  'tfs_sync_errors table exists' AS check,
  EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'tfs_sync_errors'
  ) AS result;
