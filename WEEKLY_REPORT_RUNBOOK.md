# Weekly Status Report Runbook

Last updated: 2026-08-22

This document is the operational and configuration guide for the v2 weekly status report. Update it in the same change whenever report filters, layout/grouping behavior, placement rules, release selection, endpoints, feature flags, PowerShell commands, or rollout requirements change.

## What the report contains

The current layout key is `agent7-weekly`. It reads active analytics records for these exact TFS area paths:

- `SupplyPro.Core\Enterprise Software Team\Agent7`
- `SupplyPro.Core\Enterprise Software Team\CDR`
- `SupplyPro.Core\Enterprise Software Team\Mobile`
- `SupplyPro.Core\Enterprise Software Team\NextGen`

It produces four worksheets named `Agent7`, `CDR`, `Mobile`, and `NextGen` with these columns:

| Column  | Meaning                                                                      |
| ------- | ---------------------------------------------------------------------------- |
| Version | The selected release/version tag stored on the Bug or PBI                    |
| ID      | TFS work item ID, hyperlinked when `TFS_WORKITEM_URL_TEMPLATE` is configured |
| Type    | `Product Backlog Item` is displayed as `PBI`; Bugs retain `Bug`              |
| Title   | Current analytics title                                                      |
| Status  | Current analytics state, including `Shelved`                                 |
| Remarks | Reserved for future report remarks; currently blank                          |

The checked-in filters currently:

- Include `Product Backlog Item`, `Bug`, and `Feature`.
- Exclude `Removed` and `Done`.
- Do not require a tag.
- Include `Shelved` because it is not excluded.

The workbook uses Feature-first grouping:

```text
Worksheet
  Weekly Items
    Feature
      Bug/PBI, sorted by Version, type, and ID
    Standalone Items
      Bug/PBI without Feature metadata
```

Each Feature is displayed once per worksheet even when its children have different releases. Release headers are not rendered because Version remains visible on each detail row. The renderer also supports the older release-first mode for other layouts.

Workbook presentation behavior:

- The current layout hides the optional worksheet summary band and the optional generated Feature summary through `layout.presentation`.
- When enabled, the worksheet summary band contains the tab name, section name, Pacific report date, detail-item count, unique Feature count, and count of items without a release.
- Feature rows always use a subtle light-blue band. When enabled, the generated Feature summary appears in Status with item count, distinct assigned-release count, and On-Hold count when nonzero.
- Feature child rows are Excel outline level 1. They are expanded when the workbook opens and can be collapsed or expanded with Excel's outline controls. Standalone items are not included in a Feature outline.
- With the current summary band disabled, rows 1-2 are frozen. When the band is enabled, rows 1-3 are frozen. Printed pages repeat the row-2 column headings and include the generated report date plus `Page X of Y` in the footer.
- Status highlighting applies only to the Status cell: `On-Hold` is pale red, `Shelved` is light gray, `Ready for QA` and `Resolved` are pale green, and `Re-opened` is pale yellow. Other statuses are not colored.
- Remarks remains present and blank until a durable, stakeholder-relevant TFS source field is selected.

## How report generation works

```text
TFS 2017
  -> sync-tfs-lean.ps1
  -> authenticated Render ingest API
  -> Neon PostgreSQL analytics tables
  -> v2 filters + overrides + placement rules
  -> XLSX renderer
  -> authenticated XLSX download
```

The XLSX is a live snapshot of active analytics data when the export endpoint is called. Changing a TFS work item does not change an already downloaded workbook. Refresh the analytics scope and export a new workbook after correcting TFS data.

Important files:

| File                                      | Responsibility                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `config/weekly-report-definition.v2.json` | Source areas, filters, grouping, tabs, placement rules, limits, columns, and release selection |
| `lib/weekly-report-config.js`             | Configuration validation                                                                       |
| `lib/weekly-report-placement.js`          | Canonical filtering, overrides, and placement resolution                                       |
| `lib/weekly-report-xlsx-v2.js`            | Workbook modeling, sorting, styling, and rendering                                             |
| `lib/weekly-report-export-route.js`       | Authenticated v2 XLSX endpoint                                                                 |
| `lib/tfs-report-scope-refresh.ps1`        | Full TFS report-scope discovery and release selection                                          |
| `sync-tfs-lean.ps1`                       | Standard sync, report-scope refresh, and hierarchy repair orchestration                        |
| `reconcile-tfs.ps1`                       | Read-only TFS-versus-analytics audit and completeness analysis                                 |
| `weekly_report_placement_overrides`       | Database placement/exclusion exceptions                                                        |

