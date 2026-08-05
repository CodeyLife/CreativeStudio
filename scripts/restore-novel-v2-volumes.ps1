[CmdletBinding()]
param(
  [string]$SourcePrefix = "web",
  [string]$TargetPrefix = "creative_studio_novel",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$volumeMap = [ordered]@{
  postgres  = "ymcp-postgres"
  minio     = "ymcp-minio"
  qdrant    = "ymcp-qdrant"
  tei_cache = "ymcp-tei-cache"
}

function Invoke-Docker {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  $output = & docker @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "docker $($Arguments -join ' ') failed:`n$($output -join "`n")"
  }
  return @($output)
}

function Test-VolumeExists([string]$Name) {
  $volumes = Invoke-Docker volume ls --format "{{.Name}}"
  return $volumes -contains $Name
}

function Get-RunningMounts([string]$Name) {
  return @(Invoke-Docker ps --filter "volume=$Name" --format "{{.Names}}") | Where-Object { $_ }
}

function Test-VolumeEmpty([string]$Name) {
  $firstEntry = Invoke-Docker run --rm --mount "type=volume,src=$Name,dst=/data,readonly" alpine:latest sh -c "find /data -mindepth 1 -print -quit"
  return $firstEntry.Count -eq 0 -or -not ($firstEntry -join "").Trim()
}

function Get-VolumeStats([string]$Name) {
  $result = Invoke-Docker run --rm --mount "type=volume,src=$Name,dst=/data,readonly" alpine:latest sh -c "printf 'files='; find /data -mindepth 1 | wc -l; printf 'kib='; du -sk /data | cut -f1"
  return ($result -join " ").Trim()
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "docker command was not found"
}

$operations = foreach ($entry in $volumeMap.GetEnumerator()) {
  $source = "${SourcePrefix}_$($entry.Value)"
  $target = "${TargetPrefix}_$($entry.Key)"

  if (-not (Test-VolumeExists $source)) {
    throw "Source volume does not exist: $source"
  }

  $running = @((Get-RunningMounts $source) + (Get-RunningMounts $target)) | Sort-Object -Unique
  if ($running.Count -gt 0) {
    throw "Volume $source or $target is mounted by running containers: $($running -join ', '). Stop all writers before cloning."
  }

  $targetExists = Test-VolumeExists $target
  if ($targetExists -and -not (Test-VolumeEmpty $target)) {
    throw "Target volume is not empty: $target. This script never overwrites restored data."
  }

  [pscustomobject]@{
    Kind = $entry.Key
    Source = $source
    Target = $target
    TargetExists = $targetExists
    SourceStats = Get-VolumeStats $source
  }
}

$operations | Format-Table Kind, Source, Target, TargetExists, SourceStats -AutoSize
if ($DryRun) {
  Write-Host "Dry run complete. No volumes were created or modified."
  exit 0
}

foreach ($operation in $operations) {
  if (-not $operation.TargetExists) {
    Invoke-Docker volume create --label "com.creativestudio.novel.role=$($operation.Kind)" --label "com.creativestudio.novel.source=$($operation.Source)" $operation.Target | Out-Null
  }

  Write-Host "Cloning $($operation.Source) -> $($operation.Target)"
  Invoke-Docker run --rm `
    --mount "type=volume,src=$($operation.Source),dst=/source,readonly" `
    --mount "type=volume,src=$($operation.Target),dst=/target" `
    alpine:latest sh -c "cd /source && cp -a . /target/" | Out-Null

  $targetStats = Get-VolumeStats $operation.Target
  Write-Host "Cloned $($operation.Kind): source [$($operation.SourceStats)], target [$targetStats]"
}

Write-Host "Volume restore complete. Source volumes were left unchanged."
