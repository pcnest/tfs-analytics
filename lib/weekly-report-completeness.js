const crypto = require('node:crypto');

const COMPLETENESS_DATA_VERSION_SQL = `
  SELECT
    (SELECT COUNT(*)::int FROM tfs_workitems_analytics WHERE is_deleted = FALSE) AS "activeCount",
    (SELECT MAX(synced_at) FROM tfs_workitems_analytics WHERE is_deleted = FALSE) AS "maxSyncedAt",
    (SELECT COUNT(*)::int FROM weekly_report_placement_overrides WHERE layout_key = $1 AND is_active = TRUE) AS "overrideCount",
    (SELECT MAX(updated_at) FROM weekly_report_placement_overrides WHERE layout_key = $1 AND is_active = TRUE) AS "maxOverrideUpdatedAt"
`;

const COMPLETENESS_DATABASE_ROWS_SQL = `
  SELECT
    work_item_id AS "workItemId",
    is_deleted AS "isDeleted",
    area_path AS "areaPath",
    release,
    synced_at AS "syncedAt"
  FROM tfs_workitems_analytics
  WHERE work_item_id = ANY($1::int[])
  ORDER BY work_item_id
`;

const COMPLETENESS_OVERRIDES_SQL = `
  SELECT
    work_item_id AS "workItemId",
    action,
    tab_key AS "tabKey",
    section_key AS "sectionKey",
    updated_at AS "updatedAt"
  FROM weekly_report_placement_overrides
  WHERE layout_key = $1
    AND is_active = TRUE
  ORDER BY work_item_id
`;

const COMPLETENESS_FEATURE_REFERENCES_SQL = `
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
    AND feature_id = ANY($1::int[])
    AND area_path = ANY($2::text[])
`;

function serializeDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function normalizeDataVersion(row = {}) {
  return {
    activeCount: Number(row.activeCount || 0),
    maxSyncedAt: serializeDate(row.maxSyncedAt),
    overrideCount: Number(row.overrideCount || 0),
    maxOverrideUpdatedAt: serializeDate(row.maxOverrideUpdatedAt),
  };
}

function dataVersionsEqual(left, right) {
  return JSON.stringify(normalizeDataVersion(left)) === JSON.stringify(normalizeDataVersion(right));
}

function createLayoutFingerprint(layout) {
  return crypto.createHash('sha256').update(JSON.stringify(layout)).digest('hex');
}

function completenessError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function fetchCompletenessInputs(pool, layoutKey, layout, workItemIds) {
  const ids = [...new Set((workItemIds || []).map(Number))].sort((left, right) => left - right);
  const before = normalizeDataVersion((await pool.query(COMPLETENESS_DATA_VERSION_SQL, [layoutKey])).rows[0]);
  const featureIds = ids;
  const [databaseResult, overrideResult, featureReferenceResult] = await Promise.all([
    pool.query(COMPLETENESS_DATABASE_ROWS_SQL, [ids]),
    pool.query(COMPLETENESS_OVERRIDES_SQL, [layoutKey]),
    pool.query(COMPLETENESS_FEATURE_REFERENCES_SQL, [featureIds, layout.source.areaPaths]),
  ]);
  const after = normalizeDataVersion((await pool.query(COMPLETENESS_DATA_VERSION_SQL, [layoutKey])).rows[0]);
  if (!dataVersionsEqual(before, after)) {
    throw completenessError('COMPLETENESS_DATA_CHANGED', 'Analytics data changed during completeness classification.');
  }
  return {
    dataVersion: after,
    databaseRows: databaseResult.rows,
    overrides: overrideResult.rows,
    featureReferenceRows: featureReferenceResult.rows,
  };
}

function resolveReportImpact({ resolution, databaseStatus, reportRole, headerSynthesizable }) {
  if (!resolution.effectiveEligible) return 'not_report_eligible';
  if (!resolution.target) return 'eligible_unplaced';
  if (databaseStatus === 'active') return 'present';
  if (reportRole === 'feature_header') {
    return headerSynthesizable ? 'feature_header_synthesizable' : 'missing_feature_header';
  }
  return 'missing_detail_row';
}

function impactSeverity(reportImpact, databaseStatus) {
  if (reportImpact === 'missing_detail_row' || reportImpact === 'eligible_unplaced') return 'high';
  if (databaseStatus === 'soft_deleted' && reportImpact !== 'not_report_eligible') return 'high';
  if (reportImpact === 'missing_feature_header' || reportImpact === 'feature_header_synthesizable') return 'medium';
  if (reportImpact === 'not_report_eligible') return 'low';
  return 'none';
}

