function ConvertTo-AuditStoredText {
  param([AllowNull()][object] $Value)

  if ($null -eq $Value) { return $null }
  $text = [string]$Value
  $text = $text -replace '"', "'" -replace '[\u201C\u201D]', "'"
  $text = $text -replace '[\u2013\u2014]', '-'
  $text = $text -replace '[\u2018\u2019]', "'"
  return $text
}

function ConvertTo-AuditNullableString {
  param([AllowNull()][object] $Value)

  if ($null -eq $Value) { return $null }
  $text = ([string]$Value).Trim()
  if ($text.Length -eq 0) { return $null }
  return $text
}

function ConvertTo-AuditNullableId {
  param([AllowNull()][object] $Value)

  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
  $parsed = 0
  if ([int]::TryParse([string]$Value, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
  return $null
}

function ConvertTo-AuditUtcDate {
  param([AllowNull()][object] $Value)

  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
  try {
    return ([datetimeoffset]::Parse([string]$Value)).ToUniversalTime()
  }
  catch {
    return $null
  }
}

function ConvertTo-AuditUtcString {
  param([AllowNull()][object] $Value)

  $date = ConvertTo-AuditUtcDate -Value $Value
  if ($null -eq $date) { return $null }
  return $date.ToString('o')
}

function ConvertTo-AuditTagKey {
  param([AllowNull()][object] $Value)

  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return '' }
  $tags = @(
    ([string]$Value -split '[;,|\r\n]+') |
      ForEach-Object { $_.Trim().ToLowerInvariant() } |
      Where-Object { $_ } |
      Sort-Object -Unique
  )
  return ($tags -join '|')
}

function Get-AuditParentId {
  param([AllowNull()][object] $WorkItem)

  if ($null -eq $WorkItem -or $null -eq $WorkItem.relations) { return $null }
  foreach ($relation in @($WorkItem.relations)) {
    if ($relation.rel -ne 'System.LinkTypes.Hierarchy-Reverse') { continue }
    $url = [string]$relation.url
    if ($url -match '/(\d+)$') { return [int]$Matches[1] }
  }
  return $null
}

function Resolve-AuditFeature {
  param(
    [Parameter(Mandatory = $true)][object] $WorkItem,
    [Parameter(Mandatory = $true)][hashtable] $TfsLookup,
    [ValidateRange(1, 50)][int] $MaxDepth = 10
  )

  $workItemId = [int]$WorkItem.id
  $workItemType = [string]$WorkItem.fields.'System.WorkItemType'
  $immediateParentId = Get-AuditParentId -WorkItem $WorkItem

  if ($workItemType -eq 'Feature') {
    return [pscustomobject]@{
      immediateParentId = $immediateParentId
      featureId = $workItemId
      featureTitle = ConvertTo-AuditStoredText -Value $WorkItem.fields.'System.Title'
      status = 'self'
      depth = 0
      path = @($workItemId)
      problemId = $null
    }
  }

  if ($null -eq $immediateParentId) {
    return [pscustomobject]@{
      immediateParentId = $null
      featureId = $null
      featureTitle = $null
      status = 'standalone'
      depth = 0
      path = @($workItemId)
      problemId = $null
    }
  }

  $visited = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$visited.Add($workItemId)
  $path = New-Object 'System.Collections.Generic.List[int]'
  $path.Add($workItemId)
  $currentParentId = $immediateParentId

  for ($depth = 1; $depth -le $MaxDepth; $depth++) {
    if (-not $visited.Add($currentParentId)) {
      return [pscustomobject]@{
        immediateParentId = $immediateParentId
        featureId = $null
        featureTitle = $null
        status = 'cycle'
        depth = $depth
        path = @($path)
        problemId = $currentParentId
      }
    }
    $path.Add($currentParentId)

    if (-not $TfsLookup.ContainsKey($currentParentId)) {
      return [pscustomobject]@{
        immediateParentId = $immediateParentId
        featureId = $null
        featureTitle = $null
        status = 'missing_parent'
        depth = $depth
        path = @($path)
        problemId = $currentParentId
      }
    }

    $parent = $TfsLookup[$currentParentId]
    if ([string]$parent.fields.'System.WorkItemType' -eq 'Feature') {
      return [pscustomobject]@{
        immediateParentId = $immediateParentId
        featureId = $currentParentId
        featureTitle = ConvertTo-AuditStoredText -Value $parent.fields.'System.Title'
        status = 'resolved'
        depth = $depth
        path = @($path)
        problemId = $null
      }
    }

    $nextParentId = Get-AuditParentId -WorkItem $parent
    if ($null -eq $nextParentId) {
      return [pscustomobject]@{
        immediateParentId = $immediateParentId
        featureId = $null
        featureTitle = $null
        status = 'no_feature_ancestor'
        depth = $depth
        path = @($path)
        problemId = $null
      }
    }
    $currentParentId = $nextParentId
  }

  return [pscustomobject]@{
    immediateParentId = $immediateParentId
    featureId = $null
    featureTitle = $null
    status = 'depth_exceeded'
    depth = $MaxDepth
    path = @($path)
    problemId = $currentParentId
  }
}

function Add-AuditFieldMismatch {
  param(
    [Parameter(Mandatory = $true)][System.Collections.IList] $Target,
    [Parameter(Mandatory = $true)][int] $WorkItemId,
    [Parameter(Mandatory = $true)][string] $Field,
    [AllowNull()][object] $TfsValue,
    [AllowNull()][object] $DatabaseValue
  )

  [void]$Target.Add([pscustomobject]@{
    workItemId = $WorkItemId
    field = $Field
    tfsValue = $TfsValue
    databaseValue = $DatabaseValue
  })
}

function Compare-AuditWorkItem {
  param(
    [Parameter(Mandatory = $true)][object] $TfsItem,
    [Parameter(Mandatory = $true)][object] $DatabaseItem,
    [Parameter(Mandatory = $true)][object] $FeatureResolution,
    [AllowNull()][object] $TfsRelease,
    [bool] $CompareRelease = $false
  )

  $workItemId = [int]$TfsItem.id
  $fieldMismatches = New-Object System.Collections.ArrayList

  $tfsTitle = ConvertTo-AuditStoredText -Value $TfsItem.fields.'System.Title'
  $tfsType = ConvertTo-AuditNullableString -Value $TfsItem.fields.'System.WorkItemType'
  $tfsState = ConvertTo-AuditNullableString -Value $TfsItem.fields.'System.State'
  $tfsAreaPath = ConvertTo-AuditNullableString -Value $TfsItem.fields.'System.AreaPath'
  $tfsTags = ConvertTo-AuditNullableString -Value $TfsItem.fields.'System.Tags'
  $tfsChangedDate = ConvertTo-AuditUtcString -Value $TfsItem.fields.'System.ChangedDate'

  $comparisons = @(
    @{ field = 'title'; tfs = $tfsTitle; db = (ConvertTo-AuditNullableString -Value $DatabaseItem.title) },
    @{ field = 'type'; tfs = $tfsType; db = (ConvertTo-AuditNullableString -Value $DatabaseItem.type) },
    @{ field = 'state'; tfs = $tfsState; db = (ConvertTo-AuditNullableString -Value $DatabaseItem.state) },
    @{ field = 'areaPath'; tfs = $tfsAreaPath; db = (ConvertTo-AuditNullableString -Value $DatabaseItem.areaPath) },
    @{ field = 'changedDate'; tfs = $tfsChangedDate; db = (ConvertTo-AuditUtcString -Value $DatabaseItem.changedDate) }
  )

  if ($CompareRelease) {
    $comparisons += @{ field = 'release'; tfs = (ConvertTo-AuditNullableString -Value $TfsRelease); db = (ConvertTo-AuditNullableString -Value $DatabaseItem.release) }
  }

  foreach ($comparison in $comparisons) {
    if ($comparison.tfs -cne $comparison.db) {
      Add-AuditFieldMismatch -Target $fieldMismatches -WorkItemId $workItemId -Field $comparison.field -TfsValue $comparison.tfs -DatabaseValue $comparison.db
    }
  }

  if ((ConvertTo-AuditTagKey -Value $tfsTags) -cne (ConvertTo-AuditTagKey -Value $DatabaseItem.tags)) {
    Add-AuditFieldMismatch -Target $fieldMismatches -WorkItemId $workItemId -Field 'tags' -TfsValue $tfsTags -DatabaseValue $DatabaseItem.tags
  }

  $databaseParentId = ConvertTo-AuditNullableId -Value $DatabaseItem.parentId
  $databaseFeatureId = ConvertTo-AuditNullableId -Value $DatabaseItem.featureId
  $databaseFeatureTitle = ConvertTo-AuditNullableString -Value $DatabaseItem.feature
  $parentIdMismatch = $databaseParentId -ne $FeatureResolution.immediateParentId
  $featureIdMismatch = $databaseFeatureId -ne $FeatureResolution.featureId
  $featureTitleMismatch = $databaseFeatureTitle -cne $FeatureResolution.featureTitle
  $hierarchyMismatch = $null
  if ($parentIdMismatch -or $featureIdMismatch -or $featureTitleMismatch) {
    $hierarchyMismatch = [pscustomobject]@{
      workItemId = $workItemId
      title = $tfsTitle
      classification = if ($parentIdMismatch -or $featureIdMismatch) { 'identity' } else { 'title_only' }
      parentIdMismatch = $parentIdMismatch
      featureIdMismatch = $featureIdMismatch
      featureTitleMismatch = $featureTitleMismatch
      databaseParentId = $databaseParentId
      tfsParentId = $FeatureResolution.immediateParentId
      databaseFeatureId = $databaseFeatureId
      tfsFeatureId = $FeatureResolution.featureId
      databaseFeature = $databaseFeatureTitle
      tfsFeature = $FeatureResolution.featureTitle
      resolutionStatus = $FeatureResolution.status
      hierarchyPath = @($FeatureResolution.path)
    }
  }

  $resolutionIssue = $null
  if ($FeatureResolution.status -in @('missing_parent', 'cycle', 'depth_exceeded')) {
    $resolutionIssue = [pscustomobject]@{
      workItemId = $workItemId
      status = $FeatureResolution.status
      problemId = $FeatureResolution.problemId
      hierarchyPath = @($FeatureResolution.path)
    }
  }

  $staleRecord = $null
  $tfsChanged = ConvertTo-AuditUtcDate -Value $TfsItem.fields.'System.ChangedDate'
  $databaseSynced = ConvertTo-AuditUtcDate -Value $DatabaseItem.syncedAt
  if ($null -ne $tfsChanged -and $null -ne $databaseSynced -and $databaseSynced -lt $tfsChanged) {
    $staleRecord = [pscustomobject]@{
      workItemId = $workItemId
      tfsChangedDate = $tfsChanged.ToString('o')
      databaseSyncedAt = $databaseSynced.ToString('o')
    }
  }

  return [pscustomobject]@{
    workItemId = $workItemId
    fieldMismatches = @($fieldMismatches)
    hierarchyMismatch = $hierarchyMismatch
    resolutionIssue = $resolutionIssue
    staleRecord = $staleRecord
  }
}
