param(
    [ValidateSet("A", "B", "C", "D", "P", "baseline")]
    [string]$Case = "baseline",
    [int]$AdbPort = 5037,
    [string]$Adb = "C:\Dev\android-sdk\platform-tools\adb.exe"
)

$ErrorActionPreference = "Stop"
$env:ANDROID_ADB_SERVER_PORT = "$AdbPort"
$Root = Split-Path -Parent $PSScriptRoot
$Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$CapRoot = Join-Path $Root ("captures\2026-09-05\v020-heal-" + $Case + "-" + $Stamp)
New-Item -ItemType Directory -Force -Path $CapRoot | Out-Null

function Invoke-Adb([string[]]$AdbArgs) {
    & $Adb -P $AdbPort @AdbArgs
}

function Get-LabSerial {
    Invoke-Adb @("start-server") | Out-Null
    for ($i = 0; $i -lt 20; $i++) {
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
        Start-Sleep 1
    }
    throw "No USB D22-class device"
}

function Save-Out([string]$Name, [string]$Text) {
    Set-Content -Path (Join-Path $CapRoot $Name) -Value $Text -Encoding utf8
}

function Invoke-Su([string]$Serial, [string]$Cmd) {
    Invoke-Adb @("-s", $Serial, "shell", "su", "-c", $Cmd)
}

function Get-NetSnap([string]$Serial) {
    Invoke-Su $Serial "export PATH=/system/bin:`$PATH; echo WIFI=`$(dumpsys wifi 2>/dev/null | grep -m1 mNetworkInfo); echo MAIN_ROUTE; ip route 2>/dev/null; echo TABLE_WLAN0; ip route show table wlan0 2>/dev/null; echo ADDR; ip addr show wlan0 2>/dev/null; echo DNS_PROP=`$(getprop net.dns1); echo AIR=`$(settings get global airplane_mode_on); echo NDC_NET; ndc network list 2>/dev/null; echo CONNECTIVITY; dumpsys connectivity 2>/dev/null | grep -E 'network[{]|DnsAddresses|InterfaceName: wlan0|0.0.0.0/0'; echo WIFI_IPCFG; dumpsys wifi 2>/dev/null | grep -E '^mDhcpResults|^IP assignment:|^Static configuration:'; echo SNAP; grep net_snap /data/data/net.elfradio.elfremote/shared_prefs/elfremote.xml 2>/dev/null; echo HEAL; cat /data/data/net.elfradio.elfremote/files/heal.log 2>/dev/null | tail -n 40; echo STATUS; dumpsys package net.elfradio.elfremote | grep versionName"
}

function Trigger-Report([string]$Serial) {
    Invoke-Su $Serial "export PATH=/system/bin:`$PATH; am start-foreground-service --user 0 -n net.elfradio.elfremote/.ReportService -a net.elfradio.elfremote.REPORT_NOW >/dev/null 2>&1 || am startservice --user 0 -n net.elfradio.elfremote/.ReportService -a net.elfradio.elfremote.REPORT_NOW"
}

function Clear-HealBlob([string]$Serial) {
    Invoke-Su $Serial "sed -i /heal_blob/d /data/data/net.elfradio.elfremote/shared_prefs/elfremote.xml; export PATH=/system/bin:`$PATH; am force-stop net.elfradio.elfremote; echo cleared"
}

function Get-TableWlan0Block([string]$Txt) {
    if ($Txt -match "(?s)TABLE_WLAN0\s*\r?\n(.*?)(?:\r?\nADDR|\r?\nDNS_PROP|\r?\nAIR=)") {
        return $Matches[1]
    }
    return ""
}

function Test-HasDefault([string]$Txt) {
    $block = Get-TableWlan0Block $Txt
    return ($block -match "default via \d")
}

function Test-DnsPoisoned([string]$Txt) {
    return ($Txt -match "DnsAddresses: \[[^\]]*127\.0\.0\.1")
}

function Test-DnsUsable([string]$Txt) {
    if (Test-DnsPoisoned $Txt) { return $false }
    return ($Txt -match "DnsAddresses: \[[^\]]*(\d+\.\d+\.\d+\.\d+)")
}

function Test-HealOk([string]$Txt, [string]$Stage, [string]$Action) {
    return ($Txt -match ("stage=" + $Stage + " action=" + $Action + " result=ok"))
}

function Get-WifiToolCmd([string]$Mode, [string]$Ipv4, [string]$Gw, [string]$Dns) {
    $apk = "/system/app/ElfRemote/ElfRemote.apk"
    $cls = "net.elfradio.elfremote.WifiIpTool"
    $launch = "/system/bin/app_process -Djava.class.path=$apk /system/bin $cls"
    if ($Mode -eq "dhcp") {
        return "export PATH=/system/bin:`$PATH; su 1000 -c '$launch dhcp'"
    }
    return "export PATH=/system/bin:`$PATH; su 1000 -c '$launch static $Ipv4 $Gw $Dns'"
}

$serial = Get-LabSerial
Write-Host "capture=$CapRoot case=$Case"
if ($Case -ne "baseline") {
    Save-Out "clear_blob.txt" ((Clear-HealBlob $serial) | Out-String)
    Start-Sleep 25
    Trigger-Report $serial
    Start-Sleep 8
}
$before = Get-NetSnap $serial
Save-Out "before.txt" ($before | Out-String)

if ($Case -eq "baseline") {
    Trigger-Report $serial
    Start-Sleep 8
    $after = Get-NetSnap $serial
    Save-Out "after.txt" ($after | Out-String)
    $txt = $after | Out-String
    $ok = (Test-HasDefault $txt) -and (Test-DnsUsable $txt) -and ($txt -match "versionName=0\.1\.10-d22xx-healrc")
    if ($txt -match "net_snap.*>[^<]*127\.") { $ok = $false }
    if (-not $ok) { Write-Host "BASELINE FAIL"; exit 2 }
    Write-Host "BASELINE PASS"
    exit 0
}

