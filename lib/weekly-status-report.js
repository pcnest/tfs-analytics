const fs = require('fs');
const ExcelJS = require('exceljs');

const CONFIG_SCHEMA_VERSION = 1;
const MAX_REPORT_ROWS = 2000;
const REQUIRED_COLUMN_KEYS = [
  'version',
  'workItemId',
  'type',
  'title',
  'state',
  'remark',
];
const WORK_ITEM_TYPE_ORDER = new Map([
  ['Product Backlog Item', 0],
  ['PBI', 0],
  ['Bug', 1],
  ['Task', 2],
]);
const VERSION_COLLATOR = new Intl.Collator('en-US', {
  numeric: true,
  sensitivity: 'base',
});
const TEXT_COLLATOR = new Intl.Collator('en-US', {
  sensitivity: 'base',
});

const WORK_ITEMS_SQL = `
  SELECT
    work_item_id AS "workItemId",
    type,
    title,
    state,
    release,
    area_path AS "areaPath",
    feature_id AS "featureId",
    feature,
    tags
  FROM tfs_workitems_analytics
  WHERE is_deleted = FALSE
    AND area_path = $1
  ORDER BY work_item_id
  LIMIT $2
`;

class ReportRowLimitError extends Error {
  constructor(limit) {
    super(`Report row limit exceeded (${limit})`);
    this.name = 'ReportRowLimitError';
    this.limit = limit;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateWorksheetName(name) {
  return (
    typeof name === 'string' &&
    name.trim() !== '' &&
    name.length <= 31 &&
    !/[\\/\?\*\[\]:]/.test(name)
  );
}

function validateReportConfig(config) {
  const errors = [];

  if (!isPlainObject(config)) {
    return { ok: false, errors: ['Configuration must be an object'] };
  }
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CONFIG_SCHEMA_VERSION}`);
  }
  if (!isPlainObject(config.layouts) || Object.keys(config.layouts).length === 0) {
    errors.push('layouts must contain at least one layout');
  }

  for (const [layoutKey, layout] of Object.entries(config.layouts || {})) {
    const prefix = `layouts.${layoutKey}`;
    if (!isPlainObject(layout)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (!isPlainObject(layout.tab) || !validateWorksheetName(layout.tab.name)) {
      errors.push(`${prefix}.tab.name must be a valid Excel worksheet name`);
    }
    if (!layout.tab || typeof layout.tab.key !== 'string' || !layout.tab.key.trim()) {
      errors.push(`${prefix}.tab.key is required`);
    }
    if (!isPlainObject(layout.source) || typeof layout.source.areaPath !== 'string' || !layout.source.areaPath.trim()) {
      errors.push(`${prefix}.source.areaPath is required`);
    }
    if (!layout.source || layout.source.match !== 'exact') {
      errors.push(`${prefix}.source.match must be "exact"`);
    }
    if (!Number.isInteger(layout.rowLimit) || layout.rowLimit < 1 || layout.rowLimit > MAX_REPORT_ROWS) {
      errors.push(`${prefix}.rowLimit must be an integer from 1 to ${MAX_REPORT_ROWS}`);
    }
    if (
      !isPlainObject(layout.grouping) ||
      JSON.stringify(layout.grouping.levels) !== JSON.stringify(['release', 'feature'])
    ) {
      errors.push(`${prefix}.grouping.levels must be ["release", "feature"]`);
    }
    if (!layout.grouping || layout.grouping.includeStandaloneItems !== true) {
      errors.push(`${prefix}.grouping.includeStandaloneItems must be true`);
    }

    if (!Array.isArray(layout.columns) || layout.columns.length !== REQUIRED_COLUMN_KEYS.length) {
      errors.push(`${prefix}.columns must contain exactly ${REQUIRED_COLUMN_KEYS.length} columns`);
      continue;
    }
    const keys = layout.columns.map((column) => column && column.key);
    if (JSON.stringify(keys) !== JSON.stringify(REQUIRED_COLUMN_KEYS)) {
      errors.push(`${prefix}.columns must use the required keys in report order`);
    }
    for (const [index, column] of layout.columns.entries()) {
      if (!isPlainObject(column) || typeof column.header !== 'string' || !column.header.trim()) {
        errors.push(`${prefix}.columns[${index}].header is required`);
      }
      if (!isPlainObject(column) || !Number.isFinite(column.width) || column.width < 1 || column.width > 255) {
        errors.push(`${prefix}.columns[${index}].width must be between 1 and 255`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function loadReportConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  const validation = validateReportConfig(config);
  if (!validation.ok) {
    throw new Error(`Invalid weekly report configuration: ${validation.errors.join('; ')}`);
  }
  return config;
}

function getLayout(config, layoutKey) {
  if (!config || !config.layouts || !layoutKey) return null;
  return config.layouts[layoutKey] || null;
}

async function fetchWeeklyStatusItems(pool, layout) {
  const limit = Math.min(layout.rowLimit, MAX_REPORT_ROWS);
  const result = await pool.query(WORK_ITEMS_SQL, [
    layout.source.areaPath,
    limit + 1,
  ]);
  if (result.rows.length > limit) {
    throw new ReportRowLimitError(limit);
  }
  return result.rows;
}

function normalizeWorkItemType(type) {
  return type === 'Product Backlog Item' ? 'PBI' : String(type || '');
}

function compareReleases(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return VERSION_COLLATOR.compare(left, right);
}

function compareWorkItems(left, right) {
  const leftOrder = WORK_ITEM_TYPE_ORDER.get(left.type) ?? 99;
  const rightOrder = WORK_ITEM_TYPE_ORDER.get(right.type) ?? 99;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return Number(left.workItemId || 0) - Number(right.workItemId || 0);
}

function normalizeSourceRow(row) {
  return {
    workItemId: Number(row.workItemId),
    type: String(row.type || ''),
    title: String(row.title || ''),
    state: String(row.state || ''),
    release: row.release === null || row.release === undefined || String(row.release).trim() === ''
      ? null
      : String(row.release).trim(),
    areaPath: row.areaPath === null || row.areaPath === undefined ? null : String(row.areaPath),
    featureId: row.featureId === null || row.featureId === undefined || row.featureId === ''
      ? null
      : Number(row.featureId),
    feature: row.feature === null || row.feature === undefined ? null : String(row.feature),
    tags: row.tags === null || row.tags === undefined ? null : String(row.tags),
  };
}

function buildReportModel(rows, layout) {
  const uniqueRows = new Map();
  for (const sourceRow of rows || []) {
    const row = normalizeSourceRow(sourceRow);
    if (!Number.isInteger(row.workItemId) || row.workItemId <= 0) continue;
    if (!uniqueRows.has(row.workItemId)) uniqueRows.set(row.workItemId, row);
  }

  const featureCatalog = new Map();
  for (const row of uniqueRows.values()) {
    if (row.type === 'Feature') {
      featureCatalog.set(row.workItemId, {
        featureId: row.workItemId,
        featureTitle: row.title,
        featureRow: row,
      });
    }
  }

  const releaseMap = new Map();
  const getReleaseBucket = (release) => {
    const key = release === null ? '__NO_RELEASE__' : release;
    if (!releaseMap.has(key)) {
      releaseMap.set(key, {
        release,
        featureMap: new Map(),
        standaloneItems: [],
      });
    }
    return releaseMap.get(key);
  };

  const featureIdsWithChildren = new Set();
  for (const row of uniqueRows.values()) {
    if (row.type === 'Feature') continue;
    const releaseBucket = getReleaseBucket(row.release);
    if (Number.isInteger(row.featureId) && row.featureId > 0) {
      const key = String(row.featureId);
      featureIdsWithChildren.add(row.featureId);
      if (!releaseBucket.featureMap.has(key)) {
        const knownFeature = featureCatalog.get(row.featureId);
        releaseBucket.featureMap.set(key, {
          featureId: row.featureId,
          featureTitle: row.feature || knownFeature?.featureTitle || `Feature ${row.featureId}`,
          featureRow: knownFeature?.featureRow || null,
          items: [],
        });
      }
      releaseBucket.featureMap.get(key).items.push(row);
      continue;
    }

    releaseBucket.standaloneItems.push(row);
  }

  for (const feature of featureCatalog.values()) {
    const key = String(feature.featureId);
    if (featureIdsWithChildren.has(feature.featureId)) {
      for (const bucket of releaseMap.values()) {
        const existing = bucket.featureMap.get(key);
        if (existing) {
          existing.featureTitle = feature.featureTitle;
          existing.featureRow = feature.featureRow;
        }
      }
      continue;
    }

    const releaseBucket = getReleaseBucket(feature.featureRow.release);
    releaseBucket.featureMap.set(key, {
      ...feature,
      items: [],
    });
  }

  const releases = [...releaseMap.values()]
    .sort((left, right) => compareReleases(left.release, right.release))
    .map((bucket) => {
      const features = [...bucket.featureMap.values()]
        .map((feature) => ({
          ...feature,
          items: feature.items.sort(compareWorkItems),
        }))
        .sort((left, right) => {
          const titleComparison = TEXT_COLLATOR.compare(
            left.featureTitle || '',
            right.featureTitle || '',
          );
          if (titleComparison !== 0) return titleComparison;
          return Number(left.featureId || 0) - Number(right.featureId || 0);
        });
      return {
        release: bucket.release,
        features,
        standaloneItems: bucket.standaloneItems.sort(compareWorkItems),
      };
    });

  return {
    tabName: layout.tab.name,
    columns: layout.columns,
    sourceRowCount: uniqueRows.size,
    releases,
  };
}

function buildWorkItemUrl(template, workItemId) {
  if (!template || !String(template).includes('{id}')) return null;
  return String(template).replace('{id}', encodeURIComponent(String(workItemId)));
}

function setWorkItemIdCell(cell, workItemId, urlTemplate) {
  const url = buildWorkItemUrl(urlTemplate, workItemId);
  if (url) {
    cell.value = {
      text: String(workItemId),
      hyperlink: url,
      tooltip: `Open TFS work item ${workItemId}`,
    };
    cell.font = { color: { argb: 'FF0563C1' }, underline: true };
  } else {
    cell.value = workItemId;
  }
  cell.alignment = { horizontal: 'center', vertical: 'top', wrapText: true };
}

function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0070C0' },
    };
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
    cell.alignment = {
      horizontal: 'center',
      vertical: 'top',
      wrapText: true,
    };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFB4C7E7' } },
      left: { style: 'thin', color: { argb: 'FFB4C7E7' } },
      bottom: { style: 'thin', color: { argb: 'FFB4C7E7' } },
      right: { style: 'thin', color: { argb: 'FFB4C7E7' } },
    };
  });
}

function styleDetailRow(row) {
  row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    const centered = columnNumber === 1 || columnNumber === 2;
    cell.alignment = {
      horizontal: centered ? 'center' : 'left',
      vertical: 'top',
      wrapText: true,
    };
  });
  row.getCell(6).font = { italic: true };
}

function addReleaseHeader(worksheet, release) {
  const displayRelease = release || '-';
  const row = worksheet.addRow([displayRelease, '', '', `Release ${displayRelease}`, '', '']);
  row.getCell(1).font = { bold: true, italic: true };
  row.getCell(4).font = { bold: true, italic: true };
  row.getCell(1).alignment = { horizontal: 'center', vertical: 'center' };
  row.getCell(4).alignment = { vertical: 'center', wrapText: true };
}

function addFeatureHeader(worksheet, feature, urlTemplate) {
  const row = worksheet.addRow([
    '',
    feature.featureId || '',
    'Feature',
    feature.featureTitle || '',
    '',
    '',
  ]);
  if (feature.featureId) setWorkItemIdCell(row.getCell(2), feature.featureId, urlTemplate);
  for (const columnNumber of [2, 3, 4]) {
    const cell = row.getCell(columnNumber);
    cell.font = { ...cell.font, bold: true, italic: true };
    cell.alignment = {
      horizontal: columnNumber === 2 ? 'center' : 'left',
      vertical: 'top',
      wrapText: true,
    };
  }
}

function addDetailRow(worksheet, item, urlTemplate) {
  const row = worksheet.addRow([
    item.release || '-',
    item.workItemId,
    normalizeWorkItemType(item.type),
    item.title,
    item.state,
    '',
  ]);
  styleDetailRow(row);
  setWorkItemIdCell(row.getCell(2), item.workItemId, urlTemplate);
}

async function renderWorkbookBuffer(model, options = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TFS Analytics';
  workbook.created = options.generatedAt || new Date();
  workbook.modified = options.generatedAt || new Date();

  const worksheet = workbook.addWorksheet(model.tabName, {
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: {
        left: 0.7,
        right: 0.7,
        top: 0.75,
        bottom: 0.75,
        header: 0.3,
        footer: 0.3,
      },
    },
  });

  worksheet.columns = model.columns.map((column) => ({
    key: column.key,
    width: column.width,
  }));
  worksheet.getRow(1).height = 5;
  const headerRow = worksheet.getRow(2);
  headerRow.values = model.columns.map((column) => column.header);
  styleHeaderRow(headerRow);

  for (const release of model.releases) {
    addReleaseHeader(worksheet, release.release);
    for (const feature of release.features) {
      addFeatureHeader(worksheet, feature, options.tfsWorkItemUrlTemplate);
      for (const item of feature.items) {
        addDetailRow(worksheet, item, options.tfsWorkItemUrlTemplate);
      }
      worksheet.addRow([]);
    }
    if (release.standaloneItems.length > 0) {
      const standaloneHeader = worksheet.addRow(['', '', '', 'Standalone Items', '', '']);
      standaloneHeader.getCell(4).font = { bold: true, italic: true };
      standaloneHeader.getCell(4).alignment = { vertical: 'top', wrapText: true };
      for (const item of release.standaloneItems) {
        addDetailRow(worksheet, item, options.tfsWorkItemUrlTemplate);
      }
      worksheet.addRow([]);
    }
  }

  const output = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

function formatPacificFileDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.month}${values.day}${values.year}`;
}

function buildReportFilename(tabName, generatedAt = new Date()) {
  const safeTabName = String(tabName || 'Report').replace(/[^A-Za-z0-9_-]+/g, '');
  return `StatusReport-${safeTabName}-${formatPacificFileDate(generatedAt)}.xlsx`;
}

module.exports = {
  MAX_REPORT_ROWS,
  WORK_ITEMS_SQL,
  ReportRowLimitError,
  validateReportConfig,
  loadReportConfig,
  getLayout,
  fetchWeeklyStatusItems,
  normalizeWorkItemType,
  compareReleases,
  buildReportModel,
  buildWorkItemUrl,
  renderWorkbookBuffer,
  formatPacificFileDate,
  buildReportFilename,
};
