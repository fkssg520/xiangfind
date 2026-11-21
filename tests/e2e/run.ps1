# E2E 冒烟（Windows / 本机 Edge）
#
# 为什么不用 Playwright：装包不稳定，而 Edge 本来就在。
# 为什么用 PowerShell 而不是 Node：这台机器上 Node 起子进程被限制，PowerShell 可以。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/e2e/run.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/e2e/run.ps1 -Scenarios login,plaza
#
# 前置：应用已起在 $env:BASE（默认 http://127.0.0.1:3000），且执行过 db:migrate + db:seed。

param(
    [string[]]$Scenarios = @('login', 'plaza', 'detail', 'claim', 'publish', 'admin', 'forbidden')
)

# -File 方式传参时 "a,b" 是单个字符串，这里拆成数组
$Scenarios = @($Scenarios | ForEach-Object { $_ -split ',' } | Where-Object { $_ })

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $here)

$base = $env:BASE
if (-not $base) { $base = 'http://127.0.0.1:3000' }
$base = $base.TrimEnd('/')

$edge = $env:EDGE_PATH
if (-not $edge) { $edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }
if (-not (Test-Path $edge)) {
    Write-Host "找不到 Edge：$edge" -ForegroundColor Red
    exit 2
}

$harnessPublic = Join-Path $root 'public\__e2e-harness.html'
Copy-Item (Join-Path $here 'harness.html') $harnessPublic -Force

$profileDir = Join-Path $env:TEMP 'xf-e2e-edge'
$pass = 0
$fail = 0

Write-Host "E2E base = $base"
try {
    foreach ($name in $Scenarios) {
        # base 要一起传：harness 里的 iframe 才知道连哪个端口
        $encBase = [System.Uri]::EscapeDataString($base)
        $url = "$base/__e2e-harness.html?scenario=$name&base=$encBase"
        $dump = Join-Path $env:TEMP "e2e-$name-$PID.html"
        Remove-Item $dump -ErrorAction SilentlyContinue

        # 用 cmd 重定向拿原始输出；PowerShell 的 > 会写成 UTF-16，读回来是乱码
        $cmdLine = '"' + $edge + '" --headless=new --disable-gpu --no-first-run ' +
            '--disable-extensions --disable-crash-reporter ' +
            '--user-data-dir="' + $profileDir + '" ' +
            '--virtual-time-budget=30000 --dump-dom "' + $url + '" > "' + $dump + '" 2>nul'
        cmd /c $cmdLine

        $title = ''
        if (Test-Path $dump) {
            $body = ''
            for ($try = 0; $try -lt 8; $try++) {
                try {
                    $body = [System.IO.File]::ReadAllText($dump, [System.Text.Encoding]::UTF8)
                    break
                } catch {
                    Start-Sleep -Milliseconds 300
                }
            }
            if ($body -match '<title>RESULT:(.*?)</title>') {
                $title = $Matches[1] -replace '&quot;', '"' -replace '&amp;', '&'
            }
            Remove-Item $dump -ErrorAction SilentlyContinue
        }

        if (-not $title) {
            $fail++
            Write-Host ("  x {0}  没有拿到结果" -f $name)
            continue
        }

        $r = $null
        try { $r = $title | ConvertFrom-Json } catch { }

        $ok = $false
        if ($r -and $r.ok) {
            switch ($name) {
                'login'     { $ok = ($r.who -and $r.who -ne '登录' -and $r.hash -eq '#/plaza') }
                'plaza'     { $ok = ([int]$r.cards -gt 0) }
                'detail'    { $ok = ($r.title -and [int]$r.rows -ge 5) }
                'claim'     { $ok = ($r.modal -eq $true) -or ($r.skipped -eq $true) }
                'publish'   { $ok = ($r.moved -eq $true -and $r.title -like '*E2E*') }
                'admin'     { $ok = ($r.tabs.Count -eq 5 -and [int]$r.kpis -gt 0) }
                'forbidden' { $ok = ($r.guarded -eq $true) }
                default     { $ok = $true }
            }
        }

        if ($ok) {
            $pass++
            Write-Host ("  v {0}" -f $name) -ForegroundColor Green
        } else {
            $fail++
            Write-Host ("  x {0}  {1}" -f $name, $title) -ForegroundColor Red
        }
    }
} finally {
    Remove-Item $harnessPublic -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host ("结果：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -eq 0) { exit 0 } else { exit 1 }
