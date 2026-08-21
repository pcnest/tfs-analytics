const ExcelJS = require('exceljs');

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
const FEATURE_ROW_FILL = 'FFEAF3F8';
const FEATURE_ROW_BORDER = 'FFBDD7EE';
const SUMMARY_BAND_FILL = 'FFD9EAF7';
const SUMMARY_TEXT_COLOR = 'FF1F4E78';
const STATUS_FILLS = new Map([
  ['on-hold', 'FFF4CCCC'],
  ['shelved', 'FFE7E6E6'],
  ['ready for qa', 'FFE2F0D9'],
  ['resolved', 'FFE2F0D9'],
  ['re-opened', 'FFFFF2CC'],
]);

class InvalidPlacementPreviewError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidPlacementPreviewError';
  }
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeWorkItemType(type) {
  return type === 'Product Backlog Item' ? 'PBI' : String(type || '');
}

function normalizeRelease(value) {
  return value === null || value === undefined || String(value).trim() === ''
    ? null
    : String(value).trim();
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

function compareWorkItemsByRelease(left, right) {
  const releaseComparison = compareReleases(
    normalizeRelease(left.release),
    normalizeRelease(right.release),
  );
  if (releaseComparison !== 0) return releaseComparison;
  return compareWorkItems(left, right);
}

function compareFeatures(left, right) {
  const titleComparison = TEXT_COLLATOR.compare(
    left.featureTitle || '',
    right.featureTitle || '',
  );
  if (titleComparison !== 0) return titleComparison;
  return Number(left.featureId || 0) - Number(right.featureId || 0);
}

function buildSectionModel(placements, featureCatalog) {
  const featureRows = new Map();
  for (const placement of placements) {
    if (placement.type === 'Feature') {
      featureRows.set(Number(placement.workItemId), placement);
    }
  }

  const releaseMap = new Map();
  const getReleaseBucket = (release) => {
    const normalizedRelease = normalizeRelease(release);
    const key = normalizedRelease === null ? '__NO_RELEASE__' : normalizedRelease;
    if (!releaseMap.has(key)) {
      releaseMap.set(key, {
        release: normalizedRelease,
        featureMap: new Map(),
        standaloneItems: [],
      });
    }
    return releaseMap.get(key);
  };

  const featureIdsWithChildren = new Set();
  for (const placement of placements) {
    if (placement.type === 'Feature') continue;
    const releaseBucket = getReleaseBucket(placement.release);
    const featureId = Number(placement.featureId);
    if (Number.isInteger(featureId) && featureId > 0) {
      featureIdsWithChildren.add(featureId);
      const key = String(featureId);
      if (!releaseBucket.featureMap.has(key)) {
        const knownFeature = featureRows.get(featureId) || featureCatalog.get(featureId);
        releaseBucket.featureMap.set(key, {
          featureId,
          featureTitle: placement.feature || knownFeature?.title || `Feature ${featureId}`,
          items: [],
        });
      }
      releaseBucket.featureMap.get(key).items.push(placement);
    } else {
      releaseBucket.standaloneItems.push(placement);
    }
  }

  for (const feature of featureRows.values()) {
    if (featureIdsWithChildren.has(feature.workItemId)) {
      for (const bucket of releaseMap.values()) {
        const existing = bucket.featureMap.get(String(feature.workItemId));
        if (existing) existing.featureTitle = feature.title;
      }
      continue;
    }
    const releaseBucket = getReleaseBucket(feature.release);
    releaseBucket.featureMap.set(String(feature.workItemId), {
      featureId: feature.workItemId,
      featureTitle: feature.title,
      items: [],
    });
  }

  return [...releaseMap.values()]
    .sort((left, right) => compareReleases(left.release, right.release))
    .map((bucket) => ({
      release: bucket.release,
      features: [...bucket.featureMap.values()]
        .map((feature) => ({
          ...feature,
          items: feature.items.sort(compareWorkItems),
        }))
        .sort(compareFeatures),
      standaloneItems: bucket.standaloneItems.sort(compareWorkItems),
    }));
}

function buildFeatureSectionModel(placements, featureCatalog) {
  const featureRows = new Map();
  for (const placement of placements) {
    if (placement.type === 'Feature') {
      featureRows.set(Number(placement.workItemId), placement);
    }
  }

  const featureMap = new Map();
  const standaloneItems = [];
  const getFeatureBucket = (featureId, featureTitle) => {
    const key = String(featureId);
    const fallbackTitle = `Feature ${featureId}`;
    if (!featureMap.has(key)) {
      featureMap.set(key, {
        featureId,
        featureTitle: featureTitle || fallbackTitle,
        items: [],
      });
    } else if (
      featureTitle &&
      (!featureMap.get(key).featureTitle || featureMap.get(key).featureTitle === fallbackTitle)
    ) {
      featureMap.get(key).featureTitle = featureTitle;
    }
    return featureMap.get(key);
  };

  for (const placement of placements) {
    if (placement.type === 'Feature') continue;
    const featureId = Number(placement.featureId);
    if (Number.isInteger(featureId) && featureId > 0) {
      const knownFeature = featureRows.get(featureId) || featureCatalog.get(featureId);
      getFeatureBucket(
        featureId,
        placement.feature || knownFeature?.title || `Feature ${featureId}`,
      ).items.push(placement);
    } else {
      standaloneItems.push(placement);
    }
  }

  for (const feature of featureRows.values()) {
    const featureId = Number(feature.workItemId);
    const featureBucket = getFeatureBucket(featureId, feature.title);
    featureBucket.featureTitle = feature.title || featureBucket.featureTitle;
  }

  return {
    features: [...featureMap.values()]
      .map((feature) => ({
        ...feature,
        items: feature.items.sort(compareWorkItemsByRelease),
      }))
      .sort(compareFeatures),
    standaloneItems: standaloneItems.sort(compareWorkItemsByRelease),
  };
}

function getGroupingMode(levels) {
  const signature = JSON.stringify(levels);
  if (signature === JSON.stringify(['release', 'feature'])) return 'release-feature';
  if (signature === JSON.stringify(['feature'])) return 'feature';
  return null;
}

function buildWorkbookModel(layout, preview) {
  if (!preview?.validation?.validForExport) {
    throw new InvalidPlacementPreviewError('Placement preview is not valid for export.');
  }
  if (preview.placementsTruncated) {
    throw new InvalidPlacementPreviewError('Placement preview is truncated.');
  }
  if (!Array.isArray(preview.placements)) {
    throw new InvalidPlacementPreviewError('Placement preview does not contain placement rows.');
  }
  if (Number(preview.summary?.placedCount) !== preview.placements.length) {
    throw new InvalidPlacementPreviewError('Placement preview count does not match its placement rows.');
  }

  const featureCatalog = new Map(
    preview.placements
      .filter((placement) => placement.type === 'Feature')
      .map((placement) => [Number(placement.workItemId), placement]),
  );
  const placementsByDestination = new Map();
  for (const placement of preview.placements) {
    const destinationKey = `${normalizeKey(placement.target?.tabKey)}::${normalizeKey(placement.target?.sectionKey)}`;
    if (!placementsByDestination.has(destinationKey)) placementsByDestination.set(destinationKey, []);
    placementsByDestination.get(destinationKey).push(placement);
  }

  const tabs = [...layout.tabs]
    .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
    .map((tab) => ({
      key: tab.key,
      name: tab.name,
      order: tab.order,
      sections: [...tab.sections]
        .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
        .map((section) => {
          const destinationKey = `${normalizeKey(tab.key)}::${normalizeKey(section.key)}`;
          const groupingMode = getGroupingMode(section.grouping?.levels);
          if (!groupingMode) {
            throw new InvalidPlacementPreviewError(
              `Unsupported grouping for '${tab.key}/${section.key}'.`,
            );
          }
          const sectionPlacements = placementsByDestination.get(destinationKey) || [];
          const groupingModel = groupingMode === 'feature'
            ? buildFeatureSectionModel(sectionPlacements, featureCatalog)
            : { releases: buildSectionModel(sectionPlacements, featureCatalog) };
          return {
            key: section.key,
            name: section.name,
            order: section.order,
            groupingMode,
            releases: groupingModel.releases || [],
            features: groupingModel.features || [],
            standaloneItems: groupingModel.standaloneItems || [],
          };
        }),
    }));

  const knownDestinations = new Set(
    tabs.flatMap((tab) => tab.sections.map((section) => (
      `${normalizeKey(tab.key)}::${normalizeKey(section.key)}`
    ))),
  );
  for (const destinationKey of placementsByDestination.keys()) {
    if (!knownDestinations.has(destinationKey)) {
      throw new InvalidPlacementPreviewError(`Unknown placement destination '${destinationKey}'.`);
    }
  }

  return { columns: layout.columns, tabs };
}

function buildWorkItemUrl(template, workItemId) {
  if (!template || !String(template).includes('{id}')) return null;
  return String(template).replace('{id}', encodeURIComponent(String(workItemId)));
}

function formatCount(value, singular, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function isMissingRelease(value) {
  const normalized = normalizeRelease(value);
  return normalized === null || normalized === '-';
}

function collectTabSummary(tab) {
  const featureIds = new Set();
  const items = [];

  for (const section of tab.sections) {
    if (section.groupingMode === 'feature') {
      for (const feature of section.features) {
        if (feature.featureId) featureIds.add(Number(feature.featureId));
        items.push(...feature.items);
      }
      items.push(...section.standaloneItems);
      continue;
    }

    for (const release of section.releases) {
      for (const feature of release.features) {
        if (feature.featureId) featureIds.add(Number(feature.featureId));
        items.push(...feature.items);
      }
      items.push(...release.standaloneItems);
    }
  }

  return {
    itemCount: items.length,
    featureCount: featureIds.size,
    missingReleaseCount: items.filter((item) => isMissingRelease(item.release)).length,
  };
}

function formatPacificReportDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(value);
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

function addTabSummaryBand(worksheet, tab, generatedAt, columnCount) {
  const summary = collectTabSummary(tab);
  const sectionLabel = tab.sections.length === 1
    ? tab.sections[0].name
    : 'Weekly Items';
  const reportDate = formatPacificReportDate(generatedAt);
  const row = worksheet.addRow([
    `${tab.name} — ${sectionLabel} — ${reportDate}\n${formatCount(summary.itemCount, 'item')} · ${formatCount(summary.featureCount, 'Feature')} · ${summary.missingReleaseCount} without release`,
  ]);
  worksheet.mergeCells(row.number, 1, row.number, columnCount);
  row.height = 34;
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: SUMMARY_BAND_FILL },
    };
    cell.border = {
      top: { style: 'thin', color: { argb: FEATURE_ROW_BORDER } },
      bottom: { style: 'thin', color: { argb: FEATURE_ROW_BORDER } },
    };
  });
  row.getCell(1).font = { bold: true, color: { argb: SUMMARY_TEXT_COLOR } };
  row.getCell(1).alignment = {
    horizontal: 'center',
    vertical: 'middle',
    wrapText: true,
  };
}

