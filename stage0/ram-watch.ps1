# 0단계 #3: RAM 관찰(연구실 PC 64GB). 일정 간격으로 메모리와 페이지 파일을 CSV에 기록한다. 읽기만 한다.
#   powershell -NoProfile -ExecutionPolicy Bypass -File stage0\ram-watch.ps1 -Minutes 10 [-IntervalSec 5]
# 측정하는 동안 헤르메스, Ollama(모델 올림), Node, Claude Code를 실제처럼 돌린다.
# 성능 카운터 이름은 한국어 Windows에서 바뀌므로 Get-Counter 대신 CIM 클래스를 쓴다.
param(
  [int]$Minutes = 10,
  [int]$IntervalSec = 5
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$OutDir = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Csv = Join-Path $OutDir "ram-$Stamp.csv"

# 관심 있는 프로세스 묶음 (이름 앞부분으로 매칭)
$Groups = [ordered]@{
  ollama = '^ollama'
  node   = '^node$'
  claude = '^claude'
  codex  = '^codex'
  hermes = '^(hermes|python|pythonw|uv)$'
}

$TotalMB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)
Write-Host "RAM 관찰 시작: $Minutes 분, $IntervalSec 초 간격, 총 RAM $TotalMB MB"
Write-Host "기록 파일: $Csv"
Write-Host '중간에 멈추려면 Ctrl+C (그때까지의 기록은 남아요)'
Write-Host ''

$end = (Get-Date).AddMinutes($Minutes)
$rows = New-Object System.Collections.Generic.List[object]
$pfStart = $null
$header = $true

while ((Get-Date) -lt $end) {
  $mem = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
  $pf = (Get-CimInstance Win32_PageFileUsage | Measure-Object -Property CurrentUsage -Sum).Sum
  if ($null -eq $pfStart) { $pfStart = $pf }
  $procs = Get-Process
  $row = [ordered]@{
    time            = (Get-Date -Format 'HH:mm:ss')
    availableMB     = [int]$mem.AvailableMBytes
    committedMB     = [math]::Round($mem.CommittedBytes / 1MB)
    commitLimitMB   = [math]::Round($mem.CommitLimit / 1MB)
    pagesPerSec     = [int]$mem.PagesPerSec
    pageReadsPerSec = [int]$mem.PageReadsPerSec
    pagefileMB      = [int]$pf
  }
  foreach ($g in $Groups.Keys) {
    $ws = ($procs | Where-Object { $_.ProcessName -match $Groups[$g] } | Measure-Object -Property WorkingSet64 -Sum).Sum
    $row["${g}MB"] = [math]::Round(($(if ($ws) { $ws } else { 0 })) / 1MB)
  }
  $obj = [pscustomobject]$row
  $rows.Add($obj)
  if ($header) { $obj | Export-Csv -Path $Csv -NoTypeInformation -Encoding UTF8; $header = $false }
  else { $obj | Export-Csv -Path $Csv -NoTypeInformation -Encoding UTF8 -Append }
  Write-Host ("{0}  남은 {1,6} MB · 커밋 {2,6}/{3} MB · 페이지/초 {4,5} · 페이지파일 {5,5} MB · ollama {6} · node {7} · claude {8} · hermes {9}" -f `
      $row.time, $row.availableMB, $row.committedMB, $row.commitLimitMB, $row.pagesPerSec, $row.pagefileMB, $row.ollamaMB, $row.nodeMB, $row.claudeMB, $row.hermesMB)
  Start-Sleep -Seconds $IntervalSec
}

if ($rows.Count -eq 0) { Write-Host '[실패] 기록이 없어요'; exit 1 }

$minAvail = ($rows | Measure-Object -Property availableMB -Minimum).Minimum
$maxPf = ($rows | Measure-Object -Property pagefileMB -Maximum).Maximum
$pfGrowth = $maxPf - $pfStart
$readsAvg = [math]::Round(($rows | Measure-Object -Property pageReadsPerSec -Average).Average, 1)
$highReads = @($rows | Where-Object { $_.pageReadsPerSec -ge 100 }).Count
$highPct = [math]::Round(100 * $highReads / $rows.Count)
$peak = $rows | Sort-Object availableMB | Select-Object -First 1

Write-Host ''
Write-Host '== 요약 =='
Write-Host "샘플 $($rows.Count)개, 기록 파일 $Csv"
Write-Host "남은 메모리 최솟값: $minAvail MB (그때 ollama $($peak.ollamaMB) · node $($peak.nodeMB) · claude $($peak.claudeMB) · hermes $($peak.hermesMB) MB)"
Write-Host "페이지 파일 사용량: 시작 $pfStart MB → 최대 $maxPf MB (증가 $pfGrowth MB)"
Write-Host "디스크에서 페이지 읽기/초: 평균 $readsAvg, 100 이상인 샘플 $highPct%"

$ok = ($minAvail -ge 1024) -and ($pfGrowth -le 256) -and ($highPct -lt 10)
$why = @()
if ($minAvail -lt 1024) { $why += "남은 메모리가 1GB 밑으로 내려감" }
if ($pfGrowth -gt 256) { $why += "페이지 파일이 $pfGrowth MB 늘어남" }
if ($highPct -ge 10) { $why += "디스크 페이지 읽기가 잦음($highPct%)" }
if ($ok) {
  Write-Host '[통과] #3 RAM: 스왑 징후 없음 (기준: 남은 메모리 1GB 이상, 페이지 파일 증가 256MB 이하, 페이지 읽기 100/초 이상 샘플 10% 미만)'
} else {
  Write-Host "[실패] #3 RAM: $($why -join ', ')"
}
Write-Host '측정 중 띄워 둔 프로그램과 체감(버벅임)을 RESULTS.md에 같이 적어 주세요.'
