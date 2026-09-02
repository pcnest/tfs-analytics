function ConvertFrom-TfsWeeklyReportHistoryHtml {
  param([AllowNull()][string] $Value)

  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  $text = [regex]::Replace($Value, '(?i)<br\s*/?>', "`n")
  $text = [regex]::Replace($text, '(?i)</(?:p|div|li|ul|ol|h[1-6])\s*>', "`n")
  $text = [regex]::Replace($text, '<[^>]+>', '')
  $text = [System.Net.WebUtility]::HtmlDecode($text)
  $text = $text -replace "`r`n?", "`n"
  $text = [regex]::Replace($text, "[ \t]+`n", "`n")
  $text = [regex]::Replace($text, "`n{3,}", "`n`n")
  return $text.Trim()
}

function Get-TfsWeeklyReportRemarkAuthor {
  param([AllowNull()][object] $RevisedBy)

  if ($null -eq $RevisedBy) { return $null }
  if ($RevisedBy -is [string]) {
    $value = $RevisedBy.Trim()
    return $(if ($value) { $value } else { $null })
  }
  foreach ($propertyName in @('displayName', 'name', 'uniqueName')) {
    $property = $RevisedBy.PSObject.Properties[$propertyName]
    if ($null -ne $property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
      return ([string]$property.Value).Trim()
    }
  }
  return $null
}

function Resolve-TfsWeeklyReportRemark {
  param(
    [object[]] $Updates,
    [Parameter(Mandatory = $true)][string] $Marker,
    [Parameter(Mandatory = $true)][string] $ClearMarker,
    [ValidateRange(1, 32767)][int] $MaxLength,
    [Parameter(Mandatory = $true)][int] $WorkItemId
  )

  $candidates = New-Object System.Collections.ArrayList
  foreach ($update in @($Updates)) {
    if ($null -eq $update -or $null -eq $update.fields) { continue }
    $historyProperty = $update.fields.PSObject.Properties['System.History']
    if ($null -eq $historyProperty -or $null -eq $historyProperty.Value) { continue }
    $newValueProperty = $historyProperty.Value.PSObject.Properties['newValue']
    if ($null -eq $newValueProperty) { continue }
    $plainText = ConvertFrom-TfsWeeklyReportHistoryHtml -Value ([string]$newValueProperty.Value)
    $candidateText = $plainText.TrimStart()
    if (-not $candidateText.StartsWith($Marker, [StringComparison]::OrdinalIgnoreCase)) { continue }

    $revision = 0
    if (-not [int]::TryParse([string]$update.rev, [ref]$revision) -or $revision -le 0) {
      throw "Work item $WorkItemId has a marked Discussion entry with invalid revision metadata."
    }
    $revisedAt = [datetime]::MinValue
    if (-not [datetime]::TryParse([string]$update.revisedDate, [ref]$revisedAt)) {
      throw "Work item $WorkItemId revision $revision has an invalid revised date."
    }
    $author = Get-TfsWeeklyReportRemarkAuthor -RevisedBy $update.revisedBy
    if ([string]::IsNullOrWhiteSpace($author)) {
      throw "Work item $WorkItemId revision $revision has no revised-by identity."
    }
    [void]$candidates.Add([pscustomobject]@{
      revision = $revision
      revisedAt = $revisedAt.ToUniversalTime()
      author = $author
      text = $candidateText
    })
  }

  if ($candidates.Count -eq 0) {
    return [pscustomobject]@{
      weeklyReportRemark = $null
      weeklyReportRemarkRevision = $null
      weeklyReportRemarkChangedAt = $null
      weeklyReportRemarkChangedBy = $null
      directive = 'none'
    }
  }

  $latest = @($candidates | Sort-Object -Property @{ Expression = 'revision'; Descending = $true }, @{ Expression = 'revisedAt'; Descending = $true })[0]
  $changedAt = $latest.revisedAt.ToString('o')
  if ($latest.text.Equals($ClearMarker, [StringComparison]::OrdinalIgnoreCase)) {
    return [pscustomobject]@{
      weeklyReportRemark = $null
      weeklyReportRemarkRevision = $latest.revision
      weeklyReportRemarkChangedAt = $changedAt
      weeklyReportRemarkChangedBy = $latest.author
      directive = 'clear'
    }
  }

  $body = $latest.text.Substring($Marker.Length).Trim()
  if ($body.StartsWith('[Clear]', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Work item $WorkItemId revision $($latest.revision) has an invalid clear directive. Use '$ClearMarker' exactly."
  }
  if ([string]::IsNullOrWhiteSpace($body)) {
    throw "Work item $WorkItemId revision $($latest.revision) has a weekly-report marker with no remark text."
  }
  if ($body.Length -gt $MaxLength) {
    throw "Work item $WorkItemId revision $($latest.revision) has a weekly-report remark longer than $MaxLength characters."
  }
  return [pscustomobject]@{
    weeklyReportRemark = $body
    weeklyReportRemarkRevision = $latest.revision
    weeklyReportRemarkChangedAt = $changedAt
    weeklyReportRemarkChangedBy = $latest.author
    directive = 'remark'
  }
}

function Invoke-TfsWeeklyReportUpdatesPage {
  param(
    [Parameter(Mandatory = $true)][string] $Uri,
    [Parameter(Mandatory = $true)][hashtable] $Headers,
    [ValidateRange(1, 10)][int] $MaxRetries = 3
  )

  for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
    try {
      return Invoke-RestMethod -Method Get -Uri $Uri -Headers $Headers -TimeoutSec 60
    } catch {
      if ($attempt -eq $MaxRetries) { throw }
      Start-Sleep -Seconds ([Math]::Min(4, $attempt))
    }
  }
}