## Prerequisites

Run PowerShell commands from the repository root on a Windows machine that can reach TFS, normally while connected to the VPN.

Set these local environment variables without committing their values:

```powershell
$env:TFS_PAT = "YOUR_TFS_PAT"
$env:SYNC_API_KEY = "YOUR_SYNC_API_KEY"
$env:INGEST_URL = "https://YOUR-SERVICE.onrender.com/api/tfs-weekly-sync"
```

The deployed Render service requires:

- `DATABASE_URL`
- `SYNC_API_KEY`
- `ENABLE_WEEKLY_REPORT_PREVIEW=true`
- `ENABLE_WEEKLY_REPORT_V2_XLSX=true`
- `ENABLE_WEEKLY_REPORT_SCOPE_REFRESH=true`
- `TFS_WORKITEM_URL_TEMPLATE`, optional but recommended; it must contain `{id}`

Example URL template:

```text
https://remote.spdev.us/tfs/SupplyPro.Applications/SupplyPro.Core/_workitems?id={id}&_a=edit
```

Apply `migration-add-weekly-report-placement-overrides.sql` once before enabling v2 preview/export. The migration is idempotent and creates the placement override table, indexes, and updated-at trigger.

## Recommended weekly workflow

The normal weekly command performs the existing Standard sync and then refreshes every record that is eligible and placeable for the report layout:

```powershell
.\sync-tfs-lean.ps1 `
  -IncludeWeeklyReportScope `
  -ReportLayout "agent7-weekly"
```

Expected successful ending:

```text
Report-scope refresh complete and verified: <count> eligible items; missing=0.
```

The refresh writes a timestamped summary under `reports/`. It is safe to rerun. It does not run release cleanup, global 30-day cleanup, or release-health capture inside report-scope refresh batches.

### Refresh only

Use this after correcting TFS tags, titles, states, or hierarchy when the Standard sync does not need to run again:

```powershell
.\sync-tfs-lean.ps1 `
  -Mode ReportScopeRefresh `
  -ReportLayout "agent7-weekly"
```

### Download the workbook

After a successful refresh, download the current workbook:

```powershell
$serviceUrl = "https://tfs-analytics.onrender.com"

curl.exe -fL `
  -H "x-api-key: $env:SYNC_API_KEY" `
  -o "$env:USERPROFILE\Downloads\StatusReport.xlsx" `
  "$serviceUrl/api/weekly-status-report/export-v2.xlsx?layout=agent7-weekly"
```

Use the raw URL shown above. Do not wrap it in Markdown link syntax such as `[URL](URL)`.

The server-generated filename follows the Pacific date convention. Supplying `-o` gives the local file the requested name.

## Preview and validation

### Placement preview

The read-only placement preview shows which active analytics rows pass filters and where they are routed:

```powershell
$serviceUrl = "https://tfs-analytics.onrender.com"

curl.exe -fL `
  -H "x-api-key: $env:SYNC_API_KEY" `
  -o "$env:USERPROFILE\Downloads\Agent7-placement-preview.json" `
  "$serviceUrl/api/weekly-status-report/placement-preview?layout=agent7-weekly"
```

The preview returns JSON, not an XLSX file.

### Read-only reconciliation and completeness audit

Run this when validating report completeness, hierarchy, or TFS-to-analytics data quality:

```powershell
.\reconcile-tfs.ps1 `
  -Layout "agent7-weekly" `
  -AnalyzeReportCompleteness `
  -OutputPath ".\reports\agent7-reconciliation.json" `
  -CompletenessCsvPath ".\reports\agent7-missing-eligible.csv"
```

Audit exit codes:

- `0`: no discrepancies
- `1`: audit completed with discrepancies
- `2`: configuration, network, or execution failure

For weekly-report completeness, the key acceptance condition is `Eligible missing: 0`. Other audit categories, such as title-only differences, are reported separately and do not necessarily mean the workbook is incomplete.

