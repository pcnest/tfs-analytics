let offset = 0;

function qs(id) {
  return document.getElementById(id);
}

function buildParams() {
  const params = new URLSearchParams();
  const add = (k, v) => {
    if (v !== null && v !== undefined && String(v).trim() !== '')
      params.set(k, v);
  };

  add('q', qs('q').value);
  add('release', qs('release').value);
  add('assignedToUPN', qs('assignedToUPN').value);
  add('state', qs('state').value);
  add('type', qs('type').value);
  add('feature', qs('feature').value);
  add('fromChanged', qs('fromChanged').value);
  add('toChanged', qs('toChanged').value);

  add('limit', qs('limit').value);
  add('offset', offset);

  return params;
}

function fmt(v) {
  return v === null || v === undefined ? '—' : v;
}

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

function buildBurnupSvg(rows) {
  // rows: [{ t, total_scope, done_scope }, ...]
  const W = 720;
  const H = 160;

  const padL = 44,
    padR = 14,
    padT = 14,
    padB = 28;

  const toMs = (v) => {
    const d = new Date(v);
    const ms = d.getTime();
    return Number.isFinite(ms) ? ms : null;
  };

  const pts = rows
    .map((r) => ({
      t: r.t,
      ms: toMs(r.t),
      total: Number(r.total_scope ?? 0),
      done: Number(r.done_scope ?? 0),
    }))
    .filter((p) => p.ms !== null);

  if (pts.length < 2) return '';

  const t0 = pts[0].ms;
  const t1 = pts[pts.length - 1].ms;
  const dt = Math.max(1, t1 - t0);

  const maxY = Math.max(1, ...pts.map((p) => p.total));

  const xFor = (ms) => padL + ((W - padL - padR) * (ms - t0)) / dt;

  const yFor = (v) => padT + (H - padT - padB) * (1 - v / maxY);

  const fmtTick = (ms) => {
    const d = new Date(ms);
    // YYYY-MM-DD HH:mm (UTC)
    return d.toISOString().replace('T', ' ').slice(0, 16);
  };

  const donePts = pts
    .map((p) => `${xFor(p.ms).toFixed(1)},${yFor(p.done).toFixed(1)}`)
    .join(' ');
  const totalPts = pts
    .map((p) => `${xFor(p.ms).toFixed(1)},${yFor(p.total).toFixed(1)}`)
    .join(' ');

  const y0 = yFor(0);
  const yMid = yFor(maxY / 2);
  const yMax = yFor(maxY);

  const firstX = xFor(t0);
  const lastX = xFor(t1);

  const last = pts[pts.length - 1];
  const lastDoneX = xFor(last.ms),
    lastDoneY = yFor(last.done);
  const lastTotalX = xFor(last.ms),
    lastTotalY = yFor(last.total);

  // Minimal “legend” in the SVG itself.
  return `
    <div style="margin-top:10px;">
      <div class="muted" style="font-size:12px; margin-bottom:6px;">Burnup trend</div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="160" role="img" aria-label="Burnup chart">
        <!-- grid -->
        <line x1="${padL}" y1="${yMax}" x2="${
    W - padR
  }" y2="${yMax}" stroke="#000" opacity="0.10" vector-effect="non-scaling-stroke" />
        <line x1="${padL}" y1="${yMid}" x2="${
    W - padR
  }" y2="${yMid}" stroke="#000" opacity="0.10" vector-effect="non-scaling-stroke" />
        <line x1="${padL}" y1="${y0}"   x2="${
    W - padR
  }" y2="${y0}"   stroke="#000" opacity="0.10" vector-effect="non-scaling-stroke" />

        <!-- y labels -->
        <text x="${padL - 8}" y="${
    yMax + 4
  }" text-anchor="end" font-size="10" fill="#000" opacity="0.55">${maxY}</text>
        <text x="${padL - 8}" y="${
    yMid + 4
  }" text-anchor="end" font-size="10" fill="#000" opacity="0.55">${Math.round(
    maxY / 2
  )}</text>
        <text x="${padL - 8}" y="${
    y0 + 4
  }"   text-anchor="end" font-size="10" fill="#000" opacity="0.55">0</text>

        <!-- x labels -->
        <text x="${firstX}" y="${
    H - 10
  }" text-anchor="start" font-size="10" fill="#000" opacity="0.55">${fmtTick(
    t0
  )}</text>
        <text x="${lastX}"  y="${
    H - 10
  }" text-anchor="end"   font-size="10" fill="#000" opacity="0.55">${fmtTick(
    t1
  )}</text>

        <!-- total scope line (lighter) -->
        <polyline points="${totalPts}" fill="none" stroke="#000" opacity="0.35" stroke-width="2" vector-effect="non-scaling-stroke" />

        <!-- done line (darker) -->
        <polyline points="${donePts}" fill="none" stroke="#000" opacity="0.95" stroke-width="2.5" vector-effect="non-scaling-stroke" />

        <!-- last point markers -->
        <circle cx="${lastTotalX}" cy="${lastTotalY}" r="3.5" fill="#000" opacity="0.35" />
        <circle cx="${lastDoneX}"  cy="${lastDoneY}"  r="4"   fill="#000" opacity="0.95" />

        <!-- tiny legend -->
        <rect x="${padL}" y="${padT}" width="12" height="3" fill="#000" opacity="0.95"></rect>
        <text x="${padL + 18}" y="${
    padT + 4
  }" font-size="10" fill="#000" opacity="0.85">Done</text>

        <rect x="${
          padL + 70
        }" y="${padT}" width="12" height="3" fill="#000" opacity="0.35"></rect>
        <text x="${padL + 88}" y="${
    padT + 4
  }" font-size="10" fill="#000" opacity="0.85">Total</text>
      </svg>
    </div>
  `;
}

