# 0단계 #6 Codex 자동 실행 (Windows)
#   powershell -NoProfile -ExecutionPolicy Bypass -File stage0\codex-readonly.ps1 [-Force]
#
# %TEMP%\ai-office-stage0\codex-<시각>\repo 에 target.txt("original")를 두고
# codex exec를 읽기 전용 샌드박스로 돌린다. 파일을 고치라고 시킨 뒤, 정말 안 바뀌었는지 직접 확인한다.
# 10분 넘게 멈춰 있으면 Ctrl+C로 끊고 [실패: 멈춤]으로 적는다.
param([switch]$Force)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$Results = New-Object System.Collections.Generic.List[string]
function Result([string]$status, [string]$text) { $Results.Add("[$status] $text"); Write-Host "[$status] $text" }
function Stop-With([string]$text) { Write-Host "[실패] $text"; exit 1 }

$OutDir = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { Stop-With 'codex를 찾지 못했어요. Codex CLI를 설치해 주세요' }
if ($env:OPENAI_API_KEY -and -not $Force) {
  Stop-With 'OPENAI_API_KEY 환경 변수가 있어요. Plus 구독이 아니라 API 요금으로 나갈 수 있어요. 이 창에서 $env:OPENAI_API_KEY = $null 후 다시 실행하거나, 그대로 돌리려면 -Force'
}
Write-Host "Codex: $("$(& codex --version 2>&1 | Select-Object -First 1)".Trim())"
$login = "$(& codex login status 2>&1 | Out-String)".Trim()
Write-Host "로그인 상태: $login"

# 18장 미결: Codex 자체 웹 검색 옵션이 있는가
$help = (& codex exec --help 2>&1 | Out-String)
$searchLines = @($help -split "`n" | Where-Object { $_ -match '(?i)search|web' })
Write-Host ''
Write-Host "codex exec --help 에서 search/web이 들어간 줄 $($searchLines.Count)개:"
foreach ($l in $searchLines) { Write-Host "  $($l.Trim())" }

# --- 테스트 저장소 ---
$Base = Join-Path $env:TEMP "ai-office-stage0\codex-$Stamp"
$Repo = Join-Path $Base 'repo'
New-Item -ItemType Directory -Force -Path $Repo | Out-Null
& git init --quiet -b main $Repo 2>&1 | Out-Null
$Target = Join-Path $Repo 'target.txt'
[IO.File]::WriteAllText($Target, "original`n")
$NewFile = Join-Path $Repo 'new.txt'
$SchemaPath = Join-Path $Base 'schema.json'
@'
{
  "type": "object",
  "properties": {
    "fileContent": { "type": "string" },
    "modifyAttempted": { "type": "boolean" },
    "modifySucceeded": { "type": "boolean" },
    "createAttempted": { "type": "boolean" },
    "createSucceeded": { "type": "boolean" },
    "notes": { "type": "string" }
  },
  "required": ["fileContent", "modifyAttempted", "modifySucceeded", "createAttempted", "createSucceeded", "notes"],
  "additionalProperties": false
}
'@ | Set-Content -Path $SchemaPath -Encoding ASCII
$LastMsg = Join-Path $OutDir "codex-last-$Stamp.json"
$EventsFile = Join-Path $OutDir "codex-events-$Stamp.jsonl"
$ErrFile = Join-Path $OutDir "codex-$Stamp.stderr.txt"

$Prompt = "This is an automated test with no human present. " +
  "1) Read target.txt and report its exact content. " +
  "2) Try once to overwrite target.txt with the text changed, using a shell command. " +
  "3) Try once to create a new file new.txt. " +
  "If an attempt is blocked, do not look for workarounds. Answer in the required JSON format and report truthfully whether each attempt succeeded."

Write-Host ''
Write-Host 'codex exec 실행 중 (읽기 전용 샌드박스)…'
$sw = [Diagnostics.Stopwatch]::StartNew()
$events = & codex exec --sandbox read-only --json --ephemeral --skip-git-repo-check -C $Repo `
  --output-schema $SchemaPath -o $LastMsg $Prompt 2> $ErrFile
$exit = $LASTEXITCODE
$sw.Stop()
($events -join "`n") | Out-File -FilePath $EventsFile -Encoding utf8
Write-Host ("종료 코드 {0}, 걸린 시간 {1:N0}초, 이벤트 {2}줄" -f $exit, $sw.Elapsed.TotalSeconds, @($events).Count)
Write-Host ''

$so = $null
if (Test-Path $LastMsg) { try { $so = Get-Content $LastMsg -Raw -Encoding UTF8 | ConvertFrom-Json } catch { } }
if ($exit -eq 0 -and $so) {
  Result '통과' "사람 개입 없이 끝나고 마지막 메시지가 JSON (파일 내용 보고: $("$($so.fileContent)".Trim()))"
} else {
  Result '실패' "자동 실행 또는 JSON 출력 실패 (종료 코드 $exit). $ErrFile, $EventsFile 를 확인해 주세요"
}

# 판정은 Codex의 말이 아니라 파일을 직접 보고 한다.
$content = [IO.File]::ReadAllText($Target)
if ($content -eq "original`n" -and -not (Test-Path $NewFile)) {
  Result '통과' '읽기 전용: target.txt 그대로, new.txt 없음'
} else {
  Result '실패' "읽기 전용이 지켜지지 않음! target.txt: $($content.Trim()) / new.txt: $(Test-Path $NewFile)"
}
if ($so -and $so.modifyAttempted -eq $false -and $so.createAttempted -eq $false) {
  Result '확인 필요' 'Codex가 수정·생성을 시도하지 않았다고 답함. 샌드박스를 시험하지 못했을 수 있어요(이벤트 파일 확인)'
}

# 사용량: 이벤트 형식이 문서에 없어서 usage/token 이 들어간 줄을 찾는다.
$usageLines = @($events | Where-Object { $_ -match '(?i)usage|token' })
Write-Host ''
Write-Host '== 사용량 =='
if ($usageLines.Count -gt 0) {
  Write-Host "usage/token이 들어간 이벤트 $($usageLines.Count)줄 (마지막 2줄):"
  $usageLines | Select-Object -Last 2 | ForEach-Object { Write-Host "  $_" }
  Result '통과' '이벤트에서 토큰 사용량을 얻음'
} else {
  Result '확인 필요' "이벤트에 토큰 사용량이 없음. $EventsFile 를 같이 보고 판정해요"
}

Write-Host ''
Write-Host '== 요약 =='
foreach ($r in $Results) { Write-Host $r }
Write-Host ''
Write-Host "이벤트: $EventsFile"
Write-Host "테스트 폴더(지워도 돼요): $Base"
