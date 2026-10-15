# 0단계: 환경 확인. 읽기만 하고 아무것도 바꾸지 않는다.
#   powershell -NoProfile -ExecutionPolicy Bypass -File stage0\env.ps1
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$OutDir = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$OutFile = Join-Path $OutDir "env-$Stamp.txt"
$Lines = New-Object System.Collections.Generic.List[string]
$Checks = New-Object System.Collections.Generic.List[string]

function Say([string]$text) { Write-Host $text; $Lines.Add($text) }
function Check([string]$status, [string]$text) { $Checks.Add("[$status] $text") }

Say "== 환경 확인 · $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') =="

# --- Windows, CPU, RAM ---
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$ramGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
Say ''
Say "-- Windows"
Say "  $($os.Caption) $($os.Version) (빌드 $($os.BuildNumber)), 컴퓨터 이름 $($env:COMPUTERNAME)"
Say "  마지막 부팅: $($os.LastBootUpTime)"
Say "-- CPU: $($cpu.Name.Trim()) ($($cpu.NumberOfCores)코어 / $($cpu.NumberOfLogicalProcessors)스레드)"
Say "-- RAM: 총 $ramGB GB"
$dimms = Get-CimInstance Win32_PhysicalMemory
foreach ($d in $dimms) {
  Say ("  슬롯 {0}: {1} GB, {2} MHz, {3}" -f $d.DeviceLocator, [math]::Round($d.Capacity / 1GB), $d.ConfiguredClockSpeed, $d.PartNumber.Trim())
}
$slots = (Get-CimInstance Win32_PhysicalMemoryArray | Measure-Object -Property MemoryDevices -Sum).Sum
if ($slots) { Say "  메모리 슬롯: $($dimms.Count) / $slots 사용 중 (증설 여지 확인용)" }
if ($ramGB -lt 60) { Check '확인 필요' "RAM $ramGB GB — 설계 기준 64GB보다 작아요(3장)" } else { Check '통과' "RAM $ramGB GB" }

# --- GPU ---
Say ''
Say '-- GPU'
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
  $q = & nvidia-smi --query-gpu=name,memory.total,memory.used,driver_version,display_active --format=csv,noheader 2>&1
  foreach ($l in $q) { Say "  nvidia-smi: $l" }
  if ("$q" -match '(\d+)\s*MiB,\s*(\d+)\s*MiB') {
    $total = [int]$Matches[1]; $used = [int]$Matches[2]
    if ($total -lt 11500) { Check '확인 필요' "VRAM $total MiB — 설계 기준 12GB" } else { Check '통과' "VRAM $total MiB (지금 $used MiB 사용 중)" }
    if ($used -gt 1000) { Check '확인 필요' "모델 없이도 VRAM을 $used MiB 쓰고 있어요. 모니터가 3060에 연결돼 있으면 내장 그래픽으로 옮기는 걸 검토해 주세요(3장)" }
  }
} else {
  Say '  nvidia-smi 없음'
  Check '실패' 'nvidia-smi를 찾지 못했어요. NVIDIA 드라이버를 확인해 주세요'
}
foreach ($v in Get-CimInstance Win32_VideoController) {
  Say ("  그래픽 장치: {0} · 현재 해상도 {1}x{2}" -f $v.Name, $v.CurrentHorizontalResolution, $v.CurrentVerticalResolution)
}
Say '  (해상도가 찍힌 장치가 모니터가 연결된 쪽이에요)'

# --- 저장공간 ---
$c = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$freeGB = [math]::Round($c.FreeSpace / 1GB, 1)
Say ''
Say "-- C: 남은 공간 $freeGB GB / 전체 $([math]::Round($c.Size / 1GB)) GB"
if ($freeGB -lt 60) { Check '확인 필요' "C: 남은 공간 $freeGB GB — 설계 기준 여유 60GB 이상(3장). 모델을 받기 전이면 약 16GB가 더 줄어요" } else { Check '통과' "C: 남은 공간 $freeGB GB" }

$pf = Get-CimInstance Win32_PageFileUsage
foreach ($p in $pf) { Say "-- 페이지 파일: $($p.Name), 할당 $($p.AllocatedBaseSize) MB, 현재 사용 $($p.CurrentUsage) MB, 최대 사용 $($p.PeakUsage) MB" }

