# 비밀 값 넣기 (주인이 PC 앞에서 직접 실행). 입력한 값은 화면에 보이지 않고, C:\ai-office\data\secrets.json에만 저장된다.
#   powershell -ExecutionPolicy Bypass -File C:\ai-office\office\scripts\set-secrets.ps1
# 비워 두고 Enter를 누르면 그 값은 바꾸지 않는다. 채팅이나 다른 곳에 붙여 넣지 않는다.
param([string]$DataDir = 'C:\ai-office\data', [switch]$WithGithub)

$file = Join-Path $DataDir 'secrets.json'
$secrets = [ordered]@{}
if (Test-Path $file) {
  $old = Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json
  foreach ($p in $old.PSObject.Properties) { $secrets[$p.Name] = $p.Value }
}

function Read-Secret([string]$label) {
  $s = Read-Host -AsSecureString $label
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$items = @(
  @{ key = 'discordToken'; label = 'Discord 봇 토큰 (개발자 포털 > Bot > Reset Token)'; ok = { param($v) $v.Length -ge 50 -and $v -notmatch '\s' } },
  @{ key = 'mirrorWebhookUrl'; label = '#사무실-대화 웹훅 URL'; ok = { param($v) $v -match '^https://(discord|discordapp)\.com/api/webhooks/\d+/[\w-]+$' } }
)
if ($WithGithub) {
  $items += @{ key = 'githubToken'; label = 'GitHub 세분화 토큰 (모든 저장소, Administration·Contents 쓰기)'; ok = { param($v) $v.Length -ge 20 -and $v -notmatch '\s' } }
}

foreach ($it in $items) {
  $state = if ($secrets.Contains($it.key)) { '이미 있음, 비우면 그대로' } else { '없음' }
  while ($true) {
    $v = Read-Secret "$($it.label) [$state]"
    if ($v -eq '') { break }
    if (& $it.ok $v) { $secrets[$it.key] = $v; Write-Host "  저장할게요: $($it.key)"; break }
    Write-Host '  형식이 맞지 않아요. 다시 붙여 넣어 주세요 (비우고 Enter = 건너뛰기).'
  }
}

New-Item -ItemType Directory -Force $DataDir | Out-Null
$json = $secrets | ConvertTo-Json
# Node가 읽을 수 있게 BOM 없는 UTF-8로 쓴다
[IO.File]::WriteAllText($file, $json, (New-Object Text.UTF8Encoding $false))
Write-Host "끝: $file (값은 출력하지 않아요). 들어 있는 항목: $(@($secrets.Keys) -join ', ')"
