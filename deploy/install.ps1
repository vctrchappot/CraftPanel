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
#
# Minecraft servers, worlds, backups and accounts live in %LOCALAPPDATA%\CraftPanel and are never touched.

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
  $ConfigFile = Join-Path $Root "config.env"
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

  function Test-Healthy($port) {
    try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$port/api/health").StatusCode -eq 200 } catch { return $false }
  }

  # Stops a running CraftPanel the clean way: its Minecraft servers save and stop first.
  function Stop-CraftPanel {
    $control = Join-Path $DataDir "control.json"
    if (Test-Path $control) {
      $c = Get-Content $control -Raw | ConvertFrom-Json
      $proc = Get-Process -Id $c.pid -ErrorAction SilentlyContinue
      if ($proc) {
        Info "Stopping CraftPanel (running Minecraft servers are saved and stopped)..."
        try {
          Invoke-WebRequest -UseBasicParsing -Method Post -TimeoutSec 10 -ContentType "application/json" -Body "{}" -Headers @{ "X-CraftPanel-Control" = $c.token } "$($c.url)/api/control/shutdown" | Out-Null
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
    @"
# Generated by the CraftPanel installer; changes are overwritten on update. Settings go into config.env.
`$ErrorActionPreference = "Stop"
foreach (`$line in Get-Content "$ConfigFile") {
  if (`$line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { Set-Item "env:`$(`$Matches[1])" `$Matches[2].Trim('"') }
}
`$env:NODE_ENV = "production"
`$env:NO_COLOR = "1"
`$logs = Join-Path "$DataDir" "logs"
New-Item -ItemType Directory -Force `$logs | Out-Null
foreach (`$name in "craftpanel.log", "craftpanel.err.log") {
  `$file = Join-Path `$logs `$name
  if (Test-Path `$file) { Move-Item -Force `$file (`$file -replace '\.log$', '.previous.log') }
}
`$p = Start-Process -FilePath "$node" -ArgumentList '"$Root\apps\api\dist\index.js"' -WorkingDirectory "$Root" -WindowStyle Hidden -PassThru -Wait ``
  -RedirectStandardOutput (Join-Path `$logs "craftpanel.log") -RedirectStandardError (Join-Path `$logs "craftpanel.err.log")
exit `$p.ExitCode
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

  function Wait-Healthy($port) {
    for ($i = 0; $i -lt 60; $i++) {
      if (Test-Healthy $port) { return $true }
      # The task ends as soon as CraftPanel exits; don't wait the full minute for a crash.
      if ($i -ge 3 -and (Get-ScheduledTask -TaskName $TaskName).State -ne "Running") { return $false }
      Start-Sleep -Seconds 1
    }
    return $false
  }

  # ---- uninstall -------------------------------------------------------------------------
  if ($env:CRAFTPANEL_UNINSTALL -eq "1") {
    Step "Removing CraftPanel..."
    Stop-CraftPanel
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $Root -ErrorAction SilentlyContinue
    Remove-Item -Force $Shortcut -ErrorAction SilentlyContinue
    Write-Host "CraftPanel was removed. Your servers, worlds, backups and accounts were kept in $DataDir." -ForegroundColor Green
    return
  }

  if (-not (Test-Path $Tar)) { Fail "tar.exe is missing." "CraftPanel needs Windows 10 version 1803 or newer." }
  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("craftpanel-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory $Tmp | Out-Null
  try {
    # ---- get the release -------------------------------------------------------------------
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

    # ---- Node.js -------------------------------------------------------------------------------
    Step "Checking Node.js..."
    $node = Get-Node
    Info "Using Node.js $(& $node -v) at $node"

    # ---- install ------------------------------------------------------------------------------
    Step "Installing CraftPanel v$version to $Root..."
    New-Item -ItemType Directory -Force $Root | Out-Null
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

    $new = Join-Path $Root "apps.new"
    $apps = Join-Path $Root "apps"
    $old = Join-Path $Root "apps.previous"
    Remove-Item -Recurse -Force $new -ErrorAction SilentlyContinue
    Copy-Item -Recurse (Join-Path $src "apps") $new
    Stop-CraftPanel
    Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue
    if (Test-Path $apps) { Move-Item $apps $old }
    if (Test-Path $releaseFile) { Copy-Item $releaseFile (Join-Path $Root "apps.previous.release.json") }
    Move-Item $new $apps
    foreach ($f in "README.md", "LICENSE", "CHANGELOG.md", "release.json") { Copy-Item -Force (Join-Path $src $f) (Join-Path $Root $f) }
    Copy-Item -Force (Join-Path $src "deploy\install.ps1") (Join-Path $Root "update.ps1")
    $update = "powershell -ExecutionPolicy Bypass -File `"$(Join-Path $Root 'update.ps1')`""
    @{ method = "windows"; updateCommand = $update } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $Root "install.json")
    Write-StartScript $node
    Register-Task
    $port = Get-Port
    "[InternetShortcut]`r`nURL=http://localhost:$port/`r`n" | Set-Content -Encoding ASCII $Shortcut

    Step "Starting..."
    Start-ScheduledTask -TaskName $TaskName
    if (-not (Wait-Healthy $port)) {
      $log = Join-Path $DataDir "logs\craftpanel.err.log"
      if (Test-Path $old) {
        Write-Warning "CraftPanel v$version did not start. Going back to the previous version."
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Remove-Item -Recurse -Force (Join-Path $Root "apps.failed") -ErrorAction SilentlyContinue
        Move-Item $apps (Join-Path $Root "apps.failed")
        Move-Item $old $apps
        $prevRelease = Join-Path $Root "apps.previous.release.json"
        if (Test-Path $prevRelease) { Move-Item -Force $prevRelease $releaseFile }
        Start-ScheduledTask -TaskName $TaskName
        if (Wait-Healthy $port) { Fail "CraftPanel v$version did not start; the previous version$(if ($previous) { " (v$previous)" }) is running again." "See what went wrong in $log" }
      }
      Fail "CraftPanel did not start." "See what happened in $log"
    }
    Remove-Item -Force (Join-Path $Root "apps.previous.release.json") -ErrorAction SilentlyContinue

    # ---- summary -----------------------------------------------------------------------------
    Write-Host ""
    if ($previous -and $previous -ne $version) { Write-Host "CraftPanel updated: v$previous -> v$version" -ForegroundColor Green }
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
}

try {
  Install-CraftPanel
} catch {
  Write-Host ""
  Write-Host "X $($_.Exception.Message)" -ForegroundColor Red
  # Piped into iex there is no script file: don't close the user's PowerShell window.
  if ($PSCommandPath) { exit 1 }
}
