# elfRemote 原生 ADB 隧道

## 用途与边界

本功能让电脑上的标准 `adb` 通过本机回环端口连接远端 Android 设备。它独立于现有浏览器 ADB 终端，不修改浏览器终端的 JSON/Base64 协议。

设备必须明确上报 `managed_adb_tunnel_v1=true`。管理接口只允许已登录管理员调用；设备通过现有设备令牌认证的 `push-sync` 领取自己的连接邀请。

## 接口合同

管理员创建会话：

```http
POST /api/elfremote/adb-tunnel/session
Content-Type: application/json

{"device_id":"<设备编号>"}
```

成功响应包含：

```json
{
  "ok": true,
  "session_id": "<UUID>",
  "host_url": "wss://v.elfradio.net/api/elfremote/adb-tunnel/host?session_id=<UUID>",
  "host_token": "<64位十六进制令牌>",
  "expires_at": 0,
  "expires_at_unit": "unix_ms"
}
```

`push-sync` 额外返回：

```json
{
  "adb_tunnel": {
    "session_id": "<UUID>",
    "device_url": "wss://v.elfradio.net/api/elfremote/adb-tunnel/device?session_id=<UUID>",
    "token": "<64位十六进制令牌>",
    "expires_at": 0,
    "expires_at_unit": "unix_ms"
  }
}
```

两个 WebSocket 入口均使用 `Authorization: Bearer <令牌>`。URL 查询参数只能包含 `session_id`，令牌不得放入 URL。

管理员可查询及关闭会话：

```http
GET /api/elfremote/adb-tunnel/session?session_id=<UUID>
DELETE /api/elfremote/adb-tunnel/session
Content-Type: application/json

{"session_id":"<UUID>"}
```

## 传输和清理规则

- host 与 device 使用不同的一次性令牌，每端只允许一个连接。
- 只转发二进制帧，不解析或记录 ADB 载荷。
- 单帧最大 64 KiB，单方向等待队列最大 1 MiB。
- 会话最长 30 分钟；60 秒内未建立双端连接自动关闭；双端连接后 20 分钟没有字节流量自动关闭。
- 任一端断开、发生错误、超限或到期时，另一端同时关闭，令牌和等待队列立即清空。
- Wi-Fi 与移动数据切换时，客户端必须主动关闭旧 WebSocket；旧 ADB TCP 字节流不得续传。MQTT 恢复后应创建全新会话。
- WebSocket 关闭原因使用：`peer_closed`、`peer_error`、`binary_required`、`frame_too_large`、`backpressure_limit`、`peer_send_failed`、`connect_timeout`、`idle_timeout`、`absolute_timeout`、`session_replaced`、`admin_closed`。

## 本地桥接工具

先设置一次性 host 令牌，再启动工具：

```powershell
$env:ELFREMOTE_ADB_TUNNEL_TOKEN='<host_token>'
node tools/elfremote-adb-tunnel.mjs --url '<host_url>'
```

工具只监听 `127.0.0.1` 的随机端口，并输出实际命令：

```text
adb connect 127.0.0.1:<随机端口>
```

工具只接受一个本地 TCP 连接，不记录令牌、ADB 私钥或 ADB 载荷。进程退出或任一端断开时，本地 TCP、WebSocket 和监听端口一并关闭。
