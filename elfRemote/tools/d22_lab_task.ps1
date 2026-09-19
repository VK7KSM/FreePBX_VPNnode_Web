param(
    [ValidateSet("install", "pull_logs", "heal_network", "reboot", "install_apk", "restart_adbd")]
    [string]$Action = "pull_logs",
    [int]$ToCode = 40,
    [string]$ToName = "0.1.39-d22xx-taska",
    [int]$AdbPort = 5042,
    [string]$Adb = "C:\Dev\android-sdk\platform-tools\adb.exe",
    [string]$BaseUrl = "https://v.elfradio.net"
)

$ErrorActionPreference = "Stop"
$env:ANDROID_ADB_SERVER_PORT = "$AdbPort"
$Root = Split-Path -Parent $PSScriptRoot
$Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$prefix = "v050-task"
if ($Action -eq "heal_network") { $prefix = "v051-heal" }
if ($Action -eq "reboot") { $prefix = "v052-reboot" }
if ($Action -eq "install_apk") { $prefix = "v053-apk" }
if ($Action -eq "restart_adbd") { $prefix = "v054-adbd" }
$CapRoot = Join-Path $Root ("captures\2026-09-06\" + $prefix + "-" + $Action + "-" + $ToCode + "-" + $Stamp)
New-Item -ItemType Directory -Force -Path $CapRoot | Out-Null
$JavaHome = "C:\Users\x\.jdks\jdk-17.0.20.1+1"
$Apksigner = "C:\Dev\android-sdk\build-tools\34.0.0\apksigner.bat"

function Invoke-Adb([string[]]$AdbArgs) {
    & $Adb -P $AdbPort @AdbArgs
}

function Get-LabSerial {
    Invoke-Adb @("start-server") | Out-Null
    for ($i = 0; $i -lt 30; $i++) {
        $lines = Invoke-Adb @("devices", "-l")
        $lines | Out-File (Join-Path $CapRoot "adb_devices.txt") -Encoding utf8
        foreach ($line in $lines) {
            if ($line -notmatch "^\S+\s+device\b") { continue }
            if ($line -match "product:msm8909") { continue }
            $id = ($line -split "\s+")[0]
            if ($id -match ":") { continue }
            if ($id -eq "0") { continue }
            return $id
        }
        Start-Sleep 2
    }
    throw "No USB D22-class device"
}

function Save-Out([string]$Name, [string]$Text) {
    Set-Content -Path (Join-Path $CapRoot $Name) -Value $Text -Encoding utf8
}

function Invoke-Su([string]$Serial, [string]$Cmd) {
    Invoke-Adb @("-s", $Serial, "shell", "su", "-c", $Cmd)
}

function Wait-Usb([string]$Wanted) {
    $deadline = (Get-Date).AddMinutes(4)
    while ((Get-Date) -lt $deadline) {
        $got = $null
        try { $got = Get-LabSerial } catch { Start-Sleep 5; continue }
        if ($got) { return $got }
        Start-Sleep 5
    }
    throw "USB did not return"
}

function Find-Device([string]$WantName) {
    $web = Invoke-RestMethod -Uri ($BaseUrl + "/api/devices") -Method GET
    $hit = $null
    foreach ($d in $web.devices) {
        if ($WantName -and $d.app_version -eq $WantName) { return $d }
        if ($d.online) { $hit = $d }
    }
    return $hit
}

function Get-CertSha([string]$Apk) {
    $out = & $Apksigner verify --print-certs $Apk 2>&1 | Out-String
    Save-Out "apksigner.txt" $out
    if ($out -match "SHA-256 digest:\s*([0-9a-fA-F:]+)") {
        return ($Matches[1] -replace ":", "").ToLowerInvariant()
    }
    throw "cannot read APK cert"
}

function Poke-Report([string]$Serial) {
    Invoke-Su $Serial "export PATH=/system/bin:`$PATH; am start-foreground-service --user 0 -n net.elfradio.elfremote/.ReportService -a net.elfradio.elfremote.REPORT_NOW >/dev/null 2>&1 || true" | Out-Null
}

$serial = Get-LabSerial
Write-Host "capture=$CapRoot action=$Action serial_present=1 to=$ToName"

if ($Action -eq "install") {
    $env:JAVA_HOME = $JavaHome
    Push-Location $Root
    try {
        & .\gradlew.bat --no-daemon assembleDebug "-PelfVerCode=$ToCode" "-PelfVerName=$ToName"
        if ($LASTEXITCODE -ne 0) { throw "assembleDebug failed" }
    } finally { Pop-Location }
    $Apk = Join-Path $Root "app\build\outputs\apk\debug\app-debug.apk"
    Copy-Item $Apk (Join-Path $CapRoot "ElfRemote.apk")
    $apkHash = (Get-FileHash -Algorithm SHA256 $Apk).Hash.ToLowerInvariant()
    Save-Out "apk_sha256.txt" $apkHash
    Invoke-Adb @("-s", $serial, "push", $Apk, "/data/local/tmp/ElfRemote.apk") | Out-Null
    $pm = (Invoke-Su $serial "export PATH=/system/bin:`$PATH; pm install -r -d /data/local/tmp/ElfRemote.apk") | Out-String
    Save-Out "pm_install.txt" $pm
    if ($pm -notmatch "Success") {
        $ov = (Invoke-Su $serial "export PATH=/system/bin:`$PATH; mount -o rw,remount /system; cp /data/local/tmp/ElfRemote.apk /system/app/ElfRemote/ElfRemote.apk; chmod 644 /system/app/ElfRemote/ElfRemote.apk; reboot") | Out-String
        Save-Out "overlay_reboot.txt" $ov
        Start-Sleep 20
        $serial = Wait-Usb $serial
    }
    $deadline = (Get-Date).AddMinutes(6)
    $ok = $false
    $i = 0
    while ((Get-Date) -lt $deadline) {
        $i++
        Start-Sleep 8
        try { $serial = Wait-Usb $serial } catch { continue }
        Poke-Report $serial
        $pmn = (Invoke-Su $serial "dumpsys package net.elfradio.elfremote") | Out-String
        Save-Out "pm_dump.txt" $pmn
        $cur = Find-Device $ToName
        $webVer = if ($cur) { [string]$cur.app_version } else { "" }
        $row = "i=$i web_ver=$webVer"
        Save-Out ("poll_$i.txt") $row
        if ($pmn -match [regex]::Escape($ToName) -and $webVer -eq $ToName) {
            $ok = $true
            break
        }
    }
    Save-Out "web_after.txt" ((Invoke-RestMethod -Uri ($BaseUrl + "/api/devices") -Method GET | ConvertTo-Json -Depth 6))
    if ($ok) { Write-Host "TASK INSTALL PASS $ToName"; exit 0 }
    Write-Host "TASK INSTALL FAIL $ToName"
    exit 2
}

if ($Action -eq "install_apk") {
    $env:JAVA_HOME = $JavaHome
    Push-Location $Root
    try {
        & .\gradlew.bat --no-daemon assembleDebug "-PelfVerCode=$ToCode" "-PelfVerName=$ToName"
        if ($LASTEXITCODE -ne 0) { throw "assembleDebug failed" }
    } finally { Pop-Location }
    $Apk = Join-Path $Root "app\build\outputs\apk\debug\app-debug.apk"
    Copy-Item $Apk (Join-Path $CapRoot "B.apk")
    $apkHash = (Get-FileHash -Algorithm SHA256 $Apk).Hash.ToLowerInvariant()
    $apkLen = (Get-Item $Apk).Length
    $cert = Get-CertSha $Apk
    Save-Out "apk_sha256.txt" $apkHash
    $jobId = -join ((1..16) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) })
    $expires = [DateTimeOffset]::UtcNow.AddHours(6).ToUnixTimeMilliseconds()
    $man = [ordered]@{
        package = "net.elfradio.elfremote"
        versionCode = $ToCode
        versionName = $ToName
        size = [int]$apkLen
        sha256 = $apkHash
        certSha256 = $cert
        url = $BaseUrl + "/api/elfremote/apk/" + $jobId
        job_id = $jobId
        expires_at = $expires
    }
    $manPath = Join-Path $CapRoot "manifest.json"
    [IO.File]::WriteAllText($manPath, ($man | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
    $signed = node (Join-Path $PSScriptRoot "sign_manifest.mjs") $manPath
    Save-Out "signed.json" $signed
    $sigObj = $signed | ConvertFrom-Json
    $apkB64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($Apk))
    $pubBody = @{
        manifest_raw = $sigObj.manifest_raw
        signature = $sigObj.signature
        apk_b64 = $apkB64
    } | ConvertTo-Json -Compress -Depth 5
    $pubRes = Invoke-RestMethod -Uri ($BaseUrl + "/api/elfremote/releases") -Method POST -ContentType "application/json; charset=utf-8" -Body $pubBody
    Save-Out "publish_res.txt" ($pubRes | ConvertTo-Json -Compress)
    if (-not $pubRes.ok) { throw "publish failed" }
}

