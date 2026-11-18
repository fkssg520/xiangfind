# 一键推送：自动处理本机的 SSH 走 443 问题
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/push.ps1
#       powershell -NoProfile -ExecutionPolicy Bypass -File scripts/push.ps1 -Branch b/ui-shell
param(
    [string]$Branch = ''
)

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

# 本机 ssh 包装（不存在则用系统默认 ssh，其他机器不受影响）
$wrapper = 'D:\DeepseekWork\.gh\sshwrap.cmd'
if ((Test-Path $wrapper) -and -not $env:GIT_SSH) {
    $env:GIT_SSH = $wrapper
    Write-Host "已启用 SSH/443 包装：$wrapper" -ForegroundColor DarkGray
}

if ($Branch) {
    & git push -u origin $Branch
} else {
    & git push
}

if ($LASTEXITCODE -eq 0) {
    $head = (& git rev-parse --short HEAD)
    Write-Host "✓ 推送成功：$head" -ForegroundColor Green
} else {
    Write-Host "✗ 推送失败（退出码 $LASTEXITCODE）" -ForegroundColor Red
    Write-Host "排查见 D:\DeepseekWork\PUSH-NOTES.md" -ForegroundColor DarkGray
}

Pop-Location
exit $LASTEXITCODE
