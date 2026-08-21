'use strict';

function makeFailure(status, error, details = {}) {
  return { ok: false, status, error, ...details };
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
  validateReportScopeRefreshRequest,
};
