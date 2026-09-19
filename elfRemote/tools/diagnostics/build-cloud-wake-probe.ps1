param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [Parameter(Mandatory=$true)][string]$JavaDirectory,
    [Parameter(Mandatory=$true)][string]$SdkDirectory
)
$ErrorActionPreference='Stop'
$target=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $target){throw '输出目录已存在，禁止覆盖验证制品'}
New-Item -ItemType Directory -Path "$target/classes" -Force | Out-Null
Copy-Item -LiteralPath "$PSScriptRoot/CloudWakeProbe.java" -Destination "$target/CloudWakeProbe.java"
$android=Join-Path $SdkDirectory 'platforms/android-34/android.jar'
& "$JavaDirectory/bin/javac.exe" -encoding UTF-8 -source 8 -target 8 -bootclasspath $android -d "$target/classes" "$PSScriptRoot/CloudWakeProbe.java"
if($LASTEXITCODE -ne 0){throw '编译失败'}
& "$JavaDirectory/bin/jar.exe" cf "$target/classes.jar" -C "$target/classes" .
if($LASTEXITCODE -ne 0){throw '类文件打包失败'}
$oldJava=$env:JAVA_HOME
try{
    $env:JAVA_HOME=$JavaDirectory
    & "$SdkDirectory/build-tools/34.0.0/d8.bat" --lib $android --min-api 26 --output "$target/probe.zip" "$target/classes.jar"
    if($LASTEXITCODE -ne 0){throw 'DEX转换失败'}
}finally{$env:JAVA_HOME=$oldJava}
Get-FileHash -Algorithm SHA256 "$target/probe.zip"
