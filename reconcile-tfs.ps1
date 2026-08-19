<#
.SYNOPSIS
Read-only reconciliation of TFS work items against the Render analytics database.

.DESCRIPTION
Without -Layout, preserves the legacy random release-sample audit.
With -Layout, performs a deterministic full report-scope audit by unioning:
- work items currently returned by TFS for the layout's exact area paths;
- active database rows whose stored area path is in the layout; and
- optional explicitly requested work item IDs.

The script resolves live TFS parent ancestry to an actual Feature, compares the
result with PostgreSQL data exposed by /api/lean-workitems, and writes a JSON
report. It never calls the ingest endpoint or changes TFS/PostgreSQL data.

Exit codes:
  0 = audit completed with no discrepancies
  1 = audit completed and discrepancies were found
  2 = configuration, network, or execution failure

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\reconcile-tfs.ps1 `
    -Layout agent7-weekly `
    -OutputPath .\reports\agent7-reconciliation.json
#>

[CmdletBinding()]
param(
  [string] $TfsHost = 'https://remote.spdev.us',
  [string] $Collection = 'SupplyPro.Applications',
  [string] $Project = 'SupplyPro.Core',
  [string] $ApiVersion = '2.0',
  [ValidateRange(1, 10000)][int] $SampleSize = 10,
  [string[]] $ReleaseTargets = @(),
  [string] $Layout = '',
  [string] $LayoutPath = '',
  [string] $OutputPath = '',
  [int[]] $WorkItemIds = @(),
  [ValidateRange(1, 200)][int] $TfsBatchSize = 150,
  [ValidateRange(1, 50)][int] $MaxHierarchyDepth = 10
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$auditLibraryPath = Join-Path $PSScriptRoot 'lib\reconcile-tfs-audit.ps1'
if (-not (Test-Path -LiteralPath $auditLibraryPath -PathType Leaf)) {
  Write-Error "Reconciliation library not found: $auditLibraryPath"
  exit 2
}
. $auditLibraryPath

function Get-VersionSegments {
  param([string] $Value)

  if ([string]::IsNullOrWhiteSpace($Value)) { return @() }
  return @([regex]::Matches($Value, '\d+') | ForEach-Object { [int]$_.Value })
}

function Compare-Version {
  param([string] $Left, [string] $Right)

  $leftSegments = Get-VersionSegments -Value $Left
  $rightSegments = Get-VersionSegments -Value $Right
  $length = [Math]::Max($leftSegments.Count, $rightSegments.Count)
  for ($index = 0; $index -lt $length; $index++) {
    $leftValue = if ($index -lt $leftSegments.Count) { $leftSegments[$index] } else { 0 }
    $rightValue = if ($index -lt $rightSegments.Count) { $rightSegments[$index] } else { 0 }
    if ($leftValue -gt $rightValue) { return 1 }
    if ($leftValue -lt $rightValue) { return -1 }
  }
  return 0
}

function Get-NormalizedReleaseTargets {
  param([string[]] $Targets)

  $values = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($target in @($Targets)) {
    if ([string]::IsNullOrWhiteSpace($target)) { continue }
    $trimmed = $target.Trim()
    [void]$values.Add($trimmed)
    $lastDot = $trimmed.LastIndexOf('.')
    if ($lastDot -gt 0) {
      [void]$values.Add($trimmed.Substring(0, $lastDot))
    }
  }
  return @($values)
}

function Find-ReleaseInTags {
  param([AllowNull()][object] $Tags, [string[]] $Targets)

  if ($null -eq $Tags -or [string]::IsNullOrWhiteSpace([string]$Tags) -or $Targets.Count -eq 0) {
    return $null
  }

  $parts = @(
    ([string]$Tags).ToLowerInvariant() -split '[;\r\n,|\s]+' |
      ForEach-Object { $_.Trim() } |
      Where-Object { $_ }
  )
  $matches = @()
  foreach ($target in $Targets) {
    $normalizedTarget = $target.ToLowerInvariant()
    foreach ($part in $parts) {
      if ($part -eq $normalizedTarget -or $part.StartsWith($normalizedTarget)) {
        $matches += $target
        break
      }
    }
  }
  if ($matches.Count -eq 0) { return $null }

  $best = $matches[0]
  foreach ($match in $matches) {
    if ((Compare-Version -Left $match -Right $best) -gt 0) { $best = $match }
  }
  return $best
}

function ConvertTo-WiqlLiteral {
  param([Parameter(Mandatory = $true)][string] $Value)
  return $Value.Replace("'", "''")
}

function Invoke-TfsWiqlIds {
  param(
    [Parameter(Mandatory = $true)][string] $Wiql,
    [Parameter(Mandatory = $true)][hashtable] $Headers
  )

  $url = "$TfsHost/tfs/$Collection/$Project/_apis/wit/wiql?api-version=$ApiVersion"
  $body = @{ query = $Wiql } | ConvertTo-Json
  # WIQL POST is a read-only TFS query; this script never POSTs to Render ingestion.
  $response = Invoke-RestMethod -Method Post -Uri $url -Headers ($Headers + @{ 'Content-Type' = 'application/json' }) -Body $body
  if ($null -eq $response.workItems) { return @() }
  return @($response.workItems | ForEach-Object { [int]$_.id } | Sort-Object -Unique)
}

function Get-TfsWorkItemsById {
  param(
    [int[]] $Ids,
    [Parameter(Mandatory = $true)][hashtable] $Headers
  )

  $uniqueIds = @($Ids | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
  $results = New-Object System.Collections.ArrayList
  for ($offset = 0; $offset -lt $uniqueIds.Count; $offset += $TfsBatchSize) {
    $last = [Math]::Min($offset + $TfsBatchSize - 1, $uniqueIds.Count - 1)
    $batch = @($uniqueIds[$offset..$last])
    $idParameter = $batch -join ','
    $url = "$TfsHost/tfs/$Collection/_apis/wit/workitems?api-version=$ApiVersion&ids=$idParameter&`$expand=relations"
    $response = Invoke-RestMethod -Method Get -Uri $url -Headers $Headers
    foreach ($item in @($response.value)) {
      if ($null -ne $item) { [void]$results.Add($item) }
    }
  }
  return @($results)
}

function Get-AnalyticsApiBaseUrl {
  param([Parameter(Mandatory = $true)][string] $ConfiguredIngestUrl)

  $trimmed = $ConfiguredIngestUrl.TrimEnd('/')
  if ($trimmed -notmatch '^(.+)/api/tfs-weekly-sync$') {
    throw 'INGEST_URL must end with /api/tfs-weekly-sync.'
  }
  return $Matches[1]
}

function Get-DatabaseWorkItems {
  param(
    [Parameter(Mandatory = $true)][string] $ApiBaseUrl,
    [Parameter(Mandatory = $true)][string] $ApiKey
  )

  $apiUrl = "$ApiBaseUrl/api/lean-workitems"
  $limit = 1000
  $offset = 0
  $expectedCount = $null
  $rows = New-Object System.Collections.ArrayList

  do {
    $fullUri = "${apiUrl}?limit=$limit&offset=$offset"
    $response = Invoke-RestMethod -Method Get -Uri $fullUri -Headers @{ 'x-api-key' = $ApiKey }
    if ($response.ok -ne $true) { throw "Analytics API returned an unsuccessful response for offset $offset." }
    if ($null -eq $expectedCount) { $expectedCount = [int]$response.count }
    $page = @($response.rows)
    foreach ($row in $page) {
      if ($null -ne $row) { [void]$rows.Add($row) }
    }
    if ($page.Count -eq 0) { break }
    $offset += $page.Count
  } while ($rows.Count -lt $expectedCount)

  return @($rows)
}

function Get-LayoutDefinition {
  param(
    [Parameter(Mandatory = $true)][string] $ConfigPath,
    [Parameter(Mandatory = $true)][string] $LayoutKey
  )

  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Weekly-report definition not found: $ConfigPath"
  }
  $definition = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if ([int]$definition.schemaVersion -ne 2) { throw 'Weekly-report definition schemaVersion must be 2.' }
  $layoutProperty = $definition.layouts.PSObject.Properties[$LayoutKey]
  if ($null -eq $layoutProperty) { throw "Unknown weekly-report layout '$LayoutKey'." }
  $layoutDefinition = $layoutProperty.Value
  if ([string]$layoutDefinition.source.match -ne 'exact') {
    throw "Layout '$LayoutKey' must use exact source matching for reconciliation."
  }
  $areaPaths = @(
    $layoutDefinition.source.areaPaths |
      ForEach-Object { ([string]$_).Trim() } |
      Where-Object { $_ } |
      Sort-Object -Unique
  )
  if ($areaPaths.Count -eq 0) { throw "Layout '$LayoutKey' has no source area paths." }
  return [pscustomobject]@{ key = $LayoutKey; definition = $layoutDefinition; areaPaths = $areaPaths }
}

function Add-ItemsToLookup {
  param([hashtable] $Lookup, [object[]] $Items)
  foreach ($item in @($Items)) {
    if ($null -eq $item) { continue }
    $id = [int]$item.id
    if ($id -gt 0) { $Lookup[$id] = $item }
  }
}

function Expand-TfsAncestorLookup {
  param(
    [int[]] $CandidateIds,
    [hashtable] $Lookup,
    [hashtable] $Headers
  )

  $frontier = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($candidateId in $CandidateIds) {
    if (-not $Lookup.ContainsKey($candidateId)) { continue }
    $candidate = $Lookup[$candidateId]
    if ([string]$candidate.fields.'System.WorkItemType' -eq 'Feature') { continue }
    $parentId = Get-AuditParentId -WorkItem $candidate
    if ($null -ne $parentId) { [void]$frontier.Add($parentId) }
  }

  $processed = New-Object 'System.Collections.Generic.HashSet[int]'
  for ($depth = 1; $depth -le $MaxHierarchyDepth -and $frontier.Count -gt 0; $depth++) {
    $frontierIds = @($frontier | Sort-Object)
    $toFetch = @($frontierIds | Where-Object { -not $Lookup.ContainsKey($_) })
    if ($toFetch.Count -gt 0) {
      Add-ItemsToLookup -Lookup $Lookup -Items (Get-TfsWorkItemsById -Ids $toFetch -Headers $Headers)
    }

    $next = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($id in $frontierIds) {
      if (-not $processed.Add($id) -or -not $Lookup.ContainsKey($id)) { continue }
      $item = $Lookup[$id]
      if ([string]$item.fields.'System.WorkItemType' -eq 'Feature') { continue }
      $parentId = Get-AuditParentId -WorkItem $item
      if ($null -ne $parentId -and -not $processed.Contains($parentId)) {
        [void]$next.Add($parentId)
      }
    }
    $frontier = $next
  }
}

function Resolve-AuditOutputPath {
  param([string] $RequestedPath, [string] $LayoutKey)

  if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
    if ([IO.Path]::IsPathRooted($RequestedPath)) { return $RequestedPath }
    return Join-Path (Get-Location).Path $RequestedPath
  }
  if ([string]::IsNullOrWhiteSpace($LayoutKey)) { return $null }
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  return Join-Path $PSScriptRoot "reports\$LayoutKey-reconciliation-$timestamp.json"
}

