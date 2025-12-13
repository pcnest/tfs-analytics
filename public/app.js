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

async function loadReleaseHealth() {
  const el = document.getElementById('release-health-body');
  if (!el) return;

  el.textContent = 'Loading…';

  const r = await fetch('/api/release-health');
  const data = await r.json();

  if (!data.ok) {
    el.textContent = 'Failed to load Release Health.';
    return;
  }

  const rows = data.rows || [];
  if (!rows.length) {
    el.textContent = 'No data.';
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
            <td>${escapeHtml(x.decisionNeeded ?? '')}</td>
          </tr>
        `
          )
          .join('')}
      </tbody>
    </table>
  `;
}

function escapeHtml(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function load() {
  qs(
    'tbody'
  ).innerHTML = `<tr><td colspan="11" class="muted">Loading…</td></tr>`;
  qs('offsetLabel').textContent = String(offset);

  const params = buildParams();
  const res = await fetch(`/api/lean-workitems?${params.toString()}`);
  const data = await res.json();

  if (!data.ok) {
    qs('tbody').innerHTML = `<tr><td colspan="11" class="muted">Error: ${
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
    ).innerHTML = `<tr><td colspan="11" class="muted">No rows match the filters.</td></tr>`;
    return;
  }

  qs('tbody').innerHTML = data.rows
    .map((r) => {
      const openDep =
        r.openDepCount === null || r.openDepCount === undefined
          ? ''
          : r.openDepCount;
      const openRel =
        r.openRelatedCount === null || r.openRelatedCount === undefined
          ? ''
          : r.openRelatedCount;
      return `
      <tr>
        <td><span class="pill">${r.workItemId}</span></td>
        <td>${fmt(r.type)}</td>
        <td class="row-title">${fmt(r.title)}</td>
        <td>${fmt(r.state)}</td>
        <td>${fmt(r.release)}</td>
        <td>
          <div>${fmt(r.assignedTo)}</div>
          <div class="muted" style="font-size:12px;">${fmt(
            r.assignedToUPN
          )}</div>
        </td>
        <td class="right">${fmt(r.depCount)}</td>
        <td class="right">${openDep}</td>
        <td class="right">${fmt(r.relatedLinkCount)}</td>
        <td class="right">${openRel}</td>
        <td>${fmtDate(r.changedDate)}</td>
      </tr>
    `;
    })
    .join('');
}

qs('btnLoad').addEventListener('click', () => {
  offset = 0;
  load();
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
load();
