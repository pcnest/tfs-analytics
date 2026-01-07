-- ============================================
-- Quick Reference: Testing & Validation Queries
-- for Top Blockers Enhancement
-- ============================================

-- ============================================
-- 1. VERIFY VIEW EXISTS
-- ============================================
SELECT 
  schemaname,
  viewname,
  viewowner
FROM pg_views
WHERE viewname = 'v_release_health';

-- Expected output: 1 row with schemaname='public'


-- ============================================
-- 2. TEST VIEW WITH SAMPLE DATA
-- ============================================
SELECT 
  project,
  release,
  "ConfidencePct",
  "Top Blockers",
  "Top Blocker IDs",
  "Decision Needed (Y/N)"
FROM v_release_health
ORDER BY project, release
LIMIT 10;

-- Expected: Multiple releases with formatted blockers


-- ============================================
-- 3. CHECK BLOCKER FORMAT
-- ============================================
SELECT 
  release,
  "Top Blockers"
FROM v_release_health
WHERE "Top Blockers" IS NOT NULL 
  AND "Top Blockers" != '-'
LIMIT 5;

-- Expected format: "Type ID - Title | Type ID - Title"
-- Example: "Bug 12345 - Database timeout | Task 67890 - API refactor"


-- ============================================
-- 4. VERIFY BLOCKER COUNT
-- ============================================
SELECT 
  release,
  "Top Blockers",
  array_length(string_to_array("Top Blocker IDs", '|'), 1) as blocker_count
FROM v_release_health
WHERE "Top Blocker IDs" IS NOT NULL
  AND "Top Blocker IDs" != ''
ORDER BY blocker_count DESC
LIMIT 10;

-- Expected: Most releases have 1-5 blockers


-- ============================================
-- 5. CHECK RAW BLOCKER DATA
-- ============================================
SELECT 
  release,
  COUNT(*) as total_blockers,
  COUNT(*) FILTER (WHERE severity = 'Critical') as critical_count,
  COUNT(*) FILTER (WHERE state = 'On Hold') as on_hold_count,
  COUNT(*) FILTER (WHERE open_dep_count > 0) as dependency_count
FROM tfs_workitems_analytics
WHERE is_deleted = FALSE
  AND state NOT IN ('Done', 'Removed')
  AND (
    severity = 'Critical'
    OR state = 'On Hold'
    OR open_dep_count > 0
  )
GROUP BY release
ORDER BY total_blockers DESC
LIMIT 10;

-- This shows if you have blocker data available


-- ============================================
-- 6. TEST SPECIFIC RELEASE
-- ============================================
-- Replace '18.4' with your actual release version
SELECT *
FROM v_release_health
WHERE release = '18.4';

-- Check all columns for this release


-- ============================================
-- 7. SAMPLE BLOCKER WORK ITEMS
-- ============================================
SELECT 
  release,
  work_item_id,
  type,
  title,
  severity,
  state,
  open_dep_count
FROM tfs_workitems_analytics
WHERE is_deleted = FALSE
  AND state NOT IN ('Done', 'Removed')
  AND (severity = 'Critical' OR state = 'On Hold' OR open_dep_count > 0)
ORDER BY 
  CASE WHEN severity = 'Critical' THEN 1 
       WHEN state = 'On Hold' THEN 2 
       WHEN open_dep_count > 0 THEN 3 
       ELSE 4 END,
  release,
  work_item_id
LIMIT 20;

-- Shows raw work items that should appear as blockers


-- ============================================
-- 8. CHECK FOR RELEASES WITHOUT BLOCKERS
-- ============================================
SELECT 
  release,
  "Critical",
  "High",
  "OnHold",
  "Top Blockers"
FROM v_release_health
WHERE "Top Blockers" = '-'
  OR "Top Blockers" IS NULL
ORDER BY release
LIMIT 10;

-- These releases have no blockers (healthy!)


-- ============================================
-- 9. VERIFY CONFIDENCE CALCULATION
-- ============================================
SELECT 
  release,
  "ConfidencePct",
  "Confidence Driver",
  "Critical",
  "High",
  "OnHold",
  "QA%"
FROM v_release_health
ORDER BY "ConfidencePct" ASC
LIMIT 10;

-- Shows releases with lowest confidence