function addSectionHeader(worksheet, sectionName) {
  const row = worksheet.addRow(['', '', '', sectionName, '', '']);
  row.getCell(4).font = { bold: true, color: { argb: SUMMARY_TEXT_COLOR } };
  row.getCell(4).alignment = { vertical: 'center', wrapText: true };
}

function addReleaseHeader(worksheet, release) {
  const displayRelease = release || '-';
  const row = worksheet.addRow([displayRelease, '', '', `Release ${displayRelease}`, '', '']);
  row.getCell(1).font = { bold: true, italic: true };
  row.getCell(4).font = { bold: true, italic: true };
  row.getCell(1).alignment = { horizontal: 'center', vertical: 'center' };
  row.getCell(4).alignment = { vertical: 'center', wrapText: true };
}

function buildFeatureSummary(feature) {
  const releases = new Set(
    feature.items
      .map((item) => normalizeRelease(item.release))
      .filter((release) => release && release !== '-'),
  );
  const onHoldCount = feature.items.filter(
    (item) => normalizeKey(item.state) === 'on-hold',
  ).length;
  const parts = [
    formatCount(feature.items.length, 'item'),
    formatCount(releases.size, 'release'),
  ];
  if (onHoldCount > 0) parts.push(`${onHoldCount} On-Hold`);
  return parts.join(' · ');
}

