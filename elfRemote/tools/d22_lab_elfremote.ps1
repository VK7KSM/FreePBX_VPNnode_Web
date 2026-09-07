param(
    [ValidateSet("observe", "deploy", "accept", "kill", "reboot", "lab")]
    [string]$Action = "observe",
    [int]$AdbPort = 5037,
    [string]$Adb = "C:\Dev\android-sdk\platform-tools\adb.exe"
)

$ErrorActionPreference = "Stop"
$env:ANDROID_ADB_SERVER_PORT = "$AdbPort"
$Root = Split-Path -Parent $PSScriptRoot
$Apk = Join-Path $Root "app\build\outputs\apk\debug\app-debug.apk"
$WdDir = Join-Path $PSScriptRoot "watchdog"
$Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$CapRoot = Join-Path $Root ("captures\2026-09-05\v014-watchdog-" + $Action + "-" + $Stamp)
New-Item -ItemType Directory -Force -Path $CapRoot | Out-Null

function Invoke-Adb {
    param([Parameter(Mandatory = $true)][string[]]$AdbArgs)
    & $Adb -P $AdbPort @AdbArgs
}

function Get-LabSerial {
    Invoke-Adb -AdbArgs @("start-server") | Out-Null
    for ($i = 0; $i -lt 20; $i++) {
        $lines = Invoke-Adb -AdbArgs @("devices", "-l")
        $lines | Out-File -FilePath (Join-Path $CapRoot "adb_devices.txt") -Encoding utf8
        foreach ($line in $lines) {
            if ($line -notmatch "^\S+\s+device\b") { continue }
            if ($line -match "product:msm8909") { continue }
            $id = ($line -split "\s+")[0]
            if ($id -match ":") { continue }
            if ($id -eq "0") { continue }
            return $id
        }
        Start-Sleep -Seconds 1
    }
    throw "No USB D22-class device on port $AdbPort"
}

function Save-Out([string]$Name, [string]$Text) {
    Set-Content -Path (Join-Path $CapRoot $Name) -Value $Text -Encoding utf8
}

function Convert-UnixLf([string]$Src, [string]$Dst) {
    $t = [IO.File]::ReadAllText($Src) -replace "`r`n", "`n" -replace "`r", "`n"
    $enc = New-Object System.Text.UTF8Encoding $false
    [IO.File]::WriteAllText($Dst, $t, $enc)
}

function Invoke-RemoteSh([string]$Serial, [string]$LocalSh, [string]$RemoteName) {
    $remote = "/data/local/tmp/$RemoteName"
    $lf = Join-Path $CapRoot $RemoteName
    Convert-UnixLf $LocalSh $lf
    Invoke-Adb -AdbArgs @("-s", $Serial, "push", $lf, $remote) | Out-Null
    $out = Invoke-Adb -AdbArgs @("-s", $Serial, "shell", "su", "-c", "sh $remote")
    return ($out | Out-String)
}

$serial = Get-LabSerial
Write-Host "capture=$CapRoot action=$Action"

if ($Action -eq "observe") {
    $t = Invoke-RemoteSh $serial (Join-Path $WdDir "observe.sh") "elfremote_observe.sh"
    Save-Out "observe.txt" $t
    Write-Host $t
    exit 0
}

if ($Action -eq "deploy") {
    if (-not (Test-Path $Apk)) { throw "missing APK $Apk" }
    $apkHash = (Get-FileHash -Algorithm SHA256 $Apk).Hash
    Save-Out "apk_sha256.txt" $apkHash
    Copy-Item $Apk (Join-Path $CapRoot "ElfRemote.apk")
    $before = Invoke-RemoteSh $serial (Join-Path $WdDir "observe.sh") "elfremote_observe.sh"
    Save-Out "before.txt" $before
    Invoke-Adb -AdbArgs @("-s", $serial, "push", $Apk, "/data/local/tmp/ElfRemote.apk")
    Convert-UnixLf (Join-Path $WdDir "watchdog.sh") (Join-Path $CapRoot "watchdog.sh")
    Convert-UnixLf (Join-Path $WdDir "magisk.sh") (Join-Path $CapRoot "magisk.sh")
    Convert-UnixLf (Join-Path $WdDir "elfremote.rc") (Join-Path $CapRoot "elfremote.rc")
    Invoke-Adb -AdbArgs @("-s", $serial, "push", (Join-Path $CapRoot "watchdog.sh"), "/data/local/tmp/elfremote_watchdog.sh")
    Invoke-Adb -AdbArgs @("-s", $serial, "push", (Join-Path $CapRoot "magisk.sh"), "/data/local/tmp/elfremote_magisk.sh")
    Invoke-Adb -AdbArgs @("-s", $serial, "push", (Join-Path $CapRoot "elfremote.rc"), "/data/local/tmp/elfremote.rc")
    $dep = Invoke-RemoteSh $serial (Join-Path $WdDir "deploy.sh") "elfremote_deploy.sh"
    Save-Out "deploy_out.txt" $dep
    Write-Host $dep
    $after = Invoke-RemoteSh $serial (Join-Path $WdDir "observe.sh") "elfremote_observe.sh"
    Save-Out "after_deploy.txt" $after
    Write-Host $after
    Write-Host "deploy done; reboot still required for init.rc parse and system APK rescan"
    exit 0
}

