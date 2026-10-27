<#
  启动「短线情绪 · 涨停事件工作台」：
    1) 端口 3000 未监听 → 用 Windows 上的 Electron 运行时（Node 模式）拉起 scripts/dev-server.mjs
    2) 等待 /zt 返回 200（最多 15 秒）
    3) 用默认浏览器打开 http://localhost:3000/zt

  可重复点击：服务已在运行时只打开页面，不会重复占用端口。
  自动化调用可加 -NoBrowser，仅确保服务就绪。
#>
param([switch]$NoBrowser)

$ErrorActionPreference = "Continue"

$root = Split-Path -Parent $PSScriptRoot
$runtime = "C:\Users\fjliu.frank\AppData\Local\Programs\WindClaw\WindClaw.exe"
$port = 3000
$url = "http://localhost:$port/zt"

function Test-Serving {
  try {
    $response = Invoke-WebRequest -Uri "http://localhost:$port/zt" -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Show-Failure {
  param([string]$Message)
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($Message, "涨停工作台启动失败", "OK", "Warning") | Out-Null
  } catch {
    Write-Error $Message
  }
}

$serving = Test-Serving

if (-not $serving) {
  if (-not (Test-Path $runtime)) {
    Show-Failure ("未找到运行环境：" + $runtime)
    exit 1
  }

  # Electron 以 Node 方式运行，系统没有独立 node 可执行文件
  $env:ELECTRON_RUN_AS_NODE = "1"
  Start-Process -FilePath $runtime -ArgumentList "scripts/dev-server.mjs" `
    -WorkingDirectory $root -WindowStyle Hidden -ErrorAction Stop

  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Serving) { $serving = $true; break }
  }
}

if (-not $serving) {
  Show-Failure ("本地服务在 15 秒内未就绪。`n请在命令行手动检查：`n  cd /d " + $root + "`n  set ELECTRON_RUN_AS_NODE=1`n  " + $runtime + " scripts/dev-server.mjs")
  exit 1
}

if (-not $NoBrowser) { Start-Process $url }
