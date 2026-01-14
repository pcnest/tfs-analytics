<#
reconcile-tfs.ps1
P1 FIX: Reconciliation check to verify DB data matches TFS reality

This script:
- Fetches a random sample of work items from TFS
- Compares them with DB data from Render
- Logs any mismatches (missing items, differing titles/states/etc)

Run weekly via Task Scheduler or GitHub Actions to detect data drift.

Prereqs:
- Set env vars: TFS_PAT, SYNC_API_KEY, INGEST_URL
- Must be on VPN / able to reach TFS host

Run:
  powershell -ExecutionPolicy Bypass -File .\reconcile-tfs.ps1
#>

param(
  [string] $TfsHost = "https://remote.spdev.us",
  [string] $Collection = "SupplyPro.Applications",
  [string] $Project = "SupplyPro.Core",
  [string] $ApiVersion = "2.0",
  [int]    $SampleSize = 10,
  [string[]] $ReleaseTargets = @("80.1.6", "80.1.5", "18.5", "18.4", "18.3", "5.0.5", "4.3.26")
)

# ---------- Setup ----------
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Pat = $env:TFS_PAT
if ([string]::IsNullOrWhiteSpace($Pat)) { throw "Set env var TFS_PAT to your TFS PAT." }

$IngestUrl = $env:INGEST_URL
if ([string]::IsNullOrWhiteSpace($IngestUrl)) { throw "Set env var INGEST_URL to your Render endpoint." }

$SyncKey = $env:SYNC_API_KEY
if ([string]::IsNullOrWhiteSpace($SyncKey)) { throw "Set env var SYNC_API_KEY." }

$authHeader = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":" + $Pat))
$commonHeaders = @{ Authorization = $authHeader }

function Get-VersionSegments {
  param([string]$v)
  if ([string]::IsNullOrWhiteSpace($v)) { return @() }
  $nums = [regex]::Matches($v, "\d+")
  $segs = @()
  foreach ($m in $nums) { $segs += [int]$m.Value }
  return $segs
}

function Compare-Version {
  param([string]$A, [string]$B)
  $aSeg = Get-VersionSegments $A
  $bSeg = Get-VersionSegments $B
  $len = [Math]::Max($aSeg.Count, $bSeg.Count)
  for ($i = 0; $i -lt $len; $i++) {
    $aVal = if ($i -lt $aSeg.Count) { $aSeg[$i] } else { 0 }
    $bVal = if ($i -lt $bSeg.Count) { $bSeg[$i] } else { 0 }
    if ($aVal -gt $bVal) { return 1 }
    if ($aVal -lt $bVal) { return -1 }
  }
  return 0
}

function Find-ReleaseInTags {
  param([string]$Tags, [string[]]$Targets)
  if ([string]::IsNullOrWhiteSpace($Tags) -or -not $Targets -or $Targets.Count -eq 0) { return $null }
  $parts = ($Tags.ToLowerInvariant() -split "[;\r\n,\|\s]+") | Where-Object { $_ -and $_.Trim() -ne "" } | ForEach-Object { $_.Trim() }
  $matches = @()
  foreach ($rt in $Targets) {
    $r = $rt.ToLowerInvariant()
    foreach ($p in $parts) {
      if ($p -eq $r -or $p.StartsWith($r)) {
        $matches += $rt
        break
      }
    }
  }
  if ($matches.Count -eq 0) { return $null }
  $best = $matches[0]
  foreach ($m in $matches) {
    if ((Compare-Version $m $best) -gt 0) { $best = $m }
  }
  return $best
}

