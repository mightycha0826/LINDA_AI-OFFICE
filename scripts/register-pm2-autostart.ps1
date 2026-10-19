# 로그온 때 사무실(pm2 ai-office)을 다시 띄우는 작업 스케줄러 등록 (주인 승인 2026-10-19).
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\ai-office\office\scripts\register-pm2-autostart.ps1 [-StartNow]
# - 작업 이름 AI_Office_pm2, 현재 사용자 로그온 30초 뒤, 관리자 권한 없이 실행
# - -StartNow: 지금 떠 있는 pm2를 끄고 이 작업으로 다시 띄운다 (터미널 탭에 묶인 pm2를 떼어 내기)
# 지우려면: Unregister-ScheduledTask -TaskName AI_Office_pm2 -Confirm:$false
param([switch]$StartNow)
$ErrorActionPreference = 'Stop'
$name = 'AI_Office_pm2'
$vbs = Join-Path $PSScriptRoot 'pm2-resurrect.vbs'
if (-not (Test-Path $vbs)) { throw "없음: $vbs" }

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = 'PT30S'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'AI 사무실: 로그온 때 pm2 resurrect (C:\ai-office\office\scripts\pm2-resurrect.vbs)' -Force | Out-Null
Write-Host "등록했어요: $name (로그온 30초 뒤 pm2 resurrect)"

if ($StartNow) {
  $pm2 = Join-Path $env:APPDATA 'npm\pm2.cmd'
  & $pm2 save | Out-Null
  & $pm2 kill | Out-Null
  Start-ScheduledTask -TaskName $name
  Start-Sleep -Seconds 15
  & $pm2 list
}
