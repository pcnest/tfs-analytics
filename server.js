const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Simple in-memory rate limiter for ingest endpoint
const ingestRateLimit = new Map(); // ip -> { count, resetAt }
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of ingestRateLimit.entries()) {
    if (data.resetAt < now) ingestRateLimit.delete(ip);
  }
}, 60000); // cleanup every minute

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SYNC_API_KEY = process.env.SYNC_API_KEY || ''; // required for POST ingest
const TFS_WORKITEM_URL_TEMPLATE = process.env.TFS_WORKITEM_URL_TEMPLATE || '';

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL env var not set.');
  process.exit(1);
}

if (!SYNC_API_KEY || SYNC_API_KEY.trim() === '') {
  console.error(
    'ERROR: SYNC_API_KEY env var not set or empty. Set a strong random string.'
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 3, // Neon free tier: conservative
  connectionTimeoutMillis: 5000, // fail fast if no connection available
  idleTimeoutMillis: 30000, // release idle connections quickly
  statement_timeout: 25000, // prevent long queries (Render timeout is 30s)
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing pool...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing pool...');
  await pool.end();
  process.exit(0);
});

// ---------- Health ----------
app.get('/health', async (req, res) => {
  try {
    const r = await pool.query('select 1 as ok');
    res.json({ ok: true, db: r.rows?.[0]?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    tfsWorkItemUrlTemplate: TFS_WORKITEM_URL_TEMPLATE, // e.g. ".../_workitems/edit/{id}"
  });
});

// ---------- Release Health (Release Radar metrics) ----------
app.get('/api/release-health', async (req, res) => {
  try {
    const viewExists = await pool.query(
      "SELECT to_regclass('public.v_release_health') AS view_name"
    );
    const hasView = !!viewExists.rows?.[0]?.view_name;
    if (!hasView) {
      return res.json({
        ok: true,
        rows: [],
        message:
          'Release health view not configured yet. Create public.v_release_health to enable it.',
      });
    }

    const colsInfo = await pool.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'v_release_health'
    `
    );
    const hasTopBlockerIds = colsInfo.rows.some(
      (c) => c.column_name === 'Top Blocker IDs'
    );

    const { project, release, includeNoRelease } = req.query;

    const proj = project ? String(project).trim() : null;
    const rel = release ? String(release).trim() : null;

    const includeNoRel =
      String(includeNoRelease || '0').toLowerCase() === '1' ||
      String(includeNoRelease || '').toLowerCase() === 'true';

    const sql = `
      SELECT
        project,
        release,

        "ConfidencePct"::int               AS "confidencePct",
        "Confidence Signals"              AS "confidenceSignals",
        "Confidence Driver"               AS "confidenceDriver",

        "Critical"::int                   AS "critical",
        "High"::int                       AS "high",
        "Medium"::int                     AS "medium",
        "Low"::int                        AS "low",
        "OnHold"::int                     AS "onHold",

        "QAPass"::int                     AS "qaPass",
        "QATotal"::int                    AS "qaTotal",
        "QA status (pass/total)"          AS "qaStatus",
        "QA%"::int                        AS "qaPct",

        "Top Blockers"                    AS "topBlockers",
        ${
          hasTopBlockerIds
            ? `"Top Blocker IDs"            AS "topBlockerIds",`
            : ''
        }
        "Decision Needed (Y/N)"           AS "decisionNeeded"
      FROM public.v_release_health
      WHERE
        ($1::text IS NULL OR project = $1)
        AND ($2::text IS NULL OR release = $2)
        AND ($3::bool = true OR release <> '(no release)')
      ORDER BY project, release;
    `;

    const { rows } = await pool.query(sql, [proj, rel, includeNoRel]);
    const mappedRows = rows.map((row) => ({
      ...row,
      project: mapProjectForRelease(row.release, row.project),
    }));

    res.json({ ok: true, rows: mappedRows });
  } catch (e) {
    console.error('release-health error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Burnup endpoint
app.get('/api/release-burnup', async (req, res) => {
  const release = (req.query.release || '').toString().trim();
  const bucket = (req.query.bucket || 'day').toString().trim().toLowerCase();

  if (!release)
    return res.status(400).json({ ok: false, error: 'release required' });

  const allowed = new Set(['hour', 'day', 'week']);
  const unit = allowed.has(bucket) ? bucket : 'day';

  // Build query safely without string interpolation in SQL
  let truncFunc = "date_trunc('day', snapshot_at)";
  if (unit === 'hour') {
    truncFunc = "date_trunc('hour', snapshot_at)";
  } else if (unit === 'week') {
    truncFunc = "date_trunc('week', snapshot_at)";
  }

  const sql = `
    SELECT
      ${truncFunc} AS t,
      count(*)::int AS total_scope,
      count(*) FILTER (WHERE state = 'Done')::int AS done_scope
    FROM public.tfs_workitems_analytics_snapshots
    WHERE release = $1
    GROUP BY 1
    ORDER BY 1;
  `;

  try {
    const r = await pool.query(sql, [release]);
    res.json({ ok: true, rows: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// scope summary + predictability
app.get('/api/release-scope-summary', async (req, res) => {
  const release = (req.query.release || '').toString().trim();
  if (!release)
    return res.status(400).json({ ok: false, error: 'release required' });

  const sql = `
    WITH bounds AS (
      SELECT min(snapshot_at) AS base_at, max(snapshot_at) AS last_at
      FROM public.tfs_workitems_analytics_snapshots
      WHERE release = $1
    ),
    base AS (
      SELECT work_item_id
      FROM public.tfs_workitems_analytics_snapshots
      WHERE release = $1 AND snapshot_at = (SELECT base_at FROM bounds)
    ),
    last AS (
      SELECT work_item_id, state
      FROM public.tfs_workitems_analytics_snapshots
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
      (SELECT base_at FROM bounds) AS baseline_at,
      (SELECT last_at FROM bounds) AS latest_at,
      (SELECT count(*)::int FROM base) AS baseline_scope,
      (SELECT count(*)::int FROM last) AS current_scope,
      (SELECT count(*)::int FROM added) AS added_scope,
      (SELECT count(*)::int FROM removed) AS removed_scope,
      (SELECT delivered FROM delivered) AS delivered_from_baseline;
  `;

  try {
    const r = await pool.query(sql, [release]);
    const row = r.rows[0] || {};
    const baseline = row.baseline_scope || 0;
    const delivered = row.delivered_from_baseline || 0;
    const predictabilityPct =
      baseline > 0 ? Math.round((delivered / baseline) * 100) : 0;

    res.json({ ok: true, ...row, predictabilityPct });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Release Insights (stakeholder widgets) ----------

// 1) Flow aging / staleness (what’s stuck?)
app.get('/api/release-aging', async (req, res) => {
  const release = (req.query.release || '').toString().trim();
  const staleDaysRaw = Number(req.query.staleDays);
  const staleDays = Number.isFinite(staleDaysRaw)
    ? Math.min(Math.max(staleDaysRaw, 1), 90)
    : 7;

  if (!release)
    return res.status(400).json({ ok: false, error: 'release required' });

  try {
    // Use latest synced_at as "as of" to keep numbers consistent with your last sync
    const summarySql = `
      WITH asof AS (
        SELECT COALESCE(MAX(synced_at), now()) AS as_of
        FROM public.tfs_workitems_analytics
        WHERE release = $1
      ),
      base AS (
        SELECT
          work_item_id,
          title,
          state,
          assigned_to,
          COALESCE(state_change_date, changed_date, created_date) AS state_since,
          (SELECT as_of FROM asof) AS as_of
        FROM public.tfs_workitems_analytics
        WHERE release = $1
      ),
      calc AS (
        SELECT
          *,
          GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (as_of - state_since)) / 86400)
          )::int AS age_days
        FROM base
        WHERE state_since IS NOT NULL
      )
      SELECT
        (SELECT as_of FROM asof) AS as_of,
        COUNT(*) FILTER (WHERE lower(state) NOT IN ('done','removed'))::int AS active_count,
        MAX(age_days) FILTER (WHERE lower(state) NOT IN ('done','removed'))::int AS oldest_active_days,
        COUNT(*) FILTER (WHERE lower(state) NOT IN ('done','removed') AND age_days >= $2)::int AS stale_active_count
      FROM calc;
    `;

    const byStateSql = `
      WITH asof AS (
        SELECT COALESCE(MAX(synced_at), now()) AS as_of
        FROM public.tfs_workitems_analytics
        WHERE release = $1
      ),
      calc AS (
        SELECT
          state,
          COALESCE(state_change_date, changed_date, created_date) AS state_since,
          (SELECT as_of FROM asof) AS as_of,
          work_item_id,
          title,
          assigned_to
        FROM public.tfs_workitems_analytics
        WHERE release = $1
      ),
      aged AS (
        SELECT
          state,
          work_item_id,
          title,
          assigned_to,
          GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (as_of - state_since)) / 86400)
          )::int AS age_days
        FROM calc
        WHERE state_since IS NOT NULL
      )
      SELECT
        state,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE age_days >= $2)::int AS stale_count,
        MAX(age_days)::int AS oldest_days
      FROM aged
      WHERE lower(state) NOT IN ('done','removed')
      GROUP BY state
      ORDER BY stale_count DESC, count DESC, state ASC;
    `;

    const topOldestSql = `
      WITH asof AS (
        SELECT COALESCE(MAX(synced_at), now()) AS as_of
        FROM public.tfs_workitems_analytics
        WHERE release = $1
      ),
      aged AS (
        SELECT
          work_item_id,
          title,
          state,
          assigned_to,
          COALESCE(state_change_date, changed_date, created_date) AS state_since,
          (SELECT as_of FROM asof) AS as_of
        FROM public.tfs_workitems_analytics
        WHERE release = $1
      )
      SELECT
        work_item_id,
        title,
        state,
        assigned_to,
        GREATEST(
          0,
          FLOOR(EXTRACT(EPOCH FROM (as_of - state_since)) / 86400)
        )::int AS age_days,
        state_since
      FROM aged
      WHERE
        state_since IS NOT NULL
        AND lower(state) NOT IN ('done','removed')
      ORDER BY age_days DESC, state_since ASC
      LIMIT 5;
    `;

    const [sumR, byR, topR] = await Promise.all([
      pool.query(summarySql, [release, staleDays]),
      pool.query(byStateSql, [release, staleDays]),
      pool.query(topOldestSql, [release]),
    ]);

    const row = sumR.rows[0] || {};
    res.json({
      ok: true,
      release,
      staleDays,
      asOf: row.as_of,
      activeCount: row.active_count ?? 0,
      staleActiveCount: row.stale_active_count ?? 0,
      oldestActiveDays: row.oldest_active_days ?? 0,
      byState: byR.rows || [],
      topOldest: topR.rows || [],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 2) Throughput + simple ETA (how fast?)
app.get('/api/release-throughput', async (req, res) => {
  const release = (req.query.release || '').toString().trim();
  if (!release)
    return res.status(400).json({ ok: false, error: 'release required' });

  try {
    const sql = `
      WITH asof AS (
        SELECT COALESCE(MAX(synced_at), now()) AS as_of
        FROM public.tfs_workitems_analytics
        WHERE release = $1
      ),
      done AS (
        SELECT
          COALESCE(closed_date, state_change_date) AS done_at
        FROM public.tfs_workitems_analytics
        WHERE release = $1
          AND lower(state) = 'done'
          AND COALESCE(closed_date, state_change_date) IS NOT NULL
      ),
      remaining AS (
        SELECT COUNT(*)::int AS remaining
        FROM public.tfs_workitems_analytics
        WHERE release = $1
          AND lower(state) NOT IN ('done','removed')
      )
      SELECT
        (SELECT as_of FROM asof) AS as_of,
        COUNT(*) FILTER (WHERE done_at >= (SELECT as_of FROM asof) - interval '7 days')::int  AS done_7d,
        COUNT(*) FILTER (WHERE done_at >= (SELECT as_of FROM asof) - interval '14 days')::int AS done_14d,
        MAX(done_at) AS last_done_at,
        (SELECT remaining FROM remaining) AS remaining
      FROM done;
    `;

    const r = await pool.query(sql, [release]);
    const row = r.rows[0] || {};

    const done7 = Number(row.done_7d || 0);
    const avgPerDay7 = done7 / 7;
    const remaining = Number(row.remaining || 0);

    const etaDays = avgPerDay7 > 0 ? Math.ceil(remaining / avgPerDay7) : null;

    const asOf = row.as_of ? new Date(row.as_of) : null;
    const etaDate =
      asOf && etaDays !== null
        ? new Date(asOf.getTime() + etaDays * 86400 * 1000).toISOString()
        : null;

    res.json({
      ok: true,
      release,
      asOf: row.as_of,
      lastDoneAt: row.last_done_at,
      done7d: done7,
      done14d: Number(row.done_14d || 0),
      avgDonePerDay7d: Number.isFinite(avgPerDay7)
        ? Number(avgPerDay7.toFixed(2))
        : 0,
      remaining,
      etaDays,
      etaDate,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 3) Dependency risk (what’s blocked?)
app.get('/api/release-dependency-risk', async (req, res) => {
  const release = (req.query.release || '').toString().trim();
  if (!release)
    return res.status(400).json({ ok: false, error: 'release required' });

  try {
    const aggSql = `
      WITH asof AS (
        SELECT COALESCE(MAX(synced_at), now()) AS as_of
        FROM public.tfs_workitems_analytics
        WHERE release = $1
      ),
      active AS (
        SELECT
          work_item_id,
          title,
          state,
          assigned_to,
          COALESCE(open_dep_count, 0)::int AS open_dep_count,
          COALESCE(dep_count, 0)::int AS dep_count
        FROM public.tfs_workitems_analytics
        WHERE release = $1
          AND lower(state) NOT IN ('done','removed')
      )
      SELECT
        (SELECT as_of FROM asof) AS as_of,
        COUNT(*)::int AS active_count,
        COUNT(*) FILTER (WHERE open_dep_count > 0)::int AS blocked_count,
        COALESCE(SUM(open_dep_count),0)::int AS open_dep_total
      FROM active;
    `;

    const topSql = `
      SELECT
        work_item_id,
        title,
        state,
        assigned_to,
        COALESCE(open_dep_count, 0)::int AS open_dep_count,
        COALESCE(dep_count, 0)::int AS dep_count
      FROM public.tfs_workitems_analytics
      WHERE release = $1
        AND lower(state) NOT IN ('done','removed')
        AND COALESCE(open_dep_count,0) > 0
      ORDER BY COALESCE(open_dep_count,0) DESC, work_item_id DESC
      LIMIT 5;
    `;

    const [aggR, topR] = await Promise.all([
      pool.query(aggSql, [release]),
      pool.query(topSql, [release]),
    ]);

    const row = aggR.rows[0] || {};
    const active = Number(row.active_count || 0);
    const blocked = Number(row.blocked_count || 0);
    const blockedPct = active > 0 ? Math.round((blocked / active) * 100) : 0;

    res.json({
      ok: true,
      release,
      asOf: row.as_of,
      activeCount: active,
      blockedCount: blocked,
      blockedPct,
      openDepTotal: Number(row.open_dep_total || 0),
      topBlocked: topR.rows || [],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Dev & QA Cycle (stakeholder-friendly) ----------
app.get('/api/release-cycle', async (req, res) => {
  const release = (req.query.release || '').toString().trim();
  const windowDays = Math.min(
    Math.max(Number(req.query.windowDays) || 7, 1),
    60
  );

  if (!release)
    return res.status(400).json({ ok: false, error: 'release required' });

  try {
    // Use latest snapshot time as the “as of” timestamp for flow metrics
    const asOfR = await pool.query(
      `SELECT max(snapshot_at) AS as_of
       FROM public.tfs_workitems_analytics_snapshots
       WHERE release = $1`,
      [release]
    );
    const asOf = asOfR.rows?.[0]?.as_of || null;

    if (!asOf) {
      return res.json({
        ok: true,
        release,
        asOf: null,
        windowDays,
        message:
          'No snapshot data yet for this release. Run sync at least once.',
      });
    }

    // Current stage counts (based on latest “live” table; should match the last sync)
    const countsR = await pool.query(
      `
      SELECT
  COUNT(*) FILTER (WHERE lower(state) <> 'removed')::int AS total,
  COUNT(*) FILTER (WHERE state = 'Done')::int AS done,

  COUNT(*) FILTER (WHERE state IN ('New','Approved','Committed'))::int AS intake,

  COUNT(*) FILTER (
    WHERE state IN ('In Development','On-Hold','Shelved','Branch Checkin')
      AND lower(state) <> 'removed'
  )::int AS dev_wip,

  COUNT(*) FILTER (WHERE state = 'On-Hold' AND lower(state) <> 'removed')::int AS on_hold,

  COUNT(*) FILTER (WHERE state IN ('Resolved','Ready for QA') AND lower(state) <> 'removed')::int AS qa_queue,
  COUNT(*) FILTER (WHERE state = 'QA Testing' AND lower(state) <> 'removed')::int AS qa_testing,

  COALESCE(SUM(open_dep_count) FILTER (WHERE lower(state) NOT IN ('done','removed')), 0)::int AS open_deps
