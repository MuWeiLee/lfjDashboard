# run-refresh.ps1 - load .env then run Wind snapshot refresh
#
# Usage (run by user):
#   powershell -ExecutionPolicy Bypass -File scripts\run-refresh.ps1 -Market cn -Force
$market = "cn"; $force = $false
for ($i = 0; $i -lt $args.Count; $i++) {
  if ($args[$i] -eq "-Market") { $market = $args[$i + 1] }
  elseif ($args[$i] -eq "-Force") { $force = $true }
}

$envPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
if (Test-Path $envPath) {
  Get-Content $envPath | ForEach-Object {
    if ($_ -match "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
  }
} else { Write-Output "WARNING: .env missing (run scripts\setup-wind-env.ps1 first)" }

$node = "C:\Users\fjliu.frank\.local\lib\nodejs\node-v22.23.3-win-x64\node.exe"
if (-not (Test-Path $node)) { $node = "node" }
$refresh = Join-Path $PSScriptRoot "short-emotion\refresh.mjs"
$opt = @(); if ($force) { $opt += "--force" }
& $node $refresh $opt "--market=$market"
exit $LASTEXITCODE