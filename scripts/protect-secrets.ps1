# 비밀 파일을 Codex 샌드박스가 못 읽게 막기 (DESIGN.md 7장 "비밀 파일 읽기"). 주인이 직접 실행한다. 관리자 권한은 필요 없다(파일 주인이 주인 계정).
#   powershell -ExecutionPolicy Bypass -File C:\ai-office\office\scripts\protect-secrets.ps1
#   Codex 로그인 정보(codex-home\auth.json)도 막으려면 -IncludeCodexAuth
# 하는 일 (파일마다):
#   1. 주인 계정, SYSTEM, Administrators에 모든 권한을 직접 준다.
#   2. 위 폴더에서 물려받은 권한(Users 읽기, Authenticated Users 수정)을 끊는다 → 주인 계정만 남는다.
#   3. Codex 샌드박스 그룹(CodexSandboxUsers)에 거부(DENY)를 건다. Codex가 위 폴더에 읽기 권한을 더해도 거부가 이긴다.
# 오케스트레이터(pm2)는 주인 계정으로 돌아서 그대로 읽는다. 다시 시작할 필요 없다.
# 되돌리기: scripts\unprotect-secrets.ps1 (물려받은 권한으로 돌아간다)
# 확인: cd C:\ai-office\office\packages\orchestrator; node src/sim/secrets-read-check.ts  →  Codex "못 읽음"이면 성공
param(
  [string]$DataDir = 'C:\ai-office\data',
  [string]$Group = 'CodexSandboxUsers',
  [switch]$IncludeCodexAuth
)
$ErrorActionPreference = 'Stop'

$g = Get-LocalGroup -Name $Group -ErrorAction SilentlyContinue
if (-not $g) {
  Write-Host "그룹 $Group 이 없어요. Codex를 [windows] sandbox = `"elevated`"로 한 번 돌리면 만들어져요. 아무것도 바꾸지 않았어요."
  exit 1
}
$groupSid = $g.SID.Value
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

$secrets = Join-Path $DataDir 'secrets.json'
if (-not (Test-Path $secrets)) {
  Write-Host "$secrets 이 없어요. 먼저 오케스트레이터를 한 번 켜거나 set-secrets.ps1을 실행해 주세요. 아무것도 바꾸지 않았어요."
  exit 1
}
# 시험용 가짜 파일. 진짜 비밀 대신 이 파일로 막혔는지 확인한다(내용은 무작위 표식뿐)
$canary = Join-Path $DataDir 'secrets.canary.json'
if (-not (Test-Path $canary)) {
  [IO.File]::WriteAllText($canary, "{ `"note`": `"fake canary`", `"canary`": `"CANARY-not-yet-run`" }`n", (New-Object Text.UTF8Encoding $false))
}
$targets = @($secrets, $canary)
if ($IncludeCodexAuth) {
  $auth = Join-Path $DataDir 'codex-home\auth.json'
  if (Test-Path $auth) { $targets += $auth } else { Write-Host "건너뜀: $auth 이 없어요" }
}

function Invoke-Icacls([string[]]$icArgs) {
  & icacls.exe @icArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls 실패 (종료 코드 $LASTEXITCODE): icacls $($icArgs -join ' ')" }
}

foreach ($f in $targets) {
  Write-Host "`n== $f"
  Write-Host '바꾸기 전:'
  & icacls.exe $f
  # 순서가 중요하다: 주인 권한을 먼저 직접 준 뒤에 물려받은 권한을 끊는다(잠기지 않게)
  Invoke-Icacls @($f, '/grant', "*${ownerSid}:(F)", '/grant', '*S-1-5-18:(F)', '/grant', '*S-1-5-32-544:(F)')
  Invoke-Icacls @($f, '/inheritance:r')
  Invoke-Icacls @($f, '/deny', "*${groupSid}:(F)")

  # 확인: 보호됨(물려받기 끊김), 그룹 거부 있음, 다른 사람 허용 없음, 주인이 읽을 수 있음
  $sddl = (Get-Acl -LiteralPath $f).Sddl
  $denied = $sddl -match "\(D;[^)]*;;;$([regex]::Escape($groupSid))\)"
  $others = [regex]::Matches($sddl, '\(A;[^)]*;;;([^)]+)\)') | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -notin @($ownerSid, 'SY', 'BA') }
  $readable = $true
  try { [IO.File]::OpenRead($f).Dispose() } catch { $readable = $false }
  if ($sddl -notmatch 'D:P' -or -not $denied -or $others -or -not $readable) {
    Write-Host "확인 실패: 보호=$($sddl -match 'D:P') 거부=$denied 다른허용=$($others -join ',') 주인읽기=$readable"
    Write-Host '되돌리려면 unprotect-secrets.ps1을 실행하세요.'
    exit 1
  }
  Write-Host '바꾼 뒤:'
  & icacls.exe $f
}
# 파견 직원(친구 계정) 로그인 폴더 (8장, 2026-10-21): 폴더째 막는다. CLI가 토큰을 새로 써도 새 파일이 이 권한을 물려받는다
$guestsDir = Join-Path $DataDir 'guests'
if (Test-Path $guestsDir) {
  foreach ($d in Get-ChildItem -LiteralPath $guestsDir -Directory) {
    $p = $d.FullName
    Write-Host "`n== $p (파견 직원 로그인 폴더)"
    Invoke-Icacls @($p, '/grant', "*${ownerSid}:(OI)(CI)(F)", '/grant', '*S-1-5-18:(OI)(CI)(F)', '/grant', '*S-1-5-32-544:(OI)(CI)(F)')
    Invoke-Icacls @($p, '/inheritance:r')
    Invoke-Icacls @($p, '/deny', "*${groupSid}:(OI)(CI)(F)")
    $sddl = (Get-Acl -LiteralPath $p).Sddl
    if ($sddl -notmatch 'D:P' -or $sddl -notmatch "\(D;[^)]*;;;$([regex]::Escape($groupSid))\)") {
      Write-Host '확인 실패: 폴더 보호가 걸리지 않았어요. 되돌리려면 unprotect-secrets.ps1을 실행하세요.'
      exit 1
    }
    & icacls.exe $p
  }
}
Write-Host "`n끝: 주인 계정만 읽을 수 있고 $Group 은(는) 거부돼요. 확인: node src/sim/secrets-read-check.ts"
