# 备份恢复演练（验收项 A-08）
# 做三件事：备份 → 解压到临时目录 → 逐表比对行数，确认备份可用
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore-drill.ps1
$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

$drill = Join-Path (Split-Path -Parent $repoRoot) 'xiangfind-drill'
Remove-Item $drill -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $drill | Out-Null

$dbPath = if ($env:DATABASE_PATH) { $env:DATABASE_PATH } else { Join-Path $repoRoot 'data/xiangfind.db' }
if (-not (Test-Path $dbPath)) {
    Write-Host "找不到数据库：$dbPath" -ForegroundColor Red
    Write-Host "先跑：npm run db:migrate && npm run db:seed" -ForegroundColor Yellow
    Pop-Location
    exit 1
}

Write-Host ''
Write-Host '=== 1/3 生成备份 ===' -ForegroundColor Cyan
$env:DATABASE_PATH = $dbPath
$backupOut = & powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup.ps1 -BackupRoot $drill 2>&1
$backupOut | ForEach-Object { Write-Host $_ }
$zip = Get-ChildItem $drill -Recurse -Filter '*.zip' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $zip) {
    Write-Host '✗ 没有生成备份文件' -ForegroundColor Red
    Pop-Location
    exit 1
}
Write-Host "  备份文件：$($zip.FullName)" -ForegroundColor DarkGray

Write-Host ''
Write-Host '=== 2/3 解压（模拟从备份恢复）===' -ForegroundColor Cyan
$extract = Join-Path $drill 'restored'
Expand-Archive -Path $zip.FullName -DestinationPath $extract -Force
$restoredDb = Join-Path $extract 'xiangfind.db'
if (-not (Test-Path $restoredDb)) {
    Write-Host '✗ 备份里没有 xiangfind.db' -ForegroundColor Red
    Pop-Location
    exit 1
}
Write-Host ("  已解压：{0:N1} MB" -f ((Get-Item $restoredDb).Length / 1MB)) -ForegroundColor DarkGray

Write-Host ''
Write-Host '=== 3/3 逐表比对行数 ===' -ForegroundColor Cyan

$compare = @'
import { DatabaseSync } from 'node:sqlite';
const [live, restored] = process.argv.slice(2);
const TABLES = ['users','items','claims','messages','matches','favorites','item_images','storage_points','volunteer_assignments','audit_logs','sessions','email_tokens'];
const open = (p) => new DatabaseSync(p, { readOnly: true });
const a = open(live); const b = open(restored);
let fail = 0;
for (const t of TABLES) {
  let ca = 0, cb = 0;
  try { ca = a.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; } catch { ca = -1; }
  try { cb = b.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; } catch { cb = -1; }
  const ok = ca === cb;
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${t.padEnd(22)} 线上 ${String(ca).padStart(5)}  备份 ${String(cb).padStart(5)}`);
}
a.close(); b.close();
console.log(fail === 0 ? 'RESTORE_OK' : `RESTORE_FAILED(${fail})`);
process.exit(fail === 0 ? 0 : 1);
'@
$comparePath = Join-Path $drill 'compare.mjs'
[System.IO.File]::WriteAllText($comparePath, $compare, (New-Object System.Text.UTF8Encoding($false)))

& node $comparePath $dbPath $restoredDb
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) {
    Write-Host '=== 演练通过：备份与线上数据逐表一致 ===' -ForegroundColor Green
    Write-Host "  临时文件在 $drill，确认后可以删" -ForegroundColor DarkGray
} else {
    Write-Host '=== 演练失败：备份与线上数据不一致，A-08 不能勾 ===' -ForegroundColor Red
}

Pop-Location
exit $code
