let offset = 0;
let lastSyncInfo = null;

function qs(id) {
  return document.getElementById(id);
}

// ---------- URL State Management (Bookmarkable URLs) ----------
function loadFiltersFromURL() {
  const params = new URLSearchParams(window.location.search);

  if (params.get('q')) qs('q').value = params.get('q');
  if (params.get('release')) qs('release').value = params.get('release');
  if (params.get('assignedToUPN'))
    qs('assignedToUPN').value = params.get('assignedToUPN');
  if (params.get('state')) qs('state').value = params.get('state');
  if (params.get('type')) qs('type').value = params.get('type');
  if (params.get('feature')) qs('feature').value = params.get('feature');
  if (params.get('fromChanged'))
    qs('fromChanged').value = params.get('fromChanged');
  if (params.get('toChanged')) qs('toChanged').value = params.get('toChanged');
  if (params.get('limit')) qs('limit').value = params.get('limit');
}

function updateURL() {
  const params = buildParams();
  const newURL = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({}, '', newURL);
}

// ---------- Release Dropdown ----------
async function loadReleaseDropdown() {
  try {
    const r = await fetch('/api/releases');
    const j = await r.json();

    if (r.ok && j.ok && j.releases && j.releases.length > 0) {
      const select = qs('release');
      if (!select) return;

      // Save current value
      const currentValue = select.value;

      // Clear existing options except the first (placeholder)
      while (select.options.length > 1) {
        select.remove(1);
      }

      // Add releases as options
      j.releases.forEach((release) => {
        const option = document.createElement('option');
        option.value = release;
        option.textContent = release;
        select.appendChild(option);
      });

      // Restore value if it exists
      if (currentValue && j.releases.includes(currentValue)) {
        select.value = currentValue;
      }
    }
  } catch (e) {
    console.error('Failed to load releases:', e);
  }
}

// Load last sync info on page load
async function loadLastSyncInfo() {
  try {
    const r = await fetch('/api/last-sync-info');
    const j = await r.json();
    if (r.ok && j.ok) {
      lastSyncInfo = j;
      displaySyncBanner(j);
    }
  } catch (e) {
    console.error('Failed to load sync info:', e);
  }
}

function displaySyncBanner(info) {
  const banner = qs('syncBanner');
  if (!banner) return;

  const { lastSync, daysSince, isStale, releaseCount } = info;

  if (!lastSync) {
    banner.innerHTML = `
      <span class="status-indicator red"></span>
      <span><strong>No sync data found.</strong> Run sync script to populate data.</span>
    `;
    banner.className = 'sync-banner stale';
    banner.style.display = 'flex';
    return;
  }

  const date = new Date(lastSync);
  const dateStr = date.toISOString().slice(0, 16).replace('T', ' ');

  let statusClass = 'fresh';
  let statusColor = 'green';
  let message = `Data is up to date`;

  if (daysSince > 7) {
    statusClass = 'stale';
    statusColor = 'red';
    message = `⚠️ Data is ${daysSince} days old`;
  } else if (daysSince > 3) {
    statusClass = 'warning';
    statusColor = 'yellow';
    message = `Data is ${daysSince} days old`;
  }

  banner.innerHTML = `
    <span class="status-indicator ${statusColor}"></span>
    <span><strong>Last synced:</strong> ${dateStr} UTC (${daysSince} day${
    daysSince !== 1 ? 's' : ''
  } ago) • ${releaseCount} release${
    releaseCount !== 1 ? 's' : ''
  } • ${message}</span>
  `;
  banner.className = `sync-banner ${statusClass}`;
  banner.style.display = 'flex';
}

// Load critical bugs for current release filter
async function loadCriticalBugs() {
  const release = qs('release')?.value?.trim() || null;

  try {
    const params = new URLSearchParams();
    if (release) params.set('release', release);

    const r = await fetch(`/api/critical-bugs?${params}`);
    const j = await r.json();

    if (r.ok && j.ok) {
      displayCriticalBugs(j);
    }
  } catch (e) {
    console.error('Failed to load critical bugs:', e);
  }
}

function displayCriticalBugs(data) {
  const card = qs('criticalBugsCard');
  const count = qs('criticalBugsCount');
  const releaseLabel = qs('criticalBugsRelease');

  if (!card || !count || !releaseLabel) return;

  count.textContent = data.criticalBugsOpen || 0;
  releaseLabel.textContent =
    data.release === 'all' ? 'All releases' : `Release: ${data.release}`;

  card.style.display = 'block';
}

// Load top stale items for current release filter
async function loadStaleItems() {
  const release = qs('release')?.value?.trim() || null;

  if (!release) {
    // Hide if no release selected
    const card = qs('staleItemsCard');
    if (card) card.style.display = 'none';
    return;
  }

  try {
    const params = new URLSearchParams();
    params.set('release', release);
    params.set('staleDays', '7');

    const r = await fetch(`/api/release-aging?${params}`);
    const j = await r.json();

    if (r.ok && j.ok) {
      displayStaleItems(j);
    }
  } catch (e) {
    console.error('Failed to load stale items:', e);
  }
}

function displayStaleItems(data) {
  const card = qs('staleItemsCard');
  const list = qs('staleItemsList');
  const releaseLabel = qs('staleItemsRelease');

  if (!card || !list || !releaseLabel) return;

  const topOldest = data.topOldest || [];

  if (topOldest.length === 0) {
    list.innerHTML = '<div class="muted">No stale items found 🎉</div>';
  } else {
    const items = topOldest.slice(0, 5).map((item) => {
      const id = item.work_item_id;
      const title = escapeHtml(item.title || '(no title)');
      const state = escapeHtml(item.state || '');
      const ageDays = item.age_days || 0;
      const assignedTo = escapeHtml(item.assigned_to || 'Unassigned');

      return `
        <div style="margin-bottom:8px; padding:6px; background:#f9f9f9; border-radius:6px;">
          <div><strong>${renderIdPill(id)}</strong> ${title}</div>
          <div class="small muted" style="margin-top:2px;">
            ${state} • ${ageDays} days • ${assignedTo}
          </div>
        </div>
      `;
    });

    list.innerHTML = items.join('');
  }

  releaseLabel.textContent = `Release: ${data.release} • ${
    data.staleActiveCount || 0
  } stale (≥${data.staleDays} days)`;
  card.style.display = 'block';
}

// ---------- Readiness Scorecard Card ----------
async function loadReadinessScorecard() {
  const release = qs('release')?.value?.trim() || null;

  const card = qs('readiness-scorecard');
  const body = qs('readiness-scorecard-body');
  if (!card || !body) return;

  if (!release) {
    card.style.display = 'none';
    return;
  }

  try {
    body.innerHTML = '<div class="muted">Loading...</div>';
    card.style.display = 'block';

    const r = await fetch(
      `/api/release-readiness-scorecard?release=${encodeURIComponent(release)}`
    );
    const j = await r.json();

    if (r.ok && j.ok) {
      displayReadinessScorecard(j);
    } else {
      body.innerHTML = `<div class="muted">Error: ${
        j.error || 'Failed to load'
      }</div>`;
    }
  } catch (e) {
    console.error('Failed to load readiness scorecard:', e);
    body.innerHTML = '<div class="muted">Failed to load scorecard</div>';
  }
}