$beforeTxt = $before | Out-String
$nid = ""
$gw = ""
$ipv4 = ""
if ($beforeTxt -match "network\{(\d+)\}") { $nid = $Matches[1] }
if ($beforeTxt -match "TABLE_WLAN0[\s\S]{0,120}?default via (\d+\.\d+\.\d+\.\d+)") { $gw = $Matches[1] }
elseif ($beforeTxt -match "default via (\d+\.\d+\.\d+\.\d+)") { $gw = $Matches[1] }
if ($beforeTxt -match "inet (\d+\.\d+\.\d+\.\d+)/") { $ipv4 = $Matches[1] }
Save-Out "parsed_ids.txt" ("nid=$nid gw=$gw ipv4=$ipv4")
if ($Case -eq "B" -and ($nid.Length -eq 0 -or $gw.Length -eq 0)) {
    Write-Host "B FAIL: missing nid/gw from before snapshot"
    exit 2
}
if ($Case -eq "C" -and ($ipv4.Length -eq 0 -or $gw.Length -eq 0)) {
    Write-Host "C FAIL: missing ipv4/gw from before snapshot"
    exit 2
}

$inject = switch ($Case) {
    "A" { "svc wifi disable" }
    "B" { "export PATH=/system/bin:`$PATH; echo NID=$nid GW=$gw; ndc network route remove $nid wlan0 0.0.0.0/0 $gw; ip route del default table wlan0; echo TABLE; ip route show table wlan0; echo MAIN; ip route" }
    "C" { Get-WifiToolCmd "static" $ipv4 $gw "127.0.0.1" }
    "D" { "echo SKIP_NO_LOCAL_FIREWALL" }
    "P" { "settings put global airplane_mode_on 1; am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true" }
}

Save-Out "inject.txt" $inject
Save-Out "inject_out.txt" ((Invoke-Su $serial $inject) | Out-String)
$injected = $null
$injTxt = ""
if ($Case -eq "C") {
    $poisoned = $false
    for ($w = 1; $w -le 8; $w++) {
        Start-Sleep 4
        $injected = Get-NetSnap $serial
        Save-Out ("injected_$w.txt") ($injected | Out-String)
        $injTxt = $injected | Out-String
        if (Test-DnsPoisoned $injTxt) { $poisoned = $true; break }
    }
    Save-Out "injected.txt" $injTxt
    if (-not $poisoned) {
        Save-Out "c_restore_out.txt" ((Invoke-Su $serial (Get-WifiToolCmd "dhcp" "" "" "")) | Out-String)
        Write-Host "C FAIL: inject did not poison LinkProperties DNS"
        exit 2
    }
} else {
    Start-Sleep 3
    $injected = Get-NetSnap $serial
    Save-Out "injected.txt" ($injected | Out-String)
    $injTxt = $injected | Out-String
}
if ($Case -eq "B" -and (Test-HasDefault $injTxt)) {
    Write-Host "B FAIL: inject did not remove table wlan0 default"
    exit 2
}

Trigger-Report $serial
$deadline = (Get-Date).AddSeconds(90)
$ok = $false
$i = 0
while ((Get-Date) -lt $deadline) {
    $i++
    Start-Sleep 8
    Trigger-Report $serial
    $snap = Get-NetSnap $serial
    Save-Out ("poll_$i.txt") ($snap | Out-String)
    $txt = $snap | Out-String
    if ($Case -eq "P") {
        if ($txt -match "wait_physical" -or $txt -match "AIR=1") {
            if ($txt -notmatch "dhcpcd.*renew") { $ok = $true }
        }
        break
    }
    if ($Case -eq "D") {
        Save-Out "d_skip.txt" "no elfRemote firewall; L6 N/A"
        Write-Host "D SKIP N/A"
        exit 0
    }
    if ($Case -eq "A") {
        if ($txt -match "enable_wifi result=ok") { $ok = $true; break }
    }
    if ($Case -eq "B") {
        if ((Test-HasDefault $txt) -and (Test-HealOk $txt "L4" "restore_route")) { $ok = $true; break }
    }
    if ($Case -eq "C") {
        if ((-not (Test-DnsPoisoned $txt)) -and (Test-HealOk $txt "L5" "restore_dns")) { $ok = $true; break }
    }
}

if ($Case -eq "P") {
    Invoke-Su $serial "settings put global airplane_mode_on 0; am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false"
    Start-Sleep 5
    Trigger-Report $serial
    $end = (Get-Date).AddSeconds(90)
    $reonline = $false
    $j = 0
    while ((Get-Date) -lt $end) {
        $j++
        Start-Sleep 8
        Trigger-Report $serial
        $afterP = Get-NetSnap $serial
        Save-Out ("p_after_$j.txt") ($afterP | Out-String)
        if ((Test-HasDefault ($afterP | Out-String)) -and ($afterP | Out-String) -match "CONNECTED") { $reonline = $true; break }
    }
    Save-Out "after.txt" ((Get-NetSnap $serial) | Out-String)
    if ($ok -and $reonline) { Write-Host "P PASS physical then reonline"; exit 0 }
    Write-Host "P FAIL ok=$ok reonline=$reonline"
    exit 2
}

Save-Out "after.txt" ((Get-NetSnap $serial) | Out-String)
if ($Case -eq "C" -and -not $ok) {
    Save-Out "c_restore_out.txt" ((Invoke-Su $serial (Get-WifiToolCmd "dhcp" "" "" "")) | Out-String)
}
if ($ok) { Write-Host "$Case PASS"; exit 0 }
Write-Host "$Case FAIL"
exit 2