async function loadReleaseHealth() {
  const el = document.getElementById('release-health-body');
  if (!el) return;

  el.textContent = 'Loading...';

  // Follow current Release filter (if set)
  const params = new URLSearchParams();
  const rel = qs('release')?.value;
  if (rel && String(rel).trim() !== '') params.set('release', rel);

  const url = `/api/release-health${params.toString() ? `?${params}` : ''}`;

  try {
    const r = await fetch(url);

    let data = null;
    try {
      data = await r.json();
    } catch {
      data = {};
    }

    if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);

    if (!data.ok) {
      el.textContent =
        data.message || data.error || 'Failed to load Release Health.';
      return;
    }

    const rows = data.rows || [];
    if (!rows.length) {
      el.textContent = data.message || 'No data.';
      return;
    }

    el.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>Project</th>
            <th>Release</th>
            <th>Confidence</th>
            <th>QA</th>
            <th>C/H/M/L</th>
            <th>OnHold</th>
            <th>Driver</th>
            <th>Signals</th>
            <th>Top Blockers</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (x) => `
            <tr>
              <td>${escapeHtml(x.project)}</td>
              <td>${escapeHtml(x.release)}</td>
              <td>${x.confidencePct ?? ''}%</td>
              <td>${escapeHtml(x.qaStatus ?? '')} (${x.qaPct ?? ''}%)</td>
              <td>${x.critical}/${x.high}/${x.medium}/${x.low}</td>
              <td>${x.onHold}</td>
              <td>${escapeHtml(x.confidenceDriver ?? '')}</td>
              <td>${escapeHtml(x.confidenceSignals ?? '')}</td>
              <td>${formatBlockers(x.topBlockers, x.topBlockerIds)}</td>
              <td>${escapeHtml(x.decisionNeeded ?? '')}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    console.error('loadReleaseHealth failed', err);
    el.textContent = 'Failed to load Release Health.';
  }
}

async function loadReleaseProgress(release) {
  const el = document.getElementById('release-progress-body');
  if (!el) return;

  const rel = String(release || '').trim();
  if (!rel) {
    el.textContent = 'Enter a release and click Load.';
    return;
  }

  el.textContent = 'Loading...';

  const bucket = 'day'; // stakeholder-friendly default (switch to 'hour' if you want)

  try {
    const [burnR, scopeR] = await Promise.all([
      fetch(
        `/api/release-burnup?release=${encodeURIComponent(
          rel
        )}&bucket=${bucket}`
      ),
      fetch(`/api/release-scope-summary?release=${encodeURIComponent(rel)}`),
    ]);

    const burn = await burnR.json().catch(() => ({}));
    const scope = await scopeR.json().catch(() => ({}));

    if (!burnR.ok || !burn.ok)
      throw new Error(burn.error || `burnup HTTP ${burnR.status}`);
    if (!scopeR.ok || !scope.ok)
      throw new Error(scope.error || `scope HTTP ${scopeR.status}`);

    const rows = burn.rows || [];
    const last = rows.length ? rows[rows.length - 1] : null;

    const total = last?.total_scope ?? scope.current_scope ?? 0;
    const done = last?.done_scope ?? 0;
    const remaining = Math.max(0, total - done);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const asOf = scope.latest_at
      ? new Date(scope.latest_at)
      : last?.t
      ? new Date(last.t)
      : null;
    const asOfStr = asOf
      ? asOf.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
      : '—';

    const committed = scope.baseline_scope ?? 0;
    const current = scope.current_scope ?? 0;
    const added = scope.added_scope ?? 0;
    const removed = scope.removed_scope ?? 0;
    const deliveredCommitted = scope.delivered_from_baseline ?? 0;
    const commitMet = scope.predictabilityPct ?? 0;

    const progressBar = `
      <div style="margin-top:8px;">
        <div class="muted" style="font-size:12px; display:flex; justify-content:space-between;">
          <span><b>${done}</b> done / <b>${total}</b> total</span>
          <span><b>${pct}%</b></span>
        </div>
        <div style="height:10px; border:1px solid #3333; border-radius:999px; overflow:hidden; margin-top:6px;">
          <div style="height:100%; width:${pct}%; background:#111;"></div>
        </div>
      </div>
    `;

    const summary = `
      <div class="muted" style="margin-bottom:6px;">Release <b>${escapeHtml(
        rel
      )}</b> — as of <b>${asOfStr}</b></div>

      <div style="display:flex;gap:14px;flex-wrap:wrap; align-items:baseline;">
        <div><span class="muted">Progress</span>: <b>${done}/${total}</b> (<b>${pct}%</b>)</div>
        <div><span class="muted">Remaining</span>: <b>${remaining}</b></div>
        <div><span class="muted">Commitment met</span>: <b>${commitMet}%</b> <span class="muted">(delivered of committed)</span></div>
        <div><span class="muted">Scope change</span>: <b>+${added}</b> / <b>-${removed}</b> <span class="muted">(since baseline)</span></div>
      </div>

      ${progressBar}

      <div style="margin-top:10px; display:flex; gap:14px; flex-wrap:wrap;">
        <div class="muted">Committed (baseline): <b>${committed}</b></div>
        <div class="muted">Current scope: <b>${current}</b></div>
        <div class="muted">Delivered of committed: <b>${deliveredCommitted}</b></div>
      </div>
    `;

    let trend = '';
    if (rows.length >= 2) {
      trend = `
    <details style="margin-top:12px;">
      <summary style="cursor:pointer;">Show burnup history</summary>
      <table>
        <thead><tr><th>Time</th><th>Total</th><th>Done</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (x) => `
            <tr>
              <td>${new Date(x.t)
                .toISOString()
                .replace('T', ' ')
                .slice(0, 16)}</td>
              <td>${x.total_scope}</td>
              <td>${x.done_scope}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </details>
  `;
    }

    const chart =
      rows.length >= 2
        ? buildBurnupSvg(rows)
        : `<div class="muted" style="margin-top:10px;">Only ${rows.length} data point so far. Burnup trend will appear after at least 2 sync runs.</div>`;

    el.innerHTML = summary + chart + trend;
  } catch (err) {
    console.error('loadReleaseProgress failed', err);
    el.textContent = 'Failed to load Release Progress.';
  }
}

