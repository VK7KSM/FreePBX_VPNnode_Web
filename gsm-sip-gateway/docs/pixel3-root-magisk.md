# Pixel 3 XL Root 与 Magisk 安装流程

本文整理本项目 Pixel 3 XL 网关设备在 2026 年 7 月实际完成的 bootloader 解锁、启动分区备份、Magisk 修补与 Root 验证过程。适用机型仅为 Pixel 3 XL，设备代号为 `crosshatch`。

## 重要警告

- 解锁 bootloader 会清除用户数据。开始前必须完成备份，并确认设备属于获授权测试范围。
- `boot.img` 必须与目标设备当前构建完全一致。刷入其他型号、其他系统版本或其他安全补丁级别的镜像可能导致设备无法启动。
- 不要把本文保存的哈希当成所有 Pixel 3 XL 的通用镜像。本文哈希只对应本项目保留的 `SP1A.210812.016.B2` 制品。
- Root 会降低 Android Verified Boot 的完整性保证。完成后仍应保持 SELinux 为 `Enforcing`，并只授予确有需要的应用永久 Root 权限。
- 本仓库不分发 Magisk、TWRP、Google 原厂镜像、原始启动分区或修补后的启动镜像。相关程序应从各自官方来源取得。

## 已确认的设备基线

| 项目 | 已确认值 |
|---|---|
| 机型 | Pixel 3 XL |
| 设备代号 | `crosshatch` |
| Android | Android 12 |
| 构建编号 | `SP1A.210812.016.B2` |
| 构建指纹 | `google/crosshatch/crosshatch:12/SP1A.210812.016.B2/8602260:user/release-keys` |
| 活动插槽 | `_a` |
| Magisk | 30.7，版本码 30700 |
| Zygisk | 未启用 |
| SELinux | `Enforcing` |

2026 年 9 月的只读复核确认：bootloader 仍处于解锁状态，Verified Boot 状态为 `orange`，MagiskSU 可用，活动 `boot_a` 的 SHA-256 与 2026 年 7 月保留的 Magisk 修补镜像完全一致。

## 当时保留的制品证据

以下文件保存在项目所有者的本地研究目录中，不上传公开仓库：

| 本地文件 | 大小 | SHA-256 | 用途 |
|---|---:|---|---|
| `boot_a_SP1A.210812.016.B2_original.img` | 67108864 | `49473d0a1a262479beeb4a7cf9593ee37d26720a26ed5e92db6c03df7237c59b` | 修补前的原始活动启动分区 |
| `magisk_patched-30700_boot_a.img` | 67108864 | `0c46eee1d144ecceb2910cbe4c26e3cc27ff639af9647481e310426626c2462a` | Magisk 30.7 生成并实际运行的启动镜像 |
| `Magisk-v30.7.apk` | 11613864 | `e0d32d2123532860f97123d927b1bb86c4e08e6fd8a48bfc6b5bee0afae9ebd5` | 当时使用的 Magisk 应用 |
| `twrp-3.7.1_12-0-crosshatch.img` | 67108864 | `a9b49a93ae68be69381ddf57f1810b92f16ab6d19a117fa93726c68857997868` | 用于无 Root 环境读取原始启动分区的临时恢复镜像 |

同时保留的界面证据显示：Magisk 采用“选择并修补一个文件”，刷入后主页显示当前版本 30.7、Ramdisk 为“是”，后续超级用户页面显示网关应用和 Android Shell 均已获得授权。

当时的终端逐字日志没有完整保留。因此，下文将制品、时间线和当前状态能够直接证明的步骤标为“已确认”，把用于复现的命令标为“复原命令”。复原命令在再次使用前仍需核对目标设备实际状态。

## 准备工具

1. 从 Google 官方页面取得适用于当前系统的 Platform Tools。
2. 从 Magisk 官方 GitHub 项目取得经过核验的 Magisk APK。
3. 从 TWRP 官方来源取得 Pixel 3 XL `crosshatch` 对应镜像，并核对发布方校验值。
4. 使用可靠的数据线，保证电量充足，并准备可恢复的设备数据备份。

以下示例假设 `adb` 与 `fastboot` 已加入环境变量。连接多台设备时必须显式使用序列号，不能让工具自动选择任意目标。

## 一、检查设备与解锁状态

先在 Android 系统中打开“开发者选项”“OEM 解锁”和“USB 调试”，然后读取基本信息：

```powershell
adb devices -l
adb shell getprop ro.product.device
adb shell getprop ro.build.id
adb shell getprop ro.build.fingerprint
adb shell getprop ro.boot.slot_suffix
```

设备代号必须为 `crosshatch`。如果 bootloader 尚未解锁，复原流程为：

```powershell
adb reboot bootloader
fastboot devices
fastboot flashing unlock
```

在手机屏幕上确认解锁。此操作会清除用户数据。设备重新初始化后再次打开 USB 调试。

本项目当前设备已确认 `ro.boot.flash.locked=0`、`ro.boot.vbmeta.device_state=unlocked`。当时解锁动作本身没有保留逐字终端日志，因此不能把上述命令输出冒充为历史原始记录。

