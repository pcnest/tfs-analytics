/**
 * Get all active releases (releases with recent activity)
 */
async function getActiveReleases(pool) {
  const sql = `
    SELECT DISTINCT release
    FROM tfs_workitems_analytics
    WHERE release IS NOT NULL
      AND release != ''
      AND synced_at >= NOW() - INTERVAL '30 days'
      AND EXISTS (
        SELECT 1 FROM tfs_workitems_analytics w2
        WHERE w2.release = tfs_workitems_analytics.release
          AND lower(w2.state) NOT IN ('done', 'removed')
      )
    ORDER BY release DESC
    LIMIT 10
  `;

  const result = await pool.query(sql);
  return result.rows.map((r) => r.release);
}

/**
 * Build complete context for a release (all metrics + trends)
 */
async function buildReleaseContext(pool, release) {
  try {
    // Fetch readiness scorecard
    const scorecardSql = await getReadinessScorecard(pool, release);

    // Fetch critical bugs
    const criticalBugsSql = `
      SELECT COUNT(*)::int AS count
      FROM tfs_workitems_analytics
      WHERE release = $1
        AND type = 'Bug'
        AND severity = 'Critical'
        AND lower(state) NOT IN ('done', 'removed')
    `;
    const criticalResult = await pool.query(criticalBugsSql, [release]);
    const criticalBugs = criticalResult.rows[0]?.count || 0;

    // Fetch trends (if available)
    let trends = null;
    try {
      const velocityTrend = await pool.query(
        `
        SELECT 
          COUNT(*) FILTER (WHERE COALESCE(closed_date, state_change_date) >= NOW() - INTERVAL '2 weeks')::int AS recent,
          COUNT(*) FILTER (WHERE COALESCE(closed_date, state_change_date) >= NOW() - INTERVAL '4 weeks' 
                           AND COALESCE(closed_date, state_change_date) < NOW() - INTERVAL '2 weeks')::int AS previous
        FROM tfs_workitems_analytics
        WHERE release = $1 AND lower(state) = 'done'
      `,
        [release]
      );

      const vData = velocityTrend.rows[0];
      const vChange =
        vData.previous > 0
          ? Math.round(((vData.recent - vData.previous) / vData.previous) * 100)
          : 0;

      trends = {
        velocity:
          vChange > 5
            ? 'improving ↗'
            : vChange < -5
            ? 'degrading ↘'
            : 'stable →',
      };
    } catch (e) {
      // Trends optional
    }

    return {
      release,
      ...scorecardSql,
      details: {
        ...scorecardSql.details,
        criticalBugs,
      },
      trends,
    };
  } catch (error) {
    console.error(`Error building context for ${release}:`, error);
    throw error;
  }
}

/**
 * Get readiness scorecard data (extracted from existing endpoint logic)
 */
