# Pixel3 GSM-SIP 网关

把高通 Android 手机变成 GSM 与 SIP 之间的网关：公网手机来电/短信进内部分机，内部分机经 SIM 卡打出公网号码。当前生产机是 **Pixel 3 XL**，SIP 账号 **300**，对接 `sip.elfradio.net`。

安装包不进 Git，请到仓库 [Releases](https://github.com/VK7KSM/FreePBX_VPNnode_Web/releases) 下载。

## 当前版本

| 项 | 值 |
|---|---|
| 版本名 | 1.4.1 |
| versionCode | 6 |
| 包名 | `org.onetwoone.gateway` |
| 已验证设备 | Pixel 3 XL（`crosshatch`，Android 12） |
| SIP | TLS `sip.elfradio.net:5061`，账号 300 |

**1.4.1 变更：** PBX 送来的、Request-URI 为公网号码的呼叫，不再要求主叫必须是「SIM 呼入目的分机」。通话组里允许外呼的分机（如 104）都可以经 300 打出。直连网关、用 DTMF 拨号的旧模式仍只用 SIM 目的分机白名单。

## 和面板怎么配合

权限在 **大阪 Asterisk + Web 面板**，不在网关手机上重复做一份。

- **呼出：** 分机所在通话组有出口网关，且该分机「外呼」为允许。面板保存后大阪写入 `SIP/outbound`、`SIP/extgw`。网关只负责把 PBX 打过来的号码送到 GSM。
- **呼入：** 面板网关账户的「呼入转发」才是电话落地分机；「短信转发」可指向同组另一个分机。手机上的 SIM 目的号只要非空，网关才会向 PBX 发 INVITE；真正转给谁由大阪 `SIP/gwin` / `SIP/gwsms` 决定。
- **短信：** 同样以面板 `SIP/gwsms` 为准。1.4.1 起，PBX 发来的、收件人为公网号码的 SIP MESSAGE 也不再要求主叫必须是 SIM 目的分机。

不要在网关里再维护一份分机外呼名单。

## 运行要求

- 高通芯片手机，需要 root（建议 Magisk）
- SELinux 保持 Enforcing，不要全局放开 `/dev/snd`
- 至少一张可通话的 SIM
- SIP 服务器域名与证书一致，默认校验 TLS

## 安装

1. 从 Releases 下载 `GSM-SIP-Gateway-1.4.1.apk`
2. USB 安装：`adb install -r GSM-SIP-Gateway-1.4.1.apk`
3. 授予电话、短信、麦克风、拨号角色等权限
4. 在应用里填写：服务器 `sip.elfradio.net`、端口 `5061`、开启 TLS、网关账号 300
5. SIM1 目的分机填一个真实分机号（例如 101），保证 GSM 呼入会发 INVITE；呼入最终转到谁仍以面板为准

回退到安装 1.4.1 之前的包时，使用当时从手机拉出的备份，不要用 Git 里的源码冒充已装包。

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
| `app/src/test` | 单元测试 |
| `pjsip-build` | 从源码重编 PJSIP 的脚本和补丁 |
| `asterisk-config` | 历史示例拨号，**不是** 当前大阪生产配置 |
| `privapp-permissions-gateway.xml` | 系统特权应用权限样例 |
