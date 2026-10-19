# 헤르메스(비서실장) 연결 설정. 헤르메스를 설치한 뒤 주인이 한 번 실행한다. docs/HERMES-SETUP.md 참고.
#   powershell -ExecutionPolicy Bypass -File C:\ai-office\office\scripts\hermes-configure.ps1
# 하는 일:
#   1) 헤르메스 config.yaml에 회사 MCP 서버(office)를 넣는다 (이미 있으면 그대로)
#   2) 헤르메스 .env에 Discord 설정을 넣는다: 주인만 허용, #비서실을 홈·멘션 없이 답하는 채널로
#   3) 비서실장 봇 토큰을 화면에 안 보이게 입력받아 .env에만 저장한다 (비우고 Enter = 그대로)
#   4) 회사 config.json의 hermes.homeDir을 채워 매일 백업이 돌게 한다
# 토큰 값은 출력하지 않는다.
param(
  [string]$HermesHome = '',
  [string]$DataDir = 'C:\ai-office\data',
  [string]$OfficeDir = 'C:\ai-office\office',
  [switch]$NoToken
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding $false

# --- 헤르메스 폴더 찾기 -------------------------------------------------------
if (-not $HermesHome) {
  $cands = @($env:HERMES_HOME, (Join-Path $env:USERPROFILE '.hermes'), (Join-Path $env:LOCALAPPDATA 'hermes')) | Where-Object { $_ }
  $HermesHome = $cands | Where-Object { Test-Path (Join-Path $_ 'config.yaml') } | Select-Object -First 1
  if (-not $HermesHome) { $HermesHome = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1 }
}
if (-not $HermesHome -or -not (Test-Path $HermesHome)) {
  Write-Host '헤르메스 폴더를 찾지 못했어요. 헤르메스를 먼저 설치하고 hermes를 한 번 실행한 뒤 다시 돌려 주세요.'
  Write-Host '폴더를 알고 있으면: -HermesHome <폴더>'
  exit 1
}
Write-Host "헤르메스 폴더: $HermesHome"

# --- 회사 설정에서 ID 읽기 ----------------------------------------------------
$cfgPath = Join-Path $DataDir 'config.json'
$cfg = Get-Content -Raw -Encoding UTF8 $cfgPath | ConvertFrom-Json
$ceo = $cfg.ceoDiscordId
$secretary = $cfg.discord.channels.secretary
if (-not $ceo -or -not $secretary) { Write-Host 'config.json에 ceoDiscordId나 #비서실 채널 ID가 없어요.'; exit 1 }

# --- 1) config.yaml에 MCP 서버 ------------------------------------------------
$yamlPath = Join-Path $HermesHome 'config.yaml'
$mcpMain = (Join-Path $OfficeDir 'packages\orchestrator\src\mcp\main.ts') -replace '\\', '/'
# 헤르메스 설치기가 자기 Node를 따로 깔 수 있어, .ts를 바로 돌리는 시스템 Node 24를 절대 경로로 쓴다
$nodeExe = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $nodeExe)) { $nodeExe = (Get-Command node).Source }
$nodeExe = $nodeExe -replace '\\', '/'
$block = @(
  '  office:',
  "    command: `"$nodeExe`"",
  "    args: [`"$mcpMain`"]",
  '    env:',
  "      AI_OFFICE_DATA: `"$($DataDir -replace '\\', '/')`""
)
$yaml = if (Test-Path $yamlPath) { [IO.File]::ReadAllText($yamlPath) } else { '' }
if ($yaml -match '(?m)^\s{2}office:\s*$') {
  Write-Host 'config.yaml: office MCP 서버가 이미 있어요 (그대로 둠)'
} else {
  if (Test-Path $yamlPath) { Copy-Item $yamlPath "$yamlPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" }
  $lines = [Collections.Generic.List[string]]::new()
  if ($yaml) { $lines.AddRange([string[]]($yaml -split "`r?`n")) }
  $i = -1
  for ($k = 0; $k -lt $lines.Count; $k++) { if ($lines[$k] -match '^mcp_servers:\s*(\{\s*\})?\s*$') { $i = $k; break } }
  if ($i -ge 0) {
    $lines[$i] = 'mcp_servers:'
    $lines.InsertRange($i + 1, [string[]]$block)
  } else {
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -ne '') { $lines.Add('') }
    $lines.Add('mcp_servers:')
    $lines.AddRange([string[]]$block)
  }
  [IO.File]::WriteAllText($yamlPath, ($lines -join "`n") + "`n", $utf8)
  Write-Host 'config.yaml: office MCP 서버를 넣었어요 (예전 파일은 .bak으로 남김)'
}

# --- 2·3) .env ---------------------------------------------------------------
$envPath = Join-Path $HermesHome '.env'
$envLines = [Collections.Generic.List[string]]::new()
if (Test-Path $envPath) { $envLines.AddRange([string[]]([IO.File]::ReadAllText($envPath) -split "`r?`n")) }
function Set-EnvLine([string]$key, [string]$value) {
  for ($k = 0; $k -lt $envLines.Count; $k++) {
    if ($envLines[$k] -match "^\s*$key=") { $envLines[$k] = "$key=$value"; return }
  }
  $envLines.Add("$key=$value")
}
Set-EnvLine 'DISCORD_ALLOWED_USERS' $ceo
Set-EnvLine 'DISCORD_HOME_CHANNEL' $secretary
Set-EnvLine 'DISCORD_HOME_CHANNEL_NAME' '비서실'
Set-EnvLine 'DISCORD_FREE_RESPONSE_CHANNELS' $secretary

$hasToken = $envLines | Where-Object { $_ -match '^\s*DISCORD_BOT_TOKEN=.{20,}' }
$state = if ($hasToken) { '이미 있음, 비우면 그대로' } else { '없음' }
while (-not $NoToken) {
  $s = Read-Host -AsSecureString "비서실장 봇 토큰 (회사 시스템 봇 LINDA와 다른 앱) [$state]"
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { $tok = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  if ($tok -eq '') { break }
  if ($tok.Length -ge 50 -and $tok -notmatch '\s' -and ($tok -split '\.').Count -eq 3) {
    $sys = (Get-Content -Raw -Encoding UTF8 (Join-Path $DataDir 'secrets.json') | ConvertFrom-Json).discordToken
    if ($sys -and $sys -eq $tok) { Write-Host '  회사 시스템 봇(LINDA)과 같은 토큰이에요. 비서실장용으로 새 앱을 만들어 주세요.'; continue }
    Set-EnvLine 'DISCORD_BOT_TOKEN' $tok
    Write-Host '  저장할게요: DISCORD_BOT_TOKEN'
    break
  }
  Write-Host '  형식이 맞지 않아요. 다시 붙여 넣어 주세요 (비우고 Enter = 건너뛰기).'
}
[IO.File]::WriteAllText($envPath, (($envLines | Where-Object { $_ -ne $null }) -join "`n").TrimEnd() + "`n", $utf8)
Write-Host ".env: 허용 사용자(주인), 홈·멘션 없는 채널(#비서실)을 넣었어요"

# --- 4) 회사 config.json에 헤르메스 폴더 (백업용) -------------------------------
# PowerShell 5.1의 ConvertTo-Json은 배열·이스케이프를 바꿀 수 있어 Node로 고친다
$js = "const fs=require('fs');const [p,h]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(p,'utf8'));c.hermes={...(c.hermes||{}),homeDir:h};fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n')"
node -e $js $cfgPath $HermesHome
if ($LASTEXITCODE -ne 0) { Write-Host 'config.json을 고치지 못했어요'; exit 1 }
Write-Host "config.json: hermes.homeDir = $HermesHome (매일 백업)"

Write-Host ''
Write-Host '끝. 다음: hermes model 로 모델을 고르고(아래 안내), hermes gateway 로 Discord 연결을 켜요.'
Write-Host '  모델: 사용자 지정 OpenAI 호환 주소 http://127.0.0.1:11434/v1 · 모델 gemma4:12b, config.yaml model.ollama_num_ctx: 65536'
