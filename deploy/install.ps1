# CraftPanel installer and updater for Windows 10/11 (x64 and ARM64).
#
#   irm https://github.com/vctrchappot/CraftPanel/releases/latest/download/install.ps1 | iex
#
# Installs the latest release to %LOCALAPPDATA%\Programs\CraftPanel and starts CraftPanel whenever
# you sign in to Windows. No administrator rights needed, nothing is built on this computer, and
# Node.js is downloaded into the install folder when no suitable version is installed.
# Run it again, or update.ps1 in the install folder, to update.
#
# Options as environment variables, e.g.  $env:CRAFTPANEL_PORT = "8090"; irm … | iex
#   CRAFTPANEL_INSTALL_VERSION  install this release (e.g. 0.2.0) instead of the latest
#   CRAFTPANEL_ARCHIVE          install a downloaded craftpanel-vX.Y.Z.tar.gz
#   CRAFTPANEL_PORT             dashboard port (default 8080)
#   CRAFTPANEL_PROFILE          lan (default: reachable from your network) or local (this computer only)
#   CRAFTPANEL_UNINSTALL=1      remove CraftPanel, keep all data
#   CRAFTPANEL_RELEASE_DIR      install the newest craftpanel-vX.Y.Z.tar.gz from this folder (with its SHA256SUMS);
#                               can also be set in config.env for computers without access to GitHub
#
# Updates can also be started from the dashboard (Settings > Updates): CraftPanel runs the scheduled
# task "CraftPanel Update", which runs update.ps1 --from-dashboard and installs the newest release.
#
# Minecraft servers, worlds, backups and accounts live in %LOCALAPPDATA%\CraftPanel and are never touched.

$FromDashboard = $args -contains "--from-dashboard"
$Result = @{ from = $null; to = $null; rolledBack = $false }

