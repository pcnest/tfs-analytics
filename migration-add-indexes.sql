-- ============================================
-- Performance Migration: Add Composite Indexes
-- Run this in Neon to improve query performance
-- Safe to run multiple times (IF NOT EXISTS)
-- ============================================

-- Composite index for release + state queries (used heavily in API endpoints)
CREATE INDEX IF NOT EXISTS idx_tfs_release_state 
ON tfs_workitems_analytics(release, state);

-- Composite index for release + lower(state) queries
CREATE INDEX IF NOT EXISTS idx_tfs_release_state_lower 
ON tfs_workitems_analytics(release, lower(state));

-- Additional index for work_item_id lookups in snapshots (improve join performance)
CREATE INDEX IF NOT EXISTS idx_snapshots_work_item_snapshot 
ON tfs_workitems_analytics_snapshots(work_item_id, snapshot_at DESC);

-- Verify indexes created
SELECT 
  schemaname,
  tablename,
  indexname
FROM pg_indexes
WHERE schemaname = 'public' 
  AND tablename IN ('tfs_workitems_analytics', 'tfs_workitems_analytics_snapshots')
ORDER BY tablename, indexname;
