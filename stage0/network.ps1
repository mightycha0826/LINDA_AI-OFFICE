# 0단계 #8 학교 네트워크. 대상마다 DNS, TCP 443, TLS 인증서 발급자, HTTPS 응답을 확인한다.
#   powershell -NoProfile -ExecutionPolicy Bypass -File stage0\network.ps1
# Tailscale DERP 중계 서버는 일반 TLS로 확인되지 않아 tailscale netcheck로 본다.
# 학교가 HTTPS를 가로채 검사하면 발급자가 학교 장비 이름으로 바뀐다. 이러면 CLI들이 인증서 오류를 낼 수 있다.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$OutDir = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$OutFile = Join-Path $OutDir "network-$Stamp.txt"
$Lines = New-Object System.Collections.Generic.List[string]
function Say([string]$text) { Write-Host $text; $Lines.Add($text) }

$Targets = @(
  @{ group = 'Discord';   host = 'discord.com' },
  @{ group = 'Discord';   host = 'gateway.discord.gg' },
  @{ group = 'Discord';   host = 'cdn.discordapp.com' },
  @{ group = 'Anthropic'; host = 'api.anthropic.com' },
  @{ group = 'Anthropic'; host = 'claude.ai' },
  @{ group = 'OpenAI';    host = 'api.openai.com' },
  @{ group = 'OpenAI';    host = 'chatgpt.com' },
  @{ group = 'OpenAI';    host = 'auth.openai.com' },
  @{ group = 'GitHub';    host = 'github.com' },
  @{ group = 'GitHub';    host = 'api.github.com' },
  @{ group = 'Tailscale'; host = 'controlplane.tailscale.com' },
  @{ group = 'Tailscale'; host = 'login.tailscale.com' },
  @{ group = 'Ollama';    host = 'registry.ollama.ai' }
)

# 인증서 발급자에 이 이름들이 보이면 정상 공개 인증기관으로 본다(참고용). 아니면 가로채기 의심.
$KnownCAs = 'DigiCert|Let''s Encrypt|ISRG|Google Trust|GTS|Sectigo|GlobalSign|Amazon|Microsoft|Cloudflare|Baltimore|COMODO|Entrust|GoDaddy|Starfield|USERTrust|SSL\.com|ZeroSSL'

function Test-Target([string]$hostName) {
  $r = [ordered]@{ dns = $null; tcp = $false; issuer = $null; http = $null; error = $null; ms = $null }
  try {
    $ips = [Net.Dns]::GetHostAddresses($hostName)
    $r.dns = ($ips | Select-Object -First 2 | ForEach-Object { $_.IPAddressToString }) -join ', '
  } catch { $r.error = 'DNS 실패'; return $r }

  $client = New-Object Net.Sockets.TcpClient
  try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $task = $client.ConnectAsync($hostName, 443)
    if (-not $task.Wait(5000)) { $r.error = 'TCP 443 시간 초과'; return $r }
    $r.ms = $sw.ElapsedMilliseconds
    $r.tcp = $true
    $ssl = New-Object Net.Security.SslStream($client.GetStream(), $false, { param($s, $c, $ch, $e) $true })
    $ssl.ReadTimeout = 5000
    $ssl.AuthenticateAsClient($hostName, $null, [Security.Authentication.SslProtocols]::None, $false)   # OS 기본값(TLS 1.3 포함)
    $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
    $r.issuer = $cert.Issuer
    $ssl.Dispose()
  } catch {
    if (-not $r.error) { $r.error = "TLS 실패: $($_.Exception.InnerException.Message)$($_.Exception.Message)" }
  } finally { $client.Close() }

  try {
    $resp = Invoke-WebRequest -Uri "https://$hostName/" -Method Head -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    $r.http = [int]$resp.StatusCode
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { $r.http = [int]$resp.StatusCode }   # 403·404·405도 서버까지 닿았다는 뜻
    elseif (-not $r.error) { $r.error = "HTTPS 실패: $($_.Exception.Message)" }
  }
  return $r
}

Say "== 네트워크 확인 · $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') =="
$proxy = (netsh winhttp show proxy) -join ' '
Say "WinHTTP 프록시: $($proxy -replace '\s+', ' ')"
Say ''

$fails = @(); $suspect = @()
foreach ($t in $Targets) {
  $r = Test-Target $t.host
  $ok = $r.tcp -and $r.issuer -and ($null -ne $r.http) -and -not $r.error
  $issuerShort = if ($r.issuer) { ($r.issuer -split ',\s*' | Where-Object { $_ -match '^(CN|O)=' }) -join ', ' } else { '-' }
  $mitm = $r.issuer -and ($r.issuer -notmatch $KnownCAs)
  Say ("{0,-4} {1,-10} {2,-28} TCP {3,-4} {4,5} · HTTP {5,-4} · 발급자 {6}{7}" -f `
      $(if ($ok) { 'OK' } else { '실패' }), $t.group, $t.host, $(if ($r.tcp) { '열림' } else { '닫힘' }),
      $(if ($r.ms) { "$($r.ms)ms" } else { '' }), $(if ($null -ne $r.http) { $r.http } else { '-' }), $issuerShort,
      $(if ($r.error) { " · $($r.error)" } else { '' }))
  if (-not $ok) { $fails += $t.host }
  if ($mitm) { $suspect += "$($t.host) ($issuerShort)" }
}

Say ''
if (Get-Command tailscale -ErrorAction SilentlyContinue) {
  Say '-- tailscale netcheck'
  foreach ($l in (& tailscale netcheck 2>&1)) { Say "  $l" }
} else {
  Say '-- tailscale 미설치: 설치 뒤 tailscale netcheck 결과를 따로 붙여 주세요 (UDP 직접 연결 가능 여부)'
}

Say ''
Say '== 요약 =='
if ($fails.Count -eq 0) { Say '[통과] #8 네트워크: 모든 대상에 연결됨' }
else { Say "[실패] #8 네트워크: 연결 안 됨 → $($fails -join ', ')" }
if ($suspect.Count -gt 0) {
  Say "[확인 필요] 낯선 인증서 발급자(HTTPS 가로채기 의심): $($suspect -join '; ')"
} else {
  Say '[통과] 인증서 발급자가 모두 공개 인증기관'
}
Say '참고: 시간대에 따라 다를 수 있어요. 가능하면 낮과 밤에 한 번씩 돌려 주세요.'
$Lines | Out-File -FilePath $OutFile -Encoding utf8
Write-Host "결과 파일: $OutFile"
