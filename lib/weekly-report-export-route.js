function createWeeklyReportExportHandler(options) {
  const {
    pool,
    requireApiKey,
    definitionState,
    configModule,
    placementModule,
    xlsxModule,
    tfsWorkItemUrlTemplate = '',
    now = () => new Date(),
    logger = console,
  } = options;

  return async function weeklyReportV2Export(req, res) {
    if (!requireApiKey(req, res)) return;

    if (definitionState.initializationError || !definitionState.config) {
      return res.status(503).json({
        ok: false,
        error: 'report_export_unavailable',
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
      if (!preview.validation.validForExport) {
        return res.status(422).json({
          ok: false,
          error: 'report_not_ready',
          layout: layoutKey,
          summary: preview.summary,
          validation: preview.validation,
        });
      }

      const generatedAt = now();
      const workbookBuffer = await xlsxModule.renderWeeklyReportWorkbook({
        layout,
        preview,
        generatedAt,
        tfsWorkItemUrlTemplate,
      });
      const filename = xlsxModule.buildWeeklyReportFilename(generatedAt);

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(workbookBuffer);
    } catch (error) {
      if (
        typeof xlsxModule.InvalidPlacementPreviewError === 'function' &&
        error instanceof xlsxModule.InvalidPlacementPreviewError
      ) {
        return res.status(422).json({
          ok: false,
          error: 'report_not_ready',
        });
      }
      logger.error('weekly-report v2 export error:', error);
      if (!res.headersSent) {
        return res.status(500).json({
          ok: false,
          error: 'report_export_failed',
        });
      }
      return res.end();
    }
  };
}

module.exports = {
  createWeeklyReportExportHandler,
};
