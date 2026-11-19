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
    @{ name = 'admin';    file = 'scripts/smoke-admin.mjs';    port = 3127 }
)

$results = @()

foreach ($s in $suites) {
    $dbName = "data\/smoke-$($s.name).db"
    $dbPath = Join-Path $repoRoot "data/smoke-$($s.name).db"
    $logPath = Join-Path $repoRoot "smoke-$($s.name).log"
    Remove-Item "$dbPath*" -Force -ErrorAction SilentlyContinue
    Remove-Item $logPath -Force -ErrorAction SilentlyContinue
    if (Test-Path (Join-Path $repoRoot 'uploads')) {
        Get-ChildItem (Join-Path $repoRoot 'uploads') -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    }

    $env:DATABASE_PATH = $dbPath
    $env:PORT = "$($s.port)"
    $env:SESSION_SECRET = 'smoke'
    $env:REGISTER_LIMIT_PER_HOUR = '100'
    $env:UPLOAD_DIR = (Join-Path $repoRoot 'uploads')

    & node src/db/migrate.js 2>&1 | Out-Null
    & node src/db/seed.js 2>&1 | Out-Null

    $proc = Start-Process -FilePath 'node' -ArgumentList 'src/server.js' `
        -WorkingDirectory $repoRoot -WindowStyle Hidden `
        -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err" -PassThru
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
Get-ChildItem (Join-Path $repoRoot 'data') -Filter 'smoke-*.db*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $repoRoot -Filter 'smoke-*.log*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem (Join-Path $repoRoot 'uploads') -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

Pop-Location
