'use strict';

const DEFAULT_SYNC_MODE = 'standard';
const REPORT_HIERARCHY_REPAIR_MODE = 'report-hierarchy-repair';
const REPORT_HIERARCHY_REPAIR_SOURCE = 'tfs-report-hierarchy-repair';
const MAX_REPORT_HIERARCHY_REPAIR_ROWS = 200;
const REPORT_HIERARCHY_TYPES = new Set(['Bug', 'Product Backlog Item']);
const REPORT_SCOPE_REFRESH_MODE = 'report-scope-refresh';
const REPORT_SCOPE_REFRESH_SOURCE = 'tfs-report-scope-refresh';
const MAX_REPORT_SCOPE_REFRESH_ROWS = 200;
const WEEKLY_REPORT_REMARK_FIELDS = [
  'weeklyReportRemark',
  'weeklyReportRemarkRevision',
  'weeklyReportRemarkChangedAt',
  'weeklyReportRemarkChangedBy',
];

function getSyncRequestPolicy(body = {}, options = {}) {
  const syncMode = body.syncMode ?? DEFAULT_SYNC_MODE;
  if (![DEFAULT_SYNC_MODE, REPORT_HIERARCHY_REPAIR_MODE, REPORT_SCOPE_REFRESH_MODE].includes(syncMode)) {
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

  if (syncMode === REPORT_SCOPE_REFRESH_MODE) {
    if (options.reportScopeRefreshEnabled !== true) {
      return {
        ok: false,
        status: 503,
        error: 'report_scope_refresh_unavailable',
      };
    }

    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length > MAX_REPORT_SCOPE_REFRESH_ROWS) {
      return {
        ok: false,
        status: 400,
        error: `report-scope-refresh is limited to ${MAX_REPORT_SCOPE_REFRESH_ROWS} rows per request`,
      };
    }

    const ids = rows.map((row) => row?.workItemId);
    if (new Set(ids).size !== ids.length) {
      return {
        ok: false,
        status: 400,
        error: 'report-scope-refresh contains duplicate workItemId values',
      };
    }

    return {
      ok: true,
      syncMode,
      source: REPORT_SCOPE_REFRESH_SOURCE,
      runGlobalCleanup: false,
      captureReleaseHealth: false,
      rejectInvalidRows: true,
      invalidRowsError: 'invalid_report_scope_refresh_rows',
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
    invalidRowsError: 'invalid_report_hierarchy_repair_rows',
    allowInserts: false,
  };
}

function getSyncCapabilities(options = {}) {
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
    reportScopeRefresh: {
      supported: true,
      enabled: options.reportScopeRefreshEnabled === true,
      syncMode: REPORT_SCOPE_REFRESH_MODE,
      source: REPORT_SCOPE_REFRESH_SOURCE,
      maxRows: MAX_REPORT_SCOPE_REFRESH_ROWS,
      allowInserts: true,
      runGlobalCleanup: false,
      captureReleaseHealth: false,
      requiresLayoutKey: true,
      requiresCompletenessPreview: true,
      weeklyReportRemarks: {
        supported: true,
        enabled: options.weeklyReportRemarksEnabled === true,
        source: 'tfsDiscussionMarker',
        fields: WEEKLY_REPORT_REMARK_FIELDS,
      },
    },
  };
}

module.exports = {
  DEFAULT_SYNC_MODE,
  MAX_REPORT_HIERARCHY_REPAIR_ROWS,
  REPORT_HIERARCHY_REPAIR_MODE,
  REPORT_HIERARCHY_REPAIR_SOURCE,
  MAX_REPORT_SCOPE_REFRESH_ROWS,
  REPORT_SCOPE_REFRESH_MODE,
  REPORT_SCOPE_REFRESH_SOURCE,
  WEEKLY_REPORT_REMARK_FIELDS,
  getSyncCapabilities,
  getSyncRequestPolicy,
};