FROM public.tfs_workitems_analytics
WHERE release = $1;

      `,
      [release]
    );

    // Flow events in the last N days (based on snapshots)
    const flowR = await pool.query(
      `
      WITH hist AS (
        SELECT
          work_item_id,
          type,
          snapshot_at,
          state,
          lag(state) OVER (PARTITION BY work_item_id ORDER BY snapshot_at) AS prev_state
        FROM public.tfs_workitems_analytics_snapshots
        WHERE release = $1
          AND snapshot_at >= $2::timestamptz - ($3::int || ' days')::interval
      ),
      done_ev AS (
        SELECT * FROM hist
        WHERE state = 'Done' AND (prev_state IS DISTINCT FROM 'Done')
      ),
      rework_ev AS (
        SELECT * FROM hist
        WHERE prev_state IN ('Resolved','Ready for QA','QA Testing','Done')
          AND (
            (type = 'Bug' AND state = 'Re-opened')
            OR (type <> 'Bug' AND state = 'In Development')
          )
      )
      SELECT
        (SELECT COUNT(*)::int FROM done_ev) AS done_events,
        (SELECT COUNT(DISTINCT work_item_id)::int FROM done_ev) AS done_items,
        (SELECT COUNT(*)::int FROM rework_ev) AS rework_events,
        (SELECT COUNT(DISTINCT work_item_id)::int FROM rework_ev) AS rework_items
      `,
      [release, asOf, windowDays]
    );

    // Top stuck lists (by “days in current state” using state_change_date)
    const topDevR = await pool.query(
      `
      SELECT
        work_item_id::int AS id,
        type,
        state,
        title,
        date_part('day', $2::timestamptz - COALESCE(state_change_date, changed_date, created_date))::int AS age_days
      FROM public.tfs_workitems_analytics
      WHERE release = $1
        AND state IN ('In Development','On-Hold','Shelved','Branch Checkin')
      ORDER BY age_days DESC NULLS LAST
      LIMIT 5
      `,
      [release, asOf]
    );

    const topQaQueueR = await pool.query(
      `
      SELECT
        work_item_id::int AS id,
        type,
        state,
        title,
        date_part('day', $2::timestamptz - COALESCE(state_change_date, changed_date, created_date))::int AS age_days
      FROM public.tfs_workitems_analytics
      WHERE release = $1
        AND state IN ('Resolved','Ready for QA')
      ORDER BY age_days DESC NULLS LAST
      LIMIT 5
      `,
      [release, asOf]
    );

    const topQaTestingR = await pool.query(
      `
      SELECT
        work_item_id::int AS id,
        type,
        state,
        title,
        date_part('day', $2::timestamptz - COALESCE(state_change_date, changed_date, created_date))::int AS age_days
      FROM public.tfs_workitems_analytics
      WHERE release = $1
        AND state = 'QA Testing'
      ORDER BY age_days DESC NULLS LAST
      LIMIT 5
      `,
      [release, asOf]
    );

    res.json({
      ok: true,
      release,
      asOf,
      windowDays,
      counts: countsR.rows?.[0] || {},
      flow: flowR.rows?.[0] || {},
      top: {
        dev: topDevR.rows || [],
        qaQueue: topQaQueueR.rows || [],
        qaTesting: topQaTestingR.rows || [],
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Executive Release Readiness Scorecard ----------
app.get('/api/release-readiness-scorecard', async (req, res) => {
  const release = (req.query.release || '').toString().trim();
  if (!release)
    return res.status(400).json({ ok: false, error: 'release required' });

  try {
    // Check if we have enough data
    const snapshotCheck = await pool.query(
      'SELECT COUNT(DISTINCT run_id)::int AS snapshot_count FROM tfs_workitems_analytics_snapshots WHERE release = $1',
      [release]
    );
    const snapshotCount = snapshotCheck.rows[0]?.snapshot_count || 0;

    const lastSyncCheck = await pool.query(
      'SELECT MAX(synced_at) AS last_sync FROM tfs_workitems_analytics WHERE release = $1',
      [release]
    );
    const lastSync = lastSyncCheck.rows[0]?.last_sync;
    const daysSinceSync = lastSync
      ? Math.floor((Date.now() - new Date(lastSync).getTime()) / 86400000)
      : null;

    // Fetch scope summary
    const scopeSql = `
      WITH bounds AS (
        SELECT min(snapshot_at) AS base_at, max(snapshot_at) AS last_at
        FROM public.tfs_workitems_analytics_snapshots
        WHERE release = $1
      ),
      base AS (
        SELECT work_item_id
        FROM public.tfs_workitems_analytics_snapshots
        WHERE release = $1 AND snapshot_at = (SELECT base_at FROM bounds)
      ),
      last AS (
        SELECT work_item_id, state
        FROM public.tfs_workitems_analytics_snapshots
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

    // Fetch dependency risk
    const depSql = `
      SELECT
        COUNT(*)::int AS active_count,
        COUNT(*) FILTER (WHERE COALESCE(open_dep_count,0) > 0)::int AS blocked_count
      FROM public.tfs_workitems_analytics
      WHERE release = $1
        AND lower(state) NOT IN ('done','removed')
        AND is_deleted = FALSE
    `;
    const depR = await pool.query(depSql, [release]);
    const dep = depR.rows[0] || {};
    const active = Number(dep.active_count || 0);
    const blocked = Number(dep.blocked_count || 0);
    const blockedPct = active > 0 ? Math.round((blocked / active) * 100) : 0;

    // Fetch release health (confidence + QA)
    const healthSql = `
      SELECT
        "ConfidencePct"::int AS confidence_pct,
        "Confidence Driver" AS confidence_driver,
        "QAPass"::int AS qa_pass,
        "QATotal"::int AS qa_total,
        "QA%"::int AS qa_pct,
        "Top Blockers" AS top_blockers
      FROM public.v_release_health
      WHERE project IS NOT NULL AND release = $1
      LIMIT 1
    `;
    let confidence = null;
    let qaPct = null;
    let qaPass = null;
    let qaTotal = null;
    let topBlockers = null;
    let confidenceDriver = null;

    try {
      const healthR = await pool.query(healthSql, [release]);
      if (healthR.rows.length > 0) {
        const health = healthR.rows[0];
        confidence = health.confidence_pct;
        qaPct = health.qa_pct;
        qaPass = health.qa_pass;
        qaTotal = health.qa_total;
        topBlockers = health.top_blockers;
        confidenceDriver = health.confidence_driver;
      }
    } catch (e) {
      // View may not exist
      console.log('v_release_health not available:', e.message);
    }

    // Fetch throughput ETA (use 30-day window, fallback to full release)
    const etaSql = `
      WITH asof AS (
        SELECT COALESCE(MAX(synced_at), now()) AS as_of
        FROM public.tfs_workitems_analytics
        WHERE release = $1
      ),
      done AS (
        SELECT
          COALESCE(closed_date, state_change_date) AS done_at
        FROM public.tfs_workitems_analytics
        WHERE release = $1
          AND lower(state) = 'done'
          AND COALESCE(closed_date, state_change_date) IS NOT NULL
      ),
      remaining AS (
        SELECT COUNT(*)::int AS remaining
        FROM public.tfs_workitems_analytics
        WHERE release = $1
          AND lower(state) NOT IN ('done','removed')
          AND is_deleted = FALSE
      ),
      duration AS (
        SELECT 
          MIN(COALESCE(closed_date, state_change_date)) AS first_done,
          MAX(COALESCE(closed_date, state_change_date)) AS last_done,
          EXTRACT(EPOCH FROM (
            MAX(COALESCE(closed_date, state_change_date)) - 
            MIN(COALESCE(closed_date, state_change_date))
          ))/86400 AS days_elapsed
        FROM public.tfs_workitems_analytics
        WHERE release = $1
          AND lower(state) = 'done'
          AND COALESCE(closed_date, state_change_date) IS NOT NULL
      )
      SELECT
        (SELECT as_of FROM asof) AS as_of,
        COUNT(*) FILTER (WHERE done_at >= (SELECT as_of FROM asof) - interval '30 days')::int AS done_30d,
        COUNT(*)::int AS done_all,
        (SELECT remaining FROM remaining) AS remaining,
        (SELECT days_elapsed FROM duration) AS days_elapsed
      FROM done
    `;
    const etaR = await pool.query(etaSql, [release]);
    const eta = etaR.rows[0] || {};
    const done30 = Number(eta.done_30d || 0);
    const doneAll = Number(eta.done_all || 0);
    const daysElapsed = Number(eta.days_elapsed || 0);
    const remaining = Number(eta.remaining || 0);

    // Use 30-day average if we have recent activity, otherwise use full release history
    let avgPerDay = 0;
    if (done30 > 0) {
      avgPerDay = done30 / 30;
    } else if (doneAll > 0 && daysElapsed > 0) {
      avgPerDay = doneAll / daysElapsed;
    }

    const etaDays = avgPerDay > 0 ? Math.ceil(remaining / avgPerDay) : null;

    // Compute overall health score (simple weighted average)
    const scores = [];
    if (scopeStability !== null) scores.push(scopeStability);
    if (predictability !== null) scores.push(predictability);
    if (confidence !== null) scores.push(confidence);
    if (qaPct !== null) scores.push(qaPct);
    if (blockedPct !== null) scores.push(100 - blockedPct); // invert (lower blocked = better)
    const overallScore =
      scores.length > 0
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : null;

    // Traffic light status
    const getStatus = (score) => {
      if (score === null) return 'unknown';
      if (score >= 80) return 'green';
      if (score >= 60) return 'yellow';
      return 'red';
    };

    const warnings = [];
    if (snapshotCount < 2)
      warnings.push(
        'Not enough snapshot data (need at least 2 syncs for burnup)'
      );
    if (daysSinceSync !== null && daysSinceSync > 7)
      warnings.push(`Data is ${daysSinceSync} days old`);
    if (baseline < 10)
      warnings.push('Sample size too small for reliable ETA (<10 items)');

    res.json({
      ok: true,
      release,
      lastSync,
      daysSinceSync,
      snapshotCount,
      warnings,
      metrics: {
        scopeStability: {
          value: scopeStability,
          status: getStatus(scopeStability),
        },
        predictability: {
          value: predictability,
          status: getStatus(predictability),
        },
        confidence: {
          value: confidence,
          status: getStatus(confidence),
          driver: confidenceDriver,
        },
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
        topBlockers,
      },
    });
  } catch (e) {
    console.error('release-readiness-scorecard error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- CSV Export for Release Health ----------
app.get('/api/release-health/export.csv', async (req, res) => {
  try {
    const viewExists = await pool.query(
      "SELECT to_regclass('public.v_release_health') AS view_name"
    );
    const hasView = !!viewExists.rows?.[0]?.view_name;
    if (!hasView) {
      return res.status(404).json({
        ok: false,
        error:
          'Release health view not configured. Create public.v_release_health to enable it.',
      });
    }

    const { project, release, includeNoRelease } = req.query;
    const proj = project ? String(project).trim() : null;
    const rel = release ? String(release).trim() : null;
    const includeNoRel =
      String(includeNoRelease || '0').toLowerCase() === '1' ||
      String(includeNoRelease || '').toLowerCase() === 'true';

    const sql = `
      SELECT
        project,
        release,
        "ConfidencePct"::int AS confidence_pct,
        "Confidence Signals" AS confidence_signals,
        "Confidence Driver" AS confidence_driver,
        "Critical"::int AS critical,
        "High"::int AS high,
        "Medium"::int AS medium,
        "Low"::int AS low,
        "OnHold"::int AS on_hold,
        "QAPass"::int AS qa_pass,
        "QATotal"::int AS qa_total,
        "QA status (pass/total)" AS qa_status,
        "QA%"::int AS qa_pct,
        "Top Blockers" AS top_blockers,
        "Decision Needed (Y/N)" AS decision_needed
      FROM public.v_release_health
      WHERE
        ($1::text IS NULL OR project = $1)
        AND ($2::text IS NULL OR release = $2)
        AND ($3::bool = true OR release <> '(no release)')
      ORDER BY project, release
    `;

    const { rows } = await pool.query(sql, [proj, rel, includeNoRel]);
    const mappedRows = rows.map((row) => ({
      ...row,
      project: mapProjectForRelease(row.release, row.project),
    }));

    const headers = [
      'project',
      'release',
      'confidence_pct',
      'confidence_signals',
      'confidence_driver',
      'critical',
      'high',
      'medium',
      'low',
      'on_hold',
      'qa_pass',
      'qa_total',
      'qa_status',
      'qa_pct',
      'top_blockers',
      'decision_needed',
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=release_health.csv'
    );

    res.write(headers.join(',') + '\n');
    for (const row of mappedRows) {
      const line = headers.map((h) => csvEscape(row[h])).join(',');
      res.write(line + '\n');
    }
    res.end();
  } catch (e) {
    console.error('release-health CSV export error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Last Sync Info ----------
app.get('/api/last-sync-info', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT MAX(synced_at) AS last_sync, COUNT(DISTINCT release)::int AS release_count FROM tfs_workitems_analytics WHERE is_deleted = FALSE'
    );
    const row = r.rows[0] || {};
    const lastSync = row.last_sync;
    const daysSince = lastSync
      ? Math.floor((Date.now() - new Date(lastSync).getTime()) / 86400000)
      : null;

    res.json({
      ok: true,
      lastSync,
      daysSince,
      releaseCount: row.release_count || 0,
      isStale: daysSince !== null && daysSince > 7,
    });
  } catch (e) {
    console.error('last-sync-info error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Critical Bugs Count ----------
app.get('/api/critical-bugs', async (req, res) => {
  const release = req.query.release ? String(req.query.release).trim() : null;

  try {
    const where = [
      "type = 'Bug'",
      "severity = 'Critical'",
      "lower(state) NOT IN ('done','removed')",
      'is_deleted = FALSE',
    ];
    const params = [];

    if (release) {
      params.push(release);
      where.push(`release = $${params.length}`);
    }

    const sql = `
      SELECT
        COUNT(*)::int AS critical_bugs_open,
        jsonb_agg(jsonb_build_object(
          'id', work_item_id,
          'title', title,
          'state', state,
          'assignedTo', assigned_to,
          'release', release
        ) ORDER BY changed_date DESC) FILTER (WHERE true) AS top_items
      FROM (
        SELECT work_item_id, title, state, assigned_to, release, changed_date
        FROM tfs_workitems_analytics
        WHERE ${where.join(' AND ')}
        ORDER BY changed_date DESC
        LIMIT 10
      ) sub
    `;

    const r = await pool.query(sql, params);
    const row = r.rows[0] || {};

    res.json({
      ok: true,
      release: release || 'all',
      criticalBugsOpen: row.critical_bugs_open || 0,
      topItems: row.top_items || [],
    });
  } catch (e) {
    console.error('critical-bugs error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Predictability Index Report ----------
app.get('/api/release-predictability', async (req, res) => {
  const releases = req.query.releases
    ? String(req.query.releases)
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r)
    : null;

  if (!releases || releases.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'releases parameter required (comma-separated)',
    });
  }

  try {
    const results = [];

    for (const release of releases) {
      // Reuse scope summary logic
      const sql = `
        WITH bounds AS (
          SELECT min(snapshot_at) AS base_at, max(snapshot_at) AS last_at
          FROM public.tfs_workitems_analytics_snapshots
          WHERE release = $1
        ),
        base AS (
          SELECT work_item_id
          FROM public.tfs_workitems_analytics_snapshots
          WHERE release = $1 AND snapshot_at = (SELECT base_at FROM bounds)
        ),
        last AS (
          SELECT work_item_id, state
          FROM public.tfs_workitems_analytics_snapshots
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
          (SELECT base_at FROM bounds) AS baseline_at,
          (SELECT last_at FROM bounds) AS latest_at,
          (SELECT count(*)::int FROM base) AS baseline_scope,
          (SELECT count(*)::int FROM last) AS current_scope,
          (SELECT count(*)::int FROM added) AS added_scope,
          (SELECT count(*)::int FROM removed) AS removed_scope,
          (SELECT delivered FROM delivered) AS delivered_from_baseline
      `;

      const r = await pool.query(sql, [release]);
      const row = r.rows[0] || {};

      const baseline = Number(row.baseline_scope || 0);
      const added = Number(row.added_scope || 0);
      const removed = Number(row.removed_scope || 0);
      const delivered = Number(row.delivered_from_baseline || 0);
      const current = Number(row.current_scope || 0);

      // Calculate metrics
      const scopeChurnPct =
        baseline > 0 ? Math.round(((added + removed) / baseline) * 100) : 0;
      const predictabilityScore = Math.max(0, 100 - scopeChurnPct);
      const committedVsDeliveredPct =
        baseline > 0 ? Math.round((delivered / baseline) * 100) : 0;

      // Calculate duration in weeks
      const baseAt = row.baseline_at ? new Date(row.baseline_at) : null;
      const latestAt = row.latest_at ? new Date(row.latest_at) : null;
      const durationWeeks =
        baseAt && latestAt
          ? Math.max(
              1,
              Math.round(
                (latestAt.getTime() - baseAt.getTime()) / (7 * 86400 * 1000)
              )
            )
          : null;

      results.push({
        release,
        baselineAt: row.baseline_at,
        latestAt: row.latest_at,
        durationWeeks,
        baseline,
        current,
        added,
        removed,
        delivered,
        scopeChurnPct,
        predictabilityScore,
        committedVsDeliveredPct,
      });
    }

    // Sort by predictability score (best first)
    results.sort((a, b) => b.predictabilityScore - a.predictabilityScore);

    res.json({
      ok: true,
      releases: results.map((r) => r.release),
      data: results,
    });
  } catch (e) {
    console.error('release-predictability error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Release List (for dropdown) ----------
app.get('/api/releases', async (req, res) => {
  try {
    const sql = `
      SELECT DISTINCT release
      FROM tfs_workitems_analytics
      WHERE is_deleted = FALSE
        AND release IS NOT NULL
        AND release != ''
      ORDER BY release DESC
    `;

    const r = await pool.query(sql);
    const releases = r.rows.map((row) => row.release);

    res.json({
      ok: true,
      releases,
      count: releases.length,
    });
  } catch (e) {
    console.error('releases list error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- CSV Exports for Reports ----------
app.get('/api/quality-trends/export.csv', async (req, res) => {
  const release = req.query.release ? String(req.query.release).trim() : null;
  if (!release) {
    return res
      .status(400)
      .json({ ok: false, error: 'release parameter required' });
  }

  try {
    // Reuse the quality-trends logic
    const fromDate = req.query.fromDate
      ? String(req.query.fromDate).trim()
      : null;
    const toDate = req.query.toDate ? String(req.query.toDate).trim() : null;

    const defaultFromDate = new Date();
    defaultFromDate.setDate(defaultFromDate.getDate() - 84);
    const from = fromDate ? new Date(fromDate) : defaultFromDate;
    const to = toDate ? new Date(toDate) : new Date();

    const sql = `
      SELECT
        date_trunc('week', created_date)::date AS week,
        COUNT(*) FILTER (WHERE created_date IS NOT NULL)::int AS bugs_found,
        COUNT(*) FILTER (WHERE lower(state) = 'done')::int AS bugs_closed,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (COALESCE(closed_date, state_change_date) - created_date))/86400
        ) FILTER (WHERE lower(state) = 'done')::int AS median_resolution_days
      FROM tfs_workitems_analytics
      WHERE release = $1
        AND type = 'Bug'
        AND created_date BETWEEN $2 AND $3
        AND is_deleted = FALSE
      GROUP BY 1
      ORDER BY 1
    `;

    const r = await pool.query(sql, [release, from, to]);
    const headers = [
      'week',
      'bugs_found',
      'bugs_closed',
      'median_resolution_days',
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=quality_trends_${release}.csv`
    );

    res.write(headers.join(',') + '\n');
    for (const row of r.rows) {
      const line = headers.map((h) => csvEscape(row[h])).join(',');
      res.write(line + '\n');
    }
    res.end();
  } catch (e) {
    console.error('quality-trends CSV export error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/api/weekly-throughput/export.csv', async (req, res) => {
  const release = req.query.release ? String(req.query.release).trim() : null;
  if (!release) {
    return res
      .status(400)
      .json({ ok: false, error: 'release parameter required' });
  }

  try {
    const fromDate = req.query.fromDate
      ? String(req.query.fromDate).trim()
      : null;
    const toDate = req.query.toDate ? String(req.query.toDate).trim() : null;

    const defaultFromDate = new Date();
    defaultFromDate.setDate(defaultFromDate.getDate() - 84);
    const from = fromDate ? new Date(fromDate) : defaultFromDate;
    const to = toDate ? new Date(toDate) : new Date();

    const sql = `
      SELECT
        date_trunc('week', COALESCE(closed_date, state_change_date))::date AS week,
        COUNT(*)::int AS closed_count,
        COALESCE(SUM(effort), 0)::numeric(10,2) AS closed_effort,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (COALESCE(closed_date, state_change_date) - created_date))/86400
        )::int AS median_cycle_days
      FROM tfs_workitems_analytics
      WHERE release = $1
        AND COALESCE(closed_date, state_change_date) BETWEEN $2 AND $3
        AND lower(state) = 'done'
        AND is_deleted = FALSE
      GROUP BY 1
      ORDER BY 1
    `;

    const r = await pool.query(sql, [release, from, to]);
    const headers = [
      'week',
      'closed_count',
      'closed_effort',
      'median_cycle_days',
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=weekly_throughput_${release}.csv`
    );

    res.write(headers.join(',') + '\n');
    for (const row of r.rows) {
      const line = headers.map((h) => csvEscape(row[h])).join(',');
      res.write(line + '\n');
    }
    res.end();
  } catch (e) {
    console.error('weekly-throughput CSV export error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Quality Trends Report ----------
app.get('/api/quality-trends', async (req, res) => {
  const release = req.query.release ? String(req.query.release).trim() : null;
  const fromDate = req.query.fromDate
    ? String(req.query.fromDate).trim()
    : null;
  const toDate = req.query.toDate ? String(req.query.toDate).trim() : null;
  const severity = req.query.severity
    ? String(req.query.severity).trim()
    : null;

  if (!release) {
    return res
      .status(400)
      .json({ ok: false, error: 'release parameter required' });
  }

  // Default to last 12 weeks if no date range specified
  const defaultFromDate = new Date();
  defaultFromDate.setDate(defaultFromDate.getDate() - 84); // 12 weeks
  const from = fromDate ? new Date(fromDate) : defaultFromDate;
  const to = toDate ? new Date(toDate) : new Date();

  try {
    // Weekly bug creation and closure
    const weeklyBugsSql = `
      WITH weekly_created AS (
        SELECT
          date_trunc('week', created_date) AS week,
          COUNT(*)::int AS bugs_found
        FROM tfs_workitems_analytics
        WHERE release = $1
          AND type = 'Bug'
          AND created_date BETWEEN $2 AND $3
          AND is_deleted = FALSE
          ${severity ? 'AND severity = $4' : ''}
        GROUP BY 1
      ),
      weekly_closed AS (
        SELECT
          date_trunc('week', COALESCE(closed_date, state_change_date)) AS week,
          COUNT(*)::int AS bugs_closed,
          PERCENTILE_CONT(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (COALESCE(closed_date, state_change_date) - created_date))/86400
          )::int AS median_resolution_days
        FROM tfs_workitems_analytics
        WHERE release = $1
          AND type = 'Bug'
          AND COALESCE(closed_date, state_change_date) BETWEEN $2 AND $3
          AND lower(state) = 'done'
          AND is_deleted = FALSE
          ${severity ? 'AND severity = $4' : ''}
        GROUP BY 1
      ),
      rework AS (
        SELECT
          date_trunc('week', snapshot_at) AS week,
          COUNT(DISTINCT work_item_id)::int AS reopened_bugs
        FROM (
          SELECT
            work_item_id,
            snapshot_at,
            state,
            LAG(state) OVER (PARTITION BY work_item_id ORDER BY snapshot_at) AS prev_state
          FROM tfs_workitems_analytics_snapshots
          WHERE release = $1
            AND type = 'Bug'
            AND snapshot_at BETWEEN $2 AND $3
            ${severity ? 'AND severity = $4' : ''}
        ) sub
        WHERE state IN ('Re-opened', 'Active', 'In Development')
          AND prev_state IN ('Resolved', 'Done')
        GROUP BY 1
      )
      SELECT
        COALESCE(c.week, cl.week, r.week) AS week,
        COALESCE(c.bugs_found, 0) AS bugs_found,
        COALESCE(cl.bugs_closed, 0) AS bugs_closed,
        cl.median_resolution_days,
        COALESCE(r.reopened_bugs, 0) AS reopened_bugs,
        COALESCE(c.bugs_found, 0) - COALESCE(cl.bugs_closed, 0) AS net_change
      FROM weekly_created c
      FULL OUTER JOIN weekly_closed cl USING(week)
      FULL OUTER JOIN rework r USING(week)
      ORDER BY week
    `;

    const params = severity
      ? [release, from, to, severity]
      : [release, from, to];

    const weeklyR = await pool.query(weeklyBugsSql, params);

    // Current critical bugs open
    const criticalSql = `
      SELECT COUNT(*)::int AS critical_open
      FROM tfs_workitems_analytics
      WHERE release = $1
        AND type = 'Bug'
        AND severity = 'Critical'
        AND lower(state) NOT IN ('done', 'removed')
        AND is_deleted = FALSE
    `;
    const criticalR = await pool.query(criticalSql, [release]);

    // Calculate reopen rate
    const reopenRateSql = `
      WITH closed_bugs AS (
        SELECT work_item_id
        FROM tfs_workitems_analytics
        WHERE release = $1
          AND type = 'Bug'
          AND COALESCE(closed_date, state_change_date) BETWEEN $2 AND $3
          AND lower(state) = 'done'
          AND is_deleted = FALSE
      ),
      reopened AS (
        SELECT DISTINCT work_item_id
        FROM tfs_workitems_analytics_snapshots
        WHERE release = $1
          AND type = 'Bug'
          AND work_item_id IN (SELECT work_item_id FROM closed_bugs)
          AND snapshot_at > $2
          AND state IN ('Re-opened', 'Active')
      )
      SELECT
        (SELECT COUNT(*)::int FROM closed_bugs) AS total_closed,
        (SELECT COUNT(*)::int FROM reopened) AS total_reopened
    `;
    const reopenR = await pool.query(reopenRateSql, [release, from, to]);
    const reopenData = reopenR.rows[0] || {};
    const totalClosed = Number(reopenData.total_closed || 0);
    const totalReopened = Number(reopenData.total_reopened || 0);
    const reopenRatePct =
      totalClosed > 0 ? Math.round((totalReopened / totalClosed) * 100) : 0;

    res.json({
      ok: true,
      release,
      fromDate: from.toISOString(),
      toDate: to.toISOString(),
      severity: severity || 'all',
      summary: {
        criticalOpen: criticalR.rows[0]?.critical_open || 0,
        reopenRatePct,
        totalClosed,
        totalReopened,
      },
      weekly: weeklyR.rows,
    });
  } catch (e) {
    console.error('quality-trends error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Weekly Throughput Report ----------
app.get('/api/weekly-throughput', async (req, res) => {
  const release = req.query.release ? String(req.query.release).trim() : null;
  const fromDate = req.query.fromDate
    ? String(req.query.fromDate).trim()
    : null;
  const toDate = req.query.toDate ? String(req.query.toDate).trim() : null;
  const type = req.query.type ? String(req.query.type).trim() : null;

  if (!release) {
    return res
      .status(400)
      .json({ ok: false, error: 'release parameter required' });
  }

  // Default to last 12 weeks
  const defaultFromDate = new Date();
  defaultFromDate.setDate(defaultFromDate.getDate() - 84);
  const from = fromDate ? new Date(fromDate) : defaultFromDate;
  const to = toDate ? new Date(toDate) : new Date();

  try {
    const sql = `
      WITH weekly_closed AS (
        SELECT
          date_trunc('week', COALESCE(closed_date, state_change_date)) AS week,
          COUNT(*)::int AS closed_count,
          COALESCE(SUM(effort), 0)::numeric(10,2) AS closed_effort,
          PERCENTILE_CONT(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (COALESCE(closed_date, state_change_date) - created_date))/86400
          )::int AS median_cycle_days
        FROM tfs_workitems_analytics
        WHERE release = $1
          AND COALESCE(closed_date, state_change_date) BETWEEN $2 AND $3
          AND lower(state) = 'done'
          AND is_deleted = FALSE
          ${type ? 'AND type = $4' : ''}
        GROUP BY 1
      ),
      rework AS (
        SELECT
          date_trunc('week', snapshot_at) AS week,
          COUNT(DISTINCT work_item_id)::int AS rework_count
        FROM (
          SELECT
            work_item_id,
            snapshot_at,
            type,
            state,
            LAG(state) OVER (PARTITION BY work_item_id ORDER BY snapshot_at) AS prev_state
          FROM tfs_workitems_analytics_snapshots
          WHERE release = $1
            AND snapshot_at BETWEEN $2 AND $3
            ${type ? 'AND type = $4' : ''}
        ) sub
        WHERE (
          (type = 'Bug' AND state = 'Re-opened' AND prev_state IN ('Resolved', 'Done'))
          OR (type != 'Bug' AND state = 'In Development' AND prev_state IN ('Resolved', 'QA Testing', 'Done'))
        )
        GROUP BY 1
      ),
      scope_changes AS (
        SELECT
          date_trunc('week', snapshot_at) AS week,
          COUNT(DISTINCT CASE WHEN is_new THEN work_item_id END)::int AS scope_added
        FROM (
          SELECT
            work_item_id,
            snapshot_at,
            ROW_NUMBER() OVER (PARTITION BY work_item_id ORDER BY snapshot_at) AS rn
          FROM tfs_workitems_analytics_snapshots
          WHERE release = $1
            AND snapshot_at BETWEEN $2 AND $3
            ${type ? 'AND type = $4' : ''}
        ) sub
        CROSS JOIN LATERAL (
          SELECT (rn = 1) AS is_new
        ) flags
        WHERE is_new
        GROUP BY 1
      )
      SELECT
        w.week,
        w.closed_count,
        w.closed_effort,
        w.median_cycle_days,
        COALESCE(r.rework_count, 0) AS rework_count,
        COALESCE(s.scope_added, 0) AS scope_added,
        AVG(w.closed_count) OVER (
          ORDER BY w.week
          ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        )::numeric(10,1) AS rolling_avg_3week
      FROM weekly_closed w
      LEFT JOIN rework r USING(week)
      LEFT JOIN scope_changes s USING(week)
      ORDER BY w.week
    `;

    const params = type ? [release, from, to, type] : [release, from, to];
    const r = await pool.query(sql, params);

    // Calculate summary metrics
    const rows = r.rows || [];
    const totalClosed = rows.reduce(
      (sum, row) => sum + Number(row.closed_count || 0),
      0
    );
    const totalEffort = rows.reduce(
      (sum, row) => sum + Number(row.closed_effort || 0),
      0
    );
    const avgClosedPerWeek =
      rows.length > 0 ? (totalClosed / rows.length).toFixed(1) : 0;
    const lastWeekClosed =
      rows.length > 0 ? rows[rows.length - 1].closed_count : 0;

    res.json({
      ok: true,
      release,
      fromDate: from.toISOString(),
      toDate: to.toISOString(),
      type: type || 'all',
      summary: {
        totalClosed,
        totalEffort: Number(totalEffort.toFixed(2)),
        avgClosedPerWeek: Number(avgClosedPerWeek),
        lastWeekClosed,
        weeksTracked: rows.length,
      },
      weekly: rows,
    });
  } catch (e) {
    console.error('weekly-throughput error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Static dashboard ----------
app.use('/', express.static(path.join(__dirname, 'public')));

// ---------- Helpers ----------
function requireApiKey(req, res) {
  if (!SYNC_API_KEY) return true; // if you leave it empty, auth is disabled (not recommended)
  const key = req.header('x-api-key');
  if (!key || key !== SYNC_API_KEY) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// FIX P0: Input validation to prevent data corruption
function validateRow(r, idx) {
  const errors = [];

  // Validate work_item_id (must be positive integer)
  if (!Number.isInteger(r.workItemId) || r.workItemId <= 0) {
    errors.push(`Row ${idx}: Invalid work_item_id: ${r.workItemId}`);
  }

  // Validate type (must be valid work item type)
  const validTypes = new Set([
    'Product Backlog Item',
    'Bug',
    'Task',
    'Feature',
  ]);
  if (!r.type || !validTypes.has(r.type)) {
    errors.push(`Row ${idx}: Invalid type: ${r.type}`);
  }

  // Validate required fields
  if (!r.title || typeof r.title !== 'string' || r.title.trim() === '') {
    errors.push(`Row ${idx}: Missing or invalid title`);
  }

  if (!r.state || typeof r.state !== 'string' || r.state.trim() === '') {
    errors.push(`Row ${idx}: Missing or invalid state`);
  }

  // Validate effort (must be non-negative if present)
  if (r.effort !== null && r.effort !== undefined) {
    const e = Number(r.effort);
    if (!Number.isFinite(e) || e < 0) {
      errors.push(
        `Row ${idx}: Invalid effort: ${r.effort} (must be non-negative number)`
      );
    }
  }

  // Validate counts (must be non-negative integers if present)
  const countFields = [
    'depCount',
    'openDepCount',
    'relatedLinkCount',
    'openRelatedCount',
  ];
  for (const field of countFields) {
    if (r[field] !== null && r[field] !== undefined) {
      const val = Number(r[field]);
      if (!Number.isFinite(val) || val < 0 || !Number.isInteger(val)) {
        errors.push(
          `Row ${idx}: Invalid ${field}: ${r[field]} (must be non-negative integer)`
        );
      }
    }
  }

  return errors;
}

function toDateOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function normInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function mapProjectForRelease(release, currentProject) {
  const r = release ? String(release) : '';
  if (/^18\./.test(r)) return 'Agent7';
  if (/^5\./.test(r)) return 'Mobile';
  if (/^80\.1\./.test(r)) return 'NextGen';
  if (/^4\.3\./.test(r)) return 'SSIS';
  return currentProject;
}

// Build a single multi-row upsert statement (chunked) for good performance.
function buildUpsert(rows) {
  // Columns match schema.sql (including is_deleted for soft delete support)
  const cols = [
    'work_item_id',
    'type',
    'title',
    'state',
    'reason',
    'assigned_to',
    'assigned_to_upn',
    'project',
    'area_path',
    'iteration_path',
    'tags',
    'release',
    'created_by',
    'changed_by',
    'created_date',
    'changed_date',
    'state_change_date',
    'severity',
    'effort',
    'parent_id',
    'feature_id',
    'feature',
    'dep_count',
    'open_dep_count',
    'related_link_count',
    'open_related_count',
    'closed_date',
    'source',
    'synced_at',
    'is_deleted', // FIX P0: Soft delete support
  ];

  const values = [];
  const valuesSql = rows
    .map((r, idx) => {
      const base = idx * cols.length;
      const p = (i) => `$${base + i + 1}`;
      // push values in exact col order
      values.push(
        normInt(r.workItemId), // work_item_id
        r.type ?? null,
        r.title ?? null,
        r.state ?? null,
        r.reason ?? null,

        r.assignedTo ?? null,
        r.assignedToUPN ?? null,

        r.project ?? null,
        r.areaPath ?? null,
        r.iterationPath ?? null,

        r.tags ?? null,
        r.release ?? null,

        r.createdBy ?? null,
        r.changedBy ?? null,

        toDateOrNull(r.createdDate),
        toDateOrNull(r.changedDate),
        toDateOrNull(r.stateChangeDate),

        r.severity ?? null,
        normNum(r.effort),

        normInt(r.parentId),
        normInt(r.featureId),
        r.feature ?? null,

        normInt(r.depCount) ?? 0,
        r.openDepCount === null || r.openDepCount === undefined
          ? null
          : normInt(r.openDepCount) ?? 0,

        normInt(r.relatedLinkCount) ?? 0,
        r.openRelatedCount === null || r.openRelatedCount === undefined
          ? null
          : normInt(r.openRelatedCount) ?? 0,
        toDateOrNull(r.closedDate),
        r.source ?? 'tfs-weekly-sync',
        toDateOrNull(r.syncedAtUtc) ?? new Date(),
        false // FIX P0: is_deleted = false (item is active)
      );

      return `(${cols.map((_, j) => p(j)).join(',')})`;
    })
    .join(',');

  const insertSql = `
    INSERT INTO tfs_workitems_analytics (${cols.join(',')})
    VALUES ${valuesSql}
    ON CONFLICT (work_item_id) DO UPDATE SET
      type               = EXCLUDED.type,
      title              = EXCLUDED.title,
      state              = EXCLUDED.state,
      reason             = EXCLUDED.reason,
      assigned_to        = EXCLUDED.assigned_to,
      assigned_to_upn    = EXCLUDED.assigned_to_upn,
      project            = EXCLUDED.project,
      area_path          = EXCLUDED.area_path,
      iteration_path     = EXCLUDED.iteration_path,
      tags               = EXCLUDED.tags,
      release            = EXCLUDED.release,
      created_by         = EXCLUDED.created_by,
      changed_by         = EXCLUDED.changed_by,
      created_date       = EXCLUDED.created_date,
      changed_date       = EXCLUDED.changed_date,
      state_change_date  = EXCLUDED.state_change_date,
      severity           = EXCLUDED.severity,
      effort             = EXCLUDED.effort,
      parent_id          = EXCLUDED.parent_id,
      feature_id         = EXCLUDED.feature_id,
      feature            = EXCLUDED.feature,
      dep_count          = EXCLUDED.dep_count,
      open_dep_count     = EXCLUDED.open_dep_count,
      related_link_count = EXCLUDED.related_link_count,
      open_related_count = EXCLUDED.open_related_count,
      closed_date        = EXCLUDED.closed_date,
      source             = EXCLUDED.source,
      synced_at          = EXCLUDED.synced_at,
      is_deleted         = EXCLUDED.is_deleted
  `;

  return { text: insertSql, values };
}

// add a snapshot insert helper
function buildSnapshotInsert(runId, snapshotAt, rows) {
  const cols = [
    'run_id',
    'snapshot_at',
    'work_item_id',
    'release',
    'type',
    'state',
    'severity',
    'effort',
    'dep_count',
    'open_dep_count',
    'related_link_count',
    'open_related_count',
    'closed_date',
  ];

  const values = [];
  const valuesSql = rows
    .map((r, idx) => {
      const base = idx * cols.length;
      const p = (i) => `$${base + i + 1}`;

      values.push(
        runId,
        snapshotAt,

        normInt(r.workItemId),
        r.release ?? null,
        r.type ?? null,
        r.state ?? null,
        r.severity ?? null,
        normNum(r.effort),

        normInt(r.depCount) ?? 0,
        r.openDepCount === null || r.openDepCount === undefined
          ? null
          : normInt(r.openDepCount) ?? 0,

        normInt(r.relatedLinkCount) ?? 0,
        r.openRelatedCount === null || r.openRelatedCount === undefined
          ? null
          : normInt(r.openRelatedCount) ?? 0,

        toDateOrNull(r.closedDate)
      );

      return `(${cols.map((_, j) => p(j)).join(',')})`;
    })
    .join(',');

  const text = `
    INSERT INTO public.tfs_workitems_analytics_snapshots (${cols.join(',')})
    VALUES ${valuesSql}
  `;
  return { text, values };
}

// ---------- Ingest ----------
// FIX P2: Delta sync watermark endpoint
app.get('/api/last-sync-watermark', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const r = await pool.query(
      'SELECT MAX(changed_date) AS last_changed_date FROM tfs_workitems_analytics WHERE is_deleted = FALSE'
    );
    res.json({
      ok: true,
      lastChangedDate: r.rows[0]?.last_changed_date || null,
    });
  } catch (e) {
    console.error('last-sync-watermark error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// FIX P1: Orphaned reference check endpoint
app.get('/api/check-orphaned-refs', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  try {
    const orphanedParents = await pool.query(`
      SELECT work_item_id, parent_id, title
      FROM tfs_workitems_analytics
      WHERE parent_id IS NOT NULL
        AND is_deleted = FALSE
        AND parent_id NOT IN (SELECT work_item_id FROM tfs_workitems_analytics)
      ORDER BY work_item_id
      LIMIT 100
    `);

    const orphanedFeatures = await pool.query(`
      SELECT work_item_id, feature_id, title
      FROM tfs_workitems_analytics
      WHERE feature_id IS NOT NULL
        AND is_deleted = FALSE
        AND feature_id NOT IN (SELECT work_item_id FROM tfs_workitems_analytics)
      ORDER BY work_item_id
      LIMIT 100
    `);

    res.json({
      ok: true,
      orphanedParents: orphanedParents.rows,
      orphanedFeatures: orphanedFeatures.rows,
      totalOrphanedParents: orphanedParents.rows.length,
      totalOrphanedFeatures: orphanedFeatures.rows.length,
    });
  } catch (e) {
    console.error('check-orphaned-refs error:', e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/api/tfs-weekly-sync', async (req, res) => {
  // Rate limit: 5 requests per minute per IP
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const limit = ingestRateLimit.get(ip);

  if (limit) {
    if (limit.resetAt > now) {
      if (limit.count >= 5) {
        return res
          .status(429)
          .json({ error: 'Too many sync requests, please slow down.' });
      }
      limit.count++;
    } else {
      ingestRateLimit.set(ip, { count: 1, resetAt: now + 60000 });
    }
  } else {
    ingestRateLimit.set(ip, { count: 1, resetAt: now + 60000 });
  }

  if (!requireApiKey(req, res)) return;

  const { source, syncedAtUtc, rows } = req.body || {};
  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows array required' });
  }

  const syncTs = syncedAtUtc ? new Date(syncedAtUtc) : new Date();
  const src = source ?? 'tfs-weekly-sync';

  // FIX P0: Validate all rows before processing
  const validRows = [];
  const invalidRows = [];

  rows.forEach((r, i) => {
    const errs = validateRow(r, i);
    if (errs.length > 0) {
      invalidRows.push({ row: r, errors: errs, index: i });
    } else {
      validRows.push(r);
    }
  });

  // Log validation errors
  if (invalidRows.length > 0) {
    console.warn(
      `Validation failed for ${invalidRows.length} rows:`,
      invalidRows.slice(0, 5).map((x) => ({ index: x.index, errors: x.errors }))
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) create a run row (this run_id ties all snapshot rows together)
    const runR = await client.query(
      `INSERT INTO public.tfs_sync_runs(run_at, source, item_count)
       VALUES ($1, $2, $3)
       RETURNING run_id, run_at`,
      [syncTs, src, validRows.length]
    );
    const runId = runR.rows[0].run_id;
    const runAt = runR.rows[0].run_at; // normalized by DB

    // FIX P2: Track metrics (inserted vs updated)
    let insertedCount = 0;
    let updatedCount = 0;

    if (validRows.length > 0) {
      // Check which work items already exist
      const existingIdsResult = await client.query(
        'SELECT work_item_id FROM tfs_workitems_analytics WHERE work_item_id = ANY($1)',
        [validRows.map((r) => r.workItemId)]
      );
      const existingSet = new Set(
        existingIdsResult.rows.map((r) => r.work_item_id)
      );

      for (const r of validRows) {
        if (existingSet.has(r.workItemId)) {
          updatedCount++;
        } else {
          insertedCount++;
        }
      }
    }

    const chunks = chunkArray(validRows, 200);
    for (const ch of chunks) {
      const enriched = ch.map((r) => ({
        ...r,
        source: src,
        syncedAtUtc: runAt.toISOString(),
      }));

      // 2) upsert latest
      const q = buildUpsert(enriched);
      await client.query(q.text, q.values);

      // 3) insert snapshots
      const s = buildSnapshotInsert(runId, runAt, enriched);
      await client.query(s.text, s.values);
    }

    // FIX P2: Store invalid rows in quarantine table
    if (invalidRows.length > 0) {
      for (const bad of invalidRows) {
        await client.query(
          'INSERT INTO tfs_sync_errors (run_id, row_data, error_message) VALUES ($1, $2, $3)',
          [runId, JSON.stringify(bad.row), bad.errors.join('; ')]
        );
      }
    }

    // FIX P0: Mark old items as deleted (soft delete)
    // Items not synced in last 30 days are considered deleted
    const deleteThreshold = new Date(Date.now() - 30 * 86400 * 1000);
    const deleteResult = await client.query(
      'UPDATE tfs_workitems_analytics SET is_deleted = TRUE WHERE synced_at < $1 AND is_deleted = FALSE',
      [deleteThreshold]
    );
    const deletedCount = deleteResult.rowCount || 0;

    // FIX P2: Store metrics in sync run
    const metrics = {
      inserted: insertedCount,
      updated: updatedCount,
      quarantined: invalidRows.length,
      deleted: deletedCount,
      validRows: validRows.length,
      invalidRows: invalidRows.length,
    };

    await client.query(
      'UPDATE tfs_sync_runs SET metrics = $1, last_changed_date = (SELECT MAX(changed_date) FROM tfs_workitems_analytics WHERE is_deleted = FALSE) WHERE run_id = $2',
      [JSON.stringify(metrics), runId]
    );

    await client.query('COMMIT');
    res.json({
      ok: true,
      count: validRows.length,
      runId,
      runAt,
      metrics,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('INGEST ERROR:', e);
    res
      .status(500)
      .json({ error: 'internal_error', message: String(e?.message || e) });
  } finally {
    client.release();
  }
});

// ---------- Query / grid ----------
app.get('/api/lean-workitems', async (req, res) => {
  const {
    q,
    release,
    assignedToUPN,
    state,
    type,
    feature,
    fromChanged,
    toChanged,
    limit,
    offset,
  } = req.query;

  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const off = Math.max(Number(offset) || 0, 0);

  const where = ['is_deleted = FALSE']; // FIX P0: Filter out soft-deleted items
  const params = [];
  const add = (sql, val) => {
    params.push(val);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (release) add('release = ?', String(release));
  if (assignedToUPN) add('assigned_to_upn = ?', String(assignedToUPN));
  if (state) add('state = ?', String(state));
  if (type) add('type = ?', String(type));
  if (feature) add('feature ILIKE ?', `%${String(feature)}%`);

  if (fromChanged) add('changed_date >= ?', new Date(String(fromChanged)));
  if (toChanged) add('changed_date <= ?', new Date(String(toChanged)));

  if (q) {
    const s = String(q).trim();
    if (s) {
      params.push(`%${s}%`);
      const p = `$${params.length}`;
      where.push(
        `(title ILIKE ${p} OR tags ILIKE ${p} OR CAST(work_item_id AS TEXT) ILIKE ${p})`
      );
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT
      work_item_id as "workItemId",
      type, title, state, reason,
      assigned_to as "assignedTo",
      assigned_to_upn as "assignedToUPN",
      project, area_path as "areaPath", iteration_path as "iterationPath",
      tags, release,
      created_by as "createdBy", changed_by as "changedBy",
      created_date as "createdDate", changed_date as "changedDate", state_change_date as "stateChangeDate",
      severity, effort,
      parent_id as "parentId", feature_id as "featureId", feature,
      dep_count as "depCount", open_dep_count as "openDepCount",
      related_link_count as "relatedLinkCount", open_related_count as "openRelatedCount",
      source, synced_at as "syncedAt"
    FROM tfs_workitems_analytics
    ${whereSql}
    ORDER BY changed_date DESC NULLS LAST
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;

  const sqlCount = `
    SELECT COUNT(*)::int as count
    FROM tfs_workitems_analytics
    ${whereSql}
  `;

  try {
    const [rCount, rRows] = await Promise.all([
      pool.query(sqlCount, params),
      pool.query(sql, [...params, lim, off]),
    ]);

    // small rollup for dashboard tiles
    const roll = await pool.query(
      `
      SELECT
        COUNT(*)::int as total,
        COALESCE(SUM(dep_count),0)::int as dep_total,
        COALESCE(SUM(related_link_count),0)::int as rel_total,
        COALESCE(SUM(open_dep_count),0)::int as open_dep_total,
        COALESCE(SUM(open_related_count),0)::int as open_rel_total
      FROM tfs_workitems_analytics
      ${whereSql}
    `,
      params
    );

    res.json({
      ok: true,
      count: rCount.rows[0].count,
      limit: lim,
      offset: off,
      rollup: roll.rows[0],
      rows: rRows.rows,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- CSV export ----------
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

app.get('/api/lean-workitems/export.csv', async (req, res) => {
  // reuse the JSON endpoint logic by calling DB again (keeps things simple)
  // If you want streaming later, we can upgrade it.
  req.query.limit = String(Math.min(Number(req.query.limit) || 5000, 20000));
  req.query.offset = String(Math.max(Number(req.query.offset) || 0, 0));

  // build same query as /api/lean-workitems but without rollups
  const {
    q,
    release,
    assignedToUPN,
    state,
    type,
    feature,
    fromChanged,
    toChanged,
    limit,
    offset,
  } = req.query;

  const lim = Math.min(Math.max(Number(limit) || 5000, 1), 20000);
  const off = Math.max(Number(offset) || 0, 0);

  const where = [];
  const params = [];
  const add = (sql, val) => {
    params.push(val);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (release) add('release = ?', String(release));
  if (assignedToUPN) add('assigned_to_upn = ?', String(assignedToUPN));
  if (state) add('state = ?', String(state));
  if (type) add('type = ?', String(type));
  if (feature) add('feature ILIKE ?', `%${String(feature)}%`);
  if (fromChanged) add('changed_date >= ?', new Date(String(fromChanged)));
  if (toChanged) add('changed_date <= ?', new Date(String(toChanged)));

  if (q) {
    const s = String(q).trim();
    if (s) {
      params.push(`%${s}%`);
      const p = `$${params.length}`;
      where.push(
        `(title ILIKE ${p} OR tags ILIKE ${p} OR CAST(work_item_id AS TEXT) ILIKE ${p})`
      );
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT
      work_item_id,
      type, title, state, reason,
      assigned_to,
      assigned_to_upn,
      project, area_path, iteration_path,
      tags, release,
      created_by, changed_by,
      created_date, changed_date, state_change_date,
      severity, effort,
      parent_id, feature_id, feature,
      dep_count, open_dep_count,
      related_link_count, open_related_count,
      source, synced_at
    FROM tfs_workitems_analytics
    ${whereSql}
    ORDER BY changed_date DESC NULLS LAST
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;

  try {
    const r = await pool.query(sql, [...params, lim, off]);

    const headers = [
      'work_item_id',
      'type',
      'title',
      'state',
      'reason',
      'assigned_to',
      'assigned_to_upn',
      'project',
      'area_path',
      'iteration_path',
      'tags',
      'release',
      'created_by',
      'changed_by',
      'created_date',
      'changed_date',
      'state_change_date',
      'severity',
      'effort',
      'parent_id',
      'feature_id',
      'feature',
      'dep_count',
      'open_dep_count',
      'related_link_count',
      'open_related_count',
      'source',
      'synced_at',
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=tfs_workitems_analytics.csv'
    );

    res.write(headers.join(',') + '\n');
    for (const row of r.rows) {
      const line = headers.map((h) => csvEscape(row[h])).join(',');
      res.write(line + '\n');
    }
    res.end();
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`tfs-analytics-dashboard listening on :${PORT}`);
});