function addFeatureHeader(worksheet, feature, urlTemplate) {
  const row = worksheet.addRow([
    '',
    feature.featureId || '',
    'Feature',
    feature.featureTitle || '',
    buildFeatureSummary(feature),
    '',
  ]);
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: FEATURE_ROW_FILL },
    };
    cell.border = {
      top: { style: 'thin', color: { argb: FEATURE_ROW_BORDER } },
      bottom: { style: 'thin', color: { argb: FEATURE_ROW_BORDER } },
    };
  });
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
  row.getCell(5).font = { italic: true, color: { argb: SUMMARY_TEXT_COLOR } };
  row.getCell(5).alignment = { vertical: 'top', wrapText: true };
}

function styleStatusCell(cell, state) {
  const fill = STATUS_FILLS.get(normalizeKey(state));
  if (!fill) return;
  cell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: fill },
  };
}

function addDetailRow(worksheet, item, urlTemplate, { outlineLevel = 0 } = {}) {
  const row = worksheet.addRow([
    item.release || '-',
    item.workItemId,
    normalizeWorkItemType(item.type),
    item.title,
    item.state,
    '',
  ]);
  row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    cell.alignment = {
      horizontal: columnNumber === 1 || columnNumber === 2 ? 'center' : 'left',
      vertical: 'top',
      wrapText: true,
    };
  });
  row.outlineLevel = outlineLevel;
  row.getCell(6).font = { italic: true };
  styleStatusCell(row.getCell(5), item.state);
  setWorkItemIdCell(row.getCell(2), item.workItemId, urlTemplate);
  return row;
}

