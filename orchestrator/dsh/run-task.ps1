<#
.SYNOPSIS
  dsh 编排任务启动器：预检依赖 → 后台启动 headless 编排 → 输出进度查看方式。

.DESCRIPTION
  用 pwsh 运行。示例：

    # 默认主路由 gpt-relay，启动后立即跟随日志（Ctrl+C 只退出跟随，不影响任务）
    pwsh orchestrator/dsh/run-task.ps1 -Task "自主推进小说《xxx》，推进第一个故事弧到定稿" -Watch

    # 切换备用路由 glm-relay（自动校验 stream-bridge:17890 与 GLM_RELAY_API_KEY）
    pwsh orchestrator/dsh/run-task.ps1 -Task "..." -Model glm

    # 续接历史会话 / 查看可续接会话
    pwsh orchestrator/dsh/run-task.ps1 -Task "继续推进" -Session <session-id>
    pwsh orchestrator/dsh/run-task.ps1 -ListSessions

    # 只打印将执行的命令，不真正启动（检查配置用）
    pwsh orchestrator/dsh/run-task.ps1 -Task "..." -DryRun

  模型路由由 patches/model-*.patch.yml 选择层决定；新增路由 = 在 cordis.patch.yml
  加 provider 声明 + 新增一个 model patch 文件，本脚本无需改动。
  日志落在 .logs/orchestrator/（.logs/ 已被 .gitignore 忽略）。
#>
param(
  [string]$Task,
  [ValidateSet('gpt', 'glm')]
  [string]$Model = 'gpt',
  [string]$Session,
  [string]$ApiKey,
  [string]$Name,
  [switch]$Watch,
  [switch]$ListSessions,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptDir)
$logDir = Join-Path $repoRoot '.logs\orchestrator'

function Test-Port {
  param([int]$Port)
  return [bool](Test-NetConnection 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue)
}

function Fail {
  param([string]$Message)
  Write-Host "✗ $Message" -ForegroundColor Red
  exit 1
}

# ---- 会话列表模式 ----
if ($ListSessions) {
  $sessionsRoot = Join-Path $env:USERPROFILE '.dsh\sessions'
  if (-not (Test-Path $sessionsRoot)) { Write-Host '（未找到会话目录）'; exit 0 }
  Write-Host "最近会话文件（--resume 用的会话 id 以 dsh 启动/结束输出为准）：`n"
  Get-ChildItem $sessionsRoot -Recurse -File -Depth 3 -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 12 |
    ForEach-Object { '{0}  {1}' -f $_.LastWriteTime.ToString('MM-dd HH:mm'), $_.FullName }
  exit 0
}

if (-not $Task) {
  Write-Host '用法: run-task.ps1 -Task "<任务描述>" [-Model gpt|glm] [-Session <id>] [-Name <标记>] [-ApiKey <key>] [-Watch] [-DryRun]'
  Write-Host '      run-task.ps1 -ListSessions   查看最近会话'
  exit 1
}

# ---- 模型路由与密钥（DryRun 跳过预检，允许无凭据检查配置）----
$dry = [bool]$DryRun
$keyEnvName = if ($Model -eq 'gpt') { 'GPT_RELAY_API_KEY' } else { 'GLM_RELAY_API_KEY' }
if ($ApiKey) {
  Set-Item -Path "env:$keyEnvName" -Value $ApiKey
  Write-Host "✓ 已为本次运行设置 $keyEnvName"
}
if (-not $dry -and -not (Test-Path "env:$keyEnvName")) {
  Fail "缺少 $keyEnvName（模型路由 $Model）。先 `$env:$keyEnvName = '<key>'，或用 -ApiKey 传入（不落盘）。"
}

if (-not $dry -and $Model -eq 'glm') {
  if (-not (Test-Port 17890)) {
    Fail 'glm-relay 必须经 stream-bridge（127.0.0.1:17890）。先运行: node orchestrator/dsh/stream-bridge.mjs'
  }
}

# ---- 服务依赖预检 ----
if ($dry) {
  Write-Host '[DryRun] 跳过端口与密钥预检'
}
else {
if (-not (Test-Port 7654)) {
  Fail 'novel-v2 MCP server 未运行（7654）。先运行: npm run novel:mcp:v2:http'
}
if (-not (Test-Port 7233)) {
  Write-Host '⚠ Temporal server 未运行（7233）——章节生成/审校等 workflow 类任务会失败（Docker: creative-studio-temporal-1）' -ForegroundColor Yellow
}
if (-not (Test-Port 4771)) {
  Write-Host '⚠ novel-v2 worker 未运行（4771）——生成类任务会失败。先运行: npm run novel:v2:worker' -ForegroundColor Yellow
}
if (-not (Test-Port 4770)) {
  Write-Host 'ℹ novel-v2 API 未运行（4770）——仅影响短剧产物 REST 读回' -ForegroundColor DarkGray
}
}

# ---- 组装启动脚本 ----
$patchBase = Join-Path $scriptDir 'cordis.patch.yml'
$routeId = if ($Model -eq 'gpt') { 'gpt-relay' } else { 'glm-relay' }
$patchModel = Join-Path $scriptDir "patches\model-$routeId.patch.yml"
foreach ($p in @($patchBase, $patchModel)) {
  if (-not (Test-Path $p)) { Fail "缺少 patch 文件: $p" }
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$slug = if ($Name) { $Name } else { ($Task -replace '\s+', ' ').Trim() }
$slug = ($slug -replace '[^\p{L}\p{N}_-]+', '-').Trim('-')
if ($slug.Length -gt 40) { $slug = $slug.Substring(0, 40) }
$logPath = Join-Path $logDir "$stamp-$Model-$slug.log"
$errPath = "$logPath.err"
$pidPath = "$logPath.pid"
$runPath = Join-Path $logDir "$stamp-$Model-$slug.run.ps1"

# 任务文本用单引号包裹（内部单引号翻倍转义），避免 $ 变量展开与引号断裂
$taskEsc = $Task.Replace("'", "''")
$sessionArg = ''
if ($Session) { $sessionArg = " --resume '$($Session.Replace("'", "''"))'" }
$bootLine = "dsh --profile headless --patch '$patchBase' --patch '$patchModel'$sessionArg '$taskEsc'"
Set-Content -Path $runPath -Value $bootLine -Encoding UTF8

$label = if ($Model -eq 'gpt') { 'gpt-relay / gpt-5.6-sol' } else { 'glm-relay / glm-5.2（经 stream-bridge）' }

if ($DryRun) {
  Write-Host "`n[DryRun] 启动脚本: $runPath"
  Write-Host "[DryRun] 内容:   $bootLine"
  Write-Host "[DryRun] 日志:   $logPath"
  exit 0
}

# ---- 后台启动（独立进程，关掉当前窗口不影响任务）----
$proc = Start-Process -FilePath 'pwsh' `
  -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runPath) `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $logPath -RedirectStandardError $errPath
Set-Content -Path $pidPath -Value $proc.Id

Write-Host ''
Write-Host "✓ 任务已启动  PID=$($proc.Id)  路由=$label" -ForegroundColor Green
Write-Host "  日志:     $logPath（错误输出: $errPath）"
Write-Host "  跟随进度: Get-Content '$logPath' -Wait -Tail 40"
Write-Host '  停止跟随: Ctrl+C（不影响任务本身）'
Write-Host "  判断结束: Get-Process -Id $($proc.Id)  → 找不到进程即已退出，日志末尾为最终结果"
if ($Watch) {
  Write-Host "`n--- 跟随日志（Ctrl+C 退出跟随）---`n"
  Get-Content $logPath -Wait -Tail 40
}