function displayReadinessScorecard(data) {
  const body = qs('readiness-scorecard-body');
  if (!body) return;

  const { metrics, warnings } = data;
  const getStatusIcon = (status) => {
    if (status === 'green') return '🟢';
    if (status === 'yellow') return '🟡';
    if (status === 'red') return '🔴';
    return '⚪';
  };

  const warningsHtml =
    warnings && warnings.length > 0
      ? `<div style="margin-top:12px; padding:8px; background:#fff9e6; border-radius:6px; font-size:12px;">
         <strong>⚠️ Warnings:</strong><br>${warnings
           .map((w) => `• ${escapeHtml(w)}`)
           .join('<br>')}
       </div>`
      : '';

  body.innerHTML = `
    <div class="metric-row">
      <span class="metric-label">
        Overall Health Score
        <div class="muted" style="font-size:11px; margin-top:2px;">Composite score across all metrics</div>
      </span>
      <span class="metric-value">
        <span class="score-badge ${metrics.overallScore?.status || 'yellow'}">
          ${
            metrics.overallScore?.value !== null
              ? metrics.overallScore.value + '%'
              : 'N/A'
          }
        </span>
        ${getStatusIcon(metrics.overallScore?.status)}
      </span>
    </div>
    <div class="metric-row">
      <span class="metric-label">
        Scope Stability
        <div class="muted" style="font-size:11px; margin-top:2px;">% of scope unchanged since start</div>
      </span>
      <span class="metric-value">
        ${
          metrics.scopeStability?.value !== null
            ? metrics.scopeStability.value + '%'
            : 'N/A'
        }
        ${getStatusIcon(metrics.scopeStability?.status)}
      </span>
    </div>
    <div class="metric-row">
      <span class="metric-label">
        Predictability
        <div class="muted" style="font-size:11px; margin-top:2px;">Variance from original plan</div>
      </span>
      <span class="metric-value">
        ${
          metrics.predictability?.value !== null
            ? metrics.predictability.value + '%'
            : 'N/A'
        }
        ${getStatusIcon(metrics.predictability?.status)}
      </span>
    </div>
    <div class="metric-row">
      <span class="metric-label">
        Confidence
        <div class="muted" style="font-size:11px; margin-top:2px;">Trending toward on-time delivery</div>
      </span>
      <span class="metric-value">
        ${
          metrics.confidence?.value !== null
            ? metrics.confidence.value + '%'
            : 'N/A'
        }
        ${getStatusIcon(metrics.confidence?.status)}
      </span>
    </div>
    <div class="metric-row">
      <span class="metric-label">
        QA Pass Rate
        <div class="muted" style="font-size:11px; margin-top:2px;">QA-approved items / total items</div>
      </span>
      <span class="metric-value">
        ${metrics.qaPct?.value !== null ? metrics.qaPct.value + '%' : 'N/A'}
        ${
          metrics.qaPct?.pass !== undefined
            ? ` (${metrics.qaPct.pass}/${metrics.qaPct.total})`
            : ''
        }
        ${getStatusIcon(metrics.qaPct?.status)}
      </span>
    </div>
    <div class="metric-row">
      <span class="metric-label">
        Blocked Items
        <div class="muted" style="font-size:11px; margin-top:2px;">% of active items with blockers</div>
      </span>
      <span class="metric-value">
        ${
          metrics.blockedPct?.value !== null
            ? metrics.blockedPct.value + '%'
            : 'N/A'
        }
        ${getStatusIcon(metrics.blockedPct?.status)}
      </span>
    </div>
    <div class="metric-row">
      <span class="metric-label">
        ETA (days remaining)
        <div class="muted" style="font-size:11px; margin-top:2px;">Estimated days until release completion</div>
      </span>
      <span class="metric-value">
        ${
          metrics.etaDays?.value !== null
            ? metrics.etaDays.value + ' days'
            : 'N/A'
        }
      </span>
    </div>
    ${warningsHtml}
  `;
}

// ---------- Quality Trends Chart ----------
async function loadQualityTrends() {
  const release = qs('release')?.value?.trim() || null;

  const card = qs('quality-trends-card');
  const body = qs('quality-trends-body');
  if (!card || !body) return;

  if (!release) {
    card.style.display = 'none';
    return;
  }

  try {
    body.innerHTML = '<div class="muted">Loading...</div>';
    card.style.display = 'block';

    // Fetch both trends data and historical trend
    const [trendsR, historyR] = await Promise.all([
      fetch(`/api/quality-trends?release=${encodeURIComponent(release)}`),
      fetch(
        `/api/metrics-history?release=${encodeURIComponent(
          release
        )}&metric=bugs&weeks=8`
      ),
    ]);

    const trendsData = await trendsR.json();
    const historyData = await historyR.json();

    if (trendsR.ok && trendsData.ok) {
      displayQualityTrends(
        trendsData,
        historyData.ok ? historyData.trend : null
      );
    } else {
      body.innerHTML = `<div class="muted">Error: ${
        trendsData.error || 'Failed to load'
      }</div>`;
    }
  } catch (e) {
    console.error('Failed to load quality trends:', e);
    body.innerHTML = '<div class="muted">Failed to load quality trends</div>';
  }
}

function displayQualityTrends(data, trend) {
  const body = qs('quality-trends-body');
  if (!body) return;

  const { summary, weekly } = data;

  if (!weekly || weekly.length === 0) {
    body.innerHTML =
      '<div class="muted">No bug data available for this release</div>';
    return;
  }

  const trendBadge = trend ? buildTrendBadge(trend) : '';

  const summaryHtml = `
    <div style="display:flex; gap:20px; margin-bottom:14px; flex-wrap:wrap; align-items:center;">
      <div>
        <div class="small muted">Critical Open</div>
        <div style="font-size:20px; font-weight:700;">${
          summary.criticalOpen || 0
        }</div>
      </div>
      <div>
        <div class="small muted">Reopen Rate</div>
        <div style="font-size:20px; font-weight:700;">${
          summary.reopenRatePct || 0
        }%</div>
      </div>
      <div>
        <div class="small muted">Total Closed</div>
        <div style="font-size:20px; font-weight:700;">${
          summary.totalClosed || 0
        }</div>
      </div>
      ${trendBadge}
    </div>
  `;

  const chartSvg = buildLineChart(weekly, [
    { key: 'bugs_found', label: 'Bugs Found', color: '#f44336' },
    { key: 'bugs_closed', label: 'Bugs Closed', color: '#4caf50' },
  ]);

  body.innerHTML = summaryHtml + chartSvg;
}

// ---------- Throughput Chart ----------
async function loadThroughputChart() {
  const release = qs('release')?.value?.trim() || null;

  const card = qs('throughput-card');
  const body = qs('throughput-body');
  if (!card || !body) return;

  if (!release) {
    card.style.display = 'none';
    return;
  }

  try {
    body.innerHTML = '<div class="muted">Loading...</div>';
    card.style.display = 'block';

    // Fetch both throughput data and historical trend
    const [throughputR, historyR] = await Promise.all([
      fetch(`/api/weekly-throughput?release=${encodeURIComponent(release)}`),
      fetch(
        `/api/metrics-history?release=${encodeURIComponent(
          release
        )}&metric=velocity&weeks=8`
      ),
    ]);

    const throughputData = await throughputR.json();
    const historyData = await historyR.json();

    if (throughputR.ok && throughputData.ok) {
      displayThroughputChart(
        throughputData,
        historyData.ok ? historyData.trend : null
      );
    } else {
      body.innerHTML = `<div class="muted">Error: ${
        throughputData.error || 'Failed to load'
      }</div>`;
    }
  } catch (e) {
    console.error('Failed to load throughput:', e);
    body.innerHTML = '<div class="muted">Failed to load throughput</div>';
  }
}

