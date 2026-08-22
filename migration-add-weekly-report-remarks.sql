-- =====================================================================
-- Migration: Add derived TFS Discussion remarks to analytics work items
-- Safe to run multiple times. Apply before deploying remark-aware code.
-- =====================================================================

ALTER TABLE tfs_workitems_analytics
  ADD COLUMN IF NOT EXISTS weekly_report_remark TEXT,
  ADD COLUMN IF NOT EXISTS weekly_report_remark_revision INTEGER,
  ADD COLUMN IF NOT EXISTS weekly_report_remark_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS weekly_report_remark_changed_by TEXT;

COMMENT ON COLUMN tfs_workitems_analytics.weekly_report_remark IS
  'Latest plain-text TFS Discussion body marked for the weekly report; null when absent or explicitly cleared.';
COMMENT ON COLUMN tfs_workitems_analytics.weekly_report_remark_revision IS
  'TFS work item revision containing the latest weekly-report directive.';
COMMENT ON COLUMN tfs_workitems_analytics.weekly_report_remark_changed_at IS
  'TFS revised timestamp for the latest weekly-report directive.';
COMMENT ON COLUMN tfs_workitems_analytics.weekly_report_remark_changed_by IS
  'TFS identity display value for the latest weekly-report directive.';
