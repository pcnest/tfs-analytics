<#
sync-tfs-lean.ps1
- Fetches TFS work items (filtered by release tags)
- Computes totals always: depCount, relatedLinkCount
- Computes open counts ONLY for active items (not Done/Removed) by fetching linked states only (System.State field)
- Pushes to Render ingest endpoint (which writes to Neon)

Prereqs:
- You are on the VPN / can reach Host
- Set env vars:
  TFS_PAT       = your TFS PAT
  SYNC_API_KEY  = same as Render env SYNC_API_KEY
  INGEST_URL    = e.g. https://your-render-app.onrender.com/api/tfs-weekly-sync

Run:
  powershell -ExecutionPolicy Bypass -File .\sync-tfs-lean.ps1
#>

param(
  [string]   $TfsHost = "https://remote.spdev.us",
  [string]   $Collection = "SupplyPro.Applications",
  [string]   $Project = "SupplyPro.Core",
  [string]   $ApiVersion = "2.0",
  [string[]] $ReleaseTargets = @("80.1.6", "4.3.26", "18.4", "5.0.5"),
  [int]      $ChunkSize = 150,

  # Open counts are computed only if source ticket state NOT in this list:
  [string[]] $SkipOpenCountStates = @("Done", "Removed"),

  # Linked ticket states treated as "terminal" (NOT open)
  [string[]] $TerminalLinkedStates = @("Done", "Removed", "Resolved")
)

# ---------- Setup ----------
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Pat = $env:TFS_PAT
if ([string]::IsNullOrWhiteSpace($Pat)) { throw "Set env var TFS_PAT to your TFS PAT." }

$IngestUrl = $env:INGEST_URL
if ([string]::IsNullOrWhiteSpace($IngestUrl)) { throw "Set env var INGEST_URL to your Render endpoint (/api/tfs-weekly-sync)." }

$SyncKey = $env:SYNC_API_KEY
if ([string]::IsNullOrWhiteSpace($SyncKey)) { throw "Set env var SYNC_API_KEY (must match Render SYNC_API_KEY)." }

$authHeader = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":" + $Pat))
$commonHeaders = @{ Authorization = $authHeader }

function Split-List {
  param([object[]]$List, [int]$Size)
  if (-not $List -or $List.Count -eq 0) { return @() }
  $chunks = @()
  for ($i = 0; $i -lt $List.Count; $i += $Size) {
    $chunks += , ($List[$i..([Math]::Min($i + $Size - 1, $List.Count - 1))])
  }
  return $chunks
}

function Get-Name {
  param($v)
  if ($null -eq $v) { return $null }
  if ($v -is [PSObject]) {
    if ($v.PSObject.Properties.Name -contains 'displayName') { return $v.displayName }
    if ($v.PSObject.Properties.Name -contains 'uniqueName') { return $v.uniqueName }
  }
  return [string]$v
}

function Get-UPN {
  param($v)
  if ($null -eq $v) { return $null }
  if ($v -is [PSObject] -and $v.PSObject.Properties.Name -contains 'uniqueName') { return $v.uniqueName }
  $s = [string]$v
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  $m = [regex]::Match($s, "<(.+?)>")
  if ($m.Success) { return $m.Groups[1].Value }
  if ($s -like "*\*") { return $s }
  return $null
}

function Find-ReleaseInTags {
  param([string]$Tags, [string[]]$Targets)
  if ([string]::IsNullOrWhiteSpace($Tags) -or -not $Targets -or $Targets.Count -eq 0) { return $null }
  $parts = ($Tags.ToLowerInvariant() -split "[;\r\n,\|\s]+") | Where-Object { $_ -and $_.Trim() -ne "" } | ForEach-Object { $_.Trim() }
  foreach ($rt in $Targets) {
    $r = $rt.ToLowerInvariant()
    foreach ($p in $parts) {
      if ($p -eq $r -or $p.StartsWith($r)) { return $rt }
    }
  }
  return $null
}