function displayThroughputChart(data, trend) {
  const body = qs('throughput-body');
  if (!body) return;

  const { summary, weekly } = data;

  if (!weekly || weekly.length === 0) {
    body.innerHTML =
      '<div class="muted">No throughput data available for this release</div>';
    return;
  }

  const trendBadge = trend ? buildTrendBadge(trend) : '';

  const summaryHtml = `
    <div style="display:flex; gap:20px; margin-bottom:14px; flex-wrap:wrap; align-items:center;">
      <div>
        <div class="small muted">Avg/Week</div>
        <div style="font-size:20px; font-weight:700;">${
          summary.avgClosedPerWeek || 0
        }</div>
      </div>
      <div>
        <div class="small muted">Last Week</div>
        <div style="font-size:20px; font-weight:700;">${
          summary.lastWeekClosed || 0
        }</div>
      </div>
      <div>
        <div class="small muted">Total Closed</div>
        <div style="font-size:20px; font-weight:700;">${
          summary.totalClosed || 0
        }</div>
      </div>
      <div>
        <div class="small muted">Weeks Tracked</div>
        <div style="font-size:20px; font-weight:700;">${
          summary.weeksTracked || 0
        }</div>
      </div>
      ${trendBadge}
    </div>
  `;

  const chartSvg = buildBarChart(
    weekly,
    'closed_count',
    'Closed Items',
    '#2196f3'
  );

  body.innerHTML = summaryHtml + chartSvg;
}

// ---------- Trend Badge Builder ----------
function buildTrendBadge(trend) {
  if (!trend || !trend.direction) return '';

  const { direction, changePct, description } = trend;

  let arrow = '';
  let color = '#666';
  let bgColor = '#f5f5f5';

  if (direction === 'improving') {
    arrow = '↗';
    color = '#2e7d32';
    bgColor = '#e8f5e9';
  } else if (direction === 'degrading') {
    arrow = '↘';
    color = '#c62828';
    bgColor = '#ffebee';
  } else {
    arrow = '→';
    color = '#666';
    bgColor = '#f5f5f5';
  }

  const changeText =
    changePct !== null && changePct !== undefined
      ? `${changePct > 0 ? '+' : ''}${changePct}%`
      : '';

  return `
    <div style="display:flex; align-items:center; gap:6px; padding:6px 12px; background:${bgColor}; border-radius:12px; font-size:12px; color:${color}; font-weight:600;">
      <span style="font-size:16px;">${arrow}</span>
      <span>${changeText}</span>
      <span class="muted" style="font-size:11px; color:${color}; opacity:0.8;" title="${escapeHtml(
    description || ''
  )}">${direction}</span>
    </div>
  `;
}

// ---------- Simple Line Chart Builder ----------
function buildLineChart(data, series) {
  const W = 720,
    H = 200;
  const padL = 50,
    padR = 20,
    padT = 20,
    padB = 40;

  if (data.length === 0) return '';

  // Find max Y value across all series
  let maxY = 0;
  series.forEach((s) => {
    const vals = data.map((d) => Number(d[s.key] || 0));
    maxY = Math.max(maxY, ...vals);
  });
  maxY = Math.max(1, maxY);

  const xFor = (i) =>
    padL + ((W - padL - padR) * i) / Math.max(1, data.length - 1);
  const yFor = (v) => padT + (H - padT - padB) * (1 - v / maxY);

  // Grid lines
  const gridLines = [0, maxY / 2, maxY]
    .map((v) => {
      const y = yFor(v);
      return `<line x1="${padL}" y1="${y}" x2="${
        W - padR
      }" y2="${y}" stroke="#e0e0e0" stroke-width="1"/>
            <text x="${padL - 5}" y="${
        y + 4
      }" text-anchor="end" font-size="11" fill="#666">${Math.round(v)}</text>`;
    })
    .join('');

  // Series lines
  const seriesLines = series
    .map((s) => {
      const points = data
        .map((d, i) => `${xFor(i)},${yFor(Number(d[s.key] || 0))}`)
        .join(' ');
      return `<polyline points="${points}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
    })
    .join('');

  // X-axis labels (show every other week)
  const xLabels = data
    .map((d, i) => {
      if (i % 2 !== 0 && i !== data.length - 1) return '';
      const week = d.week ? new Date(d.week).toISOString().slice(5, 10) : '';
      return `<text x="${xFor(i)}" y="${
        H - padB + 20
      }" text-anchor="middle" font-size="10" fill="#666">${week}</text>`;
    })
    .join('');

  // Legend
  const legendItems = series
    .map((s, i) => {
      const x = W - padR - 150 + i * 80;
      return `<rect x="${x}" y="10" width="12" height="12" fill="${s.color}"/>
            <text x="${x + 16}" y="20" font-size="11" fill="#666">${
        s.label
      }</text>`;
    })
    .join('');

  return `
    <div class="chart-container">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="200" role="img">
        ${gridLines}
        ${seriesLines}
        ${xLabels}
        ${legendItems}
      </svg>
    </div>
  `;
}

// ---------- Simple Bar Chart Builder ----------
function buildBarChart(data, valueKey, label, color) {
  const W = 720,
    H = 200;
  const padL = 50,
    padR = 20,
    padT = 20,
    padB = 40;

  if (data.length === 0) return '';

  const values = data.map((d) => Number(d[valueKey] || 0));
  const maxY = Math.max(1, ...values);

  const barWidth = ((W - padL - padR) / data.length) * 0.7;
  const xFor = (i) => padL + ((W - padL - padR) * (i + 0.5)) / data.length;
  const yFor = (v) => padT + (H - padT - padB) * (1 - v / maxY);

  // Grid lines
  const gridLines = [0, maxY / 2, maxY]
    .map((v) => {
      const y = yFor(v);
      return `<line x1="${padL}" y1="${y}" x2="${
        W - padR
      }" y2="${y}" stroke="#e0e0e0" stroke-width="1"/>
            <text x="${padL - 5}" y="${
        y + 4
      }" text-anchor="end" font-size="11" fill="#666">${Math.round(v)}</text>`;
    })
    .join('');

  // Bars
  const bars = data
    .map((d, i) => {
      const val = Number(d[valueKey] || 0);
      const x = xFor(i) - barWidth / 2;
      const y = yFor(val);
      const h = H - padB - y;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="${color}" opacity="0.8"/>`;
    })
    .join('');

  // X-axis labels
  const xLabels = data
    .map((d, i) => {
      if (i % 2 !== 0 && i !== data.length - 1) return '';
      const week = d.week ? new Date(d.week).toISOString().slice(5, 10) : '';
      return `<text x="${xFor(i)}" y="${
        H - padB + 20
      }" text-anchor="middle" font-size="10" fill="#666">${week}</text>`;
    })
    .join('');

  return `
    <div class="chart-container">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="200" role="img">
        ${gridLines}
        ${bars}
        ${xLabels}
      </svg>
    </div>
  `;
}

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

let APP_CFG = null;

