-- ============================================
-- Migration: Add Release Health History Tracking
-- Enables confidence trend analysis (↗↘→)
-- ============================================

-- ============================================
-- Step 1: Create release_health_snapshots table
-- ============================================
CREATE TABLE IF NOT EXISTS release_health_snapshots (
  snapshot_id       SERIAL PRIMARY KEY,
  run_id            UUID NOT NULL REFERENCES tfs_sync_runs(run_id) ON DELETE CASCADE,
  snapshot_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  project           TEXT NOT NULL,
  release           TEXT NOT NULL,
  
  -- Confidence metrics
  confidence_pct    INTEGER,
  confidence_driver TEXT,
  confidence_signals TEXT,
  
  -- Bug counts
  critical          INTEGER DEFAULT 0,
  high              INTEGER DEFAULT 0,
  medium            INTEGER DEFAULT 0,
  low               INTEGER DEFAULT 0,
  on_hold           INTEGER DEFAULT 0,
  
  -- QA metrics
  qa_pass           INTEGER DEFAULT 0,
  qa_total          INTEGER DEFAULT 0,
  qa_pct            INTEGER,
  
  -- Top blockers (for reference)
  top_blockers      TEXT,
  top_blocker_ids   TEXT,
  
  -- Decision flag
  decision_needed   TEXT,
  
  UNIQUE(run_id, project, release)
);

-- ============================================
-- Step 2: Create indexes for efficient querying
-- ============================================
CREATE INDEX IF NOT EXISTS idx_release_health_snapshots_lookup 
  ON release_health_snapshots(project, release, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_release_health_snapshots_run 
  ON release_health_snapshots(run_id);

CREATE INDEX IF NOT EXISTS idx_release_health_snapshots_time 
  ON release_health_snapshots(snapshot_at DESC);

-- ============================================
-- Step 3: Create helper view for latest snapshots
-- ============================================
CREATE OR REPLACE VIEW v_release_health_latest AS
SELECT DISTINCT ON (project, release)
  snapshot_id,
  run_id,
  snapshot_at,
  project,
  release,
  confidence_pct,
  confidence_driver,
  confidence_signals,
  critical,
  high,
  medium,
  low,
  on_hold,
  qa_pass,
  qa_total,
  qa_pct,
  top_blockers,
  top_blocker_ids,
  decision_needed
FROM release_health_snapshots
ORDER BY project, release, snapshot_at DESC;

-- ============================================
-- Step 4: Create view for confidence trends
-- ============================================
CREATE OR REPLACE VIEW v_release_health_trends AS
WITH ranked_snapshots AS (
  SELECT 
    *,
    ROW_NUMBER() OVER (PARTITION BY project, release ORDER BY snapshot_at DESC) as rn,
    LAG(confidence_pct) OVER (PARTITION BY project, release ORDER BY snapshot_at) as prev_confidence_pct,
    LAG(snapshot_at) OVER (PARTITION BY project, release ORDER BY snapshot_at) as prev_snapshot_at
  FROM release_health_snapshots
),
latest AS (
  SELECT * FROM ranked_snapshots WHERE rn = 1
)
SELECT
  latest.project,
  latest.release,
  latest.snapshot_at as current_snapshot_at,
  latest.confidence_pct as current_confidence,
  latest.prev_confidence_pct as previous_confidence,
  latest.prev_snapshot_at,
  
  -- Calculate change
  (latest.confidence_pct - COALESCE(latest.prev_confidence_pct, latest.confidence_pct)) as confidence_change,
  
  -- Trend indicator
  CASE 
    WHEN latest.prev_confidence_pct IS NULL THEN 'new'
    WHEN latest.confidence_pct > latest.prev_confidence_pct + 5 THEN 'improving'
    WHEN latest.confidence_pct < latest.prev_confidence_pct - 5 THEN 'declining'
    ELSE 'stable'
  END as trend,
  
  -- Trend symbol
  CASE 
    WHEN latest.prev_confidence_pct IS NULL THEN '●'
    WHEN latest.confidence_pct > latest.prev_confidence_pct + 5 THEN '↗'
    WHEN latest.confidence_pct < latest.prev_confidence_pct - 5 THEN '↘'
    ELSE '→'
  END as trend_symbol,
  
  latest.confidence_driver,
  latest.critical,
  latest.high,
  latest.on_hold,
  latest.qa_pct,
  latest.decision_needed
FROM latest;

-- ============================================
-- Step 5: Create function to capture snapshot
-- ============================================
CREATE OR REPLACE FUNCTION capture_release_health_snapshot(p_run_id UUID)
RETURNS INTEGER AS $$
DECLARE
  rows_inserted INTEGER;
BEGIN
  -- Insert snapshot from current v_release_health view
  INSERT INTO release_health_snapshots (
    run_id,
    snapshot_at,
    project,
    release,
    confidence_pct,
    confidence_driver,
    confidence_signals,
    critical,
    high,
    medium,
    low,
    on_hold,
    qa_pass,
    qa_total,
    qa_pct,
    top_blockers,
    top_blocker_ids,
    decision_needed
  )
  SELECT
    p_run_id,
    NOW(),
    project,
    release,
    "ConfidencePct",
    "Confidence Driver",
    "Confidence Signals",
    "Critical",
    "High",
    "Medium",
    "Low",
    "OnHold",
    "QAPass",
    "QATotal",
    "QA%",
    "Top Blockers",
    "Top Blocker IDs",
    "Decision Needed (Y/N)"
  FROM v_release_health
  WHERE release IS NOT NULL AND release != '(no release)';
  
  GET DIAGNOSTICS rows_inserted = ROW_COUNT;
  RETURN rows_inserted;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- Step 6: Verify installation
-- ============================================
SELECT 
  'release_health_snapshots table created' as status,
  EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_name = 'release_health_snapshots'
  ) as table_exists
