'use strict';

const DEFAULT_SYNC_MODE = 'standard';
const REPORT_HIERARCHY_REPAIR_MODE = 'report-hierarchy-repair';
const REPORT_HIERARCHY_REPAIR_SOURCE = 'tfs-report-hierarchy-repair';
const MAX_REPORT_HIERARCHY_REPAIR_ROWS = 200;
const REPORT_HIERARCHY_TYPES = new Set(['Bug', 'Product Backlog Item']);

function getSyncRequestPolicy(body = {}) {
  const syncMode = body.syncMode ?? DEFAULT_SYNC_MODE;
  if (![DEFAULT_SYNC_MODE, REPORT_HIERARCHY_REPAIR_MODE].includes(syncMode)) {
    return {
      ok: false,
      status: 400,
      error: `Unsupported syncMode: ${syncMode}`,
    };
  }

  if (syncMode === DEFAULT_SYNC_MODE) {
    return {
      ok: true,
      syncMode,
      source: body.source ?? 'tfs-weekly-sync',
      runGlobalCleanup: true,
      captureReleaseHealth: true,
      rejectInvalidRows: false,
      allowInserts: true,
    };
  }

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > MAX_REPORT_HIERARCHY_REPAIR_ROWS) {
    return {
      ok: false,
      status: 400,
      error: `report-hierarchy-repair is limited to ${MAX_REPORT_HIERARCHY_REPAIR_ROWS} rows per request`,
    };
  }

  const invalidRow = rows.find(
    (row) => !row || !REPORT_HIERARCHY_TYPES.has(row.type),
  );
  if (invalidRow) {
    return {
      ok: false,
      status: 400,
      error:
        'report-hierarchy-repair accepts only Bug and Product Backlog Item rows',
    };
  }

  const ids = rows.map((row) => row.workItemId);
  if (new Set(ids).size !== ids.length) {
    return {
      ok: false,
      status: 400,
      error: 'report-hierarchy-repair contains duplicate workItemId values',
    };
  }

  return {
    ok: true,
    syncMode,
    source: REPORT_HIERARCHY_REPAIR_SOURCE,
    runGlobalCleanup: false,
    captureReleaseHealth: false,
    rejectInvalidRows: true,
    allowInserts: false,
  };
}

function getSyncCapabilities() {
  return {
    ok: true,
    standard: { supported: true },
    reportHierarchyRepair: {
      supported: true,
      syncMode: REPORT_HIERARCHY_REPAIR_MODE,
      maxRows: MAX_REPORT_HIERARCHY_REPAIR_ROWS,
      allowInserts: false,
      runGlobalCleanup: false,
      captureReleaseHealth: false,
    },
  };
}

module.exports = {
  DEFAULT_SYNC_MODE,
  MAX_REPORT_HIERARCHY_REPAIR_ROWS,
  REPORT_HIERARCHY_REPAIR_MODE,
  REPORT_HIERARCHY_REPAIR_SOURCE,
  getSyncCapabilities,
  getSyncRequestPolicy,
};