function addStandaloneHeader(worksheet) {
  const row = worksheet.addRow(['', '', '', 'Standalone Items', '', '']);
  row.getCell(4).font = { bold: true, italic: true };
  row.getCell(4).alignment = { vertical: 'top', wrapText: true };
}

async function renderWeeklyReportWorkbook({ layout, preview, generatedAt = new Date(), tfsWorkItemUrlTemplate = '' }) {
  const model = buildWorkbookModel(layout, preview);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TFS Analytics';
  workbook.created = generatedAt;
  workbook.modified = generatedAt;

  for (const tab of model.tabs) {
    const worksheet = workbook.addWorksheet(tab.name, {
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
    worksheet.views = [{ state: 'frozen', ySplit: 3, activeCell: 'A4' }];
    worksheet.properties.outlineProperties = {
      summaryBelow: false,
      summaryRight: true,
    };
    worksheet.pageSetup.printTitlesRow = '2:2';
    const reportDate = formatPacificReportDate(generatedAt);
    worksheet.headerFooter.oddFooter = `&LGenerated ${reportDate}&RPage &P of &N`;
    worksheet.headerFooter.evenFooter = worksheet.headerFooter.oddFooter;
    worksheet.getRow(1).height = 5;
    const headerRow = worksheet.getRow(2);
    headerRow.values = model.columns.map((column) => column.header);
    styleHeaderRow(headerRow);

    addTabSummaryBand(worksheet, tab, generatedAt, model.columns.length);

    for (const section of tab.sections) {
      if (tab.sections.length > 1) addSectionHeader(worksheet, section.name);
      if (section.groupingMode === 'feature') {
        for (const feature of section.features) {
          addFeatureHeader(worksheet, feature, tfsWorkItemUrlTemplate);
          for (const item of feature.items) {
            addDetailRow(worksheet, item, tfsWorkItemUrlTemplate, { outlineLevel: 1 });
          }
          worksheet.addRow([]);
        }
        if (section.standaloneItems.length > 0) {
          addStandaloneHeader(worksheet);
          for (const item of section.standaloneItems) {
            addDetailRow(worksheet, item, tfsWorkItemUrlTemplate);
          }
          worksheet.addRow([]);
        }
      } else {
        for (const release of section.releases) {
          addReleaseHeader(worksheet, release.release);
          for (const feature of release.features) {
            addFeatureHeader(worksheet, feature, tfsWorkItemUrlTemplate);
            for (const item of feature.items) {
              addDetailRow(worksheet, item, tfsWorkItemUrlTemplate, { outlineLevel: 1 });
            }
            worksheet.addRow([]);
          }
          if (release.standaloneItems.length > 0) {
            addStandaloneHeader(worksheet);
            for (const item of release.standaloneItems) {
              addDetailRow(worksheet, item, tfsWorkItemUrlTemplate);
            }
            worksheet.addRow([]);
          }
        }
      }
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

function buildWeeklyReportFilename(generatedAt = new Date()) {
  return `StatusReport-${formatPacificFileDate(generatedAt)}.xlsx`;
}

module.exports = {
  InvalidPlacementPreviewError,
  normalizeWorkItemType,
  compareReleases,
  compareWorkItemsByRelease,
  buildSectionModel,
  buildFeatureSectionModel,
  buildWorkbookModel,
  buildWorkItemUrl,
  collectTabSummary,
  buildFeatureSummary,
  renderWeeklyReportWorkbook,
  formatPacificFileDate,
  formatPacificReportDate,
  buildWeeklyReportFilename,
};