function Invoke-TfsWiql {
  param([string]$WiqlText)

  $url = "$TfsHost/tfs/$Collection/$Project/_apis/wit/wiql?api-version=$ApiVersion"
  $body = @{ query = $WiqlText } | ConvertTo-Json

  $resp = Invoke-RestMethod -Method Post -Uri $url -Headers ($commonHeaders + @{ "Content-Type" = "application/json" }) -Body $body
  if (-not $resp.workItems) { return @() }
  return @($resp.workItems | ForEach-Object { [int]$_.id })
}

function Get-TfsWorkItems {
  param([int[]]$Ids)
  if (-not $Ids -or $Ids.Count -eq 0) { return @() }

  $all = @()
  foreach ($chunk in Split-List -List $Ids -Size $ChunkSize) {
    $idParam = ($chunk -join ",")
    $url = "$TfsHost/tfs/$Collection/_apis/wit/workitems?api-version=$ApiVersion&ids=$idParam&`$expand=relations"
    $resp = Invoke-RestMethod -Method Get -Uri $url -Headers $commonHeaders
    if ($resp.value) { $all += $resp.value }
  }
  return $all
}

function Get-TfsStatesOnly {
  param([int[]]$Ids)
  $map = @{}
  if (-not $Ids -or $Ids.Count -eq 0) { return $map }

  foreach ($chunk in Split-List -List $Ids -Size $ChunkSize) {
    $idParam = ($chunk -join ",")
    $url = "$TfsHost/tfs/$Collection/_apis/wit/workitems?api-version=$ApiVersion&ids=$idParam&fields=System.State"
    try {
      $resp = Invoke-RestMethod -Method Get -Uri $url -Headers $commonHeaders
    }
    catch {
      Write-Warning "Get-TfsStatesOnly failed for chunk ids=[$idParam]. Error: $($_.Exception.Message)"
      continue
    }

    foreach ($wi in ($resp.value ?? @())) {
      $map[[string]$wi.id] = $wi.fields.'System.State'
    }

  }
  return $map
}

function Send-Ingest {
  param([object[]]$Rows)
  $payload = @{
    source      = "tfs-weekly-sync"
    syncedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    rows        = $Rows
  } | ConvertTo-Json -Depth 6

  $headers = @{
    "Content-Type" = "application/json"
    "x-api-key"    = $SyncKey
  }

  Invoke-RestMethod -Method Post -Uri $IngestUrl -Headers $headers -Body $payload
}

function Get-ExtractWorkItemIdFromUrl {
  param([string]$Url)

  if ([string]::IsNullOrWhiteSpace($Url)) { return $null }

  # common format: .../_apis/wit/workItems/12345
  $m = [regex]::Match($Url, "/workitems/(\d+)$", "IgnoreCase")
  if ($m.Success) { return [int]$m.Groups[1].Value }

  # fallback: last URL segment is numeric
  $last = ($Url -split "/")[-1]
  if ($last -match '^\d+$') { return [int]$last }

  return $null
}


# ---------- WIQL ----------
if ($ReleaseTargets.Count -gt 0) {
  $tagConds = $ReleaseTargets | ForEach-Object { "[System.Tags] CONTAINS '$_'" }
  $tagFilter = " AND (" + ($tagConds -join " OR ") + ")"
}
else {
  $tagFilter = ""
}

$wiqlText = @"
SELECT [System.Id]
FROM WorkItems
WHERE [System.TeamProject] = @project
  AND [System.WorkItemType] IN ('Product Backlog Item','Bug','Task','Feature')
  AND [System.State] <> 'Removed'$tagFilter
ORDER BY [System.ChangedDate] DESC
"@

Write-Host "Running WIQL..."
$ids = Invoke-TfsWiql -WiqlText $wiqlText
Write-Host "Found $($ids.Count) IDs"
if ($ids.Count -eq 0) { return }

Write-Host "Fetching work items in chunks..."
$items = Get-TfsWorkItems -Ids $ids
Write-Host "Fetched $($items.Count) work items"

# ---------- Normalize + relation counts ----------
$modelItems = @()

