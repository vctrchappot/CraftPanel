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
  $before = (Get-Content -LiteralPath (Join-Path $dataRoot "control.json") -Raw | ConvertFrom-Json).pid
  Install-Fixture "98.0.0" $false
  $after = (Get-Content -LiteralPath (Join-Path $dataRoot "control.json") -Raw | ConvertFrom-Json).pid
  if ($before -ne $after) { throw "Unsupported archive stopped the existing process" }
  foreach ($version in @("99.0.1", "99.0.2", "99.0.3")) {
    Install-Fixture $version $false
    Assert-Ready
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
  $points = @(Get-ChildItem -LiteralPath $installRoot -Directory -Filter 'state-*' | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "committed") })
  if ($points.Count -ne 2) { throw "Successful recovery retention is not bounded" }
  $passed = $true
  Write-Output "PASS: unsupported archive, failed migration, hanging startup, subsequent updates and recovery retention."
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