### Hierarchy repair

Hierarchy repair is not a routine weekly step. Use it only after a fresh audit identifies Bug/PBI parent-or-Feature identity mismatches.

Dry run:

```powershell
.\sync-tfs-lean.ps1 `
  -Mode ReportHierarchyRepair `
  -ReconciliationFile ".\reports\agent7-reconciliation.json"
```

Apply after reviewing the live-revalidated candidates:

```powershell
.\sync-tfs-lean.ps1 `
  -Mode ReportHierarchyRepair `
  -ReconciliationFile ".\reports\agent7-reconciliation.json" `
  -Apply
```

Rerun reconciliation after applying repairs.

## Configuration reference

The v2 definition is `config/weekly-report-definition.v2.json`.

### Source

`source.areaPaths` is the allowlist of TFS areas. `source.match` must remain `exact`. Adding an area does not automatically create a worksheet; add or update a placement rule and target tab as well.

### Filters

```json
"filters": {
  "types": ["Product Backlog Item", "Bug", "Feature"],
  "excludeStates": ["Removed", "Done"],
  "requiredTags": [],
  "requiredTagsMode": "all"
}
```

- `types` is an inclusion list.
- `excludeStates` removes matching states.
- `requiredTags` may be empty.
- `requiredTagsMode` is `all` or `any`.
- Placement override action `exclude` removes an otherwise eligible item.
- Placement override action `place` force-includes and routes an active in-source item.

### Presentation

The current layout uses:

```json
"presentation": {
  "showWorksheetSummaryBand": false,
  "showFeatureSummary": false
}
```

- `showWorksheetSummaryBand: false` removes the merged worksheet date/count band and freezes through row 2 instead of row 3.
- `showFeatureSummary: false` leaves the Status cell blank on Feature rows.
- Feature row shading, Feature child outlines, detail Status highlighting, print headings, and print footers are unaffected by these switches.
- Both properties are optional and default to `true`, preserving layouts created before presentation settings were introduced.
- Presentation settings must be Boolean values. Unknown presentation properties or non-Boolean values fail configuration validation.

### Release selection

`agent7-weekly` uses:

```json
"releaseSelection": {
  "strategy": "highestNumericTag",
  "fallback": "storedRelease"
}
```

When TFS has version-shaped tags, the numerically greatest tag is selected. The stored database release is used only when no version-shaped TFS tag exists. Correct mistyped release tags in TFS, then rerun report-scope refresh.

Layouts without `releaseSelection` use strict selection, which rejects unrelated ambiguous version tags.

### Tabs, sections, and grouping

The current report uses Feature-first grouping:

```json
"grouping": {
  "levels": ["feature"],
  "includeStandaloneItems": true
}
```

Supported grouping modes are:

```json
["feature"]
["release", "feature"]
```

Feature-first displays each Feature once and sorts its detail rows by Version, then PBI/Bug/Task, then ID. Release-first preserves the older Release -> Feature -> detail hierarchy.

Feature row summaries and outlines are presentation-only. They do not change placement, eligibility, Feature identity, release selection, or the underlying work-item records.

### Placement rules

Placement rules route records from exact area paths to configured tab and section keys. Priorities must be unique and deterministic. Use database overrides only for item-specific exceptions; keep general routing rules in version-controlled JSON.

### Columns and limits

Column order is currently fixed to:

```text
version, workItemId, type, title, state, remark
```

`limits.candidateRows` bounds database candidates. `limits.includedRows` bounds placed report records and is also enforced by report-scope refresh.

## Deployment and rollback

When changing grouping, presentation, or other configuration semantics, deploy the configuration and its supporting validator/renderer together. Deploy at least:

- `config/weekly-report-definition.v2.json`
- `lib/weekly-report-config.js`
- `lib/weekly-report-xlsx-v2.js`
- related tests and this runbook in source control

No database migration is required for grouping or workbook-presentation changes. Roll back the current summary suppression by setting both presentation properties to `true` or by omitting the optional `presentation` object.

After deployment:

1. Confirm Render reports a successful deploy.
2. Call placement preview and verify `validForExport: true`.
3. Download and inspect the XLSX.
4. Reconcile detail counts against preview output.

Rollback Feature-first presentation by restoring section grouping to:

```json
"levels": ["release", "feature"]
```

The renderer continues to support that mode. No data rollback or resynchronization is required solely for grouping changes.

## Endpoint reference

| Method | Endpoint                                                              | Purpose                                                          |
| ------ | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET`  | `/api/weekly-status-report/placement-preview?layout=agent7-weekly`    | Read-only filtering and placement preview                        |
| `POST` | `/api/weekly-status-report/completeness-preview?layout=agent7-weekly` | Batched completeness classification used by PowerShell workflows |
| `GET`  | `/api/weekly-status-report/export-v2.xlsx?layout=agent7-weekly`       | XLSX download                                                    |
| `GET`  | `/api/tfs-weekly-sync/capabilities`                                   | Advertised safe sync/repair/refresh modes                        |
| `POST` | `/api/tfs-weekly-sync`                                                | Authenticated ingestion used by `sync-tfs-lean.ps1`              |

