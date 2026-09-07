param([ValidateRange(1,100)][int]$Samples = 5, [switch]$IncludeTraffic,
    [ValidateSet('XX','JJ','BB')][string]$Device = 'XX')
$ErrorActionPreference='Stop'
$targetFile=if($Device -eq 'XX'){'.wrangler/d22-preview-device.json'}else{'.wrangler/d22-'+$Device.ToLowerInvariant()+'-preview-device.json'}
$target=Get-Content $targetFile -Raw|ConvertFrom-Json
$origin='https://elfremote-push-preview.kangarooo-network.workers.dev'
if($target.origin -ne $origin -or !$target.device_id){throw '缺少已核对的 D22 预览配对信息'}
$admin=Get-Content '.wrangler/push-preview-admin.json' -Raw|ConvertFrom-Json
$session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
$headers=@{'User-Agent'='elfRemote-preview-test/1.0'}
$results=[Collections.Generic.List[object]]::new()
$suffix=if($Device -eq 'XX'){'-d22-push-samples'}else{'-d22-'+$Device.ToLowerInvariant()+'-push-samples'}
$directory='elfRemote/captures/2026-09-07/'+(Get-Date -Format 'yyyyMMdd-HHmmss')+$suffix
New-Item -ItemType Directory -Path $directory -Force|Out-Null
Invoke-RestMethod ($origin+'/api/login') -Method Post -ContentType 'application/json' -Body ($admin|ConvertTo-Json -Compress) -WebSession $session -Headers $headers|Out-Null
try{
    for($i=1;$i -le $Samples;$i++){
        $watch=[Diagnostics.Stopwatch]::StartNew()
        $request=Invoke-RestMethod ($origin+'/api/devices/request-status') -Method Post -ContentType 'application/json' -Body (@{device_id=$target.device_id}|ConvertTo-Json -Compress) -WebSession $session -Headers $headers
        $state=$request.request
        do{
            Start-Sleep -Milliseconds 250
            $state=(Invoke-RestMethod ($origin+'/api/devices/status-request?device_id='+[uri]::EscapeDataString($target.device_id)) -WebSession $session -Headers $headers).request
        }while($state.state -eq 'pending' -and $watch.Elapsed.TotalSeconds -lt 15)
        $watch.Stop()
        $row=[ordered]@{sample=$i;elapsed_ms=$watch.ElapsedMilliseconds;state=$state.state;published=$request.request.published;completed_at=$state.completed_at}
        if($IncludeTraffic){
            $devices=(Invoke-RestMethod ($origin+'/api/devices') -WebSession $session -Headers $headers).devices
            $selectedDevice=$devices|Where-Object { $_.id -eq $target.device_id }|Select-Object -First 1
            $row.traffic=$selectedDevice.traffic
        }
        $results.Add([pscustomobject]$row)
        if($IncludeTraffic -and !$row.traffic.available){throw '设备流量采样不可用'}
        if($state.request_id -ne $request.request.request_id -or $state.state -ne 'completed'){throw '设备请求未在窗口内完成，保留失败样本'}
    }
}finally{
    $results|ConvertTo-Json -Depth 5|Set-Content -Encoding utf8 "$directory/api-status-samples.json"
    Invoke-RestMethod ($origin+'/api/logout') -Method Post -ContentType 'application/json' -Body '{}' -WebSession $session -Headers $headers|Out-Null
    $results|Format-Table -AutoSize
    Write-Output ('记录目录：'+$directory)
}
