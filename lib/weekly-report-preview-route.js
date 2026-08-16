function createWeeklyReportPreviewHandler(options) {
  const {
    pool,
    requireApiKey,
    definitionState,
    configModule,
    placementModule,
    logger = console,
  } = options;

  return async function weeklyReportPlacementPreview(req, res) {
    if (!requireApiKey(req, res)) return;

    if (definitionState.initializationError || !definitionState.config) {
      return res.status(503).json({
        ok: false,
        error: 'report_preview_unavailable',
      });
    }

    const layoutKey = String(req.query.layout || '').trim();
    if (!layoutKey) {
      return res.status(400).json({
        ok: false,
        error: 'layout parameter required',
      });
    }

    const layout = configModule.getLayoutDefinition(definitionState.config, layoutKey);
    if (!layout) {
      return res.status(400).json({
        ok: false,
        error: 'unknown layout',
      });
    }

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

    try {
      const inputs = await placementModule.fetchPlacementInputs(pool, layoutKey, layout);
      const preview = placementModule.resolvePlacementPreview({
        layoutKey,
        layout,
        ...inputs,
      });
      return res.status(200).json({
        ok: true,
        generatedAt: new Date().toISOString(),
        ...preview,
      });
    } catch (error) {
      logger.error('weekly-report placement preview error:', error);
      return res.status(500).json({
        ok: false,
        error: 'report_preview_failed',
      });
    }
  };
}

module.exports = {
  createWeeklyReportPreviewHandler,
};