async function loadConfig() {
  if (APP_CFG) return APP_CFG;
  try {
    const r = await fetch('/api/config');
    const j = await r.json().catch(() => ({}));
    APP_CFG = r.ok && j.ok ? j : {};
  } catch {
    APP_CFG = {};
  }
  return APP_CFG;
}

function workItemHref(id) {
  const tpl = APP_CFG?.tfsWorkItemUrlTemplate;
  if (!tpl) return null;
  return tpl.replace('{id}', encodeURIComponent(String(id)));
}

function renderIdPill(id) {
  const href = workItemHref(id);
  const label = escapeHtml(id);
  if (href) {
    return `<a class="pill" href="${escapeHtml(
      href
    )}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }
  return `<span class="pill">${label}</span>`;
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

    const header = `
      <div class="muted" style="margin-bottom:8px;">
        Release <b>${escapeHtml(rel)}</b> — as of <b>${asOfStr}</b>
      </div>
    `;

    const cards = `
      <div class="mini-cards">
        <div class="mini-card">
          <div class="mini-k">Progress</div>
          <div class="mini-v">${pct}%</div>
          <div class="mini-sub">${done} done / ${total} total</div>
          <div class="mini-bar"><div style="width:${pct}%;"></div></div>
        </div>

        <div class="mini-card">
          <div class="mini-k">Remaining</div>
          <div class="mini-v">${remaining}</div>
          <div class="mini-sub">tickets</div>
        </div>

        <div class="mini-card">
          <div class="mini-k">Commitment met</div>
          <div class="mini-v">${commitMet}%</div>
          <div class="mini-sub">${deliveredCommitted}/${committed} delivered (baseline)</div>
        </div>

        <div class="mini-card">
          <div class="mini-k">Scope change</div>
          <div class="mini-v">+${added} / -${removed}</div>
          <div class="mini-sub">since baseline</div>
        </div>
      </div>
    `;

    const chart =
      rows.length >= 2
        ? buildBurnupSvg(rows)
        : `<div class="muted" style="margin-top:10px;">Only ${rows.length} data point so far. Burnup trend will appear after at least 2 sync runs.</div>`;

    const foot = `
      <div class="muted" style="margin-top:10px;">
        Baseline scope: <b>${committed}</b> · Current scope: <b>${current}</b>
      </div>
    `;

    const drilldown =
      rows.length >= 2
        ? `
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
    `
        : '';

    el.innerHTML = header + cards + chart + foot + drilldown;
  } catch (err) {
    console.error('loadReleaseProgress failed', err);
    el.textContent = 'Failed to load Release Progress.';
  }
}

async function loadReleaseInsights(release) {
  const el = document.getElementById('release-insights-body');
  if (!el) return;

  const rel = String(release || '').trim();
  if (!rel) {
    el.textContent = 'Enter a release and click Load.';
    return;
  }

  el.textContent = 'Loading...';

  try {
    const qsRel = `release=${encodeURIComponent(rel)}`;

    const [agingR, thrR, depR] = await Promise.all([
      fetch(`/api/release-aging?${qsRel}&staleDays=7`),
      fetch(`/api/release-throughput?${qsRel}`),
      fetch(`/api/release-dependency-risk?${qsRel}`),
    ]);

    const aging = await agingR.json().catch(() => ({}));
    const thr = await thrR.json().catch(() => ({}));
    const dep = await depR.json().catch(() => ({}));

    if (!agingR.ok || !aging.ok) throw new Error(aging.error || 'aging failed');
    if (!thrR.ok || !thr.ok) throw new Error(thr.error || 'throughput failed');
    if (!depR.ok || !dep.ok) throw new Error(dep.error || 'dependency failed');

    const asOf = aging.asOf || thr.asOf || dep.asOf || null;
    const asOfStr = asOf
      ? new Date(asOf).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
      : '—';

    const etaText =
      thr.etaDays === null
        ? '—'
        : `${thr.etaDays}d (${String(thr.etaDate || '').slice(0, 10)})`;

    const cards = `
      <div class="muted" style="margin-bottom:8px;">
        Release <b>${escapeHtml(rel)}</b> — as of <b>${escapeHtml(asOfStr)}</b>
      </div>

      <div class="mini-cards">
        <div class="mini-card">
          <div class="mini-k">Stale items</div>
          <div class="mini-v">${aging.staleActiveCount ?? 0}</div>
          <div class="mini-sub">&ge; ${aging.staleDays ?? 7} days in state</div>
        </div>

        <div class="mini-card">
          <div class="mini-k">Oldest WIP</div>
          <div class="mini-v">${aging.oldestActiveDays ?? 0}d</div>
          <div class="mini-sub">in current state</div>
        </div>

        <div class="mini-card">
          <div class="mini-k">Done (7d)</div>
          <div class="mini-v">${thr.done7d ?? 0}</div>
          <div class="mini-sub">avg ${thr.avgDonePerDay7d ?? 0}/day</div>
        </div>

        <div class="mini-card">
          <div class="mini-k">ETA (rough)</div>
          <div class="mini-v">${escapeHtml(etaText)}</div>
          <div class="mini-sub">${thr.remaining ?? 0} remaining</div>
        </div>

        <div class="mini-card">
          <div class="mini-k">Blocked</div>
          <div class="mini-v">${dep.blockedPct ?? 0}%</div>
          <div class="mini-sub">${dep.blockedCount ?? 0} / ${
      dep.activeCount ?? 0
    } active</div>
        </div>

        <div class="mini-card">
          <div class="mini-k">Open deps</div>
          <div class="mini-v">${dep.openDepTotal ?? 0}</div>
          <div class="mini-sub">sum of open dep links</div>
        </div>
      </div>
    `;

    const topOldest = (aging.topOldest || [])
      .map(
        (x) => `
        <li style="margin:4px 0;">
          ${renderIdPill(x.work_item_id)}
          <span class="muted">(${escapeHtml(x.state)} • ${x.age_days}d)</span>
          <div style="margin-top:2px;">${escapeHtml(x.title || '')}</div>
        </li>
      `
      )
      .join('');

    const topBlocked = (dep.topBlocked || [])
      .map(
        (x) => `
        <li style="margin:4px 0;">
          ${renderIdPill(x.work_item_id)}
          <span class="muted">(${escapeHtml(x.state)} • open deps: ${
          x.open_dep_count
        })</span>
          <div style="margin-top:2px;">${escapeHtml(x.title || '')}</div>
        </li>
      `
      )
      .join('');

    const lists = `
      <div style="display:flex; gap:14px; flex-wrap:wrap; margin-top:12px;">
        <div style="flex:1 1 320px;">
          <div class="muted" style="font-size:12px; margin-bottom:6px;">Top stuck (oldest active)</div>
          <ul style="margin:0; padding-left:16px;">
            ${
              topOldest ||
              '<li class="muted">No active items with state dates.</li>'
            }
          </ul>
        </div>

        <div style="flex:1 1 320px;">
          <div class="muted" style="font-size:12px; margin-bottom:6px;">Top blocked</div>
          <ul style="margin:0; padding-left:16px;">
            ${topBlocked || '<li class="muted">No blocked items.</li>'}
          </ul>
        </div>
      </div>
    `;

    el.innerHTML = cards + lists;
  } catch (err) {
    console.error('loadReleaseInsights failed', err);
    el.textContent = 'Failed to load Release Insights.';
  }
}

async function loadReleaseCycle(release) {
  const el = document.getElementById('release-cycle-body');
  if (!el) return;

  const rel = String(release || '').trim();
  if (!rel) {
    el.textContent = 'Enter a release and click Load.';
    return;
  }

  el.textContent = 'Loading...';

  try {
    const r = await fetch(
      `/api/release-cycle?release=${encodeURIComponent(rel)}&windowDays=7`
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data?.error || `HTTP ${r.status}`);

    if (!data.asOf) {
      el.textContent = data.message || 'No data yet.';
      return;
    }

    const asOfStr =
      new Date(data.asOf).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    const c = data.counts || {};
    const f = data.flow || {};

    const done7 = Number(f.done_items ?? f.done_events ?? 0);
    const perDay = (done7 / 7).toFixed(2);

    const reworkItems7 = Number(f.rework_items ?? 0);
    const reworkEvents7 = Number(f.rework_events ?? 0);

    const header = `
      <div class="muted" style="margin-bottom:8px;">
        Release <b>${escapeHtml(rel)}</b> — as of <b>${asOfStr}</b>
      </div>
    `;

    const cards = `
      <div class="mini-cards">
        <div class="mini-card">
          <div class="mini-k">Dev WIP</div>
          <div class="mini-v">${Number(c.dev_wip ?? 0)}</div>
          <div class="mini-sub">In Dev / On-Hold / Shelved / Branch Checkin</div>
        </div>

        <div class="mini-card">
          <div class="mini-k">QA Queue</div>
          <div class="mini-v">${Number(c.qa_queue ?? 0)}</div>
          <div class="mini-sub">Resolved (Bug) / Ready for QA (PBI)</div>
        </div>

        <div class="mini-card">
          <div class="mini-k">QA Testing</div>
          <div class="mini-v">${Number(c.qa_testing ?? 0)}</div>
          <div class="mini-sub">currently being tested</div>
        </div>

        <div class="mini-card">
          <div class="mini-k">Done (7d)</div>
          <div class="mini-v">${done7}</div>
          <div class="mini-sub">avg ${perDay}/day</div>
        </div>

        <div class="mini-card">
  <div class="mini-k">QA bounce (7d)</div>
  <div class="mini-v">${reworkItems7}</div>
  <div class="mini-sub">${reworkEvents7} bounce event(s)</div>
</div>


        <div class="mini-card">
          <div class="mini-k">Blocked (On-Hold)</div>
          <div class="mini-v">${Number(c.on_hold ?? 0)}</div>
          <div class="mini-sub">current On-Hold tickets</div>
        </div>
      </div>
    `;

    const mkList = (items) => {
      if (!items || !items.length) return `<div class="muted">None.</div>`;
      return `
        <ul>
          ${items
            .map(
              (x) => `
            <li>
              ${renderIdPill(x.id)}
              <span class="muted">(${escapeHtml(x.state)} • ${Number(
                x.age_days ?? 0
              )}d)</span><br/>
              ${escapeHtml(x.title || '')}
            </li>
          `
            )
            .join('')}
        </ul>
      `;
    };

    const top = data.top || {};
    const lists = `
      <div class="two-col">
        <div>
          <div class="k">Top stuck (Dev WIP)</div>
          ${mkList(top.dev)}
        </div>
        <div>
          <div class="k">Top stuck (QA Queue)</div>
          ${mkList(top.qaQueue)}
        </div>
        <div>
          <div class="k">Top stuck (QA Testing)</div>
          ${mkList(top.qaTesting)}
        </div>
      </div>
    `;

    el.innerHTML = header + cards + lists;
  } catch (err) {
    console.error('loadReleaseCycle failed', err);
    el.textContent = 'Failed to load Dev & QA Cycle.';
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

function sanitizeAiHtml(html) {
  const input = String(html ?? '');
  if (!input) return '';

  const parser = new DOMParser();
  const doc = parser.parseFromString(input, 'text/html');
  const allowedTags = new Set([
    'h2',
    'h3',
    'h4',
    'p',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'br',
    'strong',
    'em',
    'b',
    'i',
    'u',
    'ul',
    'ol',
    'li',
    'span',
    'div',
    'hr',
  ]);
  const allowedAttrs = {
    table: new Set(['border', 'cellpadding', 'cellspacing']),
    th: new Set(['colspan', 'rowspan']),
    td: new Set(['colspan', 'rowspan']),
  };

  const nodes = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }

  nodes.forEach((node) => {
    const tag = node.tagName.toLowerCase();
    if (!allowedTags.has(tag)) {
      const parent = node.parentNode;
      if (!parent) return;
      while (node.firstChild) {
        parent.insertBefore(node.firstChild, node);
      }
      parent.removeChild(node);
      return;
    }

    const allowed = allowedAttrs[tag];
    Array.from(node.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (!allowed || !allowed.has(name)) {
        node.removeAttribute(attr.name);
      }
    });
  });

  return doc.body.innerHTML;
}

function formatBlockers(text, idsRaw) {
  // New format: "Type ID - Title | Type ID - Title"
  // The SQL view now provides formatted text like "Bug 12345 - Title"
  const blockers = String(text ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

  const ids = String(idsRaw ?? '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

  if (blockers.length === 0) return '-';

  const items = [];
  for (let i = 0; i < blockers.length; i += 1) {
    const blockerText = blockers[i];
    const id = ids[i] ?? '';

    // Parse the format: "Type ID - Title"
    // Example: "Bug 12345 - Database connection timeout"
    const match = blockerText.match(/^(\w+)\s+(\d+)\s+-\s+(.+)$/);

    if (match && id) {
      const [, type, workItemId, title] = match;
      const pill = renderIdPill(id);
      // Format: <Type> <Linked ID> - <Title>
      items.push(
        `<li><span style="color:#666;">${escapeHtml(
          type
        )}</span> ${pill} — ${escapeHtml(title)}</li>`
      );
    } else if (id) {
      // Fallback: just show linked ID and text
      const pill = renderIdPill(id);
      items.push(`<li>${pill} — ${escapeHtml(blockerText)}</li>`);
    } else {
      // No ID available, show plain text
      items.push(`<li>${escapeHtml(blockerText)}</li>`);
    }
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
        <td>${renderIdPill(r.workItemId)}</td>
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

qs('btnLoad').addEventListener('click', async () => {
  offset = 0;
  updateURL(); // Update URL with current filters
  await loadConfig();
  load();
  loadCriticalBugs();
  loadStaleItems();
  loadReadinessScorecard();
  loadQualityTrends();
  loadThroughputChart();
  loadReleaseHealth();
  loadReleaseProgress(qs('release')?.value);
  loadReleaseInsights(qs('release')?.value);
  loadReleaseCycle(qs('release')?.value);
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
(async function boot() {
  await loadConfig();
  await loadLastSyncInfo();
  await loadReleaseDropdown();
  loadFiltersFromURL(); // Load filters from URL if present

  // Only auto-load if there are URL params
  const hasParams = window.location.search.length > 1;
  if (hasParams) {
    loadCriticalBugs();
    loadStaleItems();
    loadReadinessScorecard();
    loadQualityTrends();
    loadThroughputChart();
    loadReleaseHealth();
    loadReleaseProgress(qs('release')?.value);
    loadReleaseInsights(qs('release')?.value);
    loadReleaseCycle(qs('release')?.value);
    load();
  }
})();

// ============================================
// AI Report Functions
// ============================================

// Modal management
const modal = qs('aiModal');
const modalTitle = qs('modalTitle');
const modalBody = qs('modalBody');
const modalClose = qs('modalClose');
const modalClose2 = qs('modalClose2');
const modalCopy = qs('modalCopy');

function showModal(title, content) {
  modalTitle.textContent = title;
  modalBody.innerHTML = content;
  modal.style.display = 'block';
}

function hideModal() {
  modal.style.display = 'none';
}

function showModalLoading(title = 'AI Report') {
  modalTitle.textContent = title;
  modalBody.innerHTML = `
    <div style="text-align:center; padding:40px;">
      <div class="loading-spinner"></div>
      <div style="margin-top:10px;">Generating AI report...</div>
    </div>
  `;
  modal.style.display = 'block';
}

modalClose.addEventListener('click', hideModal);
modalClose2.addEventListener('click', hideModal);
window.addEventListener('click', (e) => {
  if (e.target === modal) hideModal();
});

modalCopy.addEventListener('click', () => {
  const text = modalBody.textContent || modalBody.innerText;
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const originalText = modalCopy.textContent;
      modalCopy.textContent = '✓ Copied!';
      setTimeout(() => {
        modalCopy.textContent = originalText;
      }, 2000);
    })
    .catch((err) => {
      console.error('Copy failed:', err);
      alert('Failed to copy to clipboard');
    });
});

// AI Summary for current release
qs('btnAISummary').addEventListener('click', async () => {
  const release = qs('release')?.value?.trim();

  if (!release) {
    alert('Please select a release first');
    return;
  }

  showModalLoading('AI Release Summary');

  try {
    const r = await fetch(
      `/api/ai/release-summary?release=${encodeURIComponent(release)}`
    );
    const data = await r.json();

    if (!r.ok || !data.ok) {
      showModal(
        'Error',
        `<div style="color:#c62828;">${escapeHtml(
          data.error || 'Failed to generate summary'
        )}</div>`
      );
      return;
    }

    const { summary, metrics } = data;

    const healthIcon =
      metrics.overallScore?.status === 'green'
        ? '🟢'
        : metrics.overallScore?.status === 'yellow'
        ? '🟡'
        : '🔴';

    const content = `
      <div style="margin-bottom:20px;">
        <div style="font-size:18px; font-weight:600; margin-bottom:10px;">
          ${healthIcon} Release ${escapeHtml(release)}
        </div>
        <div style="display:flex; gap:20px; margin:10px 0; flex-wrap:wrap;">
          <div>
            <div class="muted" style="font-size:12px;">Health Score</div>
            <div style="font-size:24px; font-weight:700;">${
              metrics.overallScore?.value || 'N/A'
            }%</div>
          </div>
          <div>
            <div class="muted" style="font-size:12px;">Scope Stability</div>
            <div style="font-size:24px; font-weight:700;">${
              metrics.scopeStability?.value || 'N/A'
            }%</div>
          </div>
          <div>
            <div class="muted" style="font-size:12px;">QA Pass Rate</div>
            <div style="font-size:24px; font-weight:700;">${
              metrics.qaPct?.value || 'N/A'
            }%</div>
          </div>
          <div>
            <div class="muted" style="font-size:12px;">ETA</div>
            <div style="font-size:24px; font-weight:700;">${
              metrics.etaDays?.value !== null
                ? metrics.etaDays.value + 'd'
                : 'N/A'
            }</div>
          </div>
        </div>
      </div>
      <div style="border-top:2px solid #eee; padding-top:15px;">
        <div style="font-weight:600; margin-bottom:10px;">Executive Summary:</div>
        <div style="line-height:1.8; font-size:14px;">${escapeHtml(
          summary
        )}</div>
      </div>
      <div style="margin-top:20px; padding-top:15px; border-top:1px solid #eee;">
        <button onclick="loadRiskAnalysis('${escapeHtml(
          release
        )}')" style="background:#ea4335; color:white;">
          View Risk Analysis
        </button>
      </div>
    `;

    showModal(`AI Summary: ${release}`, content);
  } catch (e) {
    console.error('AI summary error:', e);
    showModal(
      'Error',
      `<div style="color:#c62828;">Failed to generate AI summary: ${escapeHtml(
        String(e)
      )}</div>`
    );
  }
});

// Risk Analysis (can be called from summary or standalone)
window.loadRiskAnalysis = async function (release) {
  showModalLoading('AI Risk Analysis');

  try {
    const r = await fetch(
      `/api/ai/risk-analysis?release=${encodeURIComponent(release)}`
    );
    const data = await r.json();

    if (!r.ok || !data.ok) {
      showModal(
        'Error',
        `<div style="color:#c62828;">${escapeHtml(
          data.error || 'Failed to generate risk analysis'
        )}</div>`
      );
      return;
    }

    const { riskAnalysis, warnings } = data;

    const warningsHtml =
      warnings && warnings.length > 0
        ? `<div style="background:#fff9e6; padding:12px; border-radius:6px; margin-bottom:15px;">
           <div style="font-weight:600; margin-bottom:5px;">⚠️ System Warnings:</div>
           ${warnings
             .map(
               (w) => `<div style="font-size:13px;">• ${escapeHtml(w)}</div>`
             )
             .join('')}
         </div>`
        : '';

    const content = `
      ${warningsHtml}
      <div style="font-weight:600; margin-bottom:10px; font-size:16px;">Risk Analysis & Recommendations:</div>
      <div style="line-height:1.8; white-space:pre-wrap;">${escapeHtml(
        riskAnalysis
      )}</div>
    `;

    showModal(`Risk Analysis: ${release}`, content);
  } catch (e) {
    console.error('Risk analysis error:', e);
    showModal(
      'Error',
      `<div style="color:#c62828;">Failed to generate risk analysis: ${escapeHtml(
        String(e)
      )}</div>`
    );
  }
};

// Executive Report (all active releases)
qs('btnExecutiveReport').addEventListener('click', async () => {
  // First, show release selector
  showModalLoading('Select Releases');

  try {
    // Fetch available releases
    const r = await fetch('/api/ai/active-releases');
    const data = await r.json();

    if (!r.ok || !data.ok) {
      showModal(
        'Error',
        `<div style="color:#c62828;">${escapeHtml(
          data.error || 'Failed to load releases'
        )}</div>`
      );
      return;
    }

    const { releases } = data;

    if (releases.length === 0) {
      showModal('No Releases', '<div>No active releases found</div>');
      return;
    }

    // Show release selector
    const selectorHtml = `
      <div style="margin-bottom:15px;">
        <p style="color:#666; font-size:14px;">Select releases to include in the executive report:</p>
      </div>
      <div style="max-height:400px; overflow-y:auto; border:1px solid #e0e0e0; border-radius:6px; padding:10px;">
        <label style="display:flex; align-items:center; padding:8px; margin-bottom:5px; cursor:pointer; border-radius:4px; background:#f9f9f9;">
          <input type="checkbox" id="selectAllReleases" style="margin-right:10px; transform:scale(1.2);" checked>
          <strong>Select All (${releases.length} releases)</strong>
        </label>
        <hr style="margin:10px 0; border:none; border-top:1px solid #e0e0e0;">
        ${releases
          .map(
            (rel) => `
          <label style="display:flex; align-items:center; padding:8px; margin-bottom:5px; cursor:pointer; border-radius:4px; transition:background 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">
            <input type="checkbox" class="release-checkbox" value="${escapeHtml(
              rel.release
            )}" style="margin-right:10px; transform:scale(1.2);" checked>
            <div style="flex:1;">
              <div style="font-weight:500;">${escapeHtml(rel.release)}</div>
              <div style="font-size:12px; color:#666;">
                ${rel.totalItems} total • ${rel.activeItems} active • ${
              rel.doneItems
            } done
              </div>
            </div>
          </label>
        `
          )
          .join('')}
      </div>
      <div style="margin-top:20px; display:flex; gap:10px; justify-content:flex-end;">
        <button id="btnCancelReport" style="background:#666; color:white;">Cancel</button>
        <button id="btnGenerateReport" style="background:#34a853; color:white;">Generate Report</button>
      </div>
    `;

    showModal('Select Releases for Executive Report', selectorHtml);

    // Add event listeners after modal is shown
    const selectAll = qs('selectAllReleases');
    const checkboxes = document.querySelectorAll('.release-checkbox');
    const btnGenerate = qs('btnGenerateReport');
    const btnCancel = qs('btnCancelReport');

    selectAll.addEventListener('change', () => {
      checkboxes.forEach((cb) => {
        cb.checked = selectAll.checked;
      });
    });

    checkboxes.forEach((cb) => {
      cb.addEventListener('change', () => {
        const allChecked = Array.from(checkboxes).every((c) => c.checked);
        selectAll.checked = allChecked;
      });
    });

    btnCancel.addEventListener('click', hideModal);

    btnGenerate.addEventListener('click', () => {
      const selectedReleases = Array.from(checkboxes)
        .filter((cb) => cb.checked)
        .map((cb) => cb.value);

      if (selectedReleases.length === 0) {
        alert('Please select at least one release');
        return;
      }

      generateExecutiveReport(selectedReleases);
    });
  } catch (e) {
    console.error('Release selector error:', e);
    showModal(
      'Error',
      `<div style="color:#c62828;">Failed to load releases: ${escapeHtml(
        String(e)
      )}</div>`
    );
  }
});

// Generate executive report with selected releases
async function generateExecutiveReport(selectedReleases) {
  showModalLoading('Generating Executive Report');

  try {
    const releasesParam = selectedReleases.join(',');
    const r = await fetch(
      `/api/ai/executive-report?format=json&releases=${encodeURIComponent(
        releasesParam
      )}`
    );
    const data = await r.json();

    if (!r.ok || !data.ok) {
      showModal(
        'Error',
        `<div style="color:#c62828;">${escapeHtml(
          data.error || 'Failed to generate executive report'
        )}</div>`
      );
      return;
    }

    const { overview, releases, portfolioRisks } = data;

    const overviewHtml = `
      <div style="background:#f5f5f5; padding:15px; border-radius:8px; margin-bottom:20px;">
        <div style="font-size:18px; font-weight:600; margin-bottom:10px;">Portfolio Overview</div>
        <div style="display:flex; gap:20px; flex-wrap:wrap;">
          <div>
            <div class="muted" style="font-size:12px;">Total Releases</div>
            <div style="font-size:24px; font-weight:700;">${overview.total}</div>
          </div>
          <div>
            <div class="muted" style="font-size:12px;">On Track</div>
            <div style="font-size:24px; font-weight:700; color:#2e7d32;">${overview.onTrack} (${overview.onTrackPct}%)</div>
          </div>
          <div>
            <div class="muted" style="font-size:12px;">At Risk</div>
            <div style="font-size:24px; font-weight:700; color:#e65100;">${overview.atRisk} (${overview.atRiskPct}%)</div>
          </div>
          <div>
            <div class="muted" style="font-size:12px;">Critical</div>
            <div style="font-size:24px; font-weight:700; color:#c62828;">${overview.critical} (${overview.criticalPct}%)</div>
          </div>
        </div>
      </div>
    `;

    const releasesHtml = releases
      .map((rel) => {
        const icon =
          rel.status === 'green' ? '🟢' : rel.status === 'yellow' ? '🟡' : '🔴';
        const statusLabel =
          rel.status === 'green'
            ? 'ON TRACK'
            : rel.status === 'yellow'
            ? 'AT RISK'
            : 'CRITICAL';
        const statusColor =
          rel.status === 'green'
            ? '#2e7d32'
            : rel.status === 'yellow'
            ? '#e65100'
            : '#c62828';

        return `
        <div style="border: 1px solid #e0e0e0; border-radius:8px; padding:15px; margin-bottom:15px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <div style="font-size:16px; font-weight:600;">${icon} ${escapeHtml(
          rel.release
        )}</div>
            <div style="background:${statusColor}; color:white; padding:4px 12px; border-radius:12px; font-size:12px; font-weight:600;">
              ${statusLabel}
            </div>
          </div>
          <div style="color:#666; font-size:13px; margin-bottom:8px;">Health: ${
            rel.health
          }%</div>
          <div style="line-height:1.6; font-size:14px;">${escapeHtml(
            rel.summary
          )}</div>
        </div>
      `;
      })
      .join('');

    const risksHtml = `
      <div style="background:#fdecea; padding:15px; border-radius:8px; border:1px solid #f44336;">
        <div style="font-size:16px; font-weight:600; margin-bottom:10px; color:#c62828;">🔴 Top Portfolio Risks</div>
        <div style="line-height:1.8; white-space:pre-wrap; font-size:14px;">${escapeHtml(
          portfolioRisks
        )}</div>
      </div>
    `;

    const content = `
      ${overviewHtml}
      <div style="font-size:18px; font-weight:600; margin:20px 0 10px 0;">Release Summaries</div>
      ${releasesHtml}
      ${risksHtml}
      <div style="margin-top:20px; padding-top:15px; border-top:1px solid #eee; text-align:center;">
        <a href="/api/ai/executive-report?format=text" target="_blank" style="color:#4285f4; text-decoration:none;">
          📄 Download as Plain Text
        </a>
      </div>
    `;

    showModal('Weekly Executive Report', content);
  } catch (e) {
    console.error('Executive report error:', e);
    showModal(
      'Error',
      `<div style="color:#c62828;">Failed to generate executive report: ${escapeHtml(
        String(e)
      )}</div>`
    );
  }
}

// Release Radar Executive Report (cherry-pick releases)
qs('btnRadarReport')?.addEventListener('click', async () => {
  // First, fetch available releases from Release Radar
  showModalLoading('Loading Releases');

  try {
    // Get all release radar data
    const r = await fetch('/api/release-health');
    const data = await r.json();

    if (!r.ok || !data.ok) {
      showModal(
        'Error',
        `<div style="color:#c62828;">${escapeHtml(
          data.error || 'Failed to load releases'
        )}</div>`
      );
      return;
    }

    const releases = data.rows || [];

    if (releases.length === 0) {
      showModal('No Releases', '<div>No release radar data found</div>');
      return;
    }

    // Show release selector with Release Radar metrics
    const selectorHtml = `
      <div style="margin-bottom:15px;">
        <p style="color:#666; font-size:14px;">Select releases to include in the Release Radar executive report:</p>
      </div>
      <div style="max-height:400px; overflow-y:auto; border:1px solid #e0e0e0; border-radius:6px; padding:10px;">
        <label style="display:flex; align-items:center; padding:8px; margin-bottom:5px; cursor:pointer; border-radius:4px; background:#f9f9f9;">
          <input type="checkbox" id="selectAllRadarReleases" style="margin-right:10px; transform:scale(1.2);" checked>
          <strong>Select All (${releases.length} releases)</strong>
        </label>
        <hr style="margin:10px 0; border:none; border-top:1px solid #e0e0e0;">
        ${releases
          .map((rel) => {
            const icon =
              rel.confidencePct >= 80
                ? '🟢'
                : rel.confidencePct >= 60
                ? '🟡'
                : '🔴';
            return `
          <label style="display:flex; align-items:center; padding:8px; margin-bottom:5px; cursor:pointer; border-radius:4px; transition:background 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">
            <input type="checkbox" class="radar-release-checkbox" value="${escapeHtml(
              rel.release
            )}" style="margin-right:10px; transform:scale(1.2);" checked>
            <div style="flex:1;">
              <div style="font-weight:500;">${icon} ${escapeHtml(
              rel.release
            )} <span style="font-size:12px; color:#666;">(${escapeHtml(
              rel.project
            )})</span></div>
              <div style="font-size:12px; color:#666;">
                Confidence: ${rel.confidencePct}% • QA: ${
              rel.qaPct || 0
            }% • Priorities: ${rel.critical || 0}C/${rel.high || 0}H/${
              rel.medium || 0
            }M/${rel.low || 0}L
              </div>
            </div>
          </label>
        `;
          })
          .join('')}
      </div>
      <div style="margin-top:20px; display:flex; gap:10px; justify-content:flex-end;">
        <button id="btnCancelRadarReport" style="background:#666; color:white;">Cancel</button>
        <button id="btnGenerateRadarReport" style="background:#34a853; color:white;">Generate Report</button>
      </div>
    `;

    showModal('Select Releases for Release Radar Report', selectorHtml);

    // Add event listeners after modal is shown
    const selectAll = qs('selectAllRadarReleases');
    const checkboxes = document.querySelectorAll('.radar-release-checkbox');
    const btnGenerate = qs('btnGenerateRadarReport');
    const btnCancel = qs('btnCancelRadarReport');

    selectAll.addEventListener('change', () => {
      checkboxes.forEach((cb) => {
        cb.checked = selectAll.checked;
      });
    });

    checkboxes.forEach((cb) => {
      cb.addEventListener('change', () => {
        const allChecked = Array.from(checkboxes).every((c) => c.checked);
        selectAll.checked = allChecked;
      });
    });

    btnCancel.addEventListener('click', hideModal);

    btnGenerate.addEventListener('click', () => {
      const selectedReleases = Array.from(checkboxes)
        .filter((cb) => cb.checked)
        .map((cb) => cb.value);

      if (selectedReleases.length === 0) {
        alert('Please select at least one release');
        return;
      }

      generateReleaseRadarReport(selectedReleases);
    });
  } catch (e) {
    console.error('Release Radar selector error:', e);
    showModal(
      'Error',
      `<div style="color:#c62828;">Failed to load releases: ${escapeHtml(
        String(e)
      )}</div>`
    );
  }
});

// Generate Release Radar report with AI insights
async function generateReleaseRadarReport(selectedReleases) {
  showModalLoading('Generating Release Radar Report');

  try {
    const releasesParam = selectedReleases.join(',');
    const r = await fetch(
      `/api/ai/release-radar-report?releases=${encodeURIComponent(
        releasesParam
      )}`
    );
    const data = await r.json();

    if (!r.ok || !data.ok) {
      showModal(
        'Error',
        `<div style="color:#c62828;">${escapeHtml(
          data.error || 'Failed to generate Release Radar report'
        )}</div>`
      );
      return;
    }

    const { summary, releases } = data;
    const sanitizedSummary = sanitizeAiHtml(summary);

    const content = `
      <div class="ai-report">
        ${sanitizedSummary}
      </div>
      <div style="margin-top:20px; padding-top:15px; border-top:1px solid #eee; display:flex; justify-content:space-between; align-items:center;">
        <div style="font-size:12px; color:#666;">
          Generated: ${new Date().toLocaleString()}
        </div>
        <div style="display:flex; gap:8px;">
          <button id="btnCopyRadarReport" style="background:#4285f4; color:white; border:none; padding:8px 16px; border-radius:4px; cursor:pointer;">
            📋 Copy HTML
          </button>
          <button id="btnPrintRadarReport" style="background:#34a853; color:white; border:none; padding:8px 16px; border-radius:4px; cursor:pointer;">
            🖨️ Print/PDF
          </button>
        </div>
      </div>
    `;

    showModal('📊 Release Radar Executive Report', content);

    // Add copy functionality (HTML format)
    const copyBtn = qs('btnCopyRadarReport');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        // Copy HTML to clipboard for pasting into email
        const htmlContent = sanitizedSummary;

        // Try to copy as HTML first (for rich text paste)
        const blob = new Blob([htmlContent], { type: 'text/html' });
        const clipboardItem = new ClipboardItem({ 'text/html': blob });

        navigator.clipboard
          .write([clipboardItem])
          .then(() => {
            const btn = qs('btnCopyRadarReport');
            const orig = btn.textContent;
            btn.textContent = '✓ Copied!';
            setTimeout(() => {
              btn.textContent = orig;
            }, 2000);
          })
          .catch((err) => {
            console.error('Copy failed:', err);
            alert('Failed to copy to clipboard');
          });
      });
    }

    // Add print/PDF functionality
    const printBtn = qs('btnPrintRadarReport');
    if (printBtn) {
      printBtn.addEventListener('click', () => {
        const printWindow = window.open('', '_blank');
        const printContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Release Radar Report - ${new Date().toLocaleDateString()}</title>
          <style>
            body {
              font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
              padding: 20px;
              color: #1f2933;
            }
            .ai-report {
              font-size: 14px;
              line-height: 1.7;
            }
            .ai-report h2 {
              margin: 0 0 12px;
              font-size: 20px;
              color: #0f172a;
            }
            .ai-report h3 {
              margin: 18px 0 8px;
              font-size: 16px;
              color: #0f172a;
            }
            .ai-report p {
              margin: 0 0 10px;
            }
            .ai-report table {
              border-collapse: collapse;
              width: 100%;
              margin: 12px 0 18px;
            }
            .ai-report th,
            .ai-report td {
              border: 1px solid #e2e8f0;
              padding: 8px 10px;
              text-align: left;
              vertical-align: top;
              font-size: 13px;
            }
            .ai-report th {
              background-color: #f5f7fb;
              font-weight: 600;
              text-transform: uppercase;
              letter-spacing: 0.3px;
              font-size: 11px;
            }
            .ai-report tbody tr:nth-child(even) {
              background: #fafafa;
            }
            @media print {
              button { display: none; }
            }
          </style>
        </head>
        <body>
          <div class="ai-report">
            ${sanitizedSummary}
          </div>
          <div style="margin-top:30px; padding-top:15px; border-top:2px solid #ddd; font-size:12px; color:#666;">
            Generated: ${new Date().toLocaleString()}
          </div>
        </body>
        </html>
      `;
        printWindow.document.write(printContent);
        printWindow.document.close();
        printWindow.focus();
        setTimeout(() => {
          printWindow.print();
        }, 250);
      });
    }
  } catch (e) {
    console.error('Release Radar report error:', e);
    showModal(
      'Error',
      `<div style="color:#c62828;">Failed to generate Release Radar report: ${escapeHtml(
        String(e)
      )}</div>`
    );
  }
}
