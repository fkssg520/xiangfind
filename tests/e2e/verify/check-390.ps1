# A-07 复验：390px 横向溢出
#
# 用无头 Edge 打开 probe-390.html（临时拷进 public/ 保证同源），
# 依次切 12 个路由，记录 documentElement.scrollWidth，输出可直接粘贴的表格。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/e2e/verify/check-390.ps1
#   powershell ... -File check-390.ps1 -Base http://127.0.0.1:3001
#
# 前置：应用已起在 -Base（默认 http://127.0.0.1:3000），且已 db:seed。

param(
    [string]$Base
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))

if (-not $Base) {
    $Base = $env:BASE
    if (-not $Base) { $Base = 'http://127.0.0.1:3000' }
}
$Base = $Base.TrimEnd('/')

$edge = $env:EDGE_PATH
if (-not $edge) { $edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }
if (-not (Test-Path $edge)) {
    Write-Host "找不到 Edge：$edge" -ForegroundColor Red
    exit 2
}

$probeName = '__verify-390.html'
$probePublic = Join-Path $root "public\$probeName"
Copy-Item (Join-Path $here 'probe-390.html') $probePublic -Force

$profileDir = Join-Path $env:TEMP 'xf-verify-390'
$dump = Join-Path $env:TEMP "verify-390-$PID.html"

try {
    $encBase = [System.Uri]::EscapeDataString($Base)
    $url = "$Base/$probeName`?base=$encBase"

    $cmdLine = '"' + $edge + '" --headless=new --disable-gpu --no-first-run ' +
        '--disable-extensions --disable-crash-reporter ' +
        '--user-data-dir="' + $profileDir + '" ' +
        '--virtual-time-budget=40000 --dump-dom "' + $url + '" > "' + $dump + '" 2>nul'
    cmd /c $cmdLine

    $body = ''
    for ($i = 0; $i -lt 8; $i++) {
        try { $body = [System.IO.File]::ReadAllText($dump, [System.Text.Encoding]::UTF8); break }
        catch { Start-Sleep -Milliseconds 300 }
    }

    if ($body -notmatch '<title>RESULT:(.*?)</title>') {
        Write-Host "没有拿到结果，检查应用是否在 $Base 运行" -ForegroundColor Red
        exit 1
    }

    $json = $Matches[1] -replace '&quot;', '"' -replace '&amp;', '&'
    $r = $json | ConvertFrom-Json

    Write-Host ""
    Write-Host ("视口宽度：{0}px   路由数：{1}" -f $r.vw, $r.rows.Count)
    Write-Host ""
    Write-Host "| 路由 | scrollWidth | 溢出 |"
    Write-Host "|---|---|---|"

    $bad = 0
    foreach ($row in $r.rows) {
        $flag = if ($row.overflow) { '**溢出**' } else { '否' }
        if ($row.overflow) { $bad++ }
        Write-Host ("| ``{0}`` | {1} | {2} |" -f $row.route, $row.scrollW, $flag)
    }

    Write-Host ""
    if ($bad -eq 0) {
        Write-Host ("结论：{0} 个路由全部无横向溢出（A-07 通过）" -f $r.rows.Count) -ForegroundColor Green
        exit 0
    }

    Write-Host ("结论：{0} 个路由存在横向溢出" -f $bad) -ForegroundColor Red
    exit 1
} finally {
    Remove-Item $probePublic -ErrorAction SilentlyContinue
    Remove-Item $dump -ErrorAction SilentlyContinue
}
