'use strict';

function makeFailure(status, error, details = {}) {
  return { ok: false, status, error, ...details };
}

const WEEKLY_REPORT_REMARK_FIELDS = [
  'weeklyReportRemark',
  'weeklyReportRemarkRevision',
  'weeklyReportRemarkChangedAt',
  'weeklyReportRemarkChangedBy',
];

function validateWeeklyReportRemarkRow(row, index, remarks) {
  const errors = [];
  for (const field of WEEKLY_REPORT_REMARK_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row || {}, field)) {
      errors.push(`${field} is required`);
    }
  }
  if (errors.length > 0) return { index, workItemId: row?.workItemId ?? null, errors };

  const text = row.weeklyReportRemark;
  const revision = row.weeklyReportRemarkRevision;
  const changedAt = row.weeklyReportRemarkChangedAt;
  const changedBy = row.weeklyReportRemarkChangedBy;
  if (text !== null && (typeof text !== 'string' || text.length > remarks.maxLength)) {
    errors.push(`weeklyReportRemark must be null or a string no longer than ${remarks.maxLength} characters`);
  }
  if (revision !== null && (!Number.isInteger(revision) || revision <= 0)) {
    errors.push('weeklyReportRemarkRevision must be null or a positive integer');
  }
  if (changedAt !== null && (typeof changedAt !== 'string' || Number.isNaN(Date.parse(changedAt)))) {
    errors.push('weeklyReportRemarkChangedAt must be null or a valid date string');
  }
  if (changedBy !== null && (typeof changedBy !== 'string' || changedBy.trim() === '')) {
    errors.push('weeklyReportRemarkChangedBy must be null or a non-empty string');
  }
  if (revision === null) {
    if (text !== null || changedAt !== null || changedBy !== null) {
      errors.push('remark text and provenance must all be null when no source revision exists');
    }
  } else if (changedAt === null || changedBy === null) {
    errors.push('remark date and author are required when a source revision exists');
  }
  return errors.length > 0 ? { index, workItemId: row?.workItemId ?? null, errors } : null;
}

async function validateReportScopeRefreshRequest(options) {
  const {
    pool,
    body = {},
    definitionState,
    configModule,
    placementModule,
    completenessModule,
  } = options;

  if (
    definitionState?.initializationError ||
    !definitionState?.config ||
    !configModule ||
    !placementModule ||
    !completenessModule
  ) {
    return makeFailure(503, 'report_scope_refresh_unavailable');
  }

  const layoutKey = String(body.layoutKey || '').trim();
  if (!layoutKey) return makeFailure(400, 'report_scope_refresh_layout_required');
  const layout = configModule.getLayoutDefinition(definitionState.config, layoutKey);
  if (!layout) return makeFailure(400, 'unknown_report_scope_refresh_layout');

  const layoutValidation = typeof configModule.getLayoutValidation === 'function'
    ? configModule.getLayoutValidation(definitionState.validation, layoutKey)
    : definitionState.validation;
  if (!layoutValidation?.ok) {
    return makeFailure(503, 'report_scope_refresh_unavailable', {
      validation: {
        errors: layoutValidation?.errors || [],
        warnings: layoutValidation?.warnings || [],
      },
    });
  }

  if (layout.remarks) {
    const invalidRemarkRows = (body.rows || [])
      .map((row, index) => validateWeeklyReportRemarkRow(row, index, layout.remarks))
      .filter(Boolean);
    if (invalidRemarkRows.length > 0) {
      return makeFailure(400, 'invalid_report_scope_refresh_remark_fields', {
        invalidRows: invalidRemarkRows,
      });
    }
  }

  const configFingerprint = completenessModule.createLayoutFingerprint(layout);
  if (
    body.expectedConfigFingerprint &&
    body.expectedConfigFingerprint !== configFingerprint
  ) {
    return makeFailure(409, 'report_definition_changed_during_refresh');
  }

  const overrideResult = await pool.query(
    completenessModule.COMPLETENESS_OVERRIDES_SQL,
    [layoutKey],
  );
  const overrideMap = new Map(
    overrideResult.rows.map((row) => [Number(row.workItemId), row]),
  );
  const { destinations } = placementModule.buildDestinations(layout);
  const sortedRules = [...layout.placementRules]
    .sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key));
  const invalidRows = [];

  for (const [index, row] of (body.rows || []).entries()) {
    const item = placementModule.normalizeWorkItem(row || {});
    const resolution = placementModule.resolveWorkItemPlacement({
      workItem: item,
      layout,
      override: overrideMap.get(item.workItemId) || null,
      destinations,
      sortedRules,
    });
    if (!resolution.effectiveEligible || !resolution.target) {
      invalidRows.push({
        index,
        workItemId: item.workItemId,
        effectiveEligible: resolution.effectiveEligible,
        exclusionReasons: resolution.exclusionReasons,
        placementReady: Boolean(resolution.target),
      });
    }
  }

  if (invalidRows.length > 0) {
    return makeFailure(400, 'report_scope_refresh_rows_outside_layout', {
      invalidRows,
    });
  }

  return {
    ok: true,
    layoutKey,
    configFingerprint,
    rowCount: body.rows.length,
  };
}

module.exports = {
  WEEKLY_REPORT_REMARK_FIELDS,
  validateWeeklyReportRemarkRow,
  validateReportScopeRefreshRequest,
};
