param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [Parameter(Mandatory=$true)][string]$JavaDirectory,
    [Parameter(Mandatory=$true)][string]$SdkDirectory
)
$ErrorActionPreference='Stop'
$simulationOutput=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $simulationOutput){throw '输出目录已存在，禁止覆盖原始制品'}
New-Item -ItemType Directory -Path "$simulationOutput/classes" -Force | Out-Null
Copy-Item -LiteralPath "$PSScriptRoot/LocationSimulationProbe.java" -Destination "$simulationOutput/LocationSimulationProbe.java"
$simulationAndroid=Join-Path $SdkDirectory 'platforms/android-34/android.jar'
& "$JavaDirectory/bin/javac.exe" -encoding UTF-8 -source 8 -target 8 -bootclasspath $simulationAndroid -d "$simulationOutput/classes" "$simulationOutput/LocationSimulationProbe.java"
if($LASTEXITCODE -ne 0){throw '编译失败'}
& "$JavaDirectory/bin/jar.exe" cf "$simulationOutput/classes.jar" -C "$simulationOutput/classes" .
if($LASTEXITCODE -ne 0){throw '类文件打包失败'}
$simulationPreviousJava=$env:JAVA_HOME
try {
    $env:JAVA_HOME=$JavaDirectory
    & "$SdkDirectory/build-tools/34.0.0/d8.bat" --lib $simulationAndroid --min-api 26 --output "$simulationOutput/probe.zip" "$simulationOutput/classes.jar"
    if($LASTEXITCODE -ne 0){throw 'DEX转换失败'}
}finally{$env:JAVA_HOME=$simulationPreviousJava}
Get-FileHash -Algorithm SHA256 "$simulationOutput/probe.zip"
