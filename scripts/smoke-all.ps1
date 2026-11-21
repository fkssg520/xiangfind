# 跑全部冒烟：每个套件独立数据库 + 独立端口，互不污染
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-all.ps1
$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

$suites = @(
    @{ name = 'auth';     file = 'scripts/smoke-auth.mjs';     port = 3121 },
    @{ name = 'items';    file = 'scripts/smoke-items.mjs';    port = 3122 },
    @{ name = 'uploads';  file = 'scripts/smoke-uploads.mjs';  port = 3123 },
    @{ name = 'matching'; file = 'scripts/smoke-matching.mjs'; port = 3124 },
    @{ name = 'claims';   file = 'scripts/smoke-claims.mjs';   port = 3125 },
    @{ name = 'gaps';     file = 'scripts/smoke-gaps.mjs';     port = 3126 },
    @{ name = 'admin';    file = 'scripts/smoke-admin.mjs';    port = 3127 },
    @{ name = 'rate';     file = 'scripts/smoke-rate.mjs';     port = 3128 }
)

$results = @()

# 0) 前端 DOM 契约（不需要起服务）
Write-Host ''
Write-Host '===== dom =====' -ForegroundColor Cyan
$domOut = & node scripts/check-dom.mjs 2>&1
$domOut | ForEach-Object { Write-Host $_ }
$domLine = ($domOut | Select-String -Pattern '^结果：').Line
$results += [pscustomobject]@{ 套件 = 'dom'; 结果 = $domLine }

# 0.5) 契约漂移（文档 vs 实现）
Write-Host ''
Write-Host '===== contract =====' -ForegroundColor Cyan
$cOut = & node scripts/check-contract.mjs 2>&1
$cOut | ForEach-Object { Write-Host $_ }
$cLine = ($cOut | Select-String -Pattern '^结果：').Line
$results += [pscustomobject]@{ 套件 = 'contract'; 结果 = $cLine }

# 0.7) 交付前安全自检（密钥泄漏 / 真实个人信息）
Write-Host ''
Write-Host '===== secrets =====' -ForegroundColor Cyan
$sOut = & node scripts/check-secrets.mjs 2>&1
$sOut | ForEach-Object { Write-Host $_ }
$sLine = ($sOut | Select-String -Pattern '^结果：').Line
$results += [pscustomobject]@{ 套件 = 'secrets'; 结果 = $sLine }

# 0.8) 前端调用的接口是否都存在（打错一个字 = 运行时才炸）
Write-Host ''
Write-Host '===== frontapi =====' -ForegroundColor Cyan
$fOut = & node scripts/check-frontend-api.mjs 2>&1
$fOut | ForEach-Object { Write-Host $_ }
$fLine = ($fOut | Select-String -Pattern '^结果：').Line
$results += [pscustomobject]@{ 套件 = 'frontapi'; 结果 = $fLine }

# 0.9) 前端函数引用（调用不存在的函数 = 浏览器里 ReferenceError）
Write-Host ''
Write-Host '===== frontrefs =====' -ForegroundColor Cyan
$rOut = & node scripts/check-frontend-refs.mjs 2>&1
$rOut | ForEach-Object { Write-Host $_ }
$rLine = ($rOut | Select-String -Pattern '^结果：').Line
$results += [pscustomobject]@{ 套件 = 'frontrefs'; 结果 = $rLine }

# 1.0) 前端能力覆盖（需求 → 前端是否真的调用；防「后端有、前端没接」）
Write-Host ''
Write-Host '===== frontcov =====' -ForegroundColor Cyan
$vOut = & node scripts/check-frontend-coverage.mjs 2>&1
$vOut | ForEach-Object { Write-Host $_ }
$vLine = ($vOut | Select-String -Pattern '^结果：').Line
$results += [pscustomobject]@{ 套件 = 'frontcov'; 结果 = $vLine }

foreach ($s in $suites) {
    $dbPath = Join-Path $repoRoot "data/smoke-$($s.name).db"
    $logPath = Join-Path $repoRoot "smoke-$($s.name).log"

    Remove-Item "$dbPath*" -Force -ErrorAction SilentlyContinue
    Remove-Item $logPath -Force -ErrorAction SilentlyContinue
    if (Test-Path (Join-Path $repoRoot 'uploads')) {
        Get-ChildItem (Join-Path $repoRoot 'uploads') -File -ErrorAction SilentlyContinue |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }

    $env:DATABASE_PATH = $dbPath
    $env:PORT = "$($s.port)"
    $env:SESSION_SECRET = 'smoke'
    $env:REGISTER_LIMIT_PER_HOUR = '100'
    $env:UPLOAD_DIR = (Join-Path $repoRoot 'uploads')

    & node src/db/migrate.js 2>&1 | Out-Null
    & node src/db/seed.js 2>&1 | Out-Null

    $errPath = "$logPath.err"
    $proc = Start-Process -FilePath 'node' -ArgumentList 'src/server.js' -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errPath -PassThru
    Start-Sleep -Seconds 2

    Write-Host ''
    Write-Host "===== $($s.name) =====" -ForegroundColor Cyan
    $out = & node $s.file "http://127.0.0.1:$($s.port)" $logPath 2>&1
    $out | ForEach-Object { Write-Host $_ }

    $line = ($out | Select-String -Pattern '^结果：').Line
    $results += [pscustomobject]@{ 套件 = $s.name; 结果 = $line }

    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

Write-Host ''
Write-Host '===== 汇总 =====' -ForegroundColor Cyan
$results | Format-Table -AutoSize | Out-String -Width 100 | Write-Host

# 清理临时产物
Get-ChildItem (Join-Path $repoRoot 'data') -Filter 'smoke-*.db*' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $repoRoot -Filter 'smoke-*.log*' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem (Join-Path $repoRoot 'uploads') -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

Pop-Location