# --- 도구 버전 ---
Say ''
Say '-- 도구'
$tools = @(
  @{ n = 'node';      a = @('--version') },
  @{ n = 'npm';       a = @('--version') },
  @{ n = 'git';       a = @('--version') },
  @{ n = 'ollama';    a = @('--version') },
  @{ n = 'claude';    a = @('--version') },
  @{ n = 'codex';     a = @('--version') },
  @{ n = 'hermes';    a = @('--version') },
  @{ n = 'gitleaks';  a = @('version') },
  @{ n = 'tailscale'; a = @('version') },
  @{ n = 'pm2';       a = @('--version') }
)
foreach ($t in $tools) {
  $cmd = Get-Command $t.n -ErrorAction SilentlyContinue
  if ($cmd) {
    $ver = "$(& $t.n @($t.a) 2>&1 | Select-Object -First 1)".Trim()
    Say ("  {0,-10} {1}  ({2})" -f $t.n, $ver, $cmd.Source)
  } else {
    Say ("  {0,-10} 없음" -f $t.n)
  }
}
foreach ($must in @('node', 'git', 'ollama')) {
  if (-not (Get-Command $must -ErrorAction SilentlyContinue)) { Check '확인 필요' "$must 이(가) 설치돼 있지 않아요" }
}
if ($env:ANTHROPIC_API_KEY) { Check '확인 필요' 'ANTHROPIC_API_KEY 환경 변수가 있어요. claude -p가 Pro 구독이 아니라 API 요금으로 나가요' }
if ($env:OPENAI_API_KEY) { Check '확인 필요' 'OPENAI_API_KEY 환경 변수가 있어요. codex가 Plus 구독이 아니라 API 요금으로 나갈 수 있어요' }

# --- 전원과 Windows 설정 (3장 필수 설정) ---
Say ''
Say '-- 전원'
$scheme = (powercfg /getactivescheme) -join ' '
Say "  $scheme"
function Get-AcIndex([string]$sub, [string]$setting) {
  $q = powercfg /query SCHEME_CURRENT $sub $setting 2>$null
  foreach ($l in $q) { if ($l -match 'AC.*:\s*0x([0-9a-fA-F]+)') { return [Convert]::ToInt32($Matches[1], 16) } }
  return $null
}
$sleep = Get-AcIndex 'SUB_SLEEP' 'STANDBYIDLE'
$hib = Get-AcIndex 'SUB_SLEEP' 'HIBERNATEIDLE'
Say "  절전(AC): $(if ($sleep -eq 0) { '안 함' } elseif ($sleep) { "$([math]::Round($sleep / 60))분 후" } else { '읽지 못함' })"
Say "  최대 절전(AC): $(if ($hib -eq 0) { '안 함' } elseif ($hib) { "$([math]::Round($hib / 60))분 후" } else { '읽지 못함' })"
if ($sleep -eq 0 -and ($hib -eq 0 -or $null -eq $hib)) { Check '통과' '절전 모드 안 함' } else { Check '확인 필요' '절전 또는 최대 절전이 켜져 있어요. 3장: 절전 모드 "안 함"' }

Say '-- Windows 업데이트'
$ux = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings' -ErrorAction SilentlyContinue
if ($ux -and $null -ne $ux.ActiveHoursStart) {
  Say "  사용 시간: $($ux.ActiveHoursStart)시 ~ $($ux.ActiveHoursEnd)시"
} else { Say '  사용 시간: 읽지 못함 (자동 설정일 수 있어요)' }
$au = Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -ErrorAction SilentlyContinue
if ($au -and $au.NoAutoRebootWithLoggedOnUsers -eq 1) { Say '  로그인 중 자동 재시작 안 함 정책: 켜짐' } else { Say '  로그인 중 자동 재시작 안 함 정책: 없음' }
Check '확인 필요' 'Windows 업데이트 자동 재시작 막기는 설정 화면에서 직접 확인해 주세요(3장)'

Say '-- 자동 로그인'
$wl = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction SilentlyContinue
$auto = if ($wl -and "$($wl.AutoAdminLogon)" -eq '1') { '켜짐' } else { '꺼짐' }
Say "  자동 로그인: $auto (비밀번호 값은 읽지 않아요)"
if ($auto -eq '켜짐') { Check '통과' '자동 로그인 켜짐' } else { Check '확인 필요' '자동 로그인이 꺼져 있어요. 정전 뒤 재부팅하면 pm2가 시작되지 않아요(3장)' }
Check '확인 필요' 'BIOS 정전 후 자동 켜짐은 스크립트로 확인할 수 없어요. 직접 확인해 주세요'

# --- 작업 공간 ---
Say ''
Say '-- 작업 공간'
foreach ($d in @('C:\ai-office', 'C:\ai-office\office', 'C:\ai-office\repos', 'C:\ai-office\wt', 'C:\ai-office\data')) {
  Say ("  {0,-22} {1}" -f $d, $(if (Test-Path $d) { '있음' } else { '없음' }))
}

# --- 요약 ---
Say ''
Say '== 요약 =='
foreach ($c in $Checks) { Say $c }
$Lines | Out-File -FilePath $OutFile -Encoding utf8
Write-Host ''
Write-Host "결과 파일: $OutFile"