## 二、读取并保存原始启动分区

本项目保留了与活动 `_a` 插槽、构建 `SP1A.210812.016.B2` 对应的 64 MiB 原始启动分区。结合当时下载的 TWRP 镜像和文件时间线，可复原为临时启动 TWRP 后读取分区；不要把 TWRP 永久刷入启动分区。

```powershell
adb reboot bootloader
fastboot getvar current-slot
fastboot boot twrp-3.7.1_12-0-crosshatch.img
```

等待 TWRP 的 ADB 可用，再读取活动启动分区。以下示例使用 `_a`，实际操作必须以 `current-slot` 为准：

```powershell
adb shell "dd if=/dev/block/by-name/boot_a of=/sdcard/boot_a_original.img bs=4M"
adb pull /sdcard/boot_a_original.img .\boot_a_original.img
Get-FileHash .\boot_a_original.img -Algorithm SHA256
```

必须把原始镜像、构建编号、活动插槽、大小和 SHA-256 一起保存。没有原始镜像时，不应开始永久刷写。

## 三、使用 Magisk 修补原始镜像

安装 Magisk 应用并把原始镜像放到手机可选择的位置：

```powershell
adb install -r .\Magisk-v30.7.apk
adb push .\boot_a_original.img /sdcard/Download/boot_a_original.img
```

在 Magisk 中依次选择：

1. Magisk 区域的“安装”。
2. “选择并修补一个文件”。
3. 选择 `/sdcard/Download/boot_a_original.img`。
4. 等待修补完成，记录输出文件名。

将输出文件拉回电脑并计算哈希：

```powershell
adb shell "ls -l /sdcard/Download/magisk_patched-*.img"
adb pull /sdcard/Download/<实际输出文件名> .\magisk_patched_boot.img
Get-FileHash .\magisk_patched_boot.img -Algorithm SHA256
```

本项目最终保留的修补镜像 SHA-256 为 `0c46eee1d144ecceb2910cbe4c26e3cc27ff639af9647481e310426626c2462a`。

## 四、刷入活动插槽

再次确认型号、构建、活动插槽和两个镜像的哈希。设备已经解锁后，进入 bootloader：

```powershell
adb reboot bootloader
fastboot devices
fastboot getvar current-slot
```

本项目设备当时和当前均使用插槽 `_a`，对应复原命令为：

```powershell
fastboot flash boot_a .\magisk_patched_boot.img
fastboot reboot
```

如果实际活动插槽为 `_b`，必须使用经过该设备当前构建原始 `boot_b` 修补得到的镜像，不能直接复用本文的 `boot_a` 文件或哈希。

## 五、启动后验证

系统启动后，打开 Magisk，确认当前版本和 Ramdisk 状态。然后执行只读验证：

```powershell
adb shell su -c id
adb shell su -c "magisk -v; magisk -V; su -v"
adb shell getenforce
adb shell getprop ro.boot.slot_suffix
adb shell getprop ro.boot.flash.locked
adb shell getprop ro.boot.verifiedbootstate
```

本项目设备当前结果为：

- `su -c id` 返回 `uid=0(root)`；
- Magisk 为 30.7，版本码 30700；
- 活动插槽为 `_a`；
- SELinux 为 `Enforcing`；
- `boot_a` SHA-256 与保留的修补镜像一致。

安装 `elfRemote Gateway` 后，还必须在 Magisk 超级用户页面为包名 `org.onetwoone.gateway`授予永久 Root 权限。ADB Shell 获得 Root 不代表网关应用已经获得授权。

## 六、恢复原始启动镜像

若 Magisk 启动镜像造成异常，进入 bootloader，把同一设备、同一构建、同一插槽对应的原始镜像刷回：

```powershell
adb reboot bootloader
fastboot devices
fastboot getvar current-slot
fastboot flash boot_a .\boot_a_original.img
fastboot reboot
```

设备无法进入 Android 但仍能进入 bootloader 时，可以用实体按键进入 bootloader 后执行相同恢复。恢复前再次核对镜像大小和 SHA-256。

## 七、与 elfRemote Gateway 的关系

Root 与 Magisk 是首次部署前置条件，不应由普通 APK 利用漏洞静默完成。环境准备完成后：

1. 安装 `elfRemote Gateway`。
2. 为 `org.onetwoone.gateway`授予永久 Root 权限。
3. 客户端核对设备型号、构建、Magisk及现有模块。
4. 新设备缺少已登记模块时，才允许执行带清单、哈希和回滚的初始化部署。
5. 已存在且哈希正确的生产模块进入`legacy_managed`只读纳管，不卸载、不覆盖、不重装。
6. 模块状态、网关进程、SIP、MQTT、ADB、SELinux和音频节点全部通过后，设备才算完成网关初始化。

首次 Root 必须在设备交付前完成。已经异地部署、bootloader 锁定且没有现场人员确认的设备，不能依靠 `elfRemote Gateway`可靠地远程 Root。
