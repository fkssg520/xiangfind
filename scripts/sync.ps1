# 湘寻 · 双 AI 同步脚本
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sync.ps1 -Agent lead
#       （agent-b 那台机器传 -Agent agent-b）
# 作用：只读。拉取远端、列出我的留言、我的 PR、待我评审的 PR、最新交接日志。

param(
    [ValidateSet('lead', 'agent-b')]
    [string]$Agent = 'lead'
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

function Write-Section($title) {
    Write-Host ''
    Write-Host ("=== " + $title + " " + ('=' * [Math]::Max(0, 60 - $title.Length))) -ForegroundColor Cyan
}

# ---------- 定位 gh ----------
$gh = $null
$cmd = Get-Command gh -ErrorAction SilentlyContinue
if ($cmd) {
    $gh = $cmd.Source
} elseif (Test-Path (Join-Path $repoRoot 'tools/gh/bin/gh.exe')) {
    $gh = Join-Path $repoRoot 'tools/gh/bin/gh.exe'
} elseif (Test-Path 'D:\DeepseekWork\tools\gh\bin\gh.exe') {
    $gh = 'D:\DeepseekWork\tools\gh\bin\gh.exe'
}
if (-not $gh) {
    Write-Host '未找到 gh（GitHub CLI）。安装：winget install --id GitHub.cli，或把 gh.exe 放到 tools/gh/bin/' -ForegroundColor Red
    Pop-Location
    exit 1
}

# 便携版 gh 的凭据目录（若存在则沿用）
if (-not $env:GH_CONFIG_DIR -and (Test-Path 'D:\DeepseekWork\.gh')) {
    $env:GH_CONFIG_DIR = 'D:\DeepseekWork\.gh'
}
$env:GH_NO_UPDATE_NOTIFIER = '1'

Write-Host ("湘寻 · 同步报告   身份: " + $Agent + "   时间: " + (Get-Date -Format 'yyyy-MM-dd HH:mm')) -ForegroundColor Green

# ---------- 1. Git 状态 ----------
Write-Section '1. 代码'
& git fetch --prune --quiet origin 2>$null
$branch = (& git rev-parse --abbrev-ref HEAD 2>$null)
Write-Host ("当前分支 : " + $branch)
$dirty = (& git status --porcelain 2>$null)
if ($dirty) {
    Write-Host ("未提交改动 : " + (@($dirty).Count) + " 个文件（收工前记得 commit）") -ForegroundColor Yellow
} else {
    Write-Host '未提交改动 : 无'
}
$behind = (& git rev-list --count "HEAD..origin/main" 2>$null)
if ($behind -and [int]$behind -gt 0) {
    Write-Host ("落后 main : " + $behind + " 个提交 → 先 git merge origin/main") -ForegroundColor Yellow
} else {
    Write-Host '落后 main : 无'
}

# ---------- 2. 我的留言 ----------
Write-Section ("2. 发给我的留言（label: to:" + $Agent + "）")
$label = "to:" + $Agent
$issues = & $gh issue list --label $label --state open --limit 30 --json number,title,labels,createdAt 2>$null
if ($LASTEXITCODE -eq 0 -and $issues) {
    $parsed = $issues | ConvertFrom-Json
    if (@($parsed).Count -eq 0) {
        Write-Host '没有未处理留言。' -ForegroundColor Green
    } else {
        foreach ($i in $parsed) {
            $tags = ($i.labels | ForEach-Object { $_.name }) -join ','
            $age = [Math]::Round(((Get-Date) - [datetime]$i.createdAt).TotalHours, 1)
            Write-Host ("  #" + $i.number + "  [" + $age + "h]  " + $i.title + "   (" + $tags + ")")
        }
        Write-Host ''
        Write-Host '  查看详情: ' -NoNewline
        Write-Host ("gh issue view <编号> --comments") -ForegroundColor DarkGray
    }
} else {
    Write-Host '读取失败（未登录或网络问题）。先跑：gh auth status' -ForegroundColor Red
}

# ---------- 3. 我的 PR ----------
Write-Section '3. 我的 PR'
& $gh pr list --author "@me" --state open --limit 10 2>$null

Write-Section '4. 待我评审'
& $gh pr list --search "review-requested:@me" --state open --limit 10 2>$null

# ---------- 5. 最新交接日志 ----------
Write-Section '5. 最新交接日志'
$latest = Get-ChildItem (Join-Path $repoRoot 'journal') -Filter '*.md' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if ($latest) {
    Write-Host ("文件: " + $latest.Name) -ForegroundColor DarkGray
    Get-Content $latest.FullName -Encoding UTF8 | Select-Object -First 40
} else {
    Write-Host '还没有日志。'
}

Write-Section '下一步'
Write-Host '  1) 有 to:' -NoNewline
Write-Host $Agent -NoNewline -ForegroundColor Yellow
Write-Host ' 的留言 → 逐条处理并 close'
Write-Host '  2) 分支落后 main → git merge origin/main'
Write-Host '  3) 收工：commit（带 Agent 尾注）→ push → gh pr create --fill → 写 journal'
Write-Host ''

Pop-Location
