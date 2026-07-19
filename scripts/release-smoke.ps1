$ErrorActionPreference = "Stop"

$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$binary = Join-Path $workspace "src-tauri\target\release\pi-desktop.exe"
$smokeRoot = Join-Path $workspace ".release-smoke-appdata"
$memoryLimitBytes = 150MB
$cpuLimitPercent = 1.0
$settleSeconds = 30
$sampleSeconds = 60
$process = $null

if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
  throw "Release binary is missing. Run 'pnpm tauri build' first."
}

$resolvedSmoke = [System.IO.Path]::GetFullPath($smokeRoot)
if (
  -not $resolvedSmoke.StartsWith(
    $workspace + [System.IO.Path]::DirectorySeparatorChar,
    [System.StringComparison]::OrdinalIgnoreCase
  ) -or
  [System.IO.Path]::GetFileName($resolvedSmoke) -ne ".release-smoke-appdata"
) {
  throw "Refusing to use unexpected smoke-test path: $resolvedSmoke"
}

function Get-ProcessTreeSnapshot([int]$RootProcessId) {
  $records = @(
    Get-CimInstance Win32_Process |
      Select-Object ProcessId, ParentProcessId, CreationDate
  )
  $performance = @{}
  foreach ($metric in @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process)) {
    $performance[[int]$metric.IDProcess] = [long]$metric.WorkingSetPrivate
  }
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  $created = @{}
  $rootRecord = $records | Where-Object { [int]$_.ProcessId -eq $RootProcessId } | Select-Object -First 1
  if ($null -eq $rootRecord) {
    $rootProcess = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
    if ($null -eq $rootProcess) {
      throw "Pi Desktop exited during the idle measurement."
    }
    $rootRecord = [PSCustomObject]@{
      ProcessId = $RootProcessId
      ParentProcessId = 0
      CreationDate = $rootProcess.StartTime
    }
  }
  [void]$ids.Add($RootProcessId)
  $created[$RootProcessId] = $rootRecord.CreationDate
  do {
    $added = $false
    foreach ($record in $records) {
      $parentId = [int]$record.ParentProcessId
      $processId = [int]$record.ProcessId
      if (
        $ids.Contains($parentId) -and
        $record.CreationDate -ge $created[$parentId] -and
        $ids.Add($processId)
      ) {
        $created[$processId] = $record.CreationDate
        $added = $true
      }
    }
  } while ($added)

  $snapshot = @{}
  foreach ($id in $ids) {
    $item = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($null -ne $item) {
      $snapshot[$id] = [PSCustomObject]@{
        Name = $item.ProcessName
        Cpu = if ($null -eq $item.CPU) { 0.0 } else { [double]$item.CPU }
        PrivateWorkingSetBytes = if ($performance.ContainsKey($id)) {
          $performance[$id]
        } else {
          [long]$item.PrivateMemorySize64
        }
      }
    }
  }
  return $snapshot
}

try {
  New-Item -ItemType Directory -Path $resolvedSmoke -Force | Out-Null
  $env:APPDATA = $resolvedSmoke
  $env:LOCALAPPDATA = $resolvedSmoke
  $env:PI_DESKTOP_CONFIG_DIR = $resolvedSmoke
  $process = Start-Process -FilePath $binary -PassThru -WindowStyle Minimized
  Start-Sleep -Seconds $settleSeconds
  $process.Refresh()
  if ($process.HasExited) {
    throw "Pi Desktop exited during startup with code $($process.ExitCode)."
  }

  $first = Get-ProcessTreeSnapshot $process.Id
  Start-Sleep -Seconds $sampleSeconds
  $second = Get-ProcessTreeSnapshot $process.Id
  $cpuSeconds = 0.0
  $privateBytes = 0L
  foreach ($entry in $second.GetEnumerator()) {
    $privateBytes += $entry.Value.PrivateWorkingSetBytes
    $before = if ($first.ContainsKey($entry.Key)) { $first[$entry.Key].Cpu } else { 0.0 }
    $cpuSeconds += [Math]::Max(0.0, $entry.Value.Cpu - $before)
  }
  $cpuPercent = ($cpuSeconds / $sampleSeconds) * 100.0

  $second.GetEnumerator() | ForEach-Object {
    [PSCustomObject]@{
      Process = $_.Value.Name
      Id = $_.Key
      PrivateWorkingSetMB = [Math]::Round($_.Value.PrivateWorkingSetBytes / 1MB, 2)
    }
  } | Sort-Object PrivateWorkingSetMB -Descending | Format-Table -AutoSize

  if ($second.Values.Name -contains "node") {
    throw "Shell-only smoke test unexpectedly launched a Pi/Node process."
  }

  [PSCustomObject]@{
    ProcessCount = $second.Count
    PrivateWorkingSetMB = [Math]::Round($privateBytes / 1MB, 2)
    IdleCpuPercent = [Math]::Round($cpuPercent, 3)
    MemoryLimitMB = [Math]::Round($memoryLimitBytes / 1MB, 0)
    CpuLimitPercent = $cpuLimitPercent
    SettleSeconds = $settleSeconds
    SampleSeconds = $sampleSeconds
  } | Format-List

  if ($privateBytes -gt $memoryLimitBytes) {
    throw "Release smoke test exceeded the 150 MB private-working-set gate."
  }
  if ($cpuPercent -gt $cpuLimitPercent) {
    throw "Release smoke test exceeded the 1% idle-CPU gate."
  }
} finally {
  if ($null -ne $process) {
    $process.Refresh()
    if (-not $process.HasExited) {
      [void]$process.CloseMainWindow()
      if (-not $process.WaitForExit(10000)) {
        Stop-Process -Id $process.Id
      }
    }
  }
  Start-Sleep -Milliseconds 500
  if (Test-Path -LiteralPath $resolvedSmoke) {
    [System.IO.Directory]::Delete($resolvedSmoke, $true)
  }
}
