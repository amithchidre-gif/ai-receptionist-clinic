# 8-Turn Conversation Pipeline Test
# Tests: greeting, intent_detection, identity_verification, booking_flow, completed

$baseUrl = "http://localhost:4000"
$clinicId = "78de52b5-3895-4824-b970-2676eb668293"
$sessionId = "conv-test-$(Get-Random)"

Write-Host "=== 8-Turn Pipeline Test ===" -ForegroundColor Cyan
Write-Host "Session: $sessionId"
Write-Host "Clinic:  $clinicId`n"

$pass = 0
$fail = 0

function Assert-Test {
    param([string]$label, [bool]$condition)
    if ($condition) {
        $script:pass++
        Write-Host "  PASS: $label" -ForegroundColor Green
    } else {
        $script:fail++
        Write-Host "  FAIL: $label" -ForegroundColor Red
    }
}

function Invoke-Turn {
    param([string]$transcript = "")
    $body = @{
        sessionId = $sessionId
        clinicId = $clinicId
    }
    if ($transcript -ne "") {
        $body["transcriptFragment"] = $transcript
    }
    $json = $body | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$baseUrl/voice/pipeline/turn" -Method POST -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
    return $r.data
}

function Show-Response {
    param($data)
    if ($data -and $data.responseText) {
        $len = $data.responseText.Length
        $show = $data.responseText.Substring(0, [Math]::Min(80, $len))
        Write-Host "  response: $show..."
    }
}

# Turn 1: Greeting (no transcript)
Write-Host "`nTurn 1: Greeting" -ForegroundColor Yellow
$t1 = Invoke-Turn
Write-Host "  state: $($t1.state) -> $($t1.nextState)"
Show-Response $t1
Assert-Test "state is greeting" ($t1.state -eq "greeting")
Assert-Test "nextState is intent_detection" ($t1.nextState -eq "intent_detection")
Assert-Test "response contains greeting" ($t1.responseText -match "thank you for calling")

# Turn 2: Intent - book appointment
Write-Host "`nTurn 2: Intent Detection (book)" -ForegroundColor Yellow
$t2 = Invoke-Turn -transcript "I want to book an appointment please"
Write-Host "  state: $($t2.state) -> $($t2.nextState)"
Write-Host "  intent: $($t2.intent)"
Show-Response $t2
Assert-Test "state is intent_detection" ($t2.state -eq "intent_detection")
Assert-Test "nextState is identity_verification" ($t2.nextState -eq "identity_verification")
Assert-Test "intent is book_appointment" ($t2.intent -eq "book_appointment")

# Turn 3: Give name
Write-Host "`nTurn 3: Identity - Name" -ForegroundColor Yellow
$t3 = Invoke-Turn -transcript "My name is Sarah Johnson"
Write-Host "  state: $($t3.state) -> $($t3.nextState)"
Show-Response $t3
Assert-Test "state is identity_verification" ($t3.state -eq "identity_verification")
Assert-Test "nextState is identity_verification" ($t3.nextState -eq "identity_verification")
Assert-Test "response asks for DOB" ($t3.responseText -match "date of birth")

# Turn 4: Give DOB
Write-Host "`nTurn 4: Identity - DOB" -ForegroundColor Yellow
$t4 = Invoke-Turn -transcript "January 15 1990"
Write-Host "  state: $($t4.state) -> $($t4.nextState)"
Show-Response $t4
Assert-Test "state is identity_verification" ($t4.state -eq "identity_verification")
Assert-Test "nextState is identity_verification" ($t4.nextState -eq "identity_verification")
Assert-Test "response asks for phone" ($t4.responseText -match "phone")

# Turn 5: Give phone
Write-Host "`nTurn 5: Identity - Phone" -ForegroundColor Yellow
$t5 = Invoke-Turn -transcript "555-123-4567"
Write-Host "  state: $($t5.state) -> $($t5.nextState)"
Show-Response $t5
Assert-Test "state is identity_verification" ($t5.state -eq "identity_verification")
Assert-Test "nextState is booking_flow" ($t5.nextState -eq "booking_flow")
Assert-Test "response mentions verified or date" ($t5.responseText -match "verified|identity|date")

# Turn 6: Give booking date
Write-Host "`nTurn 6: Booking - Date" -ForegroundColor Yellow
$t6 = Invoke-Turn -transcript "Next Tuesday"
Write-Host "  state: $($t6.state) -> $($t6.nextState)"
Show-Response $t6
Assert-Test "state is booking_flow" ($t6.state -eq "booking_flow")
Assert-Test "nextState is awaiting_time" ($t6.nextState -eq "awaiting_time")
Assert-Test "response asks for time" ($t6.responseText -match "time")

# Turn 7: Give booking time
Write-Host "`nTurn 7: Booking - Time" -ForegroundColor Yellow
$t7 = Invoke-Turn -transcript "2pm"
Write-Host "  state: $($t7.state) -> $($t7.nextState)"
Show-Response $t7
Assert-Test "nextState is awaiting_time" ($t7.nextState -eq "awaiting_time")
Assert-Test "response asks to confirm" ($t7.responseText -match "confirm")

# Turn 8: Confirm
Write-Host "`nTurn 8: Booking - Confirm" -ForegroundColor Yellow
$t8 = Invoke-Turn -transcript "Yes please confirm"
Write-Host "  state: $($t8.state) -> $($t8.nextState)"
Show-Response $t8
Assert-Test "nextState is completed" ($t8.nextState -eq "completed")
Assert-Test "callCompletedThisTurn is true" ($t8.callCompletedThisTurn -eq $true)
Assert-Test "response confirms appointment" ($t8.responseText -match "confirmed")

# Summary
Write-Host "`n=== Results: $pass/$($pass + $fail) passed ===" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
