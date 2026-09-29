param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'

try {
    $projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
    $serverFile = Join-Path $projectRoot 'technical_analysis_server.mjs'
    $url = 'http://127.0.0.1:8799'

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $desktopNode = Join-Path $env:USERPROFILE 'Desktop\node-v22.18.0-win-x64\node.exe'
    $nodeExe = if ($nodeCommand) {
        $nodeCommand.Source
    } elseif (Test-Path -LiteralPath $desktopNode) {
        $desktopNode
    } else {
        $null
    }

    if (-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)) {
        throw 'Node.js was not found. Install Node.js 18+ or add node.exe to PATH.'
    }
    if (-not (Test-Path -LiteralPath $serverFile)) {
        throw ('Server file was not found: ' + $serverFile)
    }

    $running = $false
    try {
        $health = Invoke-RestMethod -Uri ($url + '/api/health') -TimeoutSec 2
        $running = [bool]$health.ok
    } catch {}

    if (-not $running) {
        Start-Process -FilePath $nodeExe -ArgumentList @($serverFile) -WorkingDirectory $projectRoot -WindowStyle Hidden
        foreach ($attempt in 1..10) {
            Start-Sleep -Milliseconds 500
            try {
                $health = Invoke-RestMethod -Uri ($url + '/api/health') -TimeoutSec 2
                if ($health.ok) {
                    $running = $true
                    break
                }
            } catch {}
        }
    }

    if (-not $running) {
        throw 'The local server did not start on http://127.0.0.1:8799.'
    }

    if (-not $NoBrowser) {
        Start-Process $url
    }
    Write-Host ('Started: ' + $url)
    exit 0
} catch {
    Write-Host ''
    Write-Host ('Startup failed: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