All endpoints above use the existing `x-api-key: <SYNC_API_KEY>` contract. The legacy pilot endpoint `/api/weekly-status-report/export.xlsx` is separate from the v2 workflow.

## Troubleshooting

### `404 Not Found`

- Confirm the URL has one slash before `api`.
- Confirm the latest server files were deployed.
- Confirm the corresponding feature flag is enabled.
- `ENABLE_WEEKLY_REPORT_V2_XLSX=false` intentionally leaves the export route unregistered.

### `401 Unauthorized`

- Confirm `$env:SYNC_API_KEY` is populated.
- Confirm it exactly matches Render `SYNC_API_KEY`.

### `422 Unprocessable Entity`

- Rerun without curl `-f` to save or display the JSON response body.
- Check for unknown layout, invalid definition, unplaced eligible records, truncation, or filters returning no report-ready data.
- Use placement preview to inspect validation and counts.

### `503 report_*_unavailable`

- Deploy configuration, validator, renderer, and route dependencies together.
- Check Render logs for configuration validation or module initialization errors.
- Confirm the required feature flags are enabled.

### Server does not advertise report-scope refresh

- Deploy the current server sync-mode and completeness modules.
- Set both `ENABLE_WEEKLY_REPORT_PREVIEW=true` and `ENABLE_WEEKLY_REPORT_SCOPE_REFRESH=true`.
- Restart or redeploy Render, then rerun the refresh-only command.

### Deployed completeness layout area paths do not match

- Commit and deploy `config/weekly-report-definition.v2.json` to the same service referenced by `INGEST_URL`.
- Restart or redeploy the service so the preview, completeness, refresh, and export routes reload the definition.
- Rerun the refresh only after the deployed and local `source.areaPaths` lists match exactly.

### Refresh ends with eligible missing records

- Review the timestamped refresh summary in `reports/`.
- Run reconciliation with `-AnalyzeReportCompleteness`.
- Correct TFS/configuration problems or rerun the idempotent refresh after a partial batch failure.

### Corrected TFS data is not visible in the workbook

An already downloaded workbook is immutable. Run report-scope refresh after the TFS correction, then download a new XLSX.

### Curl returns `200` but no workbook is visible

Use `-o <path>` to save binary output. Do not print XLSX bytes to the terminal.

### Excel reports repaired or unreadable worksheet content

- Discard the affected download and confirm the current `lib/weekly-report-xlsx-v2.js` is deployed.
- Download a newly generated workbook; previously generated XLSX files are immutable.
- This renderer intentionally applies row outline levels without ExcelJS's optional sheet-level `outlineProperties`, because combining that property with fit-to-page printing can serialize worksheet properties in an order that desktop Excel rejects.
- A report-scope refresh is not required when only the renderer changed.

## Maintenance checklist

Update this runbook whenever a change affects any of the following:

- Layout key, source area, filter, release-selection, grouping, placement, column, or limit configuration
- Environment variables or feature flags
- API paths, authentication, response behavior, or deployment dependencies
- Weekly sync, refresh, audit, repair, preview, or export commands
- Database migrations or placement override semantics
- Success criteria, output filenames, or troubleshooting steps

Run `npm test` before deployment and keep the Feature-first and release-first compatibility tests passing.
