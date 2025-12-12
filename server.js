const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SYNC_API_KEY = process.env.SYNC_API_KEY || ''; // required for POST ingest

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
      source             = EXCLUDED.source,
      synced_at          = EXCLUDED.synced_at
  `;

  return { text: insertSql, values };
}

// ---------- Ingest ----------
app.post('/api/tfs-weekly-sync', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { source, syncedAtUtc, rows } = req.body || {};
  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows array required' });
  }

  const syncTs = syncedAtUtc ? new Date(syncedAtUtc) : new Date();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const chunks = chunkArray(rows, 200);
    for (const ch of chunks) {
      // attach metadata once here so buildUpsert can use it
      const enriched = ch.map((r) => ({
        ...r,
        source: source ?? 'tfs-weekly-sync',
        syncedAtUtc: syncTs.toISOString(),
      }));
      const q = buildUpsert(enriched);
      await client.query(q.text, q.values);
    }

    await client.query('COMMIT');
    res.json({ ok: true, count: rows.length });
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