-- ============================================
-- 10. FULL RELEASE HEALTH SNAPSHOT
-- ============================================
SELECT 
  project,
  release,
  "ConfidencePct" || '% (' || "Confidence Driver" || ')' as confidence,
  "Critical" || '/' || "High" || '/' || "Medium" || '/' || "Low" as priorities,
  "OnHold" as on_hold,
  "QA status (pass/total)" as qa_status,
  "Top Blockers",
  "Decision Needed (Y/N)" as decision
FROM v_release_health
WHERE release != '(no release)'
ORDER BY 
  CASE 
    WHEN "Decision Needed (Y/N)" = 'Y' THEN 1 
    ELSE 2 
  END,
  "ConfidencePct" ASC,
  project,
  release;

-- Executive summary view: Decision = Y first, then by confidence


-- ============================================
-- 11. PERFORMANCE TEST
-- ============================================
EXPLAIN ANALYZE
SELECT *
FROM v_release_health;

-- Check query performance
-- Look for "Execution Time" - should be < 500ms for typical dataset


-- ============================================
-- 12. DATA FRESHNESS CHECK
-- ============================================
SELECT 
  MAX(synced_at) as last_sync,
  COUNT(DISTINCT release) as release_count,
  COUNT(*) as total_items,
  COUNT(*) FILTER (WHERE is_deleted = FALSE) as active_items
FROM tfs_workitems_analytics;

-- Verify when data was last synced


-- ============================================
-- 13. BLOCKER DETAILS (for specific release)
-- ============================================
-- Replace '18.4' with your release
WITH blocker_items AS (
  SELECT
    work_item_id,
    type,
    title,
    severity,
    state,
    open_dep_count,
    ROW_NUMBER() OVER (
      ORDER BY 
        CASE WHEN severity = 'Critical' THEN 1 
             WHEN state = 'On Hold' THEN 2 
             WHEN open_dep_count > 0 THEN 3 
             ELSE 4 END,
        work_item_id
    ) as rank
  FROM tfs_workitems_analytics
  WHERE release = '18.4'
    AND is_deleted = FALSE
    AND state NOT IN ('Done', 'Removed')
    AND (severity = 'Critical' OR state = 'On Hold' OR open_dep_count > 0)
)
SELECT 
  rank,
  work_item_id,
  type || ' ' || work_item_id || ' - ' || title as formatted_blocker,
  severity,
  state,
  open_dep_count
FROM blocker_items
WHERE rank <= 5
ORDER BY rank;

-- Shows the exact blockers that will appear for this release


-- ============================================
-- 14. COMPARE RELEASES BY BLOCKER COUNT
-- ============================================
SELECT 
  release,
  "ConfidencePct",
  "Critical",
  "OnHold",
  array_length(string_to_array("Top Blocker IDs", '|'), 1) as blocker_count,
  "Decision Needed (Y/N)" as needs_decision
FROM v_release_health
WHERE release != '(no release)'
ORDER BY blocker_count DESC NULLS LAST
LIMIT 15;

-- Identify releases with most blockers


-- ============================================
-- 15. GRANT PERMISSIONS (if needed)
-- ============================================
-- Uncomment and modify role name as needed:
-- GRANT SELECT ON v_release_health TO your_read_role;
-- GRANT SELECT ON tfs_workitems_analytics TO your_read_role;
-- GRANT SELECT ON tfs_workitems_analytics_snapshots TO your_read_role;
-- GRANT SELECT ON tfs_sync_runs TO your_read_role;


-- ============================================
-- 16. DROP AND RECREATE (troubleshooting)
-- ============================================
-- Only use if you need to completely recreate the view:
-- DROP VIEW IF EXISTS v_release_health;
-- Then run create-v-release-health.sql


-- ============================================
-- EXPECTED RESULTS SUMMARY
-- ============================================
/*
Query 1: Should return 1 row (view exists)
Query 2: Should return 10 releases with formatted data
Query 3: Should show format like "Bug 12345 - Title"
Query 4: Should show blocker counts (typically 1-5)
Query 5: Should show non-zero counts if blockers exist
Query 6: Should return 1 row with all columns
Query 7: Should return up to 20 blocker work items
Query 8: Should show releases with no blockers
Query 9: Should show releases ordered by confidence
Query 10: Should provide executive summary view
Query 11: Should show execution time < 500ms
Query 12: Should show recent synced_at timestamp
Query 13: Should show top 5 blockers for specific release
Query 14: Should show releases ranked by blocker count
*/
