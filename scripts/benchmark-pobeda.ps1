param([ValidateRange(1,10)][int]$SampleSeconds = 2)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$runPath = Join-Path $PWD ('outputs\pobeda\benchmark-' + (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fffZ'))
New-Item -ItemType Directory -Path $runPath | Out-Null
Copy-Item -LiteralPath 'src\extractors\pobeda\config.json' -Destination (Join-Path $runPath 'config.snapshot.json')
$cpu = Get-CimInstance Win32_Processor
$computer = Get-CimInstance Win32_ComputerSystem
$started = (Get-Date).ToUniversalTime()
$previousOutput = $env:RUN_OUTPUT_DIR
$env:RUN_OUTPUT_DIR = $runPath
$previous = @{}
$tracked = [System.Collections.Generic.HashSet[int]]::new()
$sharedAdb = @(Get-CimInstance Win32_Process -Filter "Name = 'adb.exe'" | Select-Object -ExpandProperty ProcessId)
try {
  $worker = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('node_modules/tsx/dist/cli.mjs', 'src/extractors/pobeda/index.ts') -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runPath 'stdout.log') -RedirectStandardError (Join-Path $runPath 'stderr.log')
  $null = $worker.Handle
  [void]$tracked.Add($worker.Id)
  Write-Output "Benchmark started: $runPath; root PID: $($worker.Id)"
  do {
    $now = (Get-Date).ToUniversalTime()
    $processes = @(Get-CimInstance Win32_Process)
    do {
      $added = $false
      foreach ($process in $processes) {
        if ($tracked.Contains([int]$process.ParentProcessId) -and $tracked.Add([int]$process.ProcessId)) { $added = $true }
      }
    } while ($added)
    $sample = foreach ($process in $processes) {
      if (!$tracked.Contains([int]$process.ProcessId) -and $process.ProcessId -notin $sharedAdb) { continue }
      $key = "$($process.ProcessId):$($process.CreationDate)"
      $seconds = ([double]$process.KernelModeTime + [double]$process.UserModeTime) / 10000000
      $cores = 0.0
      if ($previous.ContainsKey($key)) {
        $elapsed = ($now - $previous[$key].Time).TotalSeconds
        if ($elapsed -gt 0) { $cores = [Math]::Max([double]0, [double](($seconds - $previous[$key].Cpu) / $elapsed)) }
      }
      $previous[$key] = @{ Time = $now; Cpu = $seconds }
      [ordered]@{ pid = $process.ProcessId; name = $process.Name; shared = ($process.ProcessId -in $sharedAdb); workingSetBytes = [double]$process.WorkingSetSize; privateBytes = [double]$process.PrivatePageCount; cpuSeconds = $seconds; cpuCores = $cores }
    }
    [ordered]@{ time = $now.ToString('o'); processes = @($sample) } | ConvertTo-Json -Depth 4 -Compress | Add-Content -LiteralPath (Join-Path $runPath 'resources.jsonl') -Encoding UTF8
    $worker.Refresh()
    if (!$worker.HasExited) { Start-Sleep -Seconds $SampleSeconds }
  } while (!$worker.HasExited)
  $worker.WaitForExit()
  $exitCode = $worker.ExitCode
  if ($null -eq $exitCode) {
    $lastEvent = Get-Content -LiteralPath (Join-Path $runPath 'events.jsonl') -Tail 1 | ConvertFrom-Json
    if ($lastEvent.type -eq 'run-end') { $exitCode = $lastEvent.exitCode }
  }
  $metadata = [ordered]@{
    startedAt = $started.ToString('o'); endedAt = (Get-Date).ToUniversalTime().ToString('o'); exitCode = $exitCode
    sampleSeconds = $SampleSeconds; cpuName = @($cpu.Name); physicalCores = ($cpu | Measure-Object NumberOfCores -Sum).Sum
    logicalProcessors = ($cpu | Measure-Object NumberOfLogicalProcessors -Sum).Sum; hostRamBytes = [double]$computer.TotalPhysicalMemory
    configSha256 = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.IO.File]::ReadAllBytes((Join-Path $runPath 'config.snapshot.json')))).Replace('-', '')
    nodeVersion = (& node.exe --version); serial = $(if ($env:ANDROID_SERIAL) { $env:ANDROID_SERIAL } else { 'emulator-5554' })
  }
  $metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runPath 'benchmark.json') -Encoding UTF8
  Write-Output "Benchmark finished: exit $exitCode; $runPath"
  if ($null -ne $exitCode) { exit $exitCode }
} finally {
  $env:RUN_OUTPUT_DIR = $previousOutput
}