async function getReadinessScorecard(pool, release) {
  // Scope summary
  const scopeSql = `
    WITH bounds AS (
      SELECT min(snapshot_at) AS base_at, max(snapshot_at) AS last_at
      FROM tfs_workitems_analytics_snapshots
      WHERE release = $1
    ),
    base AS (
      SELECT work_item_id
      FROM tfs_workitems_analytics_snapshots
      WHERE release = $1 AND snapshot_at = (SELECT base_at FROM bounds)
    ),
    last AS (
      SELECT work_item_id, state
      FROM tfs_workitems_analytics_snapshots
      WHERE release = $1 AND snapshot_at = (SELECT last_at FROM bounds)
    ),
    added AS (
      SELECT l.work_item_id FROM last l
      LEFT JOIN base b USING(work_item_id)
      WHERE b.work_item_id IS NULL
    ),
    removed AS (
      SELECT b.work_item_id FROM base b
      LEFT JOIN last l USING(work_item_id)
      WHERE l.work_item_id IS NULL
    ),
    delivered AS (
      SELECT count(*)::int AS delivered
      FROM last
      WHERE work_item_id IN (SELECT work_item_id FROM base)
        AND state = 'Done'
    )
    SELECT
      (SELECT count(*)::int FROM base) AS baseline_scope,
      (SELECT count(*)::int FROM added) AS added_scope,
      (SELECT count(*)::int FROM removed) AS removed_scope,
      (SELECT delivered FROM delivered) AS delivered_from_baseline
  `;
  const scopeR = await pool.query(scopeSql, [release]);
  const scope = scopeR.rows[0] || {};
  const baseline = Number(scope.baseline_scope || 0);
  const added = Number(scope.added_scope || 0);
  const removed = Number(scope.removed_scope || 0);
  const delivered = Number(scope.delivered_from_baseline || 0);
  const scopeStability =
    baseline > 0 ? Math.round((1 - (added + removed) / baseline) * 100) : 0;
  const predictability =
    baseline > 0 ? Math.round((delivered / baseline) * 100) : 0;

  // Dependency risk
  const depSql = `
    SELECT
      COUNT(*)::int AS active_count,
      COUNT(*) FILTER (WHERE COALESCE(open_dep_count,0) > 0)::int AS blocked_count
    FROM tfs_workitems_analytics
    WHERE release = $1
      AND lower(state) NOT IN ('done','removed')
      AND is_deleted = FALSE
  `;
  const depR = await pool.query(depSql, [release]);
  const dep = depR.rows[0] || {};
  const active = Number(dep.active_count || 0);
  const blocked = Number(dep.blocked_count || 0);
  const blockedPct = active > 0 ? Math.round((blocked / active) * 100) : 0;

  // Health data
  let confidence = null;
  let qaPct = null;
  let qaPass = null;
  let qaTotal = null;

  try {
    const healthSql = `
      SELECT
        "ConfidencePct"::int AS confidence_pct,
        "QAPass"::int AS qa_pass,
        "QATotal"::int AS qa_total,
        "QA%"::int AS qa_pct
      FROM v_release_health
      WHERE project IS NOT NULL AND release = $1
      LIMIT 1
    `;
    const healthR = await pool.query(healthSql, [release]);
    if (healthR.rows.length > 0) {
      const health = healthR.rows[0];
      confidence = health.confidence_pct;
      qaPct = health.qa_pct;
      qaPass = health.qa_pass;
      qaTotal = health.qa_total;
    }
  } catch (e) {
    // View may not exist
  }

  // Remaining items
  const remainingSql = `
    SELECT COUNT(*)::int AS remaining
    FROM tfs_workitems_analytics
    WHERE release = $1
      AND lower(state) NOT IN ('done','removed')
      AND is_deleted = FALSE
  `;
  const remainingR = await pool.query(remainingSql, [release]);
  const remaining = remainingR.rows[0]?.remaining || 0;

  // ETA calculation
  const etaSql = `
    WITH done AS (
      SELECT COALESCE(closed_date, state_change_date) AS done_at
      FROM tfs_workitems_analytics
      WHERE release = $1
        AND lower(state) = 'done'
        AND COALESCE(closed_date, state_change_date) IS NOT NULL
    ),
    duration AS (
      SELECT 
        MIN(done_at) AS first_done,
        MAX(done_at) AS last_done,
        EXTRACT(EPOCH FROM (MAX(done_at) - MIN(done_at)))/86400 AS days_elapsed
      FROM done
    )
    SELECT
      COUNT(*) FILTER (WHERE done_at >= NOW() - INTERVAL '30 days')::int AS done_30d,
      COUNT(*)::int AS done_all,
      (SELECT days_elapsed FROM duration) AS days_elapsed
    FROM done
  `;
  const etaR = await pool.query(etaSql, [release]);
  const eta = etaR.rows[0] || {};
  const done30 = Number(eta.done_30d || 0);
  const doneAll = Number(eta.done_all || 0);
  const daysElapsed = Number(eta.days_elapsed || 0);

  let avgPerDay = 0;
  if (done30 > 0) {
    avgPerDay = done30 / 30;
  } else if (doneAll > 0 && daysElapsed > 0) {
    avgPerDay = doneAll / daysElapsed;
  }
  const etaDays = avgPerDay > 0 ? Math.ceil(remaining / avgPerDay) : null;

  // Overall health score
  const scores = [];
  if (scopeStability !== null) scores.push(scopeStability);
  if (predictability !== null) scores.push(predictability);
  if (confidence !== null) scores.push(confidence);
  if (qaPct !== null) scores.push(qaPct);
  if (blockedPct !== null) scores.push(100 - blockedPct);
  const overallScore =
    scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : null;

  const getStatus = (score) => {
    if (score === null) return 'unknown';
    if (score >= 80) return 'green';
    if (score >= 60) return 'yellow';
    return 'red';
  };

  const warnings = [];
  if (baseline < 10)
    warnings.push('Sample size too small for reliable metrics (<10 items)');
  if (scopeStability < 70)
    warnings.push(
      `High scope instability (${100 - scopeStability}% scope change)`
    );
  if (blockedPct > 20) warnings.push(`${blockedPct}% of items are blocked`);

  return {
    metrics: {
      scopeStability: {
        value: scopeStability,
        status: getStatus(scopeStability),
      },
      predictability: {
        value: predictability,
        status: getStatus(predictability),
      },
      confidence: { value: confidence, status: getStatus(confidence) },
      qaPct: {
        value: qaPct,
        pass: qaPass,
        total: qaTotal,
        status: getStatus(qaPct),
      },
      blockedPct: { value: blockedPct, status: getStatus(100 - blockedPct) },
      etaDays: { value: etaDays },
      overallScore: { value: overallScore, status: getStatus(overallScore) },
    },
    details: {
      baseline,
      added,
      removed,
      delivered,
      active,
      blocked,
      remaining,
    },
    warnings,
  };
}

module.exports = {
  getActiveReleases,
  buildReleaseContext,
  getReadinessScorecard,
};
