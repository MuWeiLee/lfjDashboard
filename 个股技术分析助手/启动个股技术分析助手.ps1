$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCommand=Get-Command node -ErrorAction SilentlyContinue
$desktopNode=Join-Path $env:USERPROFILE 'Desktop\node-v22.18.0-win-x64\node.exe'
$nodeExe=if($nodeCommand){$nodeCommand.Source}elseif(Test-Path -LiteralPath $desktopNode){$desktopNode}else{$null}
$serverFile=Join-Path $projectRoot 'technical_analysis_server.mjs'
$url='http://127.0.0.1:8799'

if(-not $nodeExe -or -not (Test-Path -LiteralPath $nodeExe)){throw 'Node.js 运行时未找到，请安装 Node.js 18 或更高版本并加入 PATH。'}
if(-not (Test-Path -LiteralPath $serverFile)){throw '未找到技术分析后端'}

$running=$false
try{$health=Invoke-RestMethod -Uri ($url+'/api/health') -TimeoutSec 2;$running=[bool]$health.ok}catch{}
if(-not $running){
  Start-Process -FilePath $nodeExe -ArgumentList $serverFile -WorkingDirectory $projectRoot -WindowStyle Hidden
  Start-Sleep -Seconds 2
}
Start-Process $url
