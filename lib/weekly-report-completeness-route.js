const MAX_COMPLETENESS_BATCH_SIZE = 500;

function createWeeklyReportCompletenessHandler(options) {
  const {
    pool,
    requireApiKey,
    definitionState,
    configModule,
    placementModule,
    completenessModule,
    logger = console,
  } = options;

  return async function weeklyReportCompletenessPreview(req, res) {
    if (!requireApiKey(req, res)) return;

    if (definitionState.initializationError || !definitionState.config) {
      return res.status(503).json({ ok: false, error: 'report_completeness_unavailable' });
    }

    const layoutKey = String(req.query.layout || '').trim();
    if (!layoutKey) return res.status(400).json({ ok: false, error: 'layout parameter required' });
    const layout = configModule.getLayoutDefinition(definitionState.config, layoutKey);
    if (!layout) return res.status(400).json({ ok: false, error: 'unknown layout' });

    const layoutValidation = typeof configModule.getLayoutValidation === 'function'
      ? configModule.getLayoutValidation(definitionState.validation, layoutKey)
      : definitionState.validation;
    if (!layoutValidation?.ok) {
      return res.status(422).json({
        ok: false,
        error: 'invalid_report_definition',
        validation: {
          validForExport: false,
          errors: layoutValidation?.errors || [],
          warnings: layoutValidation?.warnings || [],
        },
      });
    }

    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'items array required' });
    }
    if (items.length > MAX_COMPLETENESS_BATCH_SIZE) {
      return res.status(413).json({
        ok: false,
        error: 'completeness batch too large',
        limit: MAX_COMPLETENESS_BATCH_SIZE,
      });
    }

    const seen = new Set();
    const sourcePaths = new Set(layout.source.areaPaths.map(placementModule.normalizeComparable));
    for (const [index, item] of items.entries()) {
      const workItemId = Number(item?.workItemId);
      if (!Number.isInteger(workItemId) || workItemId <= 0) {
        return res.status(400).json({ ok: false, error: `items[${index}].workItemId must be a positive integer` });
      }
      if (seen.has(workItemId)) {
        return res.status(400).json({ ok: false, error: `duplicate workItemId ${workItemId}` });
      }
      seen.add(workItemId);
      if (!sourcePaths.has(placementModule.normalizeComparable(item?.areaPath))) {
        return res.status(400).json({ ok: false, error: `work item ${workItemId} is outside the layout source` });
      }
    }

    const configFingerprint = completenessModule.createLayoutFingerprint(layout);
    if (req.body?.expectedConfigFingerprint && req.body.expectedConfigFingerprint !== configFingerprint) {
      return res.status(409).json({ ok: false, error: 'report_definition_changed_during_scan' });
    }

    try {
      const inputs = await completenessModule.fetchCompletenessInputs(pool, layoutKey, layout, [...seen]);
      if (req.body?.expectedDataVersion && !completenessModule.dataVersionsEqual(req.body.expectedDataVersion, inputs.dataVersion)) {
        return res.status(409).json({ ok: false, error: 'analytics_data_changed_during_scan' });
      }
      const preview = completenessModule.resolveCompletenessPreview({
        layoutKey,
        layout,
        tfsItems: items,
        ...inputs,
        placementModule,
      });
      return res.status(200).json({ ok: true, generatedAt: new Date().toISOString(), ...preview });
    } catch (error) {
      if (error?.code === 'COMPLETENESS_DATA_CHANGED') {
        return res.status(409).json({ ok: false, error: 'analytics_data_changed_during_scan' });
      }
      logger.error('weekly-report completeness preview error:', error);
      return res.status(500).json({ ok: false, error: 'report_completeness_failed' });
    }
  };
}

module.exports = {
  MAX_COMPLETENESS_BATCH_SIZE,
  createWeeklyReportCompletenessHandler,
};