function Get-NormalizedReleaseTargets {
  param([string[]]$Targets)
  if (-not $Targets -or $Targets.Count -eq 0) { return @() }
  $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($t in $Targets) {
    if ([string]::IsNullOrWhiteSpace($t)) { continue }
    $trimmed = $t.Trim()
    [void]$set.Add($trimmed)
    $lastDot = $trimmed.LastIndexOf('.')
    if ($lastDot -gt 0) {
      $base = $trimmed.Substring(0, $lastDot)
      if (-not [string]::IsNullOrWhiteSpace($base)) { [void]$set.Add($base) }
    }
  }
  return @($set)
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "TFS Analytics Reconciliation Check" -ForegroundColor Cyan
Write-Host "Sample Size: $SampleSize" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ---------- Fetch sample IDs from TFS ----------
$tagFilter = ""
$ActiveReleaseTargets = Get-NormalizedReleaseTargets -Targets $ReleaseTargets
if ($ActiveReleaseTargets.Count -gt 0) {
  $tagConds = $ActiveReleaseTargets | ForEach-Object { "[System.Tags] CONTAINS '$_'" }
  $tagFilter = " AND (" + ($tagConds -join " OR ") + ")"
}

$wiqlText = @"
SELECT [System.Id]
FROM WorkItems
WHERE [System.TeamProject] = @project
  AND [System.WorkItemType] IN ('Product Backlog Item','Bug','Task','Feature')
$tagFilter
ORDER BY [System.ChangedDate] DESC
"@

Write-Host "Fetching work item IDs from TFS..."
$url = "$TfsHost/tfs/$Collection/$Project/_apis/wit/wiql?api-version=$ApiVersion"
$body = @{ query = $wiqlText } | ConvertTo-Json
$resp = Invoke-RestMethod -Method Post -Uri $url -Headers ($commonHeaders + @{ "Content-Type" = "application/json" }) -Body $body

if (-not $resp.workItems -or $resp.workItems.Count -eq 0) {
  Write-Host "No work items found in TFS. Exiting." -ForegroundColor Yellow
  exit 0
}

$allIds = @($resp.workItems | ForEach-Object { [int]$_.id })
Write-Host "Found $($allIds.Count) work items in TFS"

# ---------- Random sample ----------
$sampleIds = Get-Random -InputObject $allIds -Count ([Math]::Min($SampleSize, $allIds.Count))
Write-Host "Sampling $($sampleIds.Count) work items for reconciliation check"
Write-Host ""

# ---------- Fetch details from TFS ----------
Write-Host "Fetching work item details from TFS..."
$idParam = ($sampleIds -join ",")
$url = "$TfsHost/tfs/$Collection/_apis/wit/workitems?api-version=$ApiVersion&ids=$idParam&`$expand=relations"
$tfsItems = (Invoke-RestMethod -Method Get -Uri $url -Headers $commonHeaders).value

# ---------- Fetch same items from Render DB ----------
Write-Host "Fetching work item details from Render DB..."
# Build API URL by replacing the sync endpoint path
if ($IngestUrl -match '^(.+)/api/tfs-weekly-sync$') {
  $apiBaseUrl = $Matches[1]
  $apiUrl = "$apiBaseUrl/api/lean-workitems"
}
else {
  # Fallback: try to construct it
  $apiUrl = $IngestUrl -replace '/tfs-weekly-sync$', '/lean-workitems'
}

Write-Host "API URL: $apiUrl" -ForegroundColor Gray

# Pull all DB rows (paged)
$limit = 1000
$offset = 0
$dbItems = @()
$totalCount = $null
do {
  $fullUri = $apiUrl + "?limit=$limit&offset=$offset"
  Write-Host "Full URI: $fullUri" -ForegroundColor Gray
  $dbResp = Invoke-RestMethod -Method Get -Uri $fullUri -Headers @{ "x-api-key" = $SyncKey }
  if ($null -eq $totalCount) { $totalCount = $dbResp.count }
  if ($dbResp.rows) { $dbItems += $dbResp.rows }
  $offset += $limit
} while ($totalCount -gt 0 -and $dbItems.Count -lt $totalCount)

# Create lookup by work_item_id
$dbLookup = @{}
foreach ($item in $dbItems) {
  $dbLookup[[int]$item.workItemId] = $item
}

# ---------- Compare ----------
$mismatches = @()
$missing = @()

foreach ($tfsItem in $tfsItems) {
  $id = [int]$tfsItem.id
  $dbItem = $dbLookup[$id]
  
  if (-not $dbItem) {
    $missing += [PSCustomObject]@{
      WorkItemId = $id
      Title      = $tfsItem.fields.'System.Title'
      Issue      = "Missing from DB"
    }
    Write-Host "❌ MISMATCH: Work item $id exists in TFS but NOT in DB" -ForegroundColor Red
    continue
  }
  
  # Compare key fields
  # Apply same sanitization as sync script to normalize for comparison
  $tfsTitle = $tfsItem.fields.'System.Title'
  if ($tfsTitle) {
    # Replace regular ASCII quotes and Unicode curly quotes with single quotes
    $tfsTitle = $tfsTitle -replace '"', "'" -replace '[\u201C\u201D]', "'"
    # Normalize Unicode dashes to regular hyphen
    $tfsTitle = $tfsTitle -replace '[\u2013\u2014]', '-'
    # Normalize Unicode apostrophes to regular apostrophe
    $tfsTitle = $tfsTitle -replace '[\u2018\u2019]', "'"
  }
  
  $tfsState = $tfsItem.fields.'System.State'
  $tfsType = $tfsItem.fields.'System.WorkItemType'
  $tfsRelease = Find-ReleaseInTags -Tags $tfsItem.fields.'System.Tags' -Targets $ActiveReleaseTargets
  
  if ($dbItem.title -ne $tfsTitle) {
    $mismatches += [PSCustomObject]@{
      WorkItemId = $id
      Field      = "Title"
      TfsValue   = $tfsTitle
      DbValue    = $dbItem.title
    }
    Write-Host "❌ MISMATCH: Work item $id title differs" -ForegroundColor Yellow
    Write-Host "   TFS: '$tfsTitle'" -ForegroundColor Gray
    Write-Host "   DB:  '$($dbItem.title)'" -ForegroundColor Gray
  }
  
  if ($dbItem.state -ne $tfsState) {
    $mismatches += [PSCustomObject]@{
      WorkItemId = $id
      Field      = "State"
      TfsValue   = $tfsState
      DbValue    = $dbItem.state
    }
    Write-Host "❌ MISMATCH: Work item $id state differs" -ForegroundColor Yellow
    Write-Host "   TFS: '$tfsState'" -ForegroundColor Gray
    Write-Host "   DB:  '$($dbItem.state)'" -ForegroundColor Gray
  }
  
  if ($dbItem.type -ne $tfsType) {
    $mismatches += [PSCustomObject]@{
      WorkItemId = $id
      Field      = "Type"
      TfsValue   = $tfsType
      DbValue    = $dbItem.type
    }
    Write-Host "❌ MISMATCH: Work item $id type differs" -ForegroundColor Yellow
    Write-Host "   TFS: '$tfsType'" -ForegroundColor Gray
    Write-Host "   DB:  '$($dbItem.type)'" -ForegroundColor Gray
  }
  if ($dbItem.release -ne $tfsRelease) {
    $mismatches += [PSCustomObject]@{
      WorkItemId = $id
      Field      = "Release"
      TfsValue   = $tfsRelease
      DbValue    = $dbItem.release
    }
    Write-Host "? MISMATCH: Work item $id release differs" -ForegroundColor Yellow
    Write-Host "   TFS: '$tfsRelease'" -ForegroundColor Gray
    Write-Host "   DB:  '$($dbItem.release)'" -ForegroundColor Gray
  }
}

# ---------- Report ----------
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Reconciliation Report" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Sampled Items:     $($sampleIds.Count)" -ForegroundColor White
Write-Host "Missing from DB:   $($missing.Count)" -ForegroundColor $(if ($missing.Count -eq 0) { "Green" } else { "Red" })
Write-Host "Field Mismatches:  $($mismatches.Count)" -ForegroundColor $(if ($mismatches.Count -eq 0) { "Green" } else { "Yellow" })
Write-Host ""

if ($missing.Count -eq 0 -and $mismatches.Count -eq 0) {
  Write-Host "✅ All sampled work items match! DB is in sync with TFS." -ForegroundColor Green
  exit 0
}
else {
  Write-Host "⚠️  Discrepancies found. Run sync to update DB." -ForegroundColor Yellow
  
  if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "Missing Items:" -ForegroundColor Red
    $missing | Format-Table -AutoSize
  }
  
  if ($mismatches.Count -gt 0) {
    Write-Host ""
    Write-Host "Field Mismatches:" -ForegroundColor Yellow
    $mismatches | Format-Table -AutoSize
  }
  
  exit 1
}