function Get-TfsWeeklyReportRemarkForItem {
  param(
    [Parameter(Mandatory = $true)][int] $WorkItemId,
    [Parameter(Mandatory = $true)][int] $CurrentRevision,
    [Parameter(Mandatory = $true)][string] $TfsHost,
    [Parameter(Mandatory = $true)][string] $Collection,
    [Parameter(Mandatory = $true)][string] $ApiVersion,
    [Parameter(Mandatory = $true)][hashtable] $Headers,
    [Parameter(Mandatory = $true)][string] $Marker,
    [Parameter(Mandatory = $true)][string] $ClearMarker,
    [ValidateRange(1, 32767)][int] $MaxLength,
    [scriptblock] $FetchPage
  )

  if ($CurrentRevision -le 0) { throw "Work item $WorkItemId has an invalid current revision."
  }
  if ($null -eq $FetchPage) {
    $FetchPage = {
      param($skip, $top)
      $uri = "$TfsHost/tfs/$Collection/_apis/wit/workitems/$WorkItemId/updates?api-version=$ApiVersion&`$top=$top&`$skip=$skip"
      Invoke-TfsWeeklyReportUpdatesPage -Uri $uri -Headers $Headers
    }
  }

  $pageSize = 200
  $skip = 0
  $pageCount = 0
  $updates = New-Object System.Collections.ArrayList
  $updateIdLookup = @{}
  while ($true) {
    $response = & $FetchPage $skip $pageSize
    if ($null -eq $response -or $null -eq $response.value) {
      throw "Work item $WorkItemId returned a malformed updates response at skip $skip."
    }
    $page = @($response.value)
    if ($page.Count -eq 0) { break }
    foreach ($update in $page) {
      $updateId = 0
      if ($null -eq $update -or
          -not [int]::TryParse([string]$update.id, [ref]$updateId) -or
          $updateId -le 0) {
        throw "Work item $WorkItemId returned an update with an invalid update ID."
      }
      if ($updateIdLookup.ContainsKey($updateId)) {
        throw "Work item $WorkItemId returned duplicate update ID $updateId."
      }
      $updateIdLookup[$updateId] = $true
      [void]$updates.Add($update)
    }
    $pageCount++
    $skip += $page.Count
    if ($page.Count -lt $pageSize) { break }
  }

  $revisionLookup = @{}
  foreach ($update in @($updates)) {
    $revision = 0
    if ($null -eq $update -or
        -not [int]::TryParse([string]$update.rev, [ref]$revision) -or
        $revision -le 0 -or
        $revision -gt $CurrentRevision) {
      throw "Work item $WorkItemId returned invalid update revision '$($update.rev)' for current revision $CurrentRevision."
    }
    $revisionLookup[$revision] = $true
  }
  for ($revision = 1; $revision -le $CurrentRevision; $revision++) {
    if (-not $revisionLookup.ContainsKey($revision)) {
      throw "Work item $WorkItemId update history is missing revision $revision of $CurrentRevision."
    }
  }

  $result = Resolve-TfsWeeklyReportRemark `
    -Updates @($updates) `
    -Marker $Marker `
    -ClearMarker $ClearMarker `
    -MaxLength $MaxLength `
    -WorkItemId $WorkItemId
  $result | Add-Member -NotePropertyName pageCount -NotePropertyValue $pageCount
  $result | Add-Member -NotePropertyName updateCount -NotePropertyValue $updates.Count
  return $result
}
