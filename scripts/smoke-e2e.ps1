# 一键跑浏览器端到端测试：起服务 → 跑 E2E → 收摊
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-e2e.ps1
#   powershell ... -File scripts/smoke-e2e.ps1 -Port 3300 -Scenarios login,admin
#
# 说明：
# - 会用一个独立数据库 data/e2e-smoke.db，不碰你的开发库
# - 需要本机有 Edge（默认路径 C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe）
# - 在受限沙箱里跑不了（浏览器无法创建 IPC 通道），会明确报出来而不是假装通过
param(
    [int]$Port = 3300,
    [string]$Scenarios = '',
    [switch]$KeepDb
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) {
    $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
}
if (-not (Test-Path $edge)) {
    Write-Host '✗ 找不到 Edge，无法跑 E2E' -ForegroundColor Red
    Write-Host '  这个脚本用本机 Edge 无头模式，不下载浏览器' -ForegroundColor Yellow
    Pop-Location
    exit 2
}

$dbPath = Join-Path $repoRoot 'data/e2e-smoke.db'
$logPath = Join-Path $repoRoot 'e2e-smoke.log'

Write-Host ''
Write-Host '=== 1/4 准备独立数据库 ===' -ForegroundColor Cyan
Remove-Item "$dbPath*" -Force -ErrorAction SilentlyContinue
$env:DATABASE_PATH = $dbPath
$env:PORT = "$Port"
$env:SESSION_SECRET = 'e2e-smoke'
$env:REGISTER_LIMIT_PER_HOUR = '100'
$env:UPLOAD_DIR = (Join-Path $repoRoot 'uploads')

& node src/db/migrate.js 2>&1 | Out-Null
& node src/db/seed.js 2>&1 | Out-Null
Write-Host "  $dbPath" -ForegroundColor DarkGray

Write-Host ''
Write-Host '=== 2/4 起服务 ===' -ForegroundColor Cyan
$proc = Start-Process -FilePath 'node' -ArgumentList 'src/server.js' -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err" -PassThru
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
}
if (-not $ready) {
    Write-Host "  ✗ 服务没起来，看 $logPath" -ForegroundColor Red
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Pop-Location
    exit 1
}
Write-Host "  http://127.0.0.1:$Port 就绪" -ForegroundColor DarkGray

Write-Host ''
Write-Host '=== 3/4 跑 E2E ===' -ForegroundColor Cyan
$env:BASE = "http://127.0.0.1:$Port"
$e2eArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repoRoot 'tests/e2e/run.ps1'))
if ($Scenarios) { $e2eArgs += @('-Scenarios', $Scenarios) }
$out = & powershell @e2eArgs 2>&1
$out | ForEach-Object { Write-Host $_ }
$code = $LASTEXITCODE

Write-Host ''
Write-Host '=== 4/4 收摊 ===' -ForegroundColor Cyan
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
if (-not $KeepDb) {
    Remove-Item "$dbPath*" -Force -ErrorAction SilentlyContinue
    Remove-Item $logPath, "$logPath.err" -Force -ErrorAction SilentlyContinue
    # E2E 会把 harness 临时拷进 public/，跑完要清掉
    Get-ChildItem (Join-Path $repoRoot 'public') -Filter '__e2e*' -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
    Write-Host '  已清理临时数据库与日志' -ForegroundColor DarkGray
}

# 沙箱里浏览器起不来时，给出可操作的提示而不是让人瞎猜
if ($code -ne 0) {
    $joined = ($out | Out-String)
    $browserBroken = $joined -match 'mojo|crashpad|拒绝访问|Access is denied|没有拿到结果'
    if ($browserBroken) {
        Write-Host ''
        Write-Host '  可能原因：浏览器没能启动（受限环境下 Edge 无法创建 IPC 通道）。' -ForegroundColor Yellow
        Write-Host '  怎么确认：手动跑一次看有没有 mojo/crashpad 报错——' -ForegroundColor Yellow
        Write-Host "    & `"$edge`" --headless=new --dump-dom about:blank" -ForegroundColor DarkGray
        Write-Host '  这不是用例失败：换到普通终端（不受限）再跑本脚本。' -ForegroundColor Yellow
    }
}

Pop-Location
if ($code -eq 0) { Write-Host 'E2E_OK' -ForegroundColor Green } else { Write-Host 'E2E_FAILED' -ForegroundColor Red }
exit $code
