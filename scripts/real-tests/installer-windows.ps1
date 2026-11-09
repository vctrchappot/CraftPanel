# Real scheduled-task installer tests. All paths, tasks, ports and data belong to this temporary run.
param([Parameter(Mandatory = $true)][string]$Fixtures)
$ErrorActionPreference = "Stop"
$Fixtures = (Resolve-Path -LiteralPath $Fixtures).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("craftpanel-ops-" + [guid]::NewGuid().ToString("N").Substring(0, 10))
$installRoot = Join-Path $testRoot "app"
$dataRoot = Join-Path $testRoot "data"
$taskName = "CraftPanel Ops " + [guid]::NewGuid().ToString("N").Substring(0, 10)
$savedEnv = @{}
foreach ($entry in Get-ChildItem Env: | Where-Object Name -like 'CRAFTPANEL_*') { $savedEnv[$entry.Name] = $entry.Value; Remove-Item "Env:$($entry.Name)" }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$env:CRAFTPANEL_INSTALL_DIR = $installRoot
$env:CRAFTPANEL_DATA_DIR = $dataRoot
$env:CRAFTPANEL_TASK_NAME = $taskName
$env:CRAFTPANEL_PORT = "$port"
$env:CRAFTPANEL_PROFILE = "lan"
$passed = $false

