param(
    [Parameter(Mandatory = $true)][int]$ToCode,
    [Parameter(Mandatory = $true)][string]$ToName,
    [string]$ExpectState = "success",
    [switch]$CorruptHash,
    [string]$ExpectName = "",
    [int]$AdbPort = 5042,
    [string]$Adb = "C:\Dev\android-sdk\platform-tools\adb.exe",
    [string]$BaseUrl = "https://v.elfradio.net"
)

$ErrorActionPreference = "Stop"
$env:ANDROID_ADB_SERVER_PORT = "$AdbPort"
$Root = Split-Path -Parent $PSScriptRoot
$Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$CapRoot = Join-Path $Root ("captures\2026-09-05\v021-upd45-" + $ToCode + "-" + $Stamp)
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

function Get-CertSha([string]$Apk) {
    $out = & $Apksigner verify --print-certs $Apk 2>&1 | Out-String
    Save-Out "apksigner.txt" $out
    if ($out -match "SHA-256 digest:\s*([0-9a-fA-F:]+)") {
        return ($Matches[1] -replace ":", "").ToLowerInvariant()
    }
    throw "cannot read APK cert"
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

if ($ExpectName.Length -eq 0) { $ExpectName = $ToName }
$serial = Get-LabSerial
Write-Host "capture=$CapRoot serial_present=1 to=$ToName expect=$ExpectState/$ExpectName"

$env:JAVA_HOME = $JavaHome
Push-Location $Root
try {
    & .\gradlew.bat --no-daemon assembleDebug "-PelfVerCode=$ToCode" "-PelfVerName=$ToName"
    if ($LASTEXITCODE -ne 0) { throw "assembleDebug failed" }
} finally {
    Pop-Location
}
$Apk = Join-Path $Root "app\build\outputs\apk\debug\app-debug.apk"
Copy-Item $Apk (Join-Path $CapRoot "B.apk")
$apkHash = (Get-FileHash -Algorithm SHA256 $Apk).Hash.ToLowerInvariant()
$apkLen = (Get-Item $Apk).Length
$cert = Get-CertSha $Apk
Save-Out "apk_sha256.txt" $apkHash
Save-Out "apk_meta.txt" ("size=$apkLen cert=$cert")

$devices = Invoke-RestMethod -Uri ($BaseUrl + "/api/devices") -Method GET
$dev = $null
foreach ($d in $devices.devices) {
    if ($d.app_version -and $d.app_version -like "0.1.1*") { $dev = $d; break }
}
if (-not $dev) { foreach ($d in $devices.devices) { if ($d.online) { $dev = $d; break } } }
if (-not $dev) { throw "no online elfRemote device on control plane" }
$devId = [string]$dev.id
Save-Out "web_before.txt" ("app_version=" + $dev.app_version + "`nupdate_state=" + $dev.update.state + "`nupdate_target=" + $dev.update.target)

$jobId = -join ((1..16) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) })
$expires = [DateTimeOffset]::UtcNow.AddHours(6).ToUnixTimeMilliseconds()
$man = [ordered]@{
    package = "net.elfradio.elfremote"
    versionCode = $ToCode
    versionName = $ToName
    size = [int]$apkLen
    sha256 = $(if ($CorruptHash) { "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } else { $apkHash })
    certSha256 = $cert
    url = $BaseUrl + "/api/elfremote/apk/" + $jobId
    job_id = $jobId
    expires_at = $expires
    device_id = $devId
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
$pubPath = Join-Path $CapRoot "publish.json"
# avoid writing huge apk into captures twice; only hash of body
Save-Out "publish_meta.txt" ("job_id=" + $jobId + "`nsig_len=" + $sigObj.signature.Length)
$pubRes = Invoke-RestMethod -Uri ($BaseUrl + "/api/elfremote/releases") -Method POST -ContentType "application/json; charset=utf-8" -Body $pubBody
Save-Out "publish_res.txt" ($pubRes | ConvertTo-Json -Compress)
if (-not $pubRes.ok) { throw "publish failed" }

Invoke-Su $serial "export PATH=/system/bin:`$PATH; am start-foreground-service --user 0 -n net.elfradio.elfremote/.ReportService -a net.elfradio.elfremote.REPORT_NOW >/dev/null 2>&1 || true"
$deadline = (Get-Date).AddMinutes(8)
$i = 0
$ok = $false
while ((Get-Date) -lt $deadline) {
    $i++
    Start-Sleep 8
    try { $serial = Wait-Usb $serial } catch { continue }
    Invoke-Su $serial "export PATH=/system/bin:`$PATH; am start-foreground-service --user 0 -n net.elfradio.elfremote/.ReportService -a net.elfradio.elfremote.REPORT_NOW >/dev/null 2>&1 || true" | Out-Null
    $web = Invoke-RestMethod -Uri ($BaseUrl + "/api/devices") -Method GET
    $cur = $null
    foreach ($d in $web.devices) { if ($d.id -eq $devId) { $cur = $d; break } }
    $pm = (Invoke-Su $serial "dumpsys package net.elfradio.elfremote | grep versionName") | Out-String
    $state = ""
    if ($cur -and $cur.update) { $state = [string]$cur.update.state }
    $target = ""
    $vc = 0
    if ($cur -and $cur.update) {
        $target = [string]$cur.update.target
        $vc = [int]$cur.update.versionCode
    }
    $row = "i=$i state=$state web_ver=$($cur.app_version) target=$target vc=$vc pm=$($pm.Trim())"
    Save-Out ("poll_$i.txt") $row
    Save-Out "web_poll.txt" (($cur | ConvertTo-Json -Depth 6))
    $pmOk = $pm -match [regex]::Escape($ExpectName)
    $targetOk = ($target -eq $ToName) -and ($vc -eq $ToCode)
    if ($state -eq $ExpectState -and $cur.app_version -eq $ExpectName -and $pmOk -and $targetOk) {
        $ok = $true
        break
    }
}

$afterPm = (Invoke-Su $serial "dumpsys package net.elfradio.elfremote | grep versionName; echo ---; cat /data/local/elfremote/update.state 2>/dev/null; echo ---; cat /data/local/elfremote/update.out 2>/dev/null | tail -n 40") | Out-String
Save-Out "after_device.txt" $afterPm
$webFinal = Invoke-RestMethod -Uri ($BaseUrl + "/api/devices") -Method GET
Save-Out "web_after.txt" (($webFinal | ConvertTo-Json -Depth 6))
if ($ok) { Write-Host "4.5 PASS to=$ToName"; exit 0 }
Write-Host "4.5 FAIL to=$ToName"
exit 2