$cur = Find-Device $ToName
if (-not $cur) { throw "no control-plane device" }
$devId = [string]$cur.id
Save-Out "web_before.txt" ("app_version=" + $cur.app_version + "`ntask_state=" + $cur.task.state + "`ntask_type=" + $cur.task.type)

$taskType = $Action
$enqBody = @{ device_id = $devId; type = $taskType }
if ($taskType -eq "install_apk") { $enqBody.params = @{ versionCode = $ToCode } }
$enq = Invoke-RestMethod -Uri ($BaseUrl + "/api/elfremote/task") -Method POST -ContentType "application/json; charset=utf-8" -Body ($enqBody | ConvertTo-Json -Compress -Depth 5)
Save-Out "enqueue_res.txt" ($enq | ConvertTo-Json -Depth 6)
if (-not $enq.ok) { throw ("enqueue failed " + $enq.msg) }
$wantId = [string]$enq.task.id
Poke-Report $serial

$waitMin = 4
if ($taskType -eq "reboot" -or $taskType -eq "install_apk") { $waitMin = 8 }
$deadline = (Get-Date).AddMinutes($waitMin)
$ok = $false
$i = 0
while ((Get-Date) -lt $deadline) {
    $i++
    Start-Sleep 6
    try { $serial = Wait-Usb $serial } catch { continue }
    Poke-Report $serial
    $web = Invoke-RestMethod -Uri ($BaseUrl + "/api/devices") -Method GET
    $got = $null
    foreach ($d in $web.devices) { if ($d.id -eq $devId) { $got = $d; break } }
    $t = $got.task
    $sha = ""
    $bytes = 0
    $stage = ""
    if ($t.result) {
        $sha = [string]$t.result.sha256
        $bytes = [int]$t.result.bytes
        $stage = [string]$t.result.stage
    }
    $row = "i=$i id=$($t.id) type=$($t.type) state=$($t.state) label=$($t.label) bytes=$bytes sha=$sha stage=$stage"
    Save-Out ("poll_$i.txt") $row
    Save-Out "web_poll.txt" (($got | ConvertTo-Json -Depth 8))
    $log = (Invoke-Adb @("-s", $serial, "logcat", "-d", "-t", "200", "-s", "elfRemote:I")) | Out-String
    Save-Out "device_logcat.txt" $log
    $last = (Invoke-Su $serial "cat /data/local/elfremote/task.last 2>/dev/null; echo ---; cat /data/local/elfremote/task.phase 2>/dev/null") | Out-String
    Save-Out "task_last.txt" $last
    $idOk = ($t.id -eq $wantId)
    $typeOk = ($t.type -eq $taskType)
    $stateOk = ($t.state -eq "success")
    $logOk = ($log -match ("task " + $taskType))
    $contentOk = $false
    if ($taskType -eq "pull_logs") {
        $contentOk = ($sha -match "^[0-9a-f]{64}$") -and ($bytes -gt 0)
    } elseif ($taskType -eq "heal_network") {
        $contentOk = ($stage -eq "L9") -or ([string]$t.detail -eq "L9")
    } elseif ($taskType -eq "reboot") {
        $contentOk = (([string]$t.detail -eq "rebooted") -or ($stage -eq "reboot"))
        $logOk = $true
    } elseif ($taskType -eq "install_apk") {
        $contentOk = ($got.app_version -eq $ToName) -and (($stage -eq "install") -or ([string]$t.detail -eq $ToName))
        $logOk = $true
    } elseif ($taskType -eq "restart_adbd") {
        $txt = ""
        if ($t.result) { $txt = [string]$t.result.text }
        $contentOk = (([string]$t.detail -eq "adbd-5555") -or $txt.Contains("PORT=5555")) -and ($txt.Contains("lo") -or $txt.Contains("DROP"))
        $logOk = $true
    }
    if ($idOk -and $typeOk -and $stateOk -and $logOk -and $contentOk) {
        $ok = $true
        break
    }
}

$after = Invoke-RestMethod -Uri ($BaseUrl + "/api/devices") -Method GET
Save-Out "web_after.txt" (($after | ConvertTo-Json -Depth 8))
$pmn = (Invoke-Su $serial "dumpsys package net.elfradio.elfremote") | Out-String
Save-Out "pm_version.txt" $pmn
if ($ok) { Write-Host "TASK $taskType PASS"; exit 0 }
Write-Host "TASK $taskType FAIL"
exit 2
