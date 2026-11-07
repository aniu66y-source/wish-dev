# setup-opencode-paths.ps1
# Unify OpenCode's data/cache/config/state under one root and make it automatic.
#
#   Root selection (first writable): E:\Claude Agent -> D:\Claude Agent -> C:\Claude Agent
#   Layout:   <root>\.opencode\{data,cache,config,state}\opencode\   (OpenCode nests one more \opencode leaf)
#   Mechanism: 4 XDG User env vars -> XDG_DATA_HOME / XDG_CACHE_HOME / XDG_CONFIG_HOME / XDG_STATE_HOME
#   Migration: existing OpenCode data (default XDG locations) is robocopied into the new leaves,
#              byte-verified, then the source is removed. Idempotent: re-running reconciles an existing setup.
#
# Notes:
#   - tmp (Temp\opencode) is NOT unified; it follows the system TEMP and is intentionally left there.
#   - Non-admin safe: uses /COPY:DAT (not /COPYALL), never requires elevation.
#   - Service restart: pass -ServiceTask <name> to stop the 4096 listener and start that scheduled task;
#     otherwise the 4096 listener is stopped and the caller restarts the service by its own mechanism.

[CmdletBinding()]
param(
  [string]$Root,
  [string]$ServiceTask,
  [switch]$NoMigrate,
  [switch]$NoRestart
)
$ErrorActionPreference = "Stop"

function Test-RootWritable([string]$p) {
  if (-not (Test-Path $p)) {
    try { New-Item -ItemType Directory -Path $p -Force | Out-Null } catch { return $false }
  }
  $probe = Join-Path $p (".wprobe_$(Get-Random)")
  try { Set-Content -Path $probe -Value "x"; Remove-Item $probe -Force; return $true } catch { return $false }
}

# 1. pick root (E -> D -> C, first writable; explicit -Root wins)
if (-not $Root) {
  foreach ($c in @("E:\Claude Agent","D:\Claude Agent","C:\Claude Agent")) {
    if (Test-RootWritable $c) { $Root = $c; break }
  }
}
if (-not $Root -or -not (Test-RootWritable $Root)) { throw "no writable root available (E/D/C:\Claude Agent)" }

$base = Join-Path $Root ".opencode"
$parent = @{
  data   = (Join-Path $base "data")
  cache  = (Join-Path $base "cache")
  config = (Join-Path $base "config")
  state  = (Join-Path $base "state")
}
$leaf = @{}
foreach ($k in @("data","cache","config","state")) {
  $leaf[$k] = Join-Path $parent[$k] "opencode"
  if (-not (Test-Path $leaf[$k])) { New-Item -ItemType Directory -Path $leaf[$k] -Force | Out-Null }
}

# 2. set 4 XDG User env vars -> parent dirs (OpenCode appends the \opencode leaf itself)
$envMap = @{
  "XDG_DATA_HOME"   = $parent.data
  "XDG_CACHE_HOME"  = $parent.cache
  "XDG_CONFIG_HOME" = $parent.config
  "XDG_STATE_HOME"  = $parent.state
}
foreach ($k in @("XDG_DATA_HOME","XDG_CACHE_HOME","XDG_CONFIG_HOME","XDG_STATE_HOME")) {
  [Environment]::SetEnvironmentVariable($k, $envMap[$k], "User")
}

# 3. migrate existing data into the leaves (idempotent; skip if -NoMigrate)
if (-not $NoMigrate) {
  $up   = $env:USERPROFILE
  $migrate = @(
    @{ src = "$up\.local\share\opencode"; leaf = $leaf.data   },
    @{ src = "$up\.cache\opencode";       leaf = $leaf.cache },
    @{ src = "$up\.config\opencode";      leaf = $leaf.config },
    @{ src = "$up\.local\state\opencode"; leaf = $leaf.state }
  )
  $rbc = "C:\Windows\System32\robocopy.exe"
  foreach ($m in $migrate) {
    if (-not (Test-Path $m.src)) { continue }
    & $rbc $m.src $m.leaf /E /COPY:DAT /DCOPY:T /R:1 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed rc=$LASTEXITCODE : $($m.src)" }
    $sb = (Get-ChildItem $m.src  -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum
    $db = (Get-ChildItem $m.leaf -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum
    if ($sb -gt 0 -and $db -lt $sb) { throw "byte-verify failed src=$sb dst=$d for $($m.src); source retained" }
    Remove-Item $m.src -Recurse -Force
  }
}

# 4. restart the service so it picks up the new XDG env (User vars are read by newly spawned processes)
if (-not $NoRestart) {
  $conns = Get-NetTCPConnection -LocalPort 4096 -State Listen -EA SilentlyContinue
  foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -EA SilentlyContinue }
  Start-Sleep -Seconds 2
  if ($ServiceTask) {
    if (Get-ScheduledTask -TaskName $ServiceTask -EA SilentlyContinue) { Start-ScheduledTask -TaskName $ServiceTask }
  }
}

Write-Output ("opencode-paths: root=$Root  base=$base")
foreach ($k in @("XDG_DATA_HOME","XDG_CACHE_HOME","XDG_CONFIG_HOME","XDG_STATE_HOME")) {
  Write-Output ("  " + $k + " = " + [Environment]::GetEnvironmentVariable($k,"User"))
}