if ($Action -eq "accept") {
    $obs = Invoke-RemoteSh $serial (Join-Path $WdDir "observe.sh") "elfremote_observe.sh"
    Save-Out "accept.txt" $obs
    Write-Host $obs
    $cpu = Invoke-RemoteSh $serial (Join-Path $WdDir "cpu10s.sh") "elfremote_cpu10s.sh"
    Save-Out "cpu10s.txt" $cpu
    Write-Host $cpu
    $fail = @()
    if ($obs -notmatch "versionName=0\.1\.11-d22xx-upda") { $fail += "version" }
    if ($obs -notmatch "elfremote_pid=\d+") { $fail += "app-pid" }
    if ($obs -notmatch "wd_pid=\d+") { $fail += "wd-pid" }
    if ($obs -notmatch "loudtalks_pid=\d+") { $fail += "talk-app-missing" }
    if ($obs -match "codex_zello_kiosk=stopped") { $fail += "codex-zello-stopped" }
    if ($obs -match "mCurrentFocus=.*elfremote") { $fail += "stole-focus" }
    if ($cpu -match "wd_dt=(\d+)") {
        if ([int]$Matches[1] -gt 20) { $fail += "wd-cpu" }
    } else {
        $fail += "cpu-parse"
    }
    if ($cpu -match "wd_VmRSS_kb=(\d+)") {
        if ([int]$Matches[1] -gt 4096) { $fail += "wd-rss" }
    }
    if ($cpu -match "app_VmRSS_kb=(\d+)") {
        if ([int]$Matches[1] -gt 65536) { $fail += "app-rss" }
    }
    Save-Out "accept_fail.txt" ($fail -join "`n")
    if ($fail.Count -gt 0) {
        Write-Host "ACCEPT FAIL: $($fail -join ',')"
        exit 2
    }
    Write-Host "ACCEPT PASS (observe+cpu; kill/reboot not in this action)"
    exit 0
}

if ($Action -eq "kill") {
    $before = Invoke-RemoteSh $serial (Join-Path $WdDir "observe.sh") "elfremote_observe.sh"
    Save-Out "before_kill.txt" $before
    $killed = Invoke-Adb -AdbArgs @("-s", $serial, "shell", "su", "-c", "am force-stop net.elfradio.elfremote; echo killed")
    Save-Out "kill_cmd.txt" ($killed | Out-String)
    Start-Sleep -Seconds 45
    $after = Invoke-RemoteSh $serial (Join-Path $WdDir "observe.sh") "elfremote_observe.sh"
    Save-Out "after_kill_25s.txt" $after
    Write-Host $after
    if ($after -match "elfremote_pid=\d+") {
        Write-Host "KILL PASS: app back within 45s"
        exit 0
    }
    Write-Host "KILL FAIL: app not back"
    exit 2
}

if ($Action -eq "reboot") {
    $before = Invoke-RemoteSh $serial (Join-Path $WdDir "observe.sh") "elfremote_observe.sh"
    Save-Out "before_reboot.txt" $before
    Invoke-Adb -AdbArgs @("-s", $serial, "reboot")
    Write-Host "reboot issued; USB may drop. Re-run observe after device returns."
    exit 0
}

