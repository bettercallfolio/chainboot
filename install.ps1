# chainboot installer for Windows (PowerShell 5.1 or newer).
#
#   irm https://raw.githubusercontent.com/bettercallfolio/chainboot/main/install.ps1 | iex
#
# What it does, all inside your user profile and without administrator rights:
#   1. finds Node.js 22.15 or newer, or downloads the official Node.js build and checks its SHA-256
#   2. downloads the chainboot program and checks its SHA-256
#   3. creates the `chainboot` command and adds it to your user PATH
# Machines run inside WSL 2. If WSL is not enabled yet, the installer tells you the one command to enable it.
# Run it again at any time to update. Uninstall:  & ([scriptblock]::Create((irm <same url>))) -Uninstall
param(
  [string]$From = "",
  [switch]$Uninstall,
  [switch]$Purge
)

# Everything happens inside one function. Its settings and helpers stay inside it (this script
# is often run with "irm | iex", in the user's own session), and a failure ends the function,
# not the window the user is typing in.
function Install-Chainboot {
param([string]$From, [bool]$Uninstall, [bool]$Purge)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$NodeVersion = "v24.22.3"
$NodeSha = @{ x64 = "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f"; arm64 = "b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14" }
$ReleaseUrl = if ($env:CHAINBOOT_RELEASE_URL) { $env:CHAINBOOT_RELEASE_URL } else { "https://github.com/bettercallfolio/chainboot/releases/latest/download" }

$Root = Join-Path $env:LOCALAPPDATA "chainboot"
$AppDir = Join-Path $Root "app"
$RuntimeDir = Join-Path $Root "runtime"
$BinDir = Join-Path $Root "bin"
$Settings = Join-Path $env:USERPROFILE ".chainboot"

function Ok($t) { Write-Host "[ok] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "[!]  $t" -ForegroundColor Yellow }
function Die($t) { throw $t }
function Sha256($file) { (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower() }
function PathHas($dir) { (([Environment]::GetEnvironmentVariable("Path", "User")) -split ";") -contains $dir }

if ($Purge -and -not $Uninstall) { Die "-Purge goes with -Uninstall (it deletes your machines, settings and logins)" }
if ($Uninstall) {
  foreach ($d in @($AppDir, $RuntimeDir, $BinDir)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
  if (PathHas $BinDir) {
    $p = (([Environment]::GetEnvironmentVariable("Path", "User")) -split ";" | Where-Object { $_ -and $_ -ne $BinDir }) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $p, "User")
  }
  Ok "removed the chainboot program"
  if ($Purge) {
    & wsl.exe --unregister chainboot 2>$null | Out-Null
    foreach ($d in @($Root, $Settings)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
    Ok "removed machines, settings and logins"
  } else {
    Write-Host "Your machines, settings and logins were kept (add -Purge to delete them)."
  }
  return
}

$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") { "arm64" } elseif ([Environment]::Is64BitOperatingSystem) { "x64" } else { Die "chainboot needs 64-bit Windows." }
Write-Host "Installing chainboot (Windows $Arch, into $Root)"
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("chainboot-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $Tmp, $Root, $BinDir | Out-Null
try {
  # ---- 1. Node.js
  function NodeOk($exe) {
    if (-not (Test-Path $exe)) { return $false }
    try { & $exe -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=15)?0:1)" 2>$null; return ($LASTEXITCODE -eq 0) } catch { return $false }
  }
  $Node = ""
  $own = Join-Path $RuntimeDir "node.exe"
  # a Node.js that an earlier run of this installer downloaded is kept up to date with the version named above
  if ((NodeOk $own) -and ((& $own --version) -eq $NodeVersion)) { $Node = $own }
  elseif (-not (Test-Path $own)) {
    $sys = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($sys -and (NodeOk $sys.Source)) { $Node = $sys.Source }
  }
  if ($Node) { Ok "using Node.js $(& $Node --version) at $Node" }
  else {
    Write-Host "Downloading Node.js $NodeVersion (official build from nodejs.org)"
    $name = "node-$NodeVersion-win-$Arch"
    $zip = Join-Path $Tmp "node.zip"
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$NodeVersion/$name.zip" -OutFile $zip
    if ((Sha256 $zip) -ne $NodeSha[$Arch]) { Die "the Node.js download does not match its expected SHA-256. Nothing was installed." }
    Expand-Archive -Path $zip -DestinationPath $Tmp -Force
    if (Test-Path $RuntimeDir) { Remove-Item -Recurse -Force $RuntimeDir }
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    Copy-Item (Join-Path $Tmp "$name\node.exe") $own
    Copy-Item (Join-Path $Tmp "$name\LICENSE") (Join-Path $RuntimeDir "LICENSE")
    $Node = $own
    if (-not (NodeOk $Node)) { Die "the downloaded Node.js does not run on this system." }
    Ok "installed Node.js $(& $Node --version) for chainboot only"
  }

  # ---- 2. the program
  $tgz = Join-Path $Tmp "chainboot.tar.gz"
  if ($From) {
    if (-not (Test-Path $From)) { Die "no such file: $From" }
    Copy-Item $From $tgz
  } else {
    Write-Host "Downloading chainboot"
    Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseUrl/chainboot.tar.gz" -OutFile $tgz
    # (to a file first: the content of such a download arrives as bytes, not as text)
    $shaFile = Join-Path $Tmp "chainboot.sha256"
    Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseUrl/chainboot.tar.gz.sha256" -OutFile $shaFile
    $want = (((Get-Content -Raw -Path $shaFile) -split "\s+") | Where-Object { $_ })[0].Trim().ToLower()
    if ($want -notmatch "^[0-9a-f]{64}$") { Die "the checksum of chainboot could not be read. Nothing was installed." }
    if ((Sha256 $tgz) -ne $want) { Die "the chainboot download does not match its SHA-256. Nothing was installed." }
  }
  $new = "$AppDir.new"
  if (Test-Path $new) { Remove-Item -Recurse -Force $new }
  New-Item -ItemType Directory -Force -Path $new | Out-Null
  & tar.exe -xzf $tgz -C $new
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $new "chainboot.mjs")) -or -not (Test-Path (Join-Path $new "web\index.html"))) { Die "the chainboot archive is incomplete." }
  $version = & $Node (Join-Path $new "chainboot.mjs") --version
  if ($LASTEXITCODE -ne 0) { Die "the downloaded chainboot does not start." }
  if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
  Move-Item $new $AppDir

  # ---- 3. the command
  # The command starts chainboot with the Node.js found above; if that one is gone later (a
  # version manager removed it), with the one this installer keeps, or the one on the PATH.
  # Folders are written the way cmd.exe names them itself, and the file in the encoding cmd.exe
  # reads, so that a profile folder with letters outside ASCII works too.
  $cmd = @(
    "@echo off", "setlocal",
    "set `"CB_NODE=$Node`"",
    "if not exist `"%CB_NODE%`" set `"CB_NODE=%LOCALAPPDATA%\chainboot\runtime\node.exe`"",
    "if not exist `"%CB_NODE%`" set `"CB_NODE=node.exe`"",
    "`"%CB_NODE%`" `"%LOCALAPPDATA%\chainboot\app\chainboot.mjs`" %*"
  ) -join "`r`n"
  $oem = [Text.Encoding]::ASCII
  try { $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage) } catch { }
  [IO.File]::WriteAllText((Join-Path $BinDir "chainboot.cmd"), $cmd + "`r`n", $oem)
  if (-not (PathHas $BinDir)) {
    [Environment]::SetEnvironmentVariable("Path", (([Environment]::GetEnvironmentVariable("Path", "User")).TrimEnd(";") + ";" + $BinDir).TrimStart(";"), "User")
    $env:Path = "$env:Path;$BinDir"
    Warn "added $BinDir to your PATH. Open a new terminal window for the 'chainboot' command to be found."
  }
  Ok "installed chainboot $version"

  # ---- what is still needed
  $wsl = $false
  try { & wsl.exe --status *> $null; $wsl = ($LASTEXITCODE -eq 0) } catch { $wsl = $false }
  if (-not $wsl) {
    Warn "Machines run inside WSL 2, which is not enabled yet. Open PowerShell as administrator and run:"
    Write-Host "       wsl --install --no-distribution"
    Write-Host "     Restart the computer afterwards. chainboot sets up the rest by itself."
  }
  Write-Host ""
  Write-Host "Next steps"
  Write-Host "  chainboot rpc add <your RPC endpoint URL>     # free from Helius, QuickNode, Alchemy, ..."
  Write-Host "  chainboot run solinux                        # Ubuntu 26.04 LTS, straight from Solana"
  Write-Host "  chainboot ui                                  # or use the point-and-click interface"
} finally {
  if (Test-Path $Tmp) { Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue }
}
}

try {
  Install-Chainboot -From $From -Uninstall ([bool]$Uninstall) -Purge ([bool]$Purge)
} catch {
  Write-Host "[x]  $($_.Exception.Message)" -ForegroundColor Red
  # Run as a file (./install.ps1), a failure is an exit status. Pasted or piped into a session
  # ("irm | iex"), exiting would close the window the user is typing in: there the status is
  # only noted. (Inside another script the invocation names that script, not this one.)
  $self = $MyInvocation.MyCommand.Path
  if ($self -and ((Split-Path -Leaf $self) -eq "install.ps1")) { exit 1 }
  $global:LASTEXITCODE = 1
}
