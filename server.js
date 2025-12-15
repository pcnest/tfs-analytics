const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SYNC_API_KEY = process.env.SYNC_API_KEY || ''; // required for POST ingest
const TFS_WORKITEM_URL_TEMPLATE = process.env.TFS_WORKITEM_URL_TEMPLATE || '';

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL env var not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl:
    process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
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

  const sql = `
    SELECT
      date_trunc('${unit}', snapshot_at) AS t,
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
  // Columns match schema.sql
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
        toDateOrNull(r.syncedAtUtc) ?? new Date()
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
      synced_at          = EXCLUDED.synced_at
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
app.post('/api/tfs-weekly-sync', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { source, syncedAtUtc, rows } = req.body || {};
  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows array required' });
  }

  const syncTs = syncedAtUtc ? new Date(syncedAtUtc) : new Date();
  const src = source ?? 'tfs-weekly-sync';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) create a run row (this run_id ties all snapshot rows together)
    const runR = await client.query(
      `INSERT INTO public.tfs_sync_runs(run_at, source, item_count)
       VALUES ($1, $2, $3)
       RETURNING run_id, run_at`,
      [syncTs, src, rows.length]
    );
    const runId = runR.rows[0].run_id;
    const runAt = runR.rows[0].run_at; // normalized by DB

    const chunks = chunkArray(rows, 200);
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

    await client.query('COMMIT');
    res.json({ ok: true, count: rows.length, runId, runAt });
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
