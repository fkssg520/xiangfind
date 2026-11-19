# 前端静态自检：重复声明 / 重复 id / 冲突标记 / 语法
#
# 这类问题看 diff 发现不了，但会让整个页面静默失效
# （2026-11-19 就发生过 openClaimDialog 被声明两次 → app.js 整体 SyntaxError）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/e2e/verify/check-static.ps1

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
$public = Join-Path $root 'public'

$fail = 0

function Section($title) {
    Write-Host ""
    Write-Host "=== $title ==="
}

# ---------- 1. 重复的顶层声明 ----------
Section '1. app.js 顶层声明重复'
$appJs = Join-Path $public 'app.js'
$src = [System.IO.File]::ReadAllText($appJs, [System.Text.Encoding]::UTF8)
$pattern = '(?m)^(?:const|let|var|async\s+function|function|class)\s+([A-Za-z_$][\w$]*)'
$seen = @{}
$dups = @()
foreach ($m in [regex]::Matches($src, $pattern)) {
    $name = $m.Groups[1].Value
    if ($seen.ContainsKey($name)) { $dups += $name } else { $seen[$name] = $true }
}
Write-Host ("顶层声明 {0} 个" -f $seen.Count)
if ($dups.Count -eq 0) {
    Write-Host "  重复：无" -ForegroundColor Green
} else {
    Write-Host ("  重复：{0}" -f ($dups -join ', ')) -ForegroundColor Red
    $fail++
}

# ---------- 2. 重复的 HTML id ----------
Section '2. index.html 重复 id'
$html = [System.IO.File]::ReadAllText((Join-Path $public 'index.html'), [System.Text.Encoding]::UTF8)
$idSeen = @{}
$idDups = @()
foreach ($m in [regex]::Matches($html, '\sid="([^"]+)"')) {
    $id = $m.Groups[1].Value
    if ($idSeen.ContainsKey($id)) { $idDups += $id } else { $idSeen[$id] = $true }
}
Write-Host ("id {0} 个" -f $idSeen.Count)
if ($idDups.Count -eq 0) {
    Write-Host "  重复：无" -ForegroundColor Green
} else {
    Write-Host ("  重复：{0}" -f ($idDups -join ', ')) -ForegroundColor Red
    $fail++
}

# ---------- 3. 冲突标记残留 ----------
Section '3. 冲突标记残留'
$markerRe = '(?m)^(<{7}|={7}|>{7})'
$found = @()
foreach ($f in @('app.js', 'index.html', 'styles.css')) {
    $text = [System.IO.File]::ReadAllText((Join-Path $public $f), [System.Text.Encoding]::UTF8)
    if ($text -match $markerRe) { $found += $f }
}
if ($found.Count -eq 0) {
    Write-Host "  无残留" -ForegroundColor Green
} else {
    Write-Host ("  有残留：{0}" -f ($found -join ', ')) -ForegroundColor Red
    $fail++
}

# ---------- 4. CSS 花括号配平 ----------
Section '4. styles.css 花括号配平'
$css = [System.IO.File]::ReadAllText((Join-Path $public 'styles.css'), [System.Text.Encoding]::UTF8)
$depth = 0
$bad = 0
foreach ($ch in $css.ToCharArray()) {
    if ($ch -eq '{') { $depth++ }
    elseif ($ch -eq '}') { $depth--; if ($depth -lt 0) { $bad++ } }
}
Write-Host ("结束深度 {0}，异常 {1}" -f $depth, $bad)
if ($depth -eq 0 -and $bad -eq 0) {
    Write-Host "  配平" -ForegroundColor Green
} else {
    Write-Host "  不配平" -ForegroundColor Red
    $fail++
}

# ---------- 5. JS 语法 ----------
Section '5. app.js 语法（node --check）'
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
    Write-Host "  跳过：PATH 里没有 node" -ForegroundColor Yellow
} else {
    & node --check $appJs 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  通过" -ForegroundColor Green
    } else {
        Write-Host "  语法错误" -ForegroundColor Red
        & node --check $appJs
        $fail++
    }
}

Write-Host ""
if ($fail -eq 0) {
    Write-Host "结论：全部通过" -ForegroundColor Green
    exit 0
}
Write-Host ("结论：{0} 项有问题" -f $fail) -ForegroundColor Red
exit 1