function Install-CraftPanel {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repo = "vctrchappot/CraftPanel"
  $NodeMin = [version]"22.13"
  $NodeMajors = @(24, 22)
  $Root = if ($env:CRAFTPANEL_INSTALL_DIR) { $env:CRAFTPANEL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\CraftPanel" }
  $DataDir = if ($env:CRAFTPANEL_DATA_DIR) { $env:CRAFTPANEL_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "CraftPanel" }
  $TaskName = if ($env:CRAFTPANEL_TASK_NAME) { $env:CRAFTPANEL_TASK_NAME } else { "CraftPanel" }
  if ($FromDashboard) {
    # Started by the update task: this script is update.ps1 in the install folder; everything else comes from there.
    $Root = $PSScriptRoot
    $installed = Get-Content (Join-Path $Root "install.json") -Raw | ConvertFrom-Json
    if ($installed.taskName) { $TaskName = $installed.taskName }
    if ($installed.dataDir) { $DataDir = $installed.dataDir }
    foreach ($name in "CRAFTPANEL_INSTALL_VERSION", "CRAFTPANEL_ARCHIVE", "CRAFTPANEL_PORT", "CRAFTPANEL_PROFILE", "CRAFTPANEL_UNINSTALL") { Remove-Item "env:$name" -ErrorAction SilentlyContinue }
  }
  $ConfigFile = Join-Path $Root "config.env"
  # File locking works across dashboard updates and interactive installers, including different sessions.
  $Root = [IO.Path]::GetFullPath($Root)
  $ConfigFile = Join-Path $Root "config.env"
  if ($Root.TrimEnd('\') -eq [IO.Path]::GetPathRoot($Root).TrimEnd('\')) { throw "The install directory cannot be a drive root." }
  New-Item -ItemType Directory -Force (Split-Path $Root -Parent) | Out-Null
  $LockPath = "$Root.install.lock"
  try { $InstallLock = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
  catch { throw "Another CraftPanel install or update is already running (or the install directory is not writable)." }
  try {
  $UpdateTask = "$TaskName Update"
  $LogDir = Join-Path $DataDir "logs"
  $Shortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "$TaskName.url"
  $Tar = Join-Path $env:SystemRoot "System32\tar.exe"

  function Step($msg) { Write-Host "> $msg" -ForegroundColor White }
  function Info($msg) { Write-Host "  $msg" }
  function Fail($msg, $hint) { throw [System.Exception]::new($(if ($hint) { "$msg`n  $hint" } else { $msg })) }

  function Read-Config {
    $values = @{}
    if (Test-Path $ConfigFile) {
      foreach ($line in Get-Content $ConfigFile) {
        if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { $values[$Matches[1]] = $Matches[2].Trim('"') }
      }
    }
    return $values
  }

  function Get-Port { $c = Read-Config; if ($c["CRAFTPANEL_PORT"]) { [int]$c["CRAFTPANEL_PORT"] } else { 8080 } }

  function Get-LocalStatus($port, $path) {
    $config = Read-Config
    $scheme = if ($config["CRAFTPANEL_TLS_CERT"]) { "https" } else { "http" }
    $bindAddress = $config["CRAFTPANEL_HOST"]
    if (-not $bindAddress -or $bindAddress -in @("0.0.0.0", "::")) { $bindAddress = "127.0.0.1" }
    if ($bindAddress.Contains(":") -and -not $bindAddress.StartsWith("[")) { $bindAddress = "[$bindAddress]" }
    $url = "${scheme}://${bindAddress}:$port$path"
    # Only the local maintenance connection skips certificate validation (including self-signed TLS).
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
      $status = & $curl.Source --silent --insecure --noproxy '*' --max-time 2 --output NUL --write-out '%{http_code}' $url 2>$null
      if ($LASTEXITCODE -eq 0) { return [int]$status }
      return 0
    }
    try { return [int](Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $url).StatusCode }
    catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }; return 0 }
  }

  function Test-Healthy($port) { return (Get-LocalStatus $port "/api/health") -eq 200 }

  # Stops a running CraftPanel the clean way: its Minecraft servers save and stop first.
  function Stop-CraftPanel {
    $control = Join-Path $DataDir "control.json"
    if (Test-Path $control) {
      $c = Get-Content $control -Raw | ConvertFrom-Json
      $proc = Get-Process -Id $c.pid -ErrorAction SilentlyContinue
      if ($proc) {
        Info "Stopping CraftPanel (running Minecraft servers are saved and stopped)..."
        try {
          $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
          if ($curl) {
            & $curl.Source --silent --insecure --noproxy '*' --fail --max-time 10 --output NUL --request POST --header "Content-Type: application/json" --header "X-CraftPanel-Control: $($c.token)" --data '{}' "$($c.url)/api/control/shutdown"
            if ($LASTEXITCODE -ne 0) { throw "Local shutdown request failed" }
          } else {
            Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 10 -ContentType "application/json" -Body "{}" -Headers @{ "X-CraftPanel-Control" = $c.token } "$($c.url)/api/control/shutdown" | Out-Null
          }
        } catch {
          Fail "Could not ask CraftPanel to stop: $($_.Exception.Message)" "Stop it yourself (Ctrl+C in its window, or end the CraftPanel task), then run this again."
        }
        if (-not $proc.WaitForExit(180000)) { Fail "CraftPanel did not stop within 3 minutes." "Stop your Minecraft servers in the dashboard, then run this again." }
      }
    }
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    $port = Get-Port
    if (Test-Healthy $port) { Fail "Another CraftPanel is running on port $port." "Stop it with Ctrl+C in its window, or choose another port: `$env:CRAFTPANEL_PORT = `"8090`"" }
  }

  function Test-NodeOk($exe) {
    try {
      $v = & $exe -p "process.versions.node" 2>$null
      return $LASTEXITCODE -eq 0 -and [version]$v -ge $NodeMin
    } catch { return $false }
  }

  # Returns the node.exe CraftPanel runs with; downloads one into the install folder if needed.
  function Get-Node {
    $private = Join-Path $Root "node\node.exe"
    $sys = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($sys -and (Test-NodeOk $sys.Source)) { return $sys.Source }
    if ((Test-Path $private) -and (Test-NodeOk $private)) { return $private }
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    foreach ($major in $NodeMajors) {
      try { $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/latest-v$major.x/SHASUMS256.txt").Content } catch { continue }
      $line = ($sums -split "`n") | Where-Object { $_ -match "^([0-9a-f]{64})\s+(node-v[0-9.]+-win-$arch\.zip)$" } | Select-Object -First 1
      if (-not $line) { continue }
      $null = $line -match "^([0-9a-f]{64})\s+(\S+)$"
      $hash = $Matches[1]; $name = $Matches[2]
      Info "Downloading $name from nodejs.org..."
      $zip = Join-Path $Tmp $name
      Invoke-WebRequest -UseBasicParsing -OutFile $zip "https://nodejs.org/dist/latest-v$major.x/$name"
      if ((Get-FileHash -Algorithm SHA256 $zip).Hash -ne $hash.ToUpper()) { Fail "Checksum mismatch for $name." }
      $unpacked = Join-Path $Tmp "node"
      Expand-Archive -Path $zip -DestinationPath $unpacked -Force
      $dir = Get-ChildItem $unpacked -Directory | Select-Object -First 1
      Remove-Item -Recurse -Force (Join-Path $Root "node") -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Force $Root | Out-Null
      Move-Item $dir.FullName (Join-Path $Root "node")
      if (-not (Test-NodeOk $private)) { Fail "The downloaded Node.js does not run on this computer." }
      return $private
    }
    Fail "No Node.js download found for win-$arch." "Install Node.js $NodeMin or newer from https://nodejs.org and run this again."
  }

  function Write-StartScript($node) {
    # Started by the scheduled task. Reads config.env, keeps one old log, restarts on crashes via the task.
    $nodeLiteral = $node.Replace("'", "''")
    @"
# Generated by the CraftPanel installer; changes are overwritten on update. Settings go into config.env.
`$ErrorActionPreference = "Stop"
foreach (`$line in Get-Content (Join-Path `$PSScriptRoot "config.env")) {
  if (`$line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { Set-Item "env:`$(`$Matches[1])" `$Matches[2].Trim('"') }
}
`$env:NODE_ENV = "production"
`$env:NO_COLOR = "1"
`$installed = Get-Content (Join-Path `$PSScriptRoot "install.json") -Raw | ConvertFrom-Json
`$logs = Join-Path `$installed.dataDir "logs"
New-Item -ItemType Directory -Force `$logs | Out-Null
foreach (`$name in "craftpanel.log", "craftpanel.err.log") {
  `$file = Join-Path `$logs `$name
  if (Test-Path `$file) { Move-Item -Force `$file (`$file -replace '\.log$', '.previous.log') }
}
. (Join-Path `$PSScriptRoot "apps\api\dist\windows-job.ps1")
`$exitCode = [CraftPanelJob]::Run('$nodeLiteral', (Join-Path `$PSScriptRoot "apps\api\dist\index.js"), `$PSScriptRoot, (Join-Path `$logs "craftpanel.log"), (Join-Path `$logs "craftpanel.err.log"))
exit `$exitCode
"@ | Set-Content -Encoding UTF8 (Join-Path $Root "start.ps1")
  }

  function Register-Task {
    $start = Join-Path $Root "start.ps1"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`"" -WorkingDirectory $Root
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "CraftPanel Minecraft server manager (starts when you sign in)" -Force | Out-Null
  }

  # No trigger: CraftPanel starts it when you click "Update now" in the dashboard. It runs outside
  # CraftPanel's own task, so it keeps going while CraftPanel stops and restarts.
  function Register-UpdateTask {
    $script = Join-Path $Root "update.ps1"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" --from-dashboard" -WorkingDirectory $Root
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $UpdateTask -Action $action -Settings $settings -Principal $principal -Description "Installs a CraftPanel update requested from the dashboard" -Force | Out-Null
  }

  # The release notes of the installed version, from its CHANGELOG.md.
  function Show-WhatsNew($version) {
    $changelog = Join-Path $Root "CHANGELOG.md"
    if (-not (Test-Path $changelog)) { return }
    $lines = @(); $found = $false
    foreach ($line in Get-Content -Encoding UTF8 $changelog) {
      if ($line -match '^## (\S+)') { if ($found) { break }; $found = $Matches[1] -eq $version; continue }
      if ($found -and $line.Trim()) { $lines += $line }
    }
    if (-not $lines) { return }
    Write-Host ""
    Write-Host "  What's new" -ForegroundColor White
    foreach ($line in $lines | Select-Object -First 20) { Write-Host ("  " + ($line -replace '^### ', '' -replace '^- ', '  * ')) }
  }

  # The newest release archive in a folder (CRAFTPANEL_RELEASE_DIR).
  function Get-NewestArchive($dir) {
    Get-ChildItem -Path $dir -Filter "craftpanel-v*.tar.gz" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^craftpanel-v(\d+\.\d+\.\d+)\.tar\.gz$' } |
      Sort-Object { [version]($_.Name -replace '^craftpanel-v(\d+\.\d+\.\d+)\.tar\.gz$', '$1') } -Descending |
      Select-Object -First 1
  }

  function Wait-Healthy($port, $legacy = $false) {
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    for ($i = 0; $i -lt 60; $i++) {
      $status = Get-LocalStatus $port "/api/ready"
      if ($status -eq 200 -or ($legacy -and $status -eq 404 -and (Test-Healthy $port))) { return $true }
      # The task ends as soon as CraftPanel exits; don't wait the full minute for a crash.
      if ($i -ge 3 -and (Get-ScheduledTask -TaskName $TaskName).State -ne "Running") { return $false }
      if ([DateTime]::UtcNow -ge $deadline) { return $false }
      Start-Sleep -Seconds 1
    }
    return $false
  }

  function Stop-TaskConfirmed {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { Stop-ScheduledTask -TaskName $TaskName }
    $entry = Join-Path $Root "apps\api\dist\index.js"
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
      # control.json does not exist during migrations: also check the task's actual Node process.
      $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -ge 0
      })
      $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      if ($processes.Count -eq 0 -and (-not $task -or $task.State -ne "Running")) { return }
      Start-Sleep -Milliseconds 200
    }
    Fail "Could not confirm that CraftPanel stopped; database recovery was refused." "Resolve the task/process stop failure before restoring the recovery point."
  }

  function Prune-RecoveryPoints {
    $points = @(Get-ChildItem -LiteralPath $Root -Directory -Filter 'state-*' | Where-Object {
      $_.Name -match '^state-[0-9]+-[0-9]+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName "committed"))
    } | Sort-Object Name -Descending)
    foreach ($point in ($points | Select-Object -Skip 2)) {
      $target = [IO.Path]::GetFullPath($point.FullName)
      if (-not $target.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or ($point.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail "Unsafe recovery point path: $target" }
      Remove-Item -LiteralPath $target -Recurse -Force
    }
  }

  # ---- uninstall -------------------------------------------------------------------------
  $configuredData = (Read-Config)["CRAFTPANEL_DATA_DIR"]
  if ($configuredData) { $DataDir = [IO.Path]::GetFullPath($configuredData); $LogDir = Join-Path $DataDir "logs" }
  $DataDir = [IO.Path]::GetFullPath($DataDir)
  if ($Root.TrimEnd('\') -eq $DataDir.TrimEnd('\') -or
      $DataDir.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
      $Root.StartsWith($DataDir.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Fail "Install and data directories must be separate, non-overlapping directories." "This keeps application replacement and uninstall from touching server data."
  }
  if ($env:CRAFTPANEL_UNINSTALL -eq "1") {
    Step "Removing CraftPanel..."
    Stop-CraftPanel
    Stop-TaskConfirmed
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $UpdateTask -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue
    Remove-Item -Force $Shortcut -ErrorAction SilentlyContinue
    Write-Host "CraftPanel was removed. Your servers, worlds, backups and accounts were kept in $DataDir." -ForegroundColor Green
    return
  }

  if (-not (Test-Path $Tar)) { Fail "tar.exe is missing." "CraftPanel needs Windows 10 version 1803 or newer." }
  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("craftpanel-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory $Tmp | Out-Null
  try {
    if ($FromDashboard) { Write-Host "Update requested from the dashboard on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" }
    # ---- get the release -------------------------------------------------------------------
    $releaseDir = if ($env:CRAFTPANEL_RELEASE_DIR) { $env:CRAFTPANEL_RELEASE_DIR } else { (Read-Config)["CRAFTPANEL_RELEASE_DIR"] }
    if (-not $env:CRAFTPANEL_ARCHIVE -and -not $env:CRAFTPANEL_INSTALL_VERSION -and $releaseDir) {
      Step "Looking for the newest release in $releaseDir..."
      $newest = Get-NewestArchive $releaseDir
      if (-not $newest) { Fail "No craftpanel-vX.Y.Z.tar.gz in $releaseDir." }
      if (-not (Test-Path (Join-Path $releaseDir "SHA256SUMS"))) { Fail "$releaseDir has no SHA256SUMS." "Copy the SHA256SUMS file of the release next to the archive." }
      $env:CRAFTPANEL_ARCHIVE = $newest.FullName
    }
    if ($env:CRAFTPANEL_ARCHIVE) {
      if (-not (Test-Path $env:CRAFTPANEL_ARCHIVE)) { Fail "Archive not found: $env:CRAFTPANEL_ARCHIVE" }
      $archive = Join-Path $Tmp (Split-Path $env:CRAFTPANEL_ARCHIVE -Leaf)
      Copy-Item $env:CRAFTPANEL_ARCHIVE $archive
      $sums = Join-Path (Split-Path $env:CRAFTPANEL_ARCHIVE -Parent) "SHA256SUMS"
      if (-not (Test-Path $sums)) { Write-Warning "No SHA256SUMS next to the archive; skipping the checksum check."; $sums = $null }
    } else {
      $version = "$env:CRAFTPANEL_INSTALL_VERSION".TrimStart("v")
      if (-not $version) {
        Step "Looking up the latest release..."
        try {
          $release = Invoke-RestMethod -UseBasicParsing -Headers @{ "User-Agent" = "CraftPanel-installer" } "https://api.github.com/repos/$Repo/releases/latest"
        } catch {
          if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { Fail "No CraftPanel release has been published yet." }
          Fail "Could not reach GitHub: $($_.Exception.Message)" "Check the internet connection and try again."
        }
        $version = "$($release.tag_name)".TrimStart("v")
      }
      Step "Downloading CraftPanel v$version..."
      $base = "https://github.com/$Repo/releases/download/v$version"
      $archive = Join-Path $Tmp "craftpanel-v$version.tar.gz"
      $sums = Join-Path $Tmp "SHA256SUMS"
      try {
        Invoke-WebRequest -UseBasicParsing -OutFile $archive "$base/craftpanel-v$version.tar.gz"
        Invoke-WebRequest -UseBasicParsing -OutFile $sums "$base/SHA256SUMS"
      } catch { Fail "Could not download CraftPanel v${version}: $($_.Exception.Message)" "Check the version on https://github.com/$Repo/releases" }
    }
    if ($sums) {
      $name = Split-Path $archive -Leaf
      $expected = (Get-Content $sums | Where-Object { $_ -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape($name))$" } | ForEach-Object { $Matches[1] }) | Select-Object -First 1
      if (-not $expected) { Fail "$name is not listed in SHA256SUMS." }
      if ((Get-FileHash -Algorithm SHA256 $archive).Hash -ne $expected.ToUpper()) { Fail "Checksum mismatch for $name." "The download is damaged or was tampered with. Nothing was installed." }
      Info "Checksum verified."
    }

    $x = Join-Path $Tmp "x"
    New-Item -ItemType Directory $x | Out-Null
    & $Tar -xzf $archive -C $x
    if ($LASTEXITCODE -ne 0) { Fail "Could not unpack $archive." }
    $src = Get-ChildItem $x -Directory -Filter "craftpanel-v*" | Select-Object -First 1
    if (-not $src -or -not (Test-Path (Join-Path $src.FullName "apps\api\dist\index.js"))) { Fail "The archive does not contain a CraftPanel release." }
    $src = $src.FullName
    $version = (Get-Content (Join-Path $src "release.json") -Raw | ConvertFrom-Json).version
    $previous = $null
    $releaseFile = Join-Path $Root "release.json"
    if (Test-Path $releaseFile) { $previous = (Get-Content $releaseFile -Raw | ConvertFrom-Json).version }
    $Result.from = $previous; $Result.to = $version
    if ($FromDashboard -and $previous -and [version]($version -replace '-.*$', '') -le [version]($previous -replace '-.*$', '')) { Fail "CraftPanel v$previous is already the newest version." }

    # ---- Node.js -------------------------------------------------------------------------------
    Step "Checking Node.js..."
    $node = Get-Node
    Info "Using Node.js $(& $node -v) at $node"
    $snapshotCli = Join-Path $src "apps\api\dist\recovery.js"
    if (-not (Test-Path -LiteralPath $snapshotCli -PathType Leaf)) { Fail "This release does not support database recovery." "Use a compatible release. The running task has not been stopped." }
    $protocol = & $node $snapshotCli --protocol
    if ($LASTEXITCODE -ne 0 -or $protocol -ne "craftpanel-recovery-v1") { Fail "Unsupported database recovery protocol. The running task has not been stopped." }
    foreach ($f in @("README.md", "LICENSE", "CHANGELOG.md", "release.json", "deploy\install.ps1", "apps\api\dist\windows-job.ps1")) {
      if (-not (Test-Path -LiteralPath (Join-Path $src $f) -PathType Leaf)) { Fail "The release is missing $f. The running task has not been stopped." }
    }

    # ---- install ------------------------------------------------------------------------------
    Step "Installing CraftPanel v$version to $Root..."
    New-Item -ItemType Directory -Force $Root | Out-Null
    New-Item -ItemType Directory -Force $DataDir | Out-Null
    # Stage first. Environment and startup artifacts are only replaced inside the transaction.
    $new = Join-Path $Root "apps.new"
    $apps = Join-Path $Root "apps"
    $old = Join-Path $Root "apps.previous"
    Remove-Item -Recurse -Force $new -ErrorAction SilentlyContinue
    Copy-Item -Recurse (Join-Path $src "apps") $new
    Stop-CraftPanel
    Stop-TaskConfirmed
    $effectiveData = (Read-Config)["CRAFTPANEL_DATA_DIR"]
    if (-not $effectiveData) { $effectiveData = $DataDir }
    $stateDir = Join-Path $Root ("state-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + "-" + $PID)
    & $node $snapshotCli snapshot $effectiveData $stateDir
    if ($LASTEXITCODE -ne 0) {
      if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Start-ScheduledTask -TaskName $TaskName }
      Fail "Could not create the pre-update database snapshot; nothing was replaced."
    }
    Info "Database recovery point: $stateDir"
    $startup = Join-Path $stateDir "startup"
    New-Item -ItemType Directory $startup | Out-Null
    $artifactPaths = @("README.md", "LICENSE", "CHANGELOG.md", "release.json", "install.json", "start.ps1", "update.ps1", "config.env") | ForEach-Object { Join-Path $Root $_ }
    $artifactPaths += $Shortcut
    try {
      for ($i = 0; $i -lt $artifactPaths.Count; $i++) {
        if (Test-Path -LiteralPath $artifactPaths[$i]) { Copy-Item -LiteralPath $artifactPaths[$i] -Destination (Join-Path $startup "$i") }
      }
      foreach ($name in @($TaskName, $UpdateTask)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
          $xmlFile = if ($name -eq $TaskName) { "main-task.xml" } else { "update-task.xml" }
          Export-ScheduledTask -TaskName $name | Set-Content -Encoding Unicode (Join-Path $startup $xmlFile)
        }
      }
    } catch {
      if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Start-ScheduledTask -TaskName $TaskName }
      throw
    }
    $appsMoved = $false
    $newActivated = $false
    try {
    if (-not (Test-Path $ConfigFile)) {
      $prof = if ($env:CRAFTPANEL_PROFILE) { $env:CRAFTPANEL_PROFILE } else { "lan" }
      $port = if ($env:CRAFTPANEL_PORT) { $env:CRAFTPANEL_PORT } else { "8080" }
      $lines = @(
        "# CraftPanel settings. Kept on updates; restart CraftPanel (sign out and in, or run update.ps1) to apply.",
        "# lan: dashboard reachable from your network (allowed networks: Settings > Remote access); local: this computer only",
        "CRAFTPANEL_PROFILE=$prof",
        "CRAFTPANEL_PORT=$port",
        "# Don't look up new releases on GitHub:",
        "#CRAFTPANEL_UPDATE_CHECK=false"
      )
      if ($env:CRAFTPANEL_DATA_DIR) { $lines += "CRAFTPANEL_DATA_DIR=$DataDir" }
      $lines | Set-Content -Encoding ASCII $ConfigFile
    } elseif ($env:CRAFTPANEL_PORT) {
      $content = Get-Content $ConfigFile | Where-Object { $_ -notmatch '^CRAFTPANEL_PORT=' }
      ($content + "CRAFTPANEL_PORT=$env:CRAFTPANEL_PORT") | Set-Content -Encoding ASCII $ConfigFile
    }

    Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue
    if (Test-Path $apps) { Move-Item $apps $old; $appsMoved = $true }
    Move-Item $new $apps
    $newActivated = $true
    foreach ($f in "README.md", "LICENSE", "CHANGELOG.md", "release.json") { Copy-Item -Force (Join-Path $src $f) (Join-Path $Root $f) }
    Copy-Item -Force (Join-Path $src "deploy\install.ps1") (Join-Path $Root "update.ps1")
    $update = "powershell -ExecutionPolicy Bypass -File `"$(Join-Path $Root 'update.ps1')`""
    @{
      method = "windows"; updateCommand = $update; taskName = $TaskName; dataDir = $DataDir
      selfUpdate = @{ kind = "task"; task = $UpdateTask; log = (Join-Path $LogDir "update.log"); result = (Join-Path $LogDir "update-result.json") }
    } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $Root "install.json")
    Write-StartScript $node
    Register-Task
    # Re-registering the task that runs this very script could stop it; it already exists then.
    if (-not $FromDashboard) { Register-UpdateTask }
    $port = Get-Port
    "[InternetShortcut]`r`nURL=http://localhost:$port/`r`n" | Set-Content -Encoding ASCII $Shortcut

    Step "Starting..."
    Start-ScheduledTask -TaskName $TaskName
    if (-not (Wait-Healthy $port)) { Fail "The new version did not become ready." }
    } catch {
      $failure = $_.Exception.Message
      Write-Warning "Installation failed. Restoring the previous database and startup configuration."
      Stop-TaskConfirmed
      & $node $snapshotCli restore $effectiveData $stateDir
      if ($LASTEXITCODE -ne 0) { Fail "Database recovery failed; CraftPanel remains stopped." "Recovery point: $stateDir. Do not restart against an incompatible database." }
      if ($newActivated -and (Test-Path $apps)) { Move-Item -LiteralPath $apps -Destination (Join-Path $Root ("apps.failed-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())) }
      if ($appsMoved) { Move-Item -LiteralPath $old -Destination $apps }
      for ($i = 0; $i -lt $artifactPaths.Count; $i++) {
        $saved = Join-Path $startup "$i"
        if (Test-Path -LiteralPath $saved) { Copy-Item -LiteralPath $saved -Destination $artifactPaths[$i] -Force }
        elseif (Test-Path -LiteralPath $artifactPaths[$i]) { Remove-Item -LiteralPath $artifactPaths[$i] -Force }
      }
      foreach ($name in @($TaskName, $UpdateTask)) {
        # The running updater task was not changed; re-registering it could terminate recovery itself.
        if ($FromDashboard -and $name -eq $UpdateTask) { continue }
        $xmlFile = Join-Path $startup $(if ($name -eq $TaskName) { "main-task.xml" } else { "update-task.xml" })
        if (Test-Path -LiteralPath $xmlFile) { Register-ScheduledTask -TaskName $name -Xml (Get-Content -LiteralPath $xmlFile -Raw) -Force | Out-Null }
        elseif (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
      }
      if ((Test-Path $apps) -and (Test-Path -LiteralPath (Join-Path $startup "main-task.xml"))) {
        Start-ScheduledTask -TaskName $TaskName
        if (Wait-Healthy (Get-Port) $true) { $Result.rolledBack = $true; Fail "The update failed; the previous application, database and startup configuration are running again." "$failure. Recovery point: $stateDir" }
      }
      Fail "The installation failed. The original database and startup configuration were restored; CraftPanel is stopped." "$failure. Recovery point: $stateDir"
    }
    New-Item -ItemType File (Join-Path $stateDir "committed") | Out-Null
    Prune-RecoveryPoints

    # ---- summary -----------------------------------------------------------------------------
    Write-Host ""
    if ($previous -and $previous -ne $version) { Write-Host "CraftPanel updated: v$previous -> v$version" -ForegroundColor Green; Show-WhatsNew $version }
    elseif ($previous) { Write-Host "CraftPanel v$version reinstalled" -ForegroundColor Green }
    else { Write-Host "CraftPanel v$version is installed and running" -ForegroundColor Green }
    Write-Host ""
    Info "On this computer  http://localhost:$port  (also in the Start menu)"
    if ((Read-Config)["CRAFTPANEL_PROFILE"] -ne "local") {
      $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|VirtualBox|VMware|Loopback' } | Select-Object -ExpandProperty IPAddress
      foreach ($ip in $ips) { Info "From your network http://${ip}:$port" }
      Info "If Windows asks whether Node.js may communicate on private networks, allow it."
    }
    $token = Join-Path $DataDir "setup-token.txt"
    if (Test-Path $token) { Write-Host ""; Info "Setup token  $((Get-Content $token -Raw).Trim())  (needed once to create the owner account)" }
    Write-Host ""
    Info "CraftPanel starts when you sign in to Windows."
    Info "Update:    $update"
    Info "Logs:      $(Join-Path $DataDir 'logs\craftpanel.log')"
    Info "Settings:  $ConfigFile"
  } finally {
    Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
  }
  } finally { $InstallLock.Dispose() }
}

# An update started from the dashboard logs to a file the dashboard reads and leaves a result it shows after the restart.
$dashboard = $null
if ($FromDashboard) {
  $dashboard = (Get-Content (Join-Path $PSScriptRoot "install.json") -Raw | ConvertFrom-Json).selfUpdate
  New-Item -ItemType Directory -Force (Split-Path $dashboard.log) | Out-Null
  Start-Transcript -Path $dashboard.log -Force | Out-Null
}
$ok = $false
$message = ""
try {
  Install-CraftPanel
  $ok = $true
} catch {
  $message = $_.Exception.Message
  Write-Host ""
  Write-Host "X $message" -ForegroundColor Red
} finally {
  if ($dashboard) {
    Stop-Transcript | Out-Null
    $summary = if ($ok) { "Updated$(if ($Result.from) { " from $($Result.from)" }) to $($Result.to)" } else { $message -replace "\s*`n\s*", " " }
    $json = @{ ok = $ok; from = $Result.from; to = $Result.to; message = $summary; rolledBack = $Result.rolledBack; finishedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText("$($dashboard.result).tmp", $json)
    Move-Item -Force "$($dashboard.result).tmp" $dashboard.result
  }
}
# Piped into iex there is no script file: don't close the user's PowerShell window.
if (-not $ok -and $PSCommandPath) { exit 1 }