foreach ($wi in $items) {
  $fields = $wi.fields

  $tags = $fields.'System.Tags'
  $release = Find-ReleaseInTags -Tags $tags -Targets $ReleaseTargets

  # enforce release filter like your M query
  if ($ReleaseTargets.Count -gt 0 -and -not $ReleaseTargets.Contains($release)) { continue }

  $assignedToRaw = $fields.'System.AssignedTo'
  $changedByRaw = $fields.'System.ChangedBy'
  $createdByRaw = $fields.'System.CreatedBy'

  $effortRaw = $fields.'Microsoft.VSTS.Scheduling.Effort'
  $storyPointsRaw = $fields.'Microsoft.VSTS.Scheduling.StoryPoints'
  $effort = $null
  if ($null -ne $effortRaw) { $effort = [double]$effortRaw }
  elseif ($null -ne $storyPointsRaw) { $effort = [double]$storyPointsRaw }

  $parentId = $null
  $depCount = 0
  $relatedCount = 0
  $depIds = @()
  $relIds = @()

  $state = $fields.'System.State'
  $computeOpenCounts = -not ($SkipOpenCountStates -contains $state)

  if ($wi.relations) {
    foreach ($rel in $wi.relations) {
      $relType = $rel.rel
      $url = [string]$rel.url
      if ([string]::IsNullOrWhiteSpace($url)) { continue }

      $targetId = Get-ExtractWorkItemIdFromUrl $url


      if ($relType -eq "System.LinkTypes.Hierarchy-Reverse" -and -not $parentId) {
        if ($null -ne $targetId) { $parentId = $targetId }
        continue
      }

      if ($relType -like "System.LinkTypes.Dependency*") {
        if ($null -ne $targetId) {
          $depCount++
          if ($computeOpenCounts) { $depIds += $targetId }
        }
        continue
      }

      if ($relType -eq "System.LinkTypes.Related") {
        if ($null -ne $targetId) {
          $relatedCount++
          if ($computeOpenCounts) { $relIds += $targetId }
        }
        continue
      }

    }
  }

  $obj = [PSCustomObject]@{
    workItemId         = [int]$wi.id
    type               = $fields.'System.WorkItemType'
    title              = $fields.'System.Title'
    state              = $state
    reason             = $fields.'System.Reason'
    assignedTo         = Get-Name -v $assignedToRaw
    assignedToUPN      = Get-UPN  -v $assignedToRaw
    project            = $fields.'System.TeamProject'
    areaPath           = $fields.'System.AreaPath'
    iterationPath      = $fields.'System.IterationPath'
    tags               = $tags
    release            = $release
    createdBy          = Get-Name -v $createdByRaw
    changedBy          = Get-Name -v $changedByRaw
    createdDate        = $fields.'System.CreatedDate'
    changedDate        = $fields.'System.ChangedDate'
    stateChangeDate    = $fields.'Microsoft.VSTS.Common.StateChangeDate'
    closedDate         = $fields.'Microsoft.VSTS.Common.ClosedDate'
    severity           = $fields.'Microsoft.VSTS.Common.Severity'
    effort             = $effort
    parentId           = $parentId
    featureId          = $null
    feature            = $null

    depCount           = $depCount
    openDepCount       = $computeOpenCounts ? 0 : $null
    relatedLinkCount   = $relatedCount
    openRelatedCount   = $computeOpenCounts ? 0 : $null

    _computeOpenCounts = $computeOpenCounts
    _depIds            = $depIds
    _relIds            = $relIds
  }

  $modelItems += $obj
}

Write-Host "After release filter: $($modelItems.Count) items"
if ($modelItems.Count -eq 0) { return }

# ---------- Parent / Feature resolution ----------
$parentIds = $modelItems.parentId | Where-Object { $_ } | Select-Object -Unique
$parentLookup = @{}

if ($parentIds.Count -gt 0) {
  Write-Host "Fetching parents: $($parentIds.Count)"
  $parents = Get-TfsWorkItems -Ids $parentIds
  foreach ($p in $parents) {
    $pf = $p.fields
    $parentWiId = [int]$p.id
    $pParentId = $null
    if ($p.relations) {
      foreach ($rel in $p.relations) {
        if ($rel.rel -eq "System.LinkTypes.Hierarchy-Reverse") {
          $pParentId = Get-ExtractWorkItemIdFromUrl ([string]$rel.url)

          break
        }
      }
    }
    $parentLookup[$parentWiId] = [PSCustomObject]@{ id = $parentWiId; type = $pf.'System.WorkItemType'; title = $pf.'System.Title'; parentId = $pParentId }
  }
}

