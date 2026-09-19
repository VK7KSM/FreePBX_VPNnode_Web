# Pixel3 GSM-SIP 网关

把高通 Android 手机变成 GSM 与 SIP 之间的网关：公网手机来电/短信进内部分机，内部分机经 SIM 卡打出公网号码。当前生产机是 **Pixel 3 XL**，SIP 账号 **300**，对接 `sip.elfradio.net`。

安装包不进 Git，请到仓库 [Releases](https://github.com/VK7KSM/FreePBX_VPNnode_Web/releases) 下载。Pixel 3 XL 首次部署前请先阅读 [Root 与 Magisk 安装流程](docs/pixel3-root-magisk.md)。

## 当前版本

| 项 | 值 |
|---|---|
| 源码候选版本 | 1.5.0-gateway-alpha70-desktop-deadlock-fix |
| versionCode | 77 |
| 当前生产机已安装版本 | 1.5.0-gateway-alpha69-desktop-contain，versionCode 76；77 待远程下发 |
| 包名 | `org.onetwoone.gateway` |
| 已验证设备 | Pixel 3 XL（`crosshatch`，Android 12） |
| SIP | TLS `sip.elfradio.net:5061`，账号 300 |

**alpha70 变更（2026-09-19）：** 修远程桌面死锁。它不只让桌面用不了，还会把整台设备的上报一起拖死，面板上表现为「报告超时」、所有按钮变灰，而进程活着、SIP 照常注册、`last_error` 为空。`kill -3` 拿到的线程栈里是一对互指的 Blocked：会话线程在 `finish()` 里持有会话锁、等 `WebSocketImpl` 的锁；WebSocket 读线程在 `onClose` 里持有 `WebSocketImpl` 的锁、等会话锁。两道闸都补上：`finish()` 与 `close()` 不再握着会话锁去关 WebSocket；`accept()` 去掉 `synchronized`，它跑在上报线程上，绝不能阻塞。**第二道比第一道重要**——第一道只防这一个死锁，第二道防以后任何一种会话侧阻塞再拖垮上报。一个功能的缺陷不该有能力让整台设备失联。

**alpha69 变更（2026-09-19）：** 编码尺寸由设备按 contain 计算。面板报播放区的宽高（`display_w` / `display_h`，物理像素），设备拿它和 `realSize()` 求 `scale = min(boxW/screenW, boxH/screenH, 1)`，编码长边取 `max(screenW,screenH) × scale`。这个计算只有设备做得准：只有它同时知道自己的屏幕和面板报来的播放区，转屏后还能立刻取到新的屏幕尺寸。缩放比封顶 1，编得比原生大纯属浪费。

**alpha68 变更（2026-09-19）：** 周期上报新增 `location_state`，面板据此能分清「定位被关了」和「还没定到」，不再一律退回 IP 定位。取值 `{"enabled":bool,"reason":...,"gps":bool,"fused":bool,"network":bool}`，`reason` 为 `ok` / `location_disabled` / `permission_denied` / `provider_unavailable`。只报开关与权限状态，不含坐标，也不改任何定位设置。判定优先级刻意排成「没有定位服务 > 没有权限 > 总开关关闭 > 可用」，写反会把权限被拒报成定位已关闭，把人指去改一个改不好的地方。任一来源可用即算可用，不要求 GPS 开着。

**alpha67 候选变更（2026-09-19）：** 远程桌面画质改为按浏览器实际显示尺寸推导。

码率不再用固定值，按「长边 × 短边 × 帧率 × 0.12 比特」算，短边按屏幕真实纵横比推，长边取 8 的倍数。WiFi 帧率由 30 降到 15（远程管理够用）。面板在会话创建时把浏览器显示区域的长边随 `max_size` 下发，设备端按它编码；面板没报时退回 1280（移动档 720），**不退回上限**，否则盲发就按最贵的档走。尺寸上限与面板的夹逼范围对齐到 1920（移动档 960），两边不一致会让浏览器报的大尺寸被设备端悄悄压回去，表现是大窗画面偏软却查不出原因。

`bound()` 里把缺失、0 与越小的 `max_size` 一律抬到 1280：**scrcpy 把 `max_size=0` 解释成「不限制」**，会按整块 1440×2960 编码，像素是 1280 档的四倍，和「没指定就省着来」正好相反。

**alpha66 候选变更（2026-09-19）：** 修复远程桌面连不上。两层原因叠加：一是 Android 的 libcore 里 `new Socket(Proxy)` 只认 SOCKS 与 NO_PROXY，给 HTTP 型会抛 `IllegalArgumentException: Invalid Proxy`（桌面 JDK 有 HTTP 分支不抛，本机复现不出来），而 Java-WebSocket 正是用这个构造器建连；二是 `GatewayProxyWebSocket` 本就是「先试代理、失败再直连」，代理那次失败必然先回调一次 `onError`，`GatewayDesktopSession` 当时没有 `GatewayAdbSessions` 那道建连阶段的闸，于是会话被当场判死，随后直连成功的 `onOpen` 成了空响。WebSocket 改走 SOCKS，并补上建连阶段的闸。

**alpha65 候选变更（2026-09-19）：** 加入设备自助管理链接与远程桌面两项。

*自助管理链接*：远程管理页的「生成管理链接」向面板 `/api/devices/share-link` 申请一条短链接，本地生成二维码显示。屏幕上只有网址，没有密码；默认免密一小时，改密码与有效期在网页里做。二维码库是 Nayuki 的 qrcodegen（MIT），许可原文随 APK 放在 `assets/licenses/`。

*远程桌面*：官方 scrcpy 3.3.3 服务端随 APK 原样分发（Apache-2.0，`assets/scrcpy-server`，SHA-256 `7e70323b…5354be0`）。核心（root）校验哈希后把它放到 `/data/local/elfremote-gateway/desktop`，目录 `0711`、文件 `0644`，只让 uid 2000 读得到；核心目录 `/data/local/elfremote-gateway/core` 里存着核心认证口令，仍是 `0700` 不放宽，父目录只从 `0700` 改到 `0711`，给「可穿越」不给「可列目录」。

scrcpy 以 `su 2000` 拉起。它对系统服务自称 `com.android.shell`，剪贴板等服务会校验调用方 uid，所以不能用 root 跑。Magisk 的 su 只降 uid、不改 SELinux 域，子进程仍在 `u:r:magisk:s0`；策略里有 `allow untrusted_app_all magisk unix_stream_socket { getopt connectto }`，而网关应用跑在 `untrusted_app_27`（带 `untrusted_app_all` 属性），因此应用进程能直连 scrcpy 的抽象套接字，核心一个字节都不转发。既有的 `@elfremote_gateway_core_v1` 也是靠这条规则工作的。

视频与控制各走一条有序 DataChannel，与浏览器经 STUN/TURN 直连，面板只转发信令。**只建数据通道，不建音频轨、不建摄像头轨、不抢音频焦点**，GSM 与 SIP 通话链路不受影响。20 分钟无操作自动关闭。只有核心里确实装好了 scrcpy 才上报 `managed_desktop_v1`，否则面板不会给这台设备放行远程桌面。

一个和 D22 不同的坑：Android 12 的 `ps` 不显示完整参数，`pkill -f scid=<n>` 匹配不到，按 scid 结束改成直接读 `/proc/<pid>/cmdline` 匹配，连 su 与 app_process 两层一起收掉，并轮询到确认消失。

**alpha26 候选变更：** 在 alpha25 的Pixel生产Magisk模块只读识别基础上，增加严格白名单的`pixel_runtime`状态报告。报告只包含资源核验、模式、识别、启用、写锁及两个既有模块的只读状态，不上传路径、哈希或异常原文，不开放模块写操作。该候选已通过95项单元测试、APK静态核验和当前生产Pixel 3 XL的Web远程覆盖更新验收；管理端严格合同已接受完整schema 1状态，网关、SIP、MQTT、供电、音频权限、模块和业务配置基线均未回退。

**1.4.2 变更：** 出站短信按正文 `SMS <号码>: <内容>` 发送，不再要求 SIP From 等于 SIM 目的分机。102、106 等有短信权限的分机经 PBX 改写后都可以经 300 发 GSM 短信。To 已是 10–15 位号码的 MESSAGE 仍直发。乱正文仍拒绝。

**1.4.1 变更：** PBX 送来的、Request-URI 为公网号码的呼叫，不再要求主叫必须是「SIM 呼入目的分机」。通话组里允许外呼的分机（如 104）都可以经 300 打出。直连网关、用 DTMF 拨号的旧模式仍只用 SIM 目的分机白名单。

## 和面板怎么配合

权限在 **大阪 Asterisk + Web 面板**，不在网关手机上重复做一份。

- **呼出：** 分机所在通话组有出口网关，且该分机「外呼」为允许。面板保存后大阪写入 `SIP/outbound`、`SIP/extgw`。网关只负责把 PBX 打过来的号码送到 GSM。
- **呼入：** 面板网关账户的「呼入转发」才是电话落地分机；「短信转发」可指向同组另一个分机。手机上的 SIM 目的号只要非空，网关才会向 PBX 发 INVITE；真正转给谁由大阪 `SIP/gwin` / `SIP/gwsms` 决定。
- **短信：** 入站以面板 `SIP/gwsms` 为准。出站正文由大阪改写成 `SMS <号码>: <内容>`。1.4.2 起网关按该正文发 GSM，不再核对 From 是否为 SIM 目的分机。

不要在网关里再维护一份分机外呼名单。

## 远程桌面排查

- **码率异常偏高、画面看着却没动**：先怀疑动态壁纸。2026-09-19 这台机的壁纸是 `SoundVizWallpaperV2`，整屏渐变一直在缓慢流动，屏幕从来没有真正静止过，静置时仍有 2183 kbps。用 `dumpsys wallpaper | grep mWallpaperComponent` 看是不是 `com.android.systemui/.ImageWallpaper`（静态图），不是就说明在跑动态壁纸。同类现象在别的机型上也会出现，而且极难往壁纸上想。
- **想知道参数有没有生效**：看应用侧 `files/desktop/log/runtime-*.log` 里的 `DESKTOP_ENCODING`，它记录本次实际用的尺寸、帧率、码率和面板请求值。网页上的实时码率与它一对，就能分清是持续重绘还是参数没落地。
- **压帧率或压码率没用**：实测过，单独把帧率压到 10 或把码率压到 600k 都只省 16%，改 VBR 反而更高。**长边尺寸是唯一有效的杠杆**，1280→960 省 36%，→800 省 46%，→640 省 67%，→480 省 83%。
- **画面糊但带宽没跑满**：多半是显示区域太小而不是编码不够。面板小窗约 340 像素高，而编码长边可能是 1280，多出来的像素在显示时被缩掉了。点面板上的占满窗口，清晰度是白捡的，不多传一个字节；按新尺寸重新编码要下次连接才生效。
- **会话连上了却什么都不发生**：看 `DESKTOP_CONNECT_ATTEMPT_FAILED`，它表示代理那次尝试失败、直连兜底还在跑，是预期内的；如果它后面没有 `DESKTOP_CONNECTED`，才是真的连不上。

## 定位排查

- **面板显示「IP · 2000m」**：设备一个定位来源都没拿到，上报里没有定位字段，面板才退回 IP。`adb shell dumpsys location` 看 `gps` / `fused` / `network` 三段的 `enabled` 与 `allowed`。
- **Android 10 以后没有单独的 GPS 开关**。快捷设置里那个「位置信息」是总开关，一关三个来源一起 `enabled=false`，`settings get secure location_mode` 会是 `0`。所以「我只关了 GPS」实际是把 WiFi 与基站定位一起关了，这一条不查 dumpsys 想不到，查了一目了然。
- **`enabled` 和 `allowed` 是两回事**。2026-09-19 遇到过总开关打开后 `gps` 与 `fused` 的 `allowed=true` 而 `network` 是 `false`，也就是 WiFi/基站定位单独还不通。要在手机上打开「设置 → 位置信息 → 位置信息服务 → Google 位置信息准确度」，并打开同一页的「WiFi 扫描」。打开后实测从 IP 两公里变成 GPS 62 米。
- **只开 WiFi 与基站定位是正当配置**，固定设备本来就该这么配，所以 `location_state` 里任一来源可用即算可用，不要求 GPS 开着。

## 重启网关应用：只启动主界面是不够的

`am force-stop` 之后启动 `MainActivity`，起来的只有 `PjsipSipService`，**`GatewayRemoteService` 不会跟着起**，于是 SIP 恢复了、上报仍然是停的，面板上依旧「报告超时」。2026-09-19 事故现场就在这里白花了时间。

```bash
am force-stop org.onetwoone.gateway
am start -n org.onetwoone.gateway/.MainActivity
am start-foreground-service -n org.onetwoone.gateway/.remote.GatewayRemoteService
```

第三条不能省。用 `dumpsys activity services org.onetwoone.gateway` 确认两个 `ServiceRecord` 都在，再看 `last_report` 是否在 60 秒内更新过。

## 怎么确认设备到底发了什么

**查服务端落库结果，不要在设备上抢瞬时文件。** 上报报文只在发送前短暂写进 `pending_report`，成功后立刻清掉；2026-09-19 按 3 秒一次轮询了 60 秒一次都没抓到，因为每次上报都很快成功。而面板存下来的字段值等于反向证明了设备实际发出去的内容，可靠得多也省事得多。

## 运行要求

- 高通芯片手机，需要 root（建议 Magisk）
- SELinux 保持 Enforcing，不要全局放开 `/dev/snd`
- 至少一张可通话的 SIM
- SIP 服务器域名与证书一致，默认校验 TLS

## 安装

1. 从 Releases 下载 `GSM-SIP-Gateway-1.4.2.apk`
2. USB 安装：`adb install -r GSM-SIP-Gateway-1.4.2.apk`
3. 授予电话、短信、麦克风、拨号角色等权限
4. 在应用里填写：服务器 `sip.elfradio.net`、端口 `5061`、开启 TLS、网关账号 300
5. SIM1 目的分机填一个真实分机号（例如 101），保证 GSM 呼入会发 INVITE；呼入最终转到谁仍以面板为准

回退时使用当时从手机拉出的备份或对应 Releases 安装包，不要用 Git 里的源码冒充已装包。

## 编译

需要 JDK 17、Android SDK 36、NDK 25.1.8937393、CMake 3.22.1。复制 `local.properties.example` 为 `local.properties` 并填 SDK 路径。

```powershell
$env:JAVA_HOME="C:\path\to\jdk-17"
java -classpath gradle\wrapper\gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain testDebugUnitTest assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`。PJSIP 预编译库在 `app/src/main/jniLibs/arm64-v8a/`。只有要重编 PJSIP 时才需要 `pjsip-build/`。

## 目录说明

| 路径 | 内容 |
|---|---|
| `app/src/main/java` | 网关应用与 PJSIP 绑定 |
| `app/src/main/jniLibs` | `libpjsua2.so` 等 arm64 库 |
| `app/src/main/assets/scrcpy-server` | 官方 scrcpy 3.3.3 服务端，原样分发，供远程桌面使用 |
| `app/src/main/assets/licenses` | 随 APK 分发的第三方许可原文（qrcodegen、scrcpy、WebRTC） |
| `app/src/test` | 单元测试 |
| `pjsip-build` | 从源码重编 PJSIP 的脚本和补丁 |
| `asterisk-config` | 历史示例拨号，**不是** 当前大阪生产配置 |
| `privapp-permissions-gateway.xml` | 系统特权应用权限样例 |
