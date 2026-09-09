param(
    [Parameter(Mandatory=$true)][ValidateSet('BootstrapBridgeProbe','CellularWindow')][string]$Probe,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [Parameter(Mandatory=$true)][string]$JavaDirectory,
    [Parameter(Mandatory=$true)][string]$SdkDirectory,
    [string]$ClientClasses
)
$ErrorActionPreference='Stop'
$target=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $target){throw '输出目录已存在，禁止覆盖制品'}
if($Probe -eq 'BootstrapBridgeProbe' -and !(Test-Path -LiteralPath $ClientClasses)){throw '需要同版本客户端的Java类目录'}
New-Item -ItemType Directory -Path "$target/classes" | Out-Null
Copy-Item -LiteralPath "$PSScriptRoot/$Probe.java" -Destination "$target/$Probe.java"
$android=Join-Path $SdkDirectory 'platforms/android-34/android.jar'
$compile=@('-encoding','UTF-8','-source','8','-target','8','-bootclasspath',$android)
if($ClientClasses){$compile+=@('-cp',$ClientClasses)}
& "$JavaDirectory/bin/javac.exe" @compile -d "$target/classes" "$target/$Probe.java"
if($LASTEXITCODE -ne 0){throw '编译失败'}
& "$JavaDirectory/bin/jar.exe" cf "$target/classes.jar" -C "$target/classes" .
if($LASTEXITCODE -ne 0){throw '打包失败'}
$previousJava=$env:JAVA_HOME
try {
    $env:JAVA_HOME=$JavaDirectory
    & "$SdkDirectory/build-tools/34.0.0/d8.bat" --lib $android --min-api 26 --output "$target/probe.zip" "$target/classes.jar"
    if($LASTEXITCODE -ne 0){throw 'DEX转换失败'}
} finally { $env:JAVA_HOME=$previousJava }
Get-FileHash -Algorithm SHA256 "$target/probe.zip"
