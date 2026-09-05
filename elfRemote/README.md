# elfRemote

D22 / H13 / D31 / Pixel 3 的远程配置客户端。第一刀只做一件事：设备和 `v.elfradio.net/devices` 控制面通信。

包名：`net.elfradio.elfremote`  
当前版本：`0.1.0-d22xx-control-plane`  
试验机：D22-XX（Android 8.1）

## 这一刀做什么

1. 设备申请六位配对码并显示在屏幕上。
2. 管理员在设备管理页输入该码，完成配对。
3. 设备定时 HTTPS 上报；网页绿点表示**控制面在线**（最近 120 秒有心跳）。
4. 「远程 ADB」保持未接入。互联网 ADB 隧道不是本刀范围。

## 这一刀要不要改网页？

要，但只改通信必需部分：

- Worker 增加 `/api/devices/enroll`、`/api/devices/enroll-status`、`/api/devices/report`，并把 `/api/devices/pair` 从空壳改成真配对。
- 设备管理页：六码配对真正生效；在线点按 `last_seen`；10 秒刷新；标明控制面 / ADB 分离。

不改页面三块布局，不加新功能按钮。

## 协议摘要

| 接口 | 谁调用 | 作用 |
| --- | --- | --- |
| `POST /api/devices/enroll` | 设备 | 提交令牌哈希，取得六位码 |
| `GET /api/devices/enroll-status` | 设备 | 询问是否已在网页确认 |
| `POST /api/devices/pair` | 网页（已登录） | 消耗六位码，创建设备 |
| `POST /api/devices/report` | 设备 | 心跳：版本、网络、电量 |
| `GET /api/devices` | 网页 | 列表；`online` 由 `last_seen` 120 秒判定 |

设备令牌只留在机内，KV 只存 SHA-256。文档和日志不写令牌、不写完整设备序列号。

## 安装方式

elfRemote 是普通用户应用，不依赖 USB 调试，也不依赖每次 root。

1. **普通安装（产品主路径）**  
   下载 APK，用系统安装器安装。首次打开点「授予远程配置所需权限」（忽略电池优化、尝试放到桌面）。联网、开机启动、前台服务在安装时申请。
2. **打进 D22 刷机包（可选）**  
   按 `D22.md` 已有做法放到 `/system/app/ElfRemote/`（不要放 `priv-app`），与 LinphoneD22 同类。这只是出厂预装，应用仍按普通应用要权限。
3. **D22 厂家策略**  
   现行 D22 的 PackageManager 会拒绝非平台签名的 `adb install` / `pm install`（`INSTALL_FAILED_USER_RESTRICTED`）。实验室第一次预装用上面第 2 条；日常给用户的仍是可下载 APK。不要用 Magisk 模块或每次 USB 装包当产品流程。

编译：

```bat
set JAVA_HOME=C:\Users\x\.jdks\jdk-17.0.20.1+1
cd elfRemote
gradlew.bat assembleDebug
```

制品：`app/build/outputs/apk/debug/app-debug.apk`。

若心跳发不出，检查 AFWall+ 是否放行 `net.elfradio.elfremote`。

## 目录

```text
elfRemote/
  README.md
  control-plane.js          Worker 共用的在线判定和配对码
  control-plane.test.mjs
  app/                      Android 工程
  art/elfradio-icon.png     启动器图标原图
```

## 明确不做（本刀）

更新助手、Mihomo、网络自愈全阶梯、D31 配置总线、远程 ADB 隧道、丢失模式。
