# 파견 직원 넣기: 친구의 Claude·Codex 계정을 회사에 잠시 빌린다 (DESIGN 8장, 2026-10-21).
#   powershell -ExecutionPolicy Bypass -File C:\ai-office\office\scripts\add-guest.ps1 -Id minsu -Name 민수 -Provider claude
#   -Provider claude | codex, -Role developer(기본) | marketing | strategy | pm, -Cap 70(친구 계정 사용률 한도 %, 기본 70)
# 친구가 이 PC 앞에서 직접 로그인한다. 로그인 정보는 C:\ai-office\data\guests\<Id>\ 폴더에만 남는다.
# 비밀번호·키를 채팅이나 Discord에 붙여 넣지 않는다. 넣은 뒤 Discord /파견 에서 [출근]을 누른다.
param(
  [Parameter(Mandatory = $true)][string]$Id,
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][ValidateSet('claude', 'codex')][string]$Provider,
  [ValidateSet('developer', 'marketing', 'strategy', 'pm')][string]$Role = 'developer',
  [ValidateRange(1, 100)][int]$Cap = 70,
  [string]$DataDir = 'C:\ai-office\data'
)
$ErrorActionPreference = 'Stop'
if ($Id -notmatch '^[a-z0-9][a-z0-9-]{1,23}$') { throw 'Id는 영문 소문자·숫자·- 2~24자예요 (예: minsu)' }

$guestHome = Join-Path (Join-Path $DataDir 'guests') $Id
New-Item -ItemType Directory -Force -Path $guestHome | Out-Null

Write-Host ''
Write-Host "[$Name] 친구 계정으로 로그인해요. 로그인 정보는 $guestHome 에만 저장돼요."
if ($Provider -eq 'claude') {
  Write-Host '  Claude가 열리면 친구 계정으로 로그인하고, 끝나면 /exit 로 나와 주세요.'
  $env:CLAUDE_CONFIG_DIR = $guestHome
  try { & claude } finally { Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
} else {
  Write-Host '  브라우저가 열리면 친구 계정(ChatGPT)으로 로그인해 주세요.'
  $env:CODEX_HOME = $guestHome
  try { & codex login } finally { Remove-Item Env:\CODEX_HOME -ErrorAction SilentlyContinue }
}

# 명단(비밀 값 없음)에 넣는다. 같은 Id면 바꾼다
$file = Join-Path $DataDir 'guests.json'
$list = @()
if (Test-Path $file) {
  $old = Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json
  foreach ($g in @($old.guests)) { if ($g.id -ne $Id) { $list += $g } }
}
$list += [pscustomobject]@{ id = $Id; name = $Name; provider = $Provider; role = $Role; capPct = $Cap }
$json = ConvertTo-Json -InputObject ([pscustomobject]@{ guests = @($list) }) -Depth 4
[IO.File]::WriteAllText($file, $json, (New-Object Text.UTF8Encoding $false))

Write-Host ''
Write-Host "넣었어요: $Name ($Provider, $Role, 한도 $Cap%). 처음에는 퇴근 상태예요."
Write-Host 'Discord에서 /파견 을 쓰고 [출근]을 누르면 일을 받기 시작해요.'
Write-Host '로그인 폴더를 다른 계정이 못 읽게 막으려면 protect-secrets.ps1 도 한 번 더 실행해 주세요.'
