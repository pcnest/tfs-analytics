-- ============================================
-- Create v_release_health View for Release Radar
-- This view must be created in your Neon PostgreSQL database
-- ============================================

CREATE OR REPLACE VIEW v_release_health AS
WITH release_metrics AS (
  -- Count by severity
  SELECT
    project,
    release,
    COUNT(*) FILTER (WHERE severity = 'Critical' AND state NOT IN ('Done','Removed')) AS "Critical",
    COUNT(*) FILTER (WHERE severity = 'High' AND state NOT IN ('Done','Removed')) AS "High",
    COUNT(*) FILTER (WHERE severity = 'Medium' AND state NOT IN ('Done','Removed')) AS "Medium",
    COUNT(*) FILTER (WHERE severity = 'Low' AND state NOT IN ('Done','Removed')) AS "Low",
    COUNT(*) FILTER (WHERE state = 'On Hold' OR open_dep_count > 0) AS "OnHold"
  FROM tfs_workitems_analytics
  WHERE is_deleted = FALSE
  GROUP BY project, release
),
qa_metrics AS (
  -- QA pass rate (customize states based on your TFS workflow)
  SELECT
    project,
    release,
    COUNT(*) FILTER (WHERE lower(state) IN ('qa passed', 'done')) AS "QAPass",
    COUNT(*) FILTER (WHERE lower(state) IN ('qa testing', 'qa passed', 'ready for qa', 'done')) AS "QATotal"
  FROM tfs_workitems_analytics
  WHERE is_deleted = FALSE
  GROUP BY project, release
),
confidence_calc AS (
  -- Compute confidence score (customize formula to your needs)
  SELECT
    rm.project,
    rm.release,
    GREATEST(0, LEAST(100,
      100 
      - (rm."Critical" * 20)  -- Each critical bug reduces confidence by 20%
      - (rm."OnHold" * 5)     -- Each blocked item reduces confidence by 5%
      - (CASE WHEN qa."QATotal" > 0 
         THEN ((qa."QATotal" - qa."QAPass")::float / qa."QATotal") * 30 
         ELSE 0 END)          -- Failed QA items reduce confidence up to 30%
    )) AS "ConfidencePct"
  FROM release_metrics rm
  LEFT JOIN qa_metrics qa USING (project, release)
),
top_blockers_data AS (
  -- Get top 5 blockers per release (items blocking progress or critical bugs)
  SELECT
    project,
    release,
    STRING_AGG(
      type || ' ' || work_item_id || ' - ' || title,
      ' | '
      ORDER BY 
        CASE WHEN severity = 'Critical' THEN 1 
             WHEN state = 'On Hold' THEN 2 
             WHEN open_dep_count > 0 THEN 3 
             ELSE 4 END,
        work_item_id
    ) FILTER (WHERE rn <= 5) AS "Top Blockers",
    STRING_AGG(
      work_item_id::text,
      '|'
      ORDER BY 
        CASE WHEN severity = 'Critical' THEN 1 
             WHEN state = 'On Hold' THEN 2 
             WHEN open_dep_count > 0 THEN 3 
             ELSE 4 END,
        work_item_id
    ) FILTER (WHERE rn <= 5) AS "Top Blocker IDs"
  FROM (
    SELECT
      project,
      release,
      work_item_id,
      type,
      title,
      severity,
      state,
      open_dep_count,
      ROW_NUMBER() OVER (
        PARTITION BY project, release 
        ORDER BY 
          CASE WHEN severity = 'Critical' THEN 1 
               WHEN state = 'On Hold' THEN 2 
               WHEN open_dep_count > 0 THEN 3 
               ELSE 4 END,
          work_item_id
      ) AS rn
    FROM tfs_workitems_analytics
    WHERE is_deleted = FALSE
      AND state NOT IN ('Done', 'Removed')
      AND (
        severity = 'Critical'
        OR state = 'On Hold'
        OR open_dep_count > 0
      )
  ) ranked
  GROUP BY project, release
)
SELECT
  rm.project,
  rm.release,
  cc."ConfidencePct"::int,
  
  -- Driver logic (identifies main risk factor)
  CASE
    WHEN rm."Critical" > 2 THEN 'Critical-driven'
    WHEN rm."Critical" > 0 THEN 'Critical + ' || 
      CASE 
        WHEN rm."OnHold" > 5 THEN 'On-Hold-driven'
        WHEN qa."QATotal" > 0 AND (qa."QAPass"::float / qa."QATotal") < 0.5 THEN 'QA-driven'
        WHEN rm."High" > 10 THEN 'High-driven'
        ELSE 'monitoring'
      END
    WHEN rm."OnHold" > 10 THEN 'On-Hold-driven'
    WHEN rm."OnHold" > 5 THEN 'On-Hold + monitoring'
    WHEN qa."QATotal" > 0 AND (qa."QAPass"::float / qa."QATotal") < 0.5 THEN 'QA-driven'
    WHEN rm."High" > 15 THEN 'High-driven'
    WHEN rm."High" > 10 THEN 'High + monitoring'
    ELSE 'None'
  END AS "Confidence Driver",
  
  -- Signals (detailed breakdown)
  CASE 
    WHEN rm."Critical" > 0 THEN rm."Critical" || ' Critical, ' ELSE '' 
  END ||
  CASE 
    WHEN rm."High" > 0 THEN rm."High" || ' High, ' ELSE '' 
  END ||
  CASE 
    WHEN rm."OnHold" > 0 THEN rm."OnHold" || ' OnHold' ELSE 'No blockers' 
  END ||
  ' | ' ||
  COALESCE(ROUND((qa."QAPass"::float / NULLIF(qa."QATotal", 0)) * 100), 0) || '% QA'
  AS "Confidence Signals",
  
  rm."Critical",
  rm."High",
  rm."Medium",
  rm."Low",
  rm."OnHold",
  qa."QAPass",
  qa."QATotal",
  COALESCE(qa."QAPass", 0) || '/' || COALESCE(qa."QATotal", 0) AS "QA status (pass/total)",
  COALESCE(ROUND((qa."QAPass"::float / NULLIF(qa."QATotal", 0)) * 100), 0) AS "QA%",
  
  COALESCE(tb."Top Blockers", '-') AS "Top Blockers",
  COALESCE(tb."Top Blocker IDs", '') AS "Top Blocker IDs",
  
  -- Decision flag (requires stakeholder review)
  CASE
    WHEN cc."ConfidencePct" < 60 THEN 'Y'
    WHEN rm."Critical" > 0 THEN 'Y'
    WHEN rm."OnHold" > 10 THEN 'Y'
    WHEN qa."QATotal" > 0 AND (qa."QAPass"::float / qa."QATotal") < 0.5 THEN 'Y'
    ELSE 'N'
  END AS "Decision Needed (Y/N)"
  
FROM release_metrics rm
LEFT JOIN qa_metrics qa USING (project, release)
LEFT JOIN confidence_calc cc USING (project, release)
LEFT JOIN top_blockers_data tb USING (project, release)
WHERE rm.release IS NOT NULL AND rm.release != ''
ORDER BY rm.project, rm.release;

-- ============================================
-- Grant read access (adjust role as needed)
-- ============================================
-- GRANT SELECT ON v_release_health TO your_read_role;

-- ============================================
-- Verify the view works
-- ============================================
SELECT * FROM v_release_health LIMIT 5;
