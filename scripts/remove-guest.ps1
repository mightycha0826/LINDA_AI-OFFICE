# 파견 직원 빼기: 명단에서 지우고 친구 계정 로그인 폴더를 지운다 (DESIGN 8장, 2026-10-21).
#   powershell -ExecutionPolicy Bypass -File C:\ai-office\office\scripts\remove-guest.ps1 -Id minsu
# 지우면 오케스트레이터가 다음 바퀴(10초 안)에 그 직원의 일을 멈춘다. 재시작하지 않아도 된다.
param([Parameter(Mandatory = $true)][string]$Id, [string]$DataDir = 'C:\ai-office\data')
$ErrorActionPreference = 'Stop'
if ($Id -notmatch '^[a-z0-9][a-z0-9-]{1,23}$') { throw 'Id 형식이 맞지 않아요' }

$file = Join-Path $DataDir 'guests.json'
if (Test-Path $file) {
  $old = Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json
  $list = @(@($old.guests) | Where-Object { $_.id -ne $Id })
  $json = ConvertTo-Json -InputObject ([pscustomobject]@{ guests = $list }) -Depth 4
  [IO.File]::WriteAllText($file, $json, (New-Object Text.UTF8Encoding $false))
}

$guestHome = Join-Path (Join-Path $DataDir 'guests') $Id
if (Test-Path $guestHome) {
  $ok = Read-Host "$guestHome 의 로그인 정보를 지울까요? (y/N)"
  if ($ok -eq 'y') { Remove-Item -Recurse -Force $guestHome; Write-Host '로그인 폴더를 지웠어요.' }
  else { Write-Host '로그인 폴더는 남겨 뒀어요. 친구에게 계정에서 로그아웃(세션 끊기)도 부탁해 주세요.' }
}
Write-Host "명단에서 뺐어요: $Id"
