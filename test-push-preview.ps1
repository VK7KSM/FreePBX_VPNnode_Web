param(
    [string]$Origin = 'https://elfremote-push-preview.kangarooo-network.workers.dev',
    [string]$AdminFile = '.wrangler/push-preview-admin.json'
)
$ErrorActionPreference = 'Stop'
if ($Origin -ne 'https://elfremote-push-preview.kangarooo-network.workers.dev') { throw '该写测试仅允许指定隔离预览环境' }
$admin = Get-Content $AdminFile -Raw | ConvertFrom-Json
$session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
$headers = @{'User-Agent'='elfRemote-preview-test/1.0'}
function Call-Api($path, $body) {
    Invoke-RestMethod ($Origin + $path) -Method Post -ContentType 'application/json' -Headers $headers -WebSession $session -Body ($body | ConvertTo-Json -Depth 10 -Compress)
}
$login = Call-Api '/api/login' @{username=$admin.username;password=$admin.password}
if (!$login.ok) { throw '预览登录失败' }
$bytes=[byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token=[Convert]::ToHexString($bytes).ToLowerInvariant()
$hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($token))).ToLowerInvariant()
$id=$null
try {
    $enroll=Call-Api '/api/devices/enroll' @{token_sha256=$hash;app_version='preview-fixture';model_hint='D22'}
    $models=Invoke-RestMethod ($Origin+'/api/device-models') -Headers $headers -WebSession $session
    $model= $models.models | Where-Object { $_.name -eq 'D22' } | Select-Object -First 1
    if (!$model) { throw '预览型号列表缺少 D22' }
    $paired=Call-Api '/api/devices/pair' @{code=$enroll.code;model_id=$model.id;name='推送模拟测试'}
    $id=$paired.device.id
    $connection=(Call-Api '/api/devices/push-config' @{device_id=$id;token=$token}).connection
    if (!$connection.password -or !$connection.tls) { throw '未获得有效 TLS 连接参数' }
    # 仅记录临时用户名供清理；不保存连接密码或设备令牌。
    $connection.username | Set-Content -Encoding utf8 '.wrangler/push-preview-fixture-user.txt'
    $sent=Call-Api '/api/devices/request-status' @{device_id=$id}
    if (!$sent.request.published -or $sent.request.state -ne 'pending') { throw '真实发布未被接受' }
    $sync=Call-Api '/api/devices/push-sync' @{device_id=$id;token=$token}
    if ($sync.status_request.request_id -ne $sent.request.request_id) { throw '补领编号不一致' }
    $report=Call-Api '/api/devices/report' @{device_id=$id;token=$token;status_only=$true;report_id=[guid]::NewGuid().ToString();status_request_id=$sent.request.request_id;app_version='preview-fixture'}
    if (!$report.ok) { throw '模拟状态回执失败' }
    $state=Invoke-RestMethod ($Origin+'/api/devices/status-request?device_id='+[uri]::EscapeDataString($id)) -Headers $headers -WebSession $session
    if ($state.request.state -ne 'completed') { throw '请求未由设备回执完成' }
    Write-Output '通过：真实预览 Worker 登录、配对、连接配置、发布、补领和状态回执闭环；设备为模拟身份'
} finally {
    if ($id) { Call-Api '/api/devices/delete' @{id=$id;confirm=$true} | Out-Null }
    Call-Api '/api/logout' @{} | Out-Null
}