foreach ($mi in $modelItems) {
  if ($mi.parentId -and $parentLookup.ContainsKey($mi.parentId)) {
    $p = $parentLookup[$mi.parentId]
    $parentType = $p.type
    $grandparentId = $p.parentId

    if ($mi.type -eq "Feature") { $mi.featureId = $mi.workItemId }
    elseif ($parentType -eq "Feature") { $mi.featureId = $mi.parentId }
    else { $mi.featureId = $grandparentId }
  }
  else {
    if ($mi.type -eq "Feature") { $mi.featureId = $mi.workItemId }
  }
}

$featureIds = $modelItems.featureId | Where-Object { $_ } | Select-Object -Unique
if ($featureIds.Count -gt 0) {
  Write-Host "Fetching features: $($featureIds.Count)"
  $features = Get-TfsWorkItems -Ids $featureIds
  $featureLookup = @{}
  foreach ($f in $features) {
    $fid = [int]$f.id
    $featureLookup[$fid] = $f.fields.'System.Title'
  }
  foreach ($mi in $modelItems) {
    if ($mi.featureId -and $featureLookup.ContainsKey($mi.featureId)) { $mi.feature = $featureLookup[$mi.featureId] }
  }
}

# ---------- Open counts for ACTIVE items only ----------
$linkedSet = New-Object System.Collections.Generic.HashSet[int]
foreach ($mi in $modelItems) {
  if (-not $mi._computeOpenCounts) { continue }
  foreach ($id in $mi._depIds) { [void]$linkedSet.Add([int]$id) }
  foreach ($id in $mi._relIds) { [void]$linkedSet.Add([int]$id) }
}

if ($linkedSet.Count -gt 0) {
  Write-Host "Fetching linked states only (System.State): $($linkedSet.Count)"
  $linkedIds = [System.Linq.Enumerable]::ToArray([System.Collections.Generic.IEnumerable[int]]$linkedSet)
  $linkStates = Get-TfsStatesOnly -Ids $linkedIds

  foreach ($mi in $modelItems) {
    if (-not $mi._computeOpenCounts) { continue }

    $openDep = 0
    foreach ($id in $mi._depIds) {
      # --- SAFE lookup: linkStates might be null if there were no link IDs ---
      if ($null -eq $linkStates -or $linkStates -isnot [hashtable]) {
        $linkStates = @{}
      }

      $key = [string]$id
      $st = $null
      if ($null -ne $id -and $linkStates.ContainsKey($key)) {
        $st = $linkStates[$key]
      }

      if (-not ($TerminalLinkedStates -contains $st)) { $openDep++ }
    }

    $openRel = 0
    foreach ($id in $mi._relIds) {
      # --- SAFE lookup: linkStates might be null if there were no link IDs ---
      if ($null -eq $linkStates -or $linkStates -isnot [hashtable]) {
        $linkStates = @{}
      }

      $key = [string]$id
      $st = $null
      if ($null -ne $id -and $linkStates.ContainsKey($key)) {
        $st = $linkStates[$key]
      }

      if (-not ($TerminalLinkedStates -contains $st)) { $openRel++ }
    }

    $mi.openDepCount = $openDep
    $mi.openRelatedCount = $openRel
  }
}
else {
  Write-Host "No linked IDs to compute open counts."
}

# remove internal helper props before sending
foreach ($mi in $modelItems) {
  $mi.PSObject.Properties.Remove("_computeOpenCounts") | Out-Null
  $mi.PSObject.Properties.Remove("_depIds") | Out-Null
  $mi.PSObject.Properties.Remove("_relIds") | Out-Null
}

Write-Host "Posting $($modelItems.Count) rows to ingest endpoint..."
$resp = Send-Ingest -Rows $modelItems
Write-Host "Done. Server response:" ($resp | ConvertTo-Json -Depth 4)
