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
const MAX_REFERENCED_FEATURE_REMARKS = 200;

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

function validateWeeklyReportFeatureRemarkRow(row, index, remarks) {
  const result = validateWeeklyReportRemarkRow(row, index, remarks);
  const errors = result ? [...result.errors] : [];
  if (!Number.isInteger(row?.featureId) || row.featureId <= 0) {
    errors.unshift('featureId must be a positive integer');
  }
  return errors.length > 0
    ? { index, featureId: row?.featureId ?? null, errors }
    : null;
}

function validateReferencedFeatureRemarks(body, layout, placementModule) {
  if (!Object.prototype.hasOwnProperty.call(body, 'featureRemarks')) {
    return { ok: true, provided: false, featureRemarks: [] };
  }
  if (!layout.remarks) {
    return makeFailure(400, 'report_scope_refresh_feature_remarks_not_configured');
  }
  if (!Array.isArray(body.featureRemarks)) {
    return makeFailure(400, 'invalid_report_scope_refresh_feature_remarks', {
      invalidFeatureRemarks: [{ index: null, featureId: null, errors: ['featureRemarks must be an array'] }],
    });
  }
  if (body.featureRemarks.length > MAX_REFERENCED_FEATURE_REMARKS) {
    return makeFailure(400, 'invalid_report_scope_refresh_feature_remarks', {
      invalidFeatureRemarks: [{
        index: null,
        featureId: null,
        errors: [`featureRemarks is limited to ${MAX_REFERENCED_FEATURE_REMARKS} entries per request`],
      }],
    });
  }

  const invalidFeatureRemarks = body.featureRemarks
    .map((row, index) => validateWeeklyReportFeatureRemarkRow(row, index, layout.remarks))
    .filter(Boolean);
  const featureIds = body.featureRemarks.map((entry) => entry?.featureId);
  const duplicateIds = [...new Set(featureIds.filter(
    (featureId, index) => featureIds.indexOf(featureId) !== index,
  ))];
  if (duplicateIds.length > 0) {
    invalidFeatureRemarks.push({
      index: null,
      featureId: null,
      errors: [`duplicate featureId values: ${duplicateIds.join(', ')}`],
    });
  }

  const expectedIds = [...new Set((body.rows || [])
    .filter((row) => placementModule.normalizeComparable(row?.type) !== 'feature')
    .map((row) => row?.featureId)
    .filter((featureId) => Number.isInteger(featureId) && featureId > 0))]
    .sort((left, right) => left - right);
  const suppliedIds = [...new Set(featureIds.filter(
    (featureId) => Number.isInteger(featureId) && featureId > 0,
  ))].sort((left, right) => left - right);
  const suppliedSet = new Set(suppliedIds);
  const expectedSet = new Set(expectedIds);
  const missingFeatureIds = expectedIds.filter((featureId) => !suppliedSet.has(featureId));
  const unexpectedFeatureIds = suppliedIds.filter((featureId) => !expectedSet.has(featureId));
  if (missingFeatureIds.length > 0 || unexpectedFeatureIds.length > 0) {
    invalidFeatureRemarks.push({
      index: null,
      featureId: null,
      errors: [
        ...(missingFeatureIds.length > 0
          ? [`missing referenced Feature IDs: ${missingFeatureIds.join(', ')}`]
          : []),
        ...(unexpectedFeatureIds.length > 0
          ? [`unreferenced Feature IDs: ${unexpectedFeatureIds.join(', ')}`]
          : []),
      ],
    });
  }

  if (invalidFeatureRemarks.length > 0) {
    return makeFailure(400, 'invalid_report_scope_refresh_feature_remarks', {
      invalidFeatureRemarks,
    });
  }
  return { ok: true, provided: true, featureRemarks: body.featureRemarks };
}

function buildReferencedFeatureRemarkUpsert(layoutKey, featureRemarks, syncedAt) {
  if (!Array.isArray(featureRemarks) || featureRemarks.length === 0) return null;
  const columnCount = 7;
  const values = [];
  const valuesSql = featureRemarks.map((entry, index) => {
    const base = index * columnCount;
    values.push(
      layoutKey,
      entry.featureId,
      entry.weeklyReportRemark,
      entry.weeklyReportRemarkRevision,
      entry.weeklyReportRemarkChangedAt,
      entry.weeklyReportRemarkChangedBy,
      syncedAt,
    );
    return `(${Array.from({ length: columnCount }, (_, offset) => `$${base + offset + 1}`).join(',')})`;
  }).join(',');
  return {
    text: `
      INSERT INTO weekly_report_feature_remarks (
        layout_key,
        feature_work_item_id,
        weekly_report_remark,
        weekly_report_remark_revision,
        weekly_report_remark_changed_at,
        weekly_report_remark_changed_by,
        synced_at
      ) VALUES ${valuesSql}
      ON CONFLICT (layout_key, feature_work_item_id) DO UPDATE SET
        weekly_report_remark = EXCLUDED.weekly_report_remark,
        weekly_report_remark_revision = EXCLUDED.weekly_report_remark_revision,
        weekly_report_remark_changed_at = EXCLUDED.weekly_report_remark_changed_at,
        weekly_report_remark_changed_by = EXCLUDED.weekly_report_remark_changed_by,
        synced_at = EXCLUDED.synced_at
    `,
    values,
  };
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

  const featureRemarkValidation = validateReferencedFeatureRemarks(
    body,
    layout,
    placementModule,
  );
  if (!featureRemarkValidation.ok) return featureRemarkValidation;

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
    featureRemarksProvided: featureRemarkValidation.provided,
    featureRemarks: featureRemarkValidation.featureRemarks,
  };
}

module.exports = {
  MAX_REFERENCED_FEATURE_REMARKS,
  WEEKLY_REPORT_REMARK_FIELDS,
  buildReferencedFeatureRemarkUpsert,
  validateReferencedFeatureRemarks,
  validateWeeklyReportFeatureRemarkRow,
  validateWeeklyReportRemarkRow,
  validateReportScopeRefreshRequest,
};
