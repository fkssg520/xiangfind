# 起 Cloudflare 隧道：把本机 3000 端口暴露成 HTTPS 公网地址
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/tunnel-up.ps1
#   powershell ... -File scripts/tunnel-up.ps1 -Port 3000 -Name xiangfind
# 临时域名（trycloudflare.com）每次重启都会变；固定域名见 deploy/TUNNEL.md
param(
    [int]$Port = 3000,
    [string]$Name = '',
    [string]$Cloudflared = ''
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Find-Cloudflared {
    if ($Cloudflared -and (Test-Path $Cloudflared)) { return $Cloudflared }
    $candidates = @(
        (Join-Path (Split-Path -Parent $repoRoot) 'tools\cloudflared.exe'),
        (Join-Path $repoRoot 'tools\cloudflared.exe'),
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe",
        'C:\Program Files (x86)\cloudflared\cloudflared.exe'
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

Write-Host ''
Write-Host '=== 1/3 检查本机服务 ===' -ForegroundColor Cyan
$healthy = $false
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 5
    $healthy = $r.StatusCode -eq 200
    Write-Host "  /health -> $($r.StatusCode)" -ForegroundColor Green
    Write-Host "  $($r.Content)" -ForegroundColor DarkGray
} catch {
    Write-Host "  ✗ http://127.0.0.1:$Port/health 打不开" -ForegroundColor Red
}
if (-not $healthy) {
    Write-Host ''
    Write-Host '  先把服务起起来：npm start' -ForegroundColor Yellow
    Write-Host '   （隧道只负责转发，服务没起隧道也是 502）' -ForegroundColor Yellow
    exit 1
}

Write-Host ''
Write-Host '=== 2/3 找 cloudflared ===' -ForegroundColor Cyan
$exe = Find-Cloudflared
if (-not $exe) {
    Write-Host '  ✗ 没找到 cloudflared' -ForegroundColor Red
    Write-Host '  装法一：winget install --id Cloudflare.cloudflared' -ForegroundColor Yellow
    Write-Host '  装法二：下载 cloudflared-windows-amd64.exe 改名 cloudflared.exe 放到 D:\DeepseekWork\tools\' -ForegroundColor Yellow
    Write-Host '         https://github.com/cloudflare/cloudflared/releases/latest' -ForegroundColor Yellow
    exit 1
}
Write-Host "  $exe" -ForegroundColor DarkGray

Write-Host ''
Write-Host '=== 3/3 起隧道 ===' -ForegroundColor Cyan
if ($Name) {
    Write-Host "  固定隧道：$Name（地址不会变）" -ForegroundColor DarkGray
    Write-Host '  按 Ctrl+C 结束' -ForegroundColor DarkGray
    Write-Host ''
    & $exe tunnel run $Name
} else {
    Write-Host '  临时隧道（地址每次重启会变）' -ForegroundColor DarkGray
    Write-Host '  等它打印 https://xxxx.trycloudflare.com 就是公网地址' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  ⚠ 拿到地址后记得改 .env 里的 PUBLIC_BASE_URL 并重启服务，' -ForegroundColor Yellow
    Write-Host '    否则邮件里的链接会指向 localhost' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  按 Ctrl+C 结束' -ForegroundColor DarkGray
    Write-Host ''
    & $exe tunnel --url "http://127.0.0.1:$Port"
}