function Install-Fixture($version, $success) {
  $env:CRAFTPANEL_ARCHIVE = Join-Path $Fixtures "craftpanel-v$version.tar.gz"
  & powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File (Join-Path $Fixtures "install.ps1")
  if (($LASTEXITCODE -eq 0) -ne $success) { throw "Fixture $version had unexpected exit code $LASTEXITCODE" }
}
function Assert-Ready {
  $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$port/api/ready"
  if ($response.StatusCode -ne 200) { throw "The recovered installation is not ready" }
}
function Assert-Database {
  $script = "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});try{if(!db.prepare('PRAGMA table_info(users)').all().some(x=>x.name==='username'))throw Error('Old schema was not restored');if(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get('failed_update_probe'))throw Error('Failed migration survived rollback')}finally{db.close()}"
  & node -e $script (Join-Path $dataRoot "craftpanel.db")
  if ($LASTEXITCODE -ne 0) { throw "Database recovery verification failed" }
}
try {
  Install-Fixture "99.0.0" $true
  Assert-Ready
  $runtimeName = "$taskName Runtime"
  $runtime = Get-CimInstance Win32_Service -Filter ("Name='" + $runtimeName.Replace("'", "''") + "'")
  if ($runtime.State -ne "Running" -or $runtime.StartName -ne "NT SERVICE\$runtimeName") { throw "Runtime is not running under its virtual service account" }
  $runtimeProcess = $runtime.ProcessId
  # Stopping the dashboard task must not stop the independent SCM owner.
  $firstDashboard = (Get-Content -LiteralPath (Join-Path $dataRoot "control.json") -Raw | ConvertFrom-Json).pid
  Stop-ScheduledTask -TaskName $taskName
  $taskDeadline = (Get-Date).AddSeconds(30)
  while ((Get-ScheduledTask -TaskName $taskName).State -eq "Running") {
    if ((Get-Date) -gt $taskDeadline) { throw "Dashboard task did not stop" }
    Start-Sleep -Milliseconds 100
  }
  # The task leaves "Running" before its Job Object has finished killing the dashboard. A readiness
  # probe in that window is answered by the dying process and control.json still holds its PID.
  $deathDeadline = (Get-Date).AddSeconds(30)
  while (Get-Process -Id $firstDashboard -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deathDeadline) { throw "The first dashboard process $firstDashboard survived the task stop" }
    Start-Sleep -Milliseconds 100
  }
  if ((Get-CimInstance Win32_Service -Filter ("Name='" + $runtimeName.Replace("'", "''") + "'")).ProcessId -ne $runtimeProcess) { throw "Dashboard task stop restarted the runtime service" }
  Start-ScheduledTask -TaskName $taskName
  $readyDeadline = (Get-Date).AddSeconds(30)
  do {
    try {
      Assert-Ready
      # Only the restarted dashboard counts: it replaces control.json before it reports ready.
      if ((Get-Content -LiteralPath (Join-Path $dataRoot "control.json") -Raw | ConvertFrom-Json).pid -ne $firstDashboard) { break }
    } catch { if ((Get-Date) -gt $readyDeadline) { throw } }
    if ((Get-Date) -gt $readyDeadline) { throw "The restarted dashboard did not replace control.json" }
    Start-Sleep -Milliseconds 250
  } while ($true)
  $before = (Get-Content -LiteralPath (Join-Path $dataRoot "control.json") -Raw | ConvertFrom-Json).pid
  Install-Fixture "98.0.0" $false
  $after = (Get-Content -LiteralPath (Join-Path $dataRoot "control.json") -Raw | ConvertFrom-Json).pid
  if ($before -ne $after) { throw "Unsupported archive changed the dashboard process (control.json pid $before -> $after)" }
  foreach ($version in @("99.0.1", "99.0.2", "99.0.3")) {
    Install-Fixture $version $false
    Assert-Ready
    if ((Get-CimInstance Win32_Service -Filter ("Name='" + $runtimeName.Replace("'", "''") + "'")).ProcessId -ne $runtimeProcess) { throw "Dashboard rollback restarted the runtime service" }
    Assert-Database
    $childFile = Join-Path $dataRoot "failed-child-pid.txt"
    if (Test-Path -LiteralPath $childFile) {
      $childId = [int](Get-Content -LiteralPath $childFile -Raw)
      if (Get-Process -Id $childId -ErrorAction SilentlyContinue) { throw "A failed startup descendant survived the task stop" }
      Remove-Item -LiteralPath $childFile -Force
    }
    if ((Get-Content -LiteralPath (Join-Path $installRoot "release.json") -Raw | ConvertFrom-Json).version -ne "99.0.0") { throw "Release metadata was not restored" }
  }
  1..2 | ForEach-Object { Install-Fixture "99.0.0" $true; Assert-Ready }
  if ((Get-CimInstance Win32_Service -Filter ("Name='" + $runtimeName.Replace("'", "''") + "'")).ProcessId -ne $runtimeProcess) { throw "Dashboard update restarted the runtime service" }
  Install-Fixture "99.0.4" $false
  Assert-Ready
  if ((Get-CimInstance Win32_Service -Filter ("Name='" + $runtimeName.Replace("'", "''") + "'")).ProcessId -ne $runtimeProcess) { throw "Unapproved runtime update stopped the service" }
  $env:CRAFTPANEL_ALLOW_RUNTIME_RESTART = "1"
  Install-Fixture "99.0.5" $false
  Assert-Ready
  Assert-Database
  Install-Fixture "99.0.4" $true
  Remove-Item Env:CRAFTPANEL_ALLOW_RUNTIME_RESTART
  Assert-Ready
  # SCM recovery must replace a crashed wrapper; its Job Object also owns the child runtime.
  $runtimeProcess = (Get-CimInstance Win32_Service -Filter ("Name='" + $runtimeName.Replace("'", "''") + "'")).ProcessId
  Stop-Process -Id $runtimeProcess -Force
  $recoveryDeadline = (Get-Date).AddSeconds(45)
  do {
    Start-Sleep -Milliseconds 250
    $service = Get-CimInstance Win32_Service -Filter ("Name='" + $runtimeName.Replace("'", "''") + "'")
    if ((Get-Date) -gt $recoveryDeadline) { throw "SCM did not recover the crashed runtime service" }
  } while ($service.State -ne "Running" -or $service.ProcessId -eq $runtimeProcess)
  $readyDeadline = (Get-Date).AddSeconds(30)
  do { try { Assert-Ready; break } catch { if ((Get-Date) -gt $readyDeadline) { throw }; Start-Sleep -Milliseconds 250 } } while ($true)
  $points = @(Get-ChildItem -LiteralPath $installRoot -Directory -Filter 'state-*' | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "committed") })
  if ($points.Count -ne 2) { throw "Successful recovery retention is not bounded" }
  $passed = $true
  Write-Output "PASS: unsupported archive, failed migration, hanging startup, subsequent updates and recovery retention."
} catch {
  # CI runners discard retained artifacts, so print what is needed before cleanup removes it.
  Write-Output "FAILURE: $($_.Exception.Message)"
  Write-Output "before pid: $before, after pid: $after"
  try {
    $control = Get-Content -LiteralPath (Join-Path $dataRoot "control.json") -Raw -ErrorAction Stop | ConvertFrom-Json
    Write-Output "control.json pid: $($control.pid), alive: $([bool](Get-Process -Id $control.pid -ErrorAction SilentlyContinue))"
  } catch { Write-Output "control.json unreadable: $($_.Exception.Message)" }
  $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
  if ($info) { Write-Output "task last run: $($info.LastRunTime), last result: $($info.LastTaskResult)" }
  foreach ($log in @("craftpanel.log", "craftpanel.err.log", "craftpanel.previous.log", "craftpanel.err.previous.log", "runtime.err.log", "runtime-host.err.log")) {
    $file = Join-Path $dataRoot "logs\$log"
    if (Test-Path -LiteralPath $file) { Write-Output "--- $log (tail)"; Get-Content -LiteralPath $file -Tail 25 }
  }
  throw
} finally {
  $updater = Join-Path $installRoot "update.ps1"
  if (Test-Path -LiteralPath $updater) {
    $env:CRAFTPANEL_UNINSTALL = "1"
    & powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $updater
  }
  foreach ($name in @($taskName, "$taskName Update")) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
  }
  # First-install failures may leave a service before update.ps1 was activated.
  $runtimeName = "$taskName Runtime"
  if (Get-Service -Name $runtimeName -ErrorAction SilentlyContinue) {
    Stop-Service -Name $runtimeName -ErrorAction Stop
    & sc.exe delete $runtimeName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not clean up the isolated runtime service" }
  }
  if ($passed -and (Test-Path -LiteralPath $testRoot)) {
    $resolved = (Resolve-Path -LiteralPath $testRoot).Path
    $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notmatch '^craftpanel-ops-[a-f0-9]{10}$') { throw "Unsafe temporary cleanup path" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    Remove-Item -LiteralPath "$installRoot.install.lock" -Force -ErrorAction SilentlyContinue
  } elseif (Test-Path -LiteralPath $testRoot) { Write-Output "Test artifacts retained: $testRoot" }
  foreach ($entry in Get-ChildItem Env: | Where-Object Name -like 'CRAFTPANEL_*') { Remove-Item "Env:$($entry.Name)" }
  foreach ($name in $savedEnv.Keys) { Set-Item "Env:$name" $savedEnv[$name] }
}
