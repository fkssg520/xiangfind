# 备份：SQLite 数据库 + 上传目录 + .env（配置单独存）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup.ps1
# 保留策略：最近 7 个日备份 + 4 个周备份（周日算周备份）
param(
    [string]$BackupRoot = '',
    [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

if (-not $BackupRoot) {
    $BackupRoot = Join-Path (Split-Path -Parent $repoRoot) 'xiangfind-backups'
}
$dailyDir = Join-Path $BackupRoot 'daily'
$weeklyDir = Join-Path $BackupRoot 'weekly'
New-Item -ItemType Directory -Force -Path $dailyDir, $weeklyDir | Out-Null

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$isSunday = (Get-Date).DayOfWeek -eq 'Sunday'
$targetDir = if ($isSunday) { $weeklyDir } else { $dailyDir }
$archive = Join-Path $targetDir "xiangfind-$stamp.zip"

# 要备份的路径
$dbPath = if ($env:DATABASE_PATH) { $env:DATABASE_PATH } else { Join-Path $repoRoot 'data/xiangfind.db' }
$uploadDir = if ($env:UPLOAD_DIR) { $env:UPLOAD_DIR } else { Join-Path $repoRoot 'uploads' }
$envFile = Join-Path $repoRoot '.env'

# 暂存目录
$stage = Join-Path $env:TEMP "xiangfind-backup-$stamp"
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$ok = $true
try {
    # 1) 数据库：用 sqlite 的 VACUUM INTO 做一致性快照（不用停服务）
    if (Test-Path $dbPath) {
        $snapshot = Join-Path $stage 'xiangfind.db'
        & node (Join-Path $PSScriptRoot 'db-snapshot.mjs') $dbPath $snapshot 2>&1 | Out-Null
        if (-not (Test-Path $snapshot)) {
            Copy-Item $dbPath $snapshot -Force
            if (-not $Quiet) { Write-Host '  （快照失败，已退化为文件复制——若库正在写入，副本可能不一致）' -ForegroundColor Yellow }
        } elseif (-not $Quiet) {
            Write-Host '  数据库快照：VACUUM INTO（一致）' -ForegroundColor DarkGray
        }
        if (-not $Quiet) { Write-Host ("  数据库   {0:N1} MB" -f ((Get-Item $snapshot).Length / 1MB)) }
    } else {
        Write-Host "  警告：数据库不存在 $dbPath" -ForegroundColor Yellow
        $ok = $false
    }

    # 2) 上传目录
    if (Test-Path $uploadDir) {
        $uploadCount = @(Get-ChildItem $uploadDir -File -ErrorAction SilentlyContinue).Count
        Copy-Item $uploadDir (Join-Path $stage 'uploads') -Recurse -Force -ErrorAction SilentlyContinue
        if (-not $Quiet) { Write-Host "  上传目录 $uploadCount 个文件" }
    }

    # 3) .env（单独加密存放，不打进主备份）
    if (Test-Path $envFile) {
        $envBackup = Join-Path $BackupRoot "env-$stamp.txt"
        Copy-Item $envFile $envBackup -Force
        if (-not $Quiet) { Write-Host "  .env     -> $envBackup（请自行加密保管）" -ForegroundColor Yellow }
    }

    # 4) 打包
    if ($ok) {
        Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force
        $size = (Get-Item $archive).Length / 1MB
        if (-not $Quiet) {
            Write-Host ("  备份完成 {0}  {1:N1} MB" -f $archive, $size) -ForegroundColor Green
        }
    }
} finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

# 5) 轮转：日备份留 7 个，周备份留 4 个
function Trim-Backups($dir, $keep) {
    $files = Get-ChildItem $dir -Filter '*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    if (@($files).Count -gt $keep) {
        $files | Select-Object -Skip $keep | ForEach-Object {
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            if (-not $Quiet) { Write-Host "  清理旧备份 $($_.Name)" -ForegroundColor DarkGray }
        }
    }
}
Trim-Backups $dailyDir 7
Trim-Backups $weeklyDir 4

# 6) 结果摘要（给 cron/计划任务看）
if ($ok) {
    Write-Host "BACKUP_OK $archive"
    Pop-Location
    exit 0
} else {
    Write-Host 'BACKUP_FAILED' -ForegroundColor Red
    Pop-Location
    exit 1
}
