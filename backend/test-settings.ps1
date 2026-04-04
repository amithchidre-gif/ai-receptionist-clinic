param(
  [string]$BaseUrl = "http://localhost:4000",
  [string]$Email   = "admin@sunrise.test",
  [string]$Password = "Password123",
  [string]$ClinicName = "Sunrise Clinic"
)

$ErrorActionPreference = "Stop"
$pass = 0; $fail = 0

function Assert-Equal($label, $actual, $expected) {
  if ($actual -eq $expected) {
    Write-Host "  PASS  $label" -ForegroundColor Green
    $script:pass++
  } else {
    Write-Host "  FAIL  $label  (expected `"$expected`", got `"$actual`")" -ForegroundColor Red
    $script:fail++
  }
}

function Invoke-Api($method, $path, $body, $token) {
  $headers = @{ "Content-Type" = "application/json" }
  if ($token) { $headers["Authorization"] = "Bearer $token" }
  $uri = "$BaseUrl$path"
  try {
    if ($body) {
      $json = $body | ConvertTo-Json -Depth 5
      return Invoke-RestMethod -Uri $uri -Method $method -Headers $headers -Body $json
    } else {
      return Invoke-RestMethod -Uri $uri -Method $method -Headers $headers
    }
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    Write-Host "  HTTP $status on $method $path" -ForegroundColor Yellow
    throw
  }
}

# ── Step 1: Register (ignore if already exists) ───────────────────────────────
Write-Host "`n[1] Register test user ($Email)..." -ForegroundColor Cyan
try {
  Invoke-Api POST "/api/auth/register" @{ email=$Email; password=$Password; clinicName=$ClinicName } | Out-Null
  Write-Host "  Registered new user." -ForegroundColor Gray
} catch {
  Write-Host "  Already registered (continuing)." -ForegroundColor Gray
}

# ── Step 2: Login ─────────────────────────────────────────────────────────────
Write-Host "`n[2] Login..." -ForegroundColor Cyan
$loginResp = Invoke-Api POST "/api/auth/login" @{ email=$Email; password=$Password }
$token = $loginResp.data.token
if (-not $token) { Write-Host "  FAIL  No token in login response" -ForegroundColor Red; exit 1 }
Write-Host "  Token obtained." -ForegroundColor Gray

# ── Step 3: GET current settings ──────────────────────────────────────────────
Write-Host "`n[3] GET /api/settings (initial)..." -ForegroundColor Cyan
$getResp = Invoke-Api GET "/api/settings" $null $token
Assert-Equal "Response is success" $getResp.success $true

# ── Step 4: PUT update clinicName ─────────────────────────────────────────────
Write-Host "`n[4] PUT /api/settings - update clinicName to 'Sunrise Medical'..." -ForegroundColor Cyan
$putResp = Invoke-Api PUT "/api/settings" @{ clinicName="Sunrise Medical" } $token
Assert-Equal "PUT returns success"    $putResp.success $true
Assert-Equal "clinicName updated"     $putResp.data.clinicName "Sunrise Medical"

# ── Step 5: GET to confirm persisted ──────────────────────────────────────────
Write-Host "`n[5] GET /api/settings - confirm clinicName persisted..." -ForegroundColor Cyan
$getResp2 = Invoke-Api GET "/api/settings" $null $token
Assert-Equal "clinicName = 'Sunrise Medical'" $getResp2.data.clinicName "Sunrise Medical"

# ── Step 6: PUT update multiple fields ────────────────────────────────────────
Write-Host "`n[6] PUT /api/settings - update workingHours + aiEnabled..." -ForegroundColor Cyan
$putResp2 = Invoke-Api PUT "/api/settings" @{
  workingHours = "9am to 6pm"
  aiReceptionistEnabled = $true
  phone = "+19063338206"
  calendarId = "test-calendar@gmail.com"
} $token
Assert-Equal "workingHours saved"     $putResp2.data.workingHours "9am to 6pm"
Assert-Equal "aiEnabled saved"        $putResp2.data.aiReceptionistEnabled $true
Assert-Equal "phone saved"            $putResp2.data.phone "+19063338206"
Assert-Equal "calendarId saved"       $putResp2.data.calendarId "test-calendar@gmail.com"

# ── Step 7: Reject unknown fields ─────────────────────────────────────────────
Write-Host "`n[7] PUT /api/settings - reject unknown field 'hackerField'..." -ForegroundColor Cyan
try {
  Invoke-Api PUT "/api/settings" @{ hackerField="injected" } $token | Out-Null
  Write-Host "  FAIL  Should have returned 400 for unknown field" -ForegroundColor Red
  $script:fail++
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -eq 400) {
    Write-Host "  PASS  400 returned for unknown field" -ForegroundColor Green
    $script:pass++
  } else {
    Write-Host "  FAIL  Expected 400, got $status" -ForegroundColor Red
    $script:fail++
  }
}

# ── Step 8: GET without token → 401 ──────────────────────────────────────────
Write-Host "`n[8] GET /api/settings without token → expect 401..." -ForegroundColor Cyan
try {
  Invoke-Api GET "/api/settings" $null $null | Out-Null
  Write-Host "  FAIL  Should have returned 401" -ForegroundColor Red
  $script:fail++
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -eq 401) {
    Write-Host "  PASS  401 returned" -ForegroundColor Green
    $script:pass++
  } else {
    Write-Host "  FAIL  Expected 401, got $status" -ForegroundColor Red
    $script:fail++
  }
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host "`n─────────────────────────────────" -ForegroundColor White
$color = if ($fail -eq 0) { "Green" } else { "Red" }
Write-Host "Results: $pass passed, $fail failed" -ForegroundColor $color
if ($fail -gt 0) { exit 1 }