if ($Action -eq "lab") {
    $before = Invoke-RemoteSh $serial (Join-Path $WdDir "observe.sh") "elfremote_observe.sh"
    Save-Out "before.txt" $before
    Write-Host "==== BEFORE ===="
    Write-Host $before
    try {
        Invoke-Adb -AdbArgs @("-s", $serial, "pull", "/system/app/ElfRemote/ElfRemote.apk", (Join-Path $CapRoot "ElfRemote_pre.apk"))
    } catch {
        Write-Host "pre apk pull skipped"
    }
    if (-not (Test-Path $Apk)) { throw "missing APK $Apk" }
    Save-Out "apk_sha256.txt" ((Get-FileHash -Algorithm SHA256 $Apk).Hash)
    Invoke-Adb -AdbArgs @("-s", $serial, "push", $Apk, "/data/local/tmp/ElfRemote.apk")
    Convert-UnixLf (Join-Path $WdDir "watchdog.sh") (Join-Path $CapRoot "watchdog.sh")
    Convert-UnixLf (Join-Path $WdDir "magisk.sh") (Join-Path $CapRoot "magisk.sh")
    Convert-UnixLf (Join-Path $WdDir "elfremote.rc") (Join-Path $CapRoot "elfremote.rc")
    Invoke-Adb -AdbArgs @("-s", $serial, "push", (Join-Path $CapRoot "watchdog.sh"), "/data/local/tmp/elfremote_watchdog.sh")
    Invoke-Adb -AdbArgs @("-s", $serial, "push", (Join-Path $CapRoot "magisk.sh"), "/data/local/tmp/elfremote_magisk.sh")
    Invoke-Adb -AdbArgs @("-s", $serial, "push", (Join-Path $CapRoot "elfremote.rc"), "/data/local/tmp/elfremote.rc")
    $dep = Invoke-RemoteSh $serial (Join-Path $WdDir "deploy.sh") "elfremote_deploy.sh"
    Save-Out "deploy_out.txt" $dep
    Write-Host "==== DEPLOY ===="
    Write-Host $dep
    Start-Sleep -Seconds 3
    $after = Invoke-RemoteSh $serial (Join-Path $WdDir "observe.sh") "elfremote_observe.sh"
    Save-Out "after_deploy.txt" $after
    Write-Host "==== AFTER DEPLOY ===="
    Write-Host $after
    $cpu = Invoke-RemoteSh $serial (Join-Path $WdDir "cpu10s.sh") "elfremote_cpu10s.sh"
    Save-Out "cpu10s.txt" $cpu
    Write-Host "==== CPU 10s ===="
    Write-Host $cpu
    $fail = @()
    if ($after -notmatch "wd_pid=\d+") { $fail += "wd-pid" }
    if ($after -notmatch "loudtalks_pid=\d+") { $fail += "talk-app-missing" }
    if ($after -match "codex_zello_kiosk=stopped") { $fail += "codex-zello-stopped" }
    if ($after -match "mCurrentFocus=.*elfremote") { $fail += "stole-focus" }
    if ($cpu -match "wd_dt=(\d+)") {
        if ([int]$Matches[1] -gt 20) { $fail += "wd-cpu" }
    } else { $fail += "cpu-parse" }
    if ($cpu -match "wd_VmRSS_kb=(\d+)") {
        if ([int]$Matches[1] -gt 4096) { $fail += "wd-rss" }
    }
    if ($cpu -match "app_VmRSS_kb=(\d+)") {
        if ([int]$Matches[1] -gt 65536) { $fail += "app-rss" }
    }
    $verOk = $after -match "versionName=0\.1\.11-d22xx-upda"
    Save-Out "accept_soft.txt" ("version_014=" + $verOk + "`nfail=" + ($fail -join ","))
    if ($fail.Count -gt 0) {
        Write-Host "LAB RESOURCE/INDEPENDENCE FAIL: $($fail -join ',')"
        exit 2
    }
    Write-Host "LAB 4.0 PASS; version_014=$verOk ; starting kill test last"
    $killed = Invoke-Adb -AdbArgs @("-s", $serial, "shell", "su", "-c", "am force-stop net.elfradio.elfremote; echo killed")
    Save-Out "kill_cmd.txt" ($killed | Out-String)
    Start-Sleep -Seconds 45
    $killafter = Invoke-RemoteSh $serial (Join-Path $WdDir "observe.sh") "elfremote_observe.sh"
    Save-Out "after_kill_45s.txt" $killafter
    $wdlog = Invoke-Adb -AdbArgs @("-s", $serial, "shell", "su", "-c", "sh -c 'tail -n 40 /data/local/tmp/elfremote_wd.log'")
    Save-Out "wd_log.txt" ($wdlog | Out-String)
    Write-Host "==== AFTER KILL 25s ===="
    Write-Host $killafter
    Write-Host "==== WD LOG ===="
    Write-Host ($wdlog | Out-String)
    if ($killafter -notmatch "elfremote_pid=\d+") {
        Write-Host "KILL FAIL: app not back"
        exit 2
    }
    if ($killafter -notmatch "loudtalks_pid=\d+") {
        Write-Host "KILL FAIL: talk app missing after respawn"
        exit 2
    }
    Write-Host "KILL PASS. Reboot not run in this action; USB drop would need operator."
    exit 0
}
