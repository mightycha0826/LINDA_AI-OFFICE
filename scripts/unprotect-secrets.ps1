# protect-secrets.ps1 되돌리기 (DESIGN.md 7장 "비밀 파일 읽기"). 주인이 직접 실행한다.
#   powershell -ExecutionPolicy Bypass -File C:\ai-office\office\scripts\unprotect-secrets.ps1
# 파일마다 직접 준 권한과 거부를 지우고 위 폴더(DataDir)에서 물려받는 권한으로 돌린다(icacls /reset).
# 막기 전과 같은 상태다: Users 읽기, Authenticated Users 수정 → Codex 샌드박스도 다시 읽을 수 있다.
# 파일 내용은 건드리지 않는다. codex-home\auth.json은 막혀 있을 때만(물려받기가 끊겼을 때만) 되돌린다.
param([string]$DataDir = 'C:\ai-office\data')
$ErrorActionPreference = 'Stop'

$targets = @((Join-Path $DataDir 'secrets.json'), (Join-Path $DataDir 'secrets.canary.json'))
$auth = Join-Path $DataDir 'codex-home\auth.json'
if ((Test-Path $auth) -and ((Get-Acl -LiteralPath $auth).Sddl -match 'D:P')) { $targets += $auth }

foreach ($f in $targets) {
  if (-not (Test-Path $f)) { Write-Host "건너뜀: $f 이 없어요"; continue }
  & icacls.exe $f /reset | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls /reset 실패 (종료 코드 $LASTEXITCODE): $f" }
  Write-Host "`n== $f (물려받는 권한으로 돌림)"
  & icacls.exe $f
}
Write-Host "`n끝: 막기 전 권한으로 돌아갔어요. 다시 막으려면 protect-secrets.ps1"