function escapeHtml(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatBlockers(text, idsRaw) {
  const texts = String(text ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

  const ids = String(idsRaw ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

  const count = Math.max(texts.length, ids.length);
  if (count === 0) return '-';

  const items = [];
  for (let i = 0; i < count; i += 1) {
    const t = texts[i] ?? '';
    const id = ids[i] ?? '';
    const label = id
      ? `#${escapeHtml(id)}${t ? ` — ${escapeHtml(t)}` : ''}`
      : escapeHtml(t || '');
    items.push(`<li>${label}</li>`);
  }

  return `<ul class="blockers-list">${items.join('')}</ul>`;
}

async function load() {
  qs(
    'tbody'
  ).innerHTML = `<tr><td colspan="8" class="muted">Loading...</td></tr>`;
  qs('offsetLabel').textContent = String(offset);

  const params = buildParams();
  const res = await fetch(`/api/lean-workitems?${params.toString()}`);
  const data = await res.json();

  if (!data.ok) {
    qs('tbody').innerHTML = `<tr><td colspan="8" class="muted">Error: ${
      data.error || 'unknown'
    }</td></tr>`;
    return;
  }

  qs('m_total').textContent = fmt(data.rollup?.total);
  qs('m_dep_total').textContent = fmt(data.rollup?.dep_total);
  qs('m_open_dep_total').textContent = fmt(data.rollup?.open_dep_total);
  qs('m_rel_total').textContent = fmt(data.rollup?.rel_total);
  qs('m_open_rel_total').textContent = fmt(data.rollup?.open_rel_total);

  qs('showing').textContent = `${data.rows.length} / ${data.count}`;

  if (data.rows.length === 0) {
    qs(
      'tbody'
    ).innerHTML = `<tr><td colspan="8" class="muted">No rows match the filters.</td></tr>`;
    return;
  }

  qs('tbody').innerHTML = data.rows
    .map(
      (r) => `
      <tr>
        <td><span class="pill">${r.workItemId}</span></td>
        <td>${fmt(r.type)}</td>
        <td class="row-title">${fmt(r.title)}</td>
        <td>${fmt(r.severity)}</td>
        <td>${fmt(r.state)}</td>
        <td>${fmt(r.release)}</td>
        <td>
          <div>${fmt(r.assignedTo)}</div>
          <div class="muted" style="font-size:12px;">${fmt(
            r.assignedToUPN
          )}</div>
        </td>
        <td>${fmtDate(r.changedDate)}</td>
      </tr>
    `
    )
    .join('');
}

qs('btnLoad').addEventListener('click', () => {
  offset = 0;
  load();
  loadReleaseHealth();
  loadReleaseProgress(qs('release')?.value); // <--- ADD
});

qs('btnExport').addEventListener('click', () => {
  const params = buildParams();
  // export uses same filters, but we usually want a bigger limit
  if (!params.get('limit')) params.set('limit', '5000');
  window.location.href = `/api/lean-workitems/export.csv?${params.toString()}`;
});

qs('prev').addEventListener('click', () => {
  const lim = Number(qs('limit').value) || 200;
  offset = Math.max(0, offset - lim);
  load();
});

qs('next').addEventListener('click', () => {
  const lim = Number(qs('limit').value) || 200;
  offset = offset + lim;
  load();
});

// initial load
loadReleaseHealth();
loadReleaseProgress(qs('release')?.value);
load();
