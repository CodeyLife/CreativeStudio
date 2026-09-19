<#
.SYNOPSIS
  终端直查 novel-v2 编排状态：服务面板 → 项目列表 → 目录/工作流进度。
  不依赖 dsh 会话/GUI；读类操作，零风险。用 pwsh 运行。

.EXAMPLE
  pwsh orchestrator/dsh/status.ps1                 # 服务面板 + 全部项目概览
  pwsh orchestrator/dsh/status.ps1 -ProjectId p123 # 追加查看指定项目的弧/批次/工作流
#>
param(
  [string]$ProjectId
)

$ErrorActionPreference = 'Stop'
$mcp = 'http://127.0.0.1:7654/mcp'

function Test-Port {
  param([int]$Port)
  return [bool](Test-NetConnection 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue)
}

function Invoke-McpTool {
  param([string]$Name, [string]$ArgumentsJson = '{}')
  $body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"' + $Name + '","arguments":' + $ArgumentsJson + '}}'
  $resp = curl.exe -s --max-time 30 -X POST $mcp `
    -H 'Content-Type: application/json' `
    -H 'Accept: application/json, text/event-stream' `
    -d $body
  if ($LASTEXITCODE -ne 0) { throw "MCP 请求失败（curl exit $LASTEXITCODE）" }
  # 响应可能是 SSE（多行 data: {...}）或普通 JSON
  $dataLine = ($resp -split "`n") | Where-Object { $_ -match '^data:\s*\{' } | Select-Object -Last 1
  $jsonText = if ($dataLine) { $dataLine -replace '^data:\s*', '' } else { $resp }
  $envelope = $jsonText | ConvertFrom-Json
  if ($envelope.error) { throw "MCP error: $($envelope.error.message)" }
  $text = ($envelope.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text
  # 剥离可能的 markdown 围栏后返回
  return (($text -replace '(?s)^```(json)?\s*', '') -replace '```\s*$', '').Trim()
}

function Get-Collection {
  # 从未知形状的 JSON 中容错取出数组（根数组或常见容器键）
  param($Obj, [string[]]$Keys)
  if ($null -eq $Obj) { return $null }
  if ($Obj -is [array]) { return $obj }
  foreach ($k in $Keys) {
    $p = $Obj.PSObject.Properties[$k]
    if ($p -and $p.Value -is [array]) { return $p.Value }
  }
  return $null
}

function Show-Raw {
  param([string]$Label, [string]$Text)
  Write-Host "`n--- $Label（原始）---"
  $lines = $Text -split "`n"
  if ($lines.Count -gt 40) { ($lines | Select-Object -First 40) -join "`n"; Write-Host "…（共 $($lines.Count) 行，已截断）" }
  else { $Text }
}

# ---- 1. 服务面板 ----
Write-Host '=== novel-v2 编排状态 ==='
$services = @(
  @{ Port = 7233; Name = 'Temporal' },
  @{ Port = 4771; Name = 'novel-v2 worker' },
  @{ Port = 4770; Name = 'novel-v2 API' },
  @{ Port = 7654; Name = 'novel-v2 MCP' }
)
foreach ($s in $services) {
  $up = Test-Port $s.Port
  $mark = if ($up) { '✓' } else { '✗' }
  Write-Host ("  {0} {1,-18} :{2}" -f $mark, $s.Name, $s.Port)
}
if (-not (Test-Port 7654)) {
  Write-Host "`n✗ MCP server 未运行，无法查询项目状态。启动：npm run novel:mcp:v2:http（Temporal/worker 见 docs/orchestrator/dsh-runbook.md）" -ForegroundColor Red
  exit 1
}

try {
  # ---- 2. 项目列表 ----
  $projectsText = Invoke-McpTool 'novel_project_list'
  $projectsRaw = $projectsText | ConvertFrom-Json
  $projects = Get-Collection $projectsRaw @('projects', 'data', 'items')
  if (-not $projects) { Show-Raw 'novel_project_list' $projectsText; exit 0 }

  Write-Host "`n=== 项目 ==="
  $projects | ForEach-Object {
    $id = $_.id; $title = $_.title; $upd = $_.updatedAt
    Write-Host ("  {0}  {1}  (updated {2})" -f $id, $title, $upd)
  }

  # ---- 3. 目标项目详情 ----
  $target = if ($ProjectId) { $ProjectId } else { ($projects | Sort-Object { [datetime]$_.updatedAt } -Descending | Select-Object -First 1).id }
  if (-not $target) { exit 0 }
  Write-Host "`n=== 项目 $target ==="

  $catalogText = Invoke-McpTool 'novel_catalog_get' ('{"projectId":"' + $target + '","compact":true}')
  try {
    $catalog = $catalogText | ConvertFrom-Json
    $proj = $catalog.project
    if ($proj) {
      $genre = $proj.metadata.genre
      Write-Host ("  项目: {0}  题材: {1}" -f $proj.title, $genre)
    }
    $docs = Get-Collection $proj @('documents')
    $docs = @($docs | Where-Object { $_ })
    if ($docs.Count -gt 0) {
      $byStatus = $docs | Group-Object status | Sort-Object Name
      $summary = ($byStatus | ForEach-Object { "{0}×{1}" -f $_.Name, $_.Count }) -join ', '
      Write-Host "  章节: $summary"
    }
    $runs = Get-Collection $proj @('latestRuns')
    if ($runs) {
      Write-Host "  最近运行:"
      $runs | Select-Object -First 5 | ForEach-Object {
        $stage = $_.payload.stage
        $detail = if ($stage) { " [$stage] $($_.payload.decision)" } else { '' }
        Write-Host ("    {0,-16} {1,-10} {2}{3}" -f $_.workflowType, $_.status, $_.updatedAt, $detail)
      }
    }
    if (-not $proj) { Show-Raw 'novel_catalog_get' $catalogText }
  } catch { Show-Raw 'novel_catalog_get' $catalogText }

  $wfText = Invoke-McpTool 'novel_workflow_list' ('{"projectId":"' + $target + '","limit":8}')
  try {
    $wfRaw = $wfText | ConvertFrom-Json
    $wfs = Get-Collection $wfRaw @('runs', 'workflows', 'items')
    if ($wfs) {
      Write-Host "  最近工作流:"
      $wfs | Select-Object -First 8 | ForEach-Object {
        Write-Host ("    {0,-16} {1,-10} {2}" -f $_.workflowType, $_.status, $_.updatedAt)
      }
    } else { Show-Raw 'novel_workflow_list' $wfText }
  } catch { Show-Raw 'novel_workflow_list' $wfText }
}
catch {
  Write-Host "`n✗ 查询失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  排查见 docs/orchestrator/dsh-runbook.md「常见故障排查」'
  exit 1
}