function Write-AuditOutput {
  param([Parameter(Mandatory = $true)][object] $Report, [string] $Path)

  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  $directory = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($directory) -and -not (Test-Path -LiteralPath $directory)) {
    [void](New-Item -ItemType Directory -Path $directory -Force)
  }
  $Report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
  return $Path
}

try {
  $pat = $env:TFS_PAT
  if ([string]::IsNullOrWhiteSpace($pat)) { throw 'Set env var TFS_PAT to your TFS PAT.' }
  $ingestUrl = $env:INGEST_URL
  if ([string]::IsNullOrWhiteSpace($ingestUrl)) { throw 'Set env var INGEST_URL to your Render sync endpoint.' }
  $syncKey = $env:SYNC_API_KEY
  if ([string]::IsNullOrWhiteSpace($syncKey)) { throw 'Set env var SYNC_API_KEY.' }

  $authHeader = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(':' + $pat))
  $tfsHeaders = @{ Authorization = $authHeader }
  $apiBaseUrl = Get-AnalyticsApiBaseUrl -ConfiguredIngestUrl $ingestUrl

  $releaseTargetsPath = Join-Path $PSScriptRoot 'release-targets.ps1'
  if ($ReleaseTargets.Count -eq 0 -and (Test-Path -LiteralPath $releaseTargetsPath)) {
    . $releaseTargetsPath
    if (Get-Command Get-DefaultReleaseTargets -ErrorAction SilentlyContinue) {
      $ReleaseTargets = @(Get-DefaultReleaseTargets)
    }
  }
  $activeReleaseTargets = @(Get-NormalizedReleaseTargets -Targets $ReleaseTargets)

  if ([string]::IsNullOrWhiteSpace($LayoutPath)) {
    $LayoutPath = Join-Path $PSScriptRoot 'config\weekly-report-definition.v2.json'
  }

  $layoutInfo = $null
  $tfsAreaIds = @()

  if (-not [string]::IsNullOrWhiteSpace($Layout)) {
    $layoutInfo = Get-LayoutDefinition -ConfigPath $LayoutPath -LayoutKey $Layout
    $areaClauses = @($layoutInfo.areaPaths | ForEach-Object {
      "[System.AreaPath] = '$(ConvertTo-WiqlLiteral -Value $_)'"
    })
    $wiql = @"
SELECT [System.Id]
FROM WorkItems
WHERE [System.TeamProject] = @project
  AND [System.WorkItemType] IN ('Product Backlog Item','Bug','Task','Feature')
  AND ($($areaClauses -join ' OR '))
ORDER BY [System.Id]
"@
    Write-Host "Discovering TFS items for layout '$Layout'..." -ForegroundColor Cyan
    $tfsAreaIds = @(Invoke-TfsWiqlIds -Wiql $wiql -Headers $tfsHeaders)
  }
  else {
    if ($activeReleaseTargets.Count -eq 0) {
      throw 'ReleaseTargets is empty. Populate release-targets.ps1 or pass -ReleaseTargets for legacy sample mode.'
    }
    $tagConditions = @($activeReleaseTargets | ForEach-Object {
      "[System.Tags] CONTAINS '$(ConvertTo-WiqlLiteral -Value $_)'"
    })
    $wiql = @"
SELECT [System.Id]
FROM WorkItems
WHERE [System.TeamProject] = @project
  AND [System.WorkItemType] IN ('Product Backlog Item','Bug','Task','Feature')
  AND ($($tagConditions -join ' OR '))
ORDER BY [System.ChangedDate] DESC
"@
    Write-Host 'Discovering TFS items for the legacy release sample...' -ForegroundColor Cyan
    $releaseIds = @(Invoke-TfsWiqlIds -Wiql $wiql -Headers $tfsHeaders)
    if ($releaseIds.Count -gt 0) {
      $tfsAreaIds = @(Get-Random -InputObject $releaseIds -Count ([Math]::Min($SampleSize, $releaseIds.Count)))
    }
  }

  Write-Host 'Fetching active analytics rows from Render...' -ForegroundColor Cyan
  $databaseItems = @(Get-DatabaseWorkItems -ApiBaseUrl $apiBaseUrl -ApiKey $syncKey)
  $databaseLookup = @{}
  foreach ($item in $databaseItems) {
    $id = [int]$item.workItemId
    if ($id -gt 0) { $databaseLookup[$id] = $item }
  }

  $databaseAreaIds = @()
  if ($null -ne $layoutInfo) {
    $areaPathSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($areaPath in $layoutInfo.areaPaths) { [void]$areaPathSet.Add($areaPath) }
    $databaseAreaIds = @(
      $databaseItems |
        Where-Object { $null -ne $_.areaPath -and $areaPathSet.Contains([string]$_.areaPath) } |
        ForEach-Object { [int]$_.workItemId } |
        Sort-Object -Unique
    )
  }

  $explicitIds = @($WorkItemIds | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
  $candidateIds = @($tfsAreaIds + $databaseAreaIds + $explicitIds | Sort-Object -Unique)

  Write-Host "Candidate IDs: $($candidateIds.Count)" -ForegroundColor White
  Write-Host "  TFS area/sample: $($tfsAreaIds.Count)" -ForegroundColor Gray
  Write-Host "  Database area:   $($databaseAreaIds.Count)" -ForegroundColor Gray
  Write-Host "  Explicit IDs:    $($explicitIds.Count)" -ForegroundColor Gray

  $tfsLookup = @{}
  if ($candidateIds.Count -gt 0) {
    Write-Host 'Fetching current TFS fields and relations...' -ForegroundColor Cyan
    Add-ItemsToLookup -Lookup $tfsLookup -Items (Get-TfsWorkItemsById -Ids $candidateIds -Headers $tfsHeaders)
    Write-Host 'Resolving parent ancestry to Feature records...' -ForegroundColor Cyan
    Expand-TfsAncestorLookup -CandidateIds $candidateIds -Lookup $tfsLookup -Headers $tfsHeaders
  }

  $missingFromDatabase = New-Object System.Collections.ArrayList
  $missingFromTfs = New-Object System.Collections.ArrayList
  $hierarchyMismatches = New-Object System.Collections.ArrayList
  $fieldMismatches = New-Object System.Collections.ArrayList
  $resolutionIssues = New-Object System.Collections.ArrayList
  $staleDatabaseRecords = New-Object System.Collections.ArrayList
  $discrepantIds = New-Object 'System.Collections.Generic.HashSet[int]'
  $checkedCount = 0

  foreach ($candidateId in $candidateIds) {
    $hasTfs = $tfsLookup.ContainsKey($candidateId)
    $hasDatabase = $databaseLookup.ContainsKey($candidateId)
    if (-not $hasTfs) {
      [void]$missingFromTfs.Add([pscustomobject]@{
        workItemId = $candidateId
        databaseTitle = if ($hasDatabase) { $databaseLookup[$candidateId].title } else { $null }
        databaseAreaPath = if ($hasDatabase) { $databaseLookup[$candidateId].areaPath } else { $null }
      })
      [void]$discrepantIds.Add($candidateId)
      continue
    }
    if (-not $hasDatabase) {
      $tfsItem = $tfsLookup[$candidateId]
      [void]$missingFromDatabase.Add([pscustomobject]@{
        workItemId = $candidateId
        tfsTitle = ConvertTo-AuditStoredText -Value $tfsItem.fields.'System.Title'
        tfsAreaPath = $tfsItem.fields.'System.AreaPath'
      })
      [void]$discrepantIds.Add($candidateId)
      continue
    }

    $checkedCount++
    $tfsItem = $tfsLookup[$candidateId]
    $databaseItem = $databaseLookup[$candidateId]
    $featureResolution = Resolve-AuditFeature -WorkItem $tfsItem -TfsLookup $tfsLookup -MaxDepth $MaxHierarchyDepth
    $tfsRelease = if ($activeReleaseTargets.Count -gt 0) {
      Find-ReleaseInTags -Tags $tfsItem.fields.'System.Tags' -Targets $activeReleaseTargets
    } else { $null }
    $comparison = Compare-AuditWorkItem `
      -TfsItem $tfsItem `
      -DatabaseItem $databaseItem `
      -FeatureResolution $featureResolution `
      -TfsRelease $tfsRelease `
      -CompareRelease ($activeReleaseTargets.Count -gt 0)

    foreach ($mismatch in $comparison.fieldMismatches) {
      [void]$fieldMismatches.Add($mismatch)
      [void]$discrepantIds.Add($candidateId)
    }
    if ($null -ne $comparison.hierarchyMismatch) {
      [void]$hierarchyMismatches.Add($comparison.hierarchyMismatch)
      [void]$discrepantIds.Add($candidateId)
    }
    if ($null -ne $comparison.resolutionIssue) {
      [void]$resolutionIssues.Add($comparison.resolutionIssue)
      [void]$discrepantIds.Add($candidateId)
    }
    if ($null -ne $comparison.staleRecord) {
      [void]$staleDatabaseRecords.Add($comparison.staleRecord)
      [void]$discrepantIds.Add($candidateId)
    }
  }

  $hierarchyIdentityMismatchCount = @(
    $hierarchyMismatches | Where-Object { $_.classification -eq 'identity' }
  ).Count
  $hierarchyTitleOnlyMismatchCount = @(
    $hierarchyMismatches | Where-Object { $_.classification -eq 'title_only' }
  ).Count

  $report = [pscustomobject][ordered]@{
    schemaVersion = 1
    auditType = if ($null -ne $layoutInfo) { 'report-scope' } else { 'legacy-sample' }
    readOnly = $true
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    layout = if ($null -ne $layoutInfo) { $Layout } else { $null }
    layoutPath = if ($null -ne $layoutInfo) { [IO.Path]::GetFullPath($LayoutPath) } else { $null }
    areaPaths = if ($null -ne $layoutInfo) { @($layoutInfo.areaPaths) } else { @() }
    settings = [pscustomobject]@{
      maxHierarchyDepth = $MaxHierarchyDepth
      tfsBatchSize = $TfsBatchSize
      releaseComparisonEnabled = ($activeReleaseTargets.Count -gt 0)
    }
    candidates = [pscustomobject]@{
      tfsAreaOrSampleCount = $tfsAreaIds.Count
      databaseAreaCount = $databaseAreaIds.Count
      explicitCount = $explicitIds.Count
      unionCount = $candidateIds.Count
    }
    summary = [pscustomobject]@{
      candidateCount = $candidateIds.Count
      checkedCount = $checkedCount
      itemsWithDiscrepancies = $discrepantIds.Count
      hierarchyMismatchCount = $hierarchyMismatches.Count
      hierarchyIdentityMismatchCount = $hierarchyIdentityMismatchCount
      hierarchyTitleOnlyMismatchCount = $hierarchyTitleOnlyMismatchCount
      fieldMismatchCount = $fieldMismatches.Count
      hierarchyResolutionIssueCount = $resolutionIssues.Count
      staleDatabaseRecordCount = $staleDatabaseRecords.Count
      missingFromDatabaseCount = $missingFromDatabase.Count
      missingFromTfsCount = $missingFromTfs.Count
      clean = ($discrepantIds.Count -eq 0)
    }
    hierarchyMismatches = @($hierarchyMismatches)
    fieldMismatches = @($fieldMismatches)
    hierarchyResolutionIssues = @($resolutionIssues)
    staleDatabaseRecords = @($staleDatabaseRecords)
    missingFromDatabase = @($missingFromDatabase)
    missingFromTfs = @($missingFromTfs)
  }

  $resolvedOutputPath = Resolve-AuditOutputPath -RequestedPath $OutputPath -LayoutKey $Layout
  $writtenPath = Write-AuditOutput -Report $report -Path $resolvedOutputPath

  Write-Host ''
  Write-Host '========================================' -ForegroundColor Cyan
  Write-Host 'TFS Report-Scope Reconciliation Audit' -ForegroundColor Cyan
  Write-Host '========================================' -ForegroundColor Cyan
  Write-Host "Candidates:                  $($report.summary.candidateCount)"
  Write-Host "Checked in TFS and DB:       $($report.summary.checkedCount)"
  Write-Host "Items with discrepancies:    $($report.summary.itemsWithDiscrepancies)" -ForegroundColor $(if ($report.summary.clean) { 'Green' } else { 'Yellow' })
  Write-Host "Hierarchy mismatches:        $($report.summary.hierarchyMismatchCount)"
  Write-Host "  Parent/Feature ID:         $($report.summary.hierarchyIdentityMismatchCount)"
  Write-Host "  Feature title only:        $($report.summary.hierarchyTitleOnlyMismatchCount)"
  Write-Host "Other field mismatches:      $($report.summary.fieldMismatchCount)"
  Write-Host "Hierarchy resolution issues: $($report.summary.hierarchyResolutionIssueCount)"
  Write-Host "Stale database records:      $($report.summary.staleDatabaseRecordCount)"
  Write-Host "Missing from database:       $($report.summary.missingFromDatabaseCount)"
  Write-Host "Missing from TFS:            $($report.summary.missingFromTfsCount)"
  if ($null -ne $writtenPath) { Write-Host "JSON report:                 $writtenPath" -ForegroundColor Gray }

  if ($hierarchyMismatches.Count -gt 0) {
    Write-Host ''
    Write-Host 'Hierarchy mismatch examples:' -ForegroundColor Yellow
    $hierarchyMismatches | Select-Object -First 20 workItemId, classification, databaseParentId, tfsParentId, databaseFeatureId, tfsFeatureId, resolutionStatus | Format-Table -AutoSize
  }

  if ($report.summary.clean) {
    Write-Host 'Audit completed with no discrepancies.' -ForegroundColor Green
    exit 0
  }
  Write-Host 'Audit completed with discrepancies. No data was changed.' -ForegroundColor Yellow
  exit 1
}
catch {
  Write-Error "Reconciliation audit failed: $($_.Exception.Message)"
  exit 2
}