function percentage(numerator, denominator) {
  if (denominator === 0) return 100;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function resolveCompletenessPreview({
  layoutKey,
  layout,
  tfsItems,
  databaseRows = [],
  overrides = [],
  featureReferenceRows = [],
  dataVersion,
  placementModule,
}) {
  const databaseMap = new Map(databaseRows.map((row) => [Number(row.workItemId), row]));
  const overrideMap = new Map(overrides.map((row) => [Number(row.workItemId), row]));
  const { destinations } = placementModule.buildDestinations(layout);
  const sourcePaths = new Set(layout.source.areaPaths.map(placementModule.normalizeComparable));
  const sortedRules = [...layout.placementRules]
    .sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key));
  const referencedFeatureIds = new Set();
  for (const childRow of featureReferenceRows) {
    const child = placementModule.normalizeWorkItem(childRow);
    const childResolution = placementModule.resolveWorkItemPlacement({
      workItem: child,
      layout,
      override: overrideMap.get(child.workItemId) || null,
      destinations,
      sortedRules,
    });
    if (childResolution.effectiveEligible && childResolution.target && Number.isInteger(child.featureId) && child.featureId > 0) {
      referencedFeatureIds.add(child.featureId);
    }
  }

  const inputMap = new Map(tfsItems.map((row) => [Number(row.workItemId), row]));
  const items = tfsItems.map((row) => placementModule.normalizeWorkItem(row));
  const results = items.map((item) => {
    const override = overrideMap.get(item.workItemId) || null;
    const resolution = placementModule.resolveWorkItemPlacement({
      workItem: item,
      layout,
      override,
      destinations,
      sortedRules,
    });
    const databaseRow = databaseMap.get(item.workItemId) || null;
    const databaseStatus = !databaseRow
      ? 'absent'
      : databaseRow.isDeleted === true
        ? 'soft_deleted'
        : !sourcePaths.has(placementModule.normalizeComparable(databaseRow.areaPath))
          ? 'active_outside_source'
          : 'active';
    const reportRole = placementModule.normalizeComparable(item.type) === 'feature'
      ? 'feature_header'
      : 'detail_row';
    const headerSynthesizable = reportRole === 'feature_header' && referencedFeatureIds.has(item.workItemId);
    const reportImpact = resolveReportImpact({
      resolution,
      databaseStatus,
      reportRole,
      headerSynthesizable,
    });

    return {
      workItemId: item.workItemId,
      type: item.type,
      title: item.title,
      state: item.state,
      areaPath: item.areaPath,
      tags: item.parsedTags,
      changedDate: serializeDate(inputMap.get(item.workItemId)?.changedDate),
      sourceMatch: resolution.sourceMatch,
      filterEligible: resolution.filterResult.eligible,
      filterReasons: resolution.filterResult.reasons.map((reason) => reason.code),
      overrideAction: resolution.overrideAction,
      effectiveEligible: resolution.effectiveEligible,
      exclusionReasons: resolution.exclusionReasons,
      placementReady: Boolean(resolution.target),
      placementSource: resolution.placementSource,
      placementKey: resolution.placementKey,
      target: resolution.target,
      matchingRuleKeys: resolution.matchingRuleKeys,
      databaseStatus,
      databaseAreaPath: databaseRow?.areaPath || null,
      databaseRelease: databaseRow?.release || null,
      databaseSyncedAt: serializeDate(databaseRow?.syncedAt),
      reportRole,
      headerSynthesizable,
      reportImpact,
      severity: impactSeverity(reportImpact, databaseStatus),
    };
  }).sort((left, right) => left.workItemId - right.workItemId);

  const effective = results.filter((item) => item.effectiveEligible);
  const active = effective.filter((item) => item.databaseStatus === 'active');
  const visible = effective.filter((item) => item.reportImpact === 'present' || item.reportImpact === 'feature_header_synthesizable');
  return {
    layout: layoutKey,
    configFingerprint: createLayoutFingerprint(layout),
    sourceAreaPaths: [...layout.source.areaPaths],
    filters: layout.filters,
    dataVersion: normalizeDataVersion(dataVersion),
    summary: {
      tfsSourceCount: results.length,
      filterEligibleCount: results.filter((item) => item.filterEligible).length,
      effectiveEligibleCount: effective.length,
      eligibleActiveCount: active.length,
      eligibleMissingCount: effective.length - active.length,
      eligibleSoftDeletedCount: effective.filter((item) => item.databaseStatus === 'soft_deleted').length,
      eligibleAbsentCount: effective.filter((item) => item.databaseStatus === 'absent').length,
      eligibleOutsideSourceCount: effective.filter((item) => item.databaseStatus === 'active_outside_source').length,
      eligibleUnplacedCount: effective.filter((item) => !item.placementReady).length,
      analyticsRowCompletenessPct: percentage(active.length, effective.length),
      visibleReportCompletenessPct: percentage(visible.length, effective.length),
    },
    items: results,
  };
}

module.exports = {
  COMPLETENESS_DATA_VERSION_SQL,
  COMPLETENESS_DATABASE_ROWS_SQL,
  COMPLETENESS_OVERRIDES_SQL,
  COMPLETENESS_FEATURE_REFERENCES_SQL,
  normalizeDataVersion,
  dataVersionsEqual,
  createLayoutFingerprint,
  fetchCompletenessInputs,
  resolveCompletenessPreview,
};