UNION ALL
SELECT 
  'v_release_health_trends view created' as status,
  EXISTS (
    SELECT 1 FROM information_schema.views 
    WHERE table_name = 'v_release_health_trends'
  ) as view_exists
UNION ALL
SELECT 
  'capture_release_health_snapshot function created' as status,
  EXISTS (
    SELECT 1 FROM information_schema.routines 
    WHERE routine_name = 'capture_release_health_snapshot'
  ) as function_exists;

-- ============================================
-- Step 7: Backfill historical data (optional)
-- ============================================
-- If you want to create a baseline snapshot from current data:
-- 
-- DO $$
-- DECLARE
--   v_run_id UUID;
-- BEGIN
--   -- Create a special sync run for initial snapshot
--   INSERT INTO tfs_sync_runs (run_at, source, item_count)
--   VALUES (NOW(), 'initial_health_snapshot', 0)
--   RETURNING run_id INTO v_run_id;
--   
--   -- Capture snapshot
--   PERFORM capture_release_health_snapshot(v_run_id);
--   
--   RAISE NOTICE 'Initial snapshot created with run_id: %', v_run_id;
-- END $$;

-- ============================================
-- Usage Instructions
-- ============================================
/*

After running this migration:

1. MANUAL: Update your sync process to call capture_release_health_snapshot()
   after each successful sync. Example:

   // In your sync script (PowerShell/JavaScript):
   await pool.query('SELECT capture_release_health_snapshot($1)', [runId]);

2. AUTOMATIC: Or update server.js POST /api/ingest endpoint to auto-capture

3. Query trends:
   SELECT * FROM v_release_health_trends 
   WHERE release = '18.4';

4. API endpoint (to be created):
   GET /api/release-health-trends?release=18.4

Example queries:

-- Get all releases with declining confidence
SELECT project, release, current_confidence, confidence_change, trend_symbol
FROM v_release_health_trends
WHERE trend = 'declining'
ORDER BY confidence_change ASC;

-- Get confidence history for specific release
SELECT snapshot_at, confidence_pct, confidence_driver
FROM release_health_snapshots
WHERE release = '18.4'
ORDER BY snapshot_at DESC
LIMIT 10;

-- Compare confidence across releases
SELECT 
  release,
  current_confidence,
  trend_symbol,
  confidence_change,
  CASE 
    WHEN confidence_change > 0 THEN 'Getting Better'
    WHEN confidence_change < 0 THEN 'Getting Worse'
    ELSE 'Stable'
  END as status
FROM v_release_health_trends
ORDER BY current_confidence ASC;

*/
