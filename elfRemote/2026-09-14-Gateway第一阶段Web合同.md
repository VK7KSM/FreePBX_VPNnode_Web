# 2026-09-14 elfRemote Gateway 第一阶段 Web 合同

负责人：D22_Web_Dev。Pixel客户端、签名材料、安装和真机业务验收由SIP_Dev负责。本次复用现有设备后台，未创建第二套账号、设备列表或后台服务。

## 产品和更新隔离

| 字段 | 固定值 |
|---|---|
| 桌面名称 | elfRemote Gateway |
| `product_id` | `elfremote_gateway` |
| `app_package` | `org.onetwoone.gateway` |
| `model_id`、`model_hint` | `mdl_pixel3`、`Pixel 3` |
| 可选出厂身份的 `variant` | `pixel3` |
| 更新清单的 `channel` | `gateway` |
| 更新清单的 `package` | `org.onetwoone.gateway` |
| 更新清单的 `abi`、注册的 `app_abi` | `arm64-v8a` |
| 更新清单的 `certSha256`、注册的 `app_cert_sha256` | 已核实原应用证书摘要，与 `gateway-product.js` 固定值相同 |

SIP_Dev已核实实际安装基线是1.4.1、版本码6、13,184,605字节；不是仅根据源码推定的版本7。候选版本码必须大于6；原包名和原签名保持。证书摘要的上报是身份声明，不是远程硬件证明；客户端仍必须实际读取已装包和下载APK证书、包名、ABI和版本，逐项核验后才可安装。

普通Pixel型号登记不会自动取得Gateway更新渠道。注册、报告、重新安装恢复、管理员选型、发布清单、按设备列版本及更新分配均验证产品与型号/包名的对应关系。网关不能使用D22/D31发布通道。Gateway使用独立的发布列表及版本记录，旧版本清理继续复用每通道保留十版的现有机制。

## 注册与身份

复用 `POST /api/devices/enroll`：发送持久化的高熵随机 `token`、其小写SHA-256 `token_sha256`、上表注册字段、`device_name`、`app_version`、`os_version`。Gateway必须证明持有原始令牌，不使用只有哈希的旧式登记流程。

返回沿用 `device_id`、`code`、`enroll_id`、`expires_at`、`paired`。配对码一小时有效。`GET /api/devices/enroll-status?code=...&enroll_id=...` 沿用原协议。取得 `device_id` 后即可认证报告，网页配对决定长期保留设备记录。

无法读取可靠出厂地址时，省略 `hardware_identity`，由持久化令牌保持安装级身份。同包升级、重启不生成新令牌；清数据或刷机后不能承诺自动恢复原记录。不得把随机Wi-Fi地址、随机编号或Android占位MAC伪装成出厂地址。

若确有真实出厂Wi-Fi MAC，可发送 `hardware_identity:{variant:"pixel3",kind:"wifi_factory_mac",source:"android_wifi_factory",value:"实际出厂地址"}`。必须是全局单播地址，不能使用随机地址。不同产品不能通过已有网关的硬件身份退回普通登记并替换其凭证；旧安装令牌继续按现有恢复流程失效。

## 报告与推送

`POST /api/devices/report` 使用 `device_id`、`token`、`status_only:true`、唯一 `report_id`、UTC ISO格式 `reported_at`。同一样本失败重试必须复用原ID和正文，不能生成新的重复历史。注册产品字段可以重复发送；省略时沿用已绑定值，不能改变包名、签名和架构。

- `battery`：0至100数值或未知；`battery_present`、`charging`：布尔值或 `null`。
- `network`：`wifi`、`cellular`、`ethernet`、`unknown`。展示名称如4G、Cell不能代替协议值。
- `gateway`：仅保存并公开 `running`、`sip_registered`、`busy` 三个布尔值或 `null`；不认识的键丢弃，字符串形式的布尔值拒绝。密码、令牌、账号配置档案不通过这个状态对象回传。三项显示使用实际报告，未知不转换为成功或空闲。
- 能力字段每份报告发送完整当前快照，未实现为 `false`；不是仅发送本次变更的增量。
- 首阶段保持 `managed_media:false`、`managed_media_modes:[]`、`managed_media_prepare_v1:false`。服务器额外拒绝Gateway媒体会话；网页不显示连接、PTT、电话、麦克风、拍照、录像、媒体历史及空预览框，也不查询照片列表。

沿用 `POST /api/devices/push-config` 获取MQTT/TLS配置，沿用 `POST /api/devices/push-sync` 认证同步。Gateway同步成功后可直接领取已就绪能力的 `managed_task`、`managed_update`，无需等待GPS或完整采样；这些入口复用现有任务回执、更新回执和会话授权，不增加平行后台。MQTT通知收到后按原 `received_request_id`、`received_version` 确认；需要状态请求完成时，报告携带 `status_request_id`。

起始报告策略按计划每60秒提交轻量状态报告、每5分钟附带完整已实现状态；轻量报告也带完整能力快照，不主动采集照片或等待GPS。服务端对Gateway采用60秒预期间隔和原有传输余量，超时进入现有有界拉取补救，不套用D22蜂窝一小时规则。D22和D31原周期保持。本次不设置Gateway管理报告的每日字节额度。按10至15秒的HTTPS后备同步只能在MQTT不可用但HTTPS可用时启用，恢复MQTT后停止，HTTPS失败要退避；同步成功本身不替代状态报告刷新数据时间。

## 同包更新合同

清单签名、制品存储、上传与分配复用现有接口：`/api/elfremote/releases`、`/api/elfremote/releases/upload`、`/api/elfremote/assign`。生产签名公钥继续来自公共更新协议，不把APK签名私钥作为清单私钥。

清单使用 `channel`、`product_id`、`package`、`model_id`、`abi`、`versionCode`、`versionName`、`certSha256`、`size`、`sha256`、`job_id`、`expires_at`、`url`，可选 `device_id`。`url` 仍为 `https://v.elfradio.net/api/elfremote/apk/<job_id>`；Gateway清单必须有未来有效期。基线约13.2MB，现有64MiB制品上限足够第一阶段使用；这不是每日报告流量限制。后续加入代理核心如需更大制品，先核对上传/下载/存储与设备空间再调整，不能只改单端限制。

只有 `managed_update:true` 且 `managed_update_v2:true` 才显示更新入口并允许分配。收到 `managed_update` 后先对原始 `manifest_raw` 验证 `signature`，再核验清单产品约束。独立执行绑定使用 `task_id`、`task_device_id`、`task_expires_at`；不能为了替换执行编号而修改待验签原文。下载后验证实际APK，再执行安装；用 `/api/elfremote/update-progress` 回报真实阶段，健康检查通过才报 `success`。通话忙时延期安装由Pixel实际消费者实现，不能仅凭网页的可能过时 `busy` 判定可以替换进程。

本次没有发布Gateway APK、设置推荐或向任何设备分配候选。第一版全部能力为假时仍可登记、配对和报告。原地安装、自动更新和通话回归由SIP_Dev验证，Web测试不能代替真机结果。

## 后续能力边界

- 普通警报复用 `managed_alarm_tasks:true` 和 `/api/elfremote/task` 的 `play_alarm`、`stop_alarm`。通信终端直接入队，不建立媒体连接。状态和结果沿用普通任务；现有 `alarm` 回执的 `duration_ms` 最大10000，若需30秒循环规则须双方升级合同后再开启，不能宣称旧合同已支持。停止由明确停止任务或客户端有界超时完成。
- 网页交互终端复用 `managed_adb_session`；root命令使用 `managed_exec_tasks`。两者都不等于电脑原生ADB字节隧道；后者尚未实现，不上报已支持。
- 文件能力复用 `managed_file_operations`、`managed_file_tasks`、`managed_file_return`、`managed_file_delete`，按真实功能分别开启。网关设置和代理管理仍需后续专用白名单合同，不能错误启用D22的Linphone/Zello表单。
- 第一阶段不展示旧丢失模式页面、不接入自动擦除。Pixel精简丢失模式另行接线；不能为了打开页面虚报D22的危险操作能力。

## 源码来源与验证

公共Web基准为 `61e06c2`，D22参考为191。可复用 `device-identity.js`、`push-control.js`、`release-channels.js`、`elfRemote/control-plane.js`，以及D22的 `Protocol`、`PairingStore`、`CorePush`、轻量同步、`UpdatePolicy`、`UpdateTool`。D22包名、设备目录、系统写入命令和完整媒体调度不能原样复制到Pixel。

验证覆盖产品注册/恢复、无MAC安装级身份、状态白名单、错误包名/签名/ABI/型号/版本拒绝、通道筛选/分配/轻量领取、未登录或错误设备令牌拒绝、媒体拒绝、普通警报、前端能力显示和旧产品回归。最终发布提交、部署及浏览器复核结果随后追加。

## 发布与验收结果

2026-09-14悉尼11:13完成生产核验。实现提交 `f8655fa7c2f2e11604d50152a1df6fd4c2ed2178`；代码验证 `34794911781` 和Cloudflare部署 `34794911801` 均成功。Web全量579项通过，本地真实浏览器合成设备验证无页面脚本异常；只读阶段不显示未完成入口，未知忙闲保持未知，声明警报后点击使用普通任务，没有媒体预览。

生产 `gateway` 发布列表返回200且为空，Pixel型号注册键为 `pixel3`。线上设备脚本与本地构建摘要一致，设备页排除构建版本标记后逐字一致；生产标记为 `18970db3129169926fb7`。未向真实设备发送注册、警报、更新或其他管理任务，未上传Gateway APK。原始生产核验在主Web工作区 `.wrangler/gateway-live-*.json`，本地界面证据为 `output/playwright/gateway-first-stage.png`。

已主动通知SIP_Dev开始其负责的只读客户端注册联调；Pixel实际报告和后续同包更新仍须客户端真机验证。测试浏览器与预览服务器均已关闭，主工作区保留原未提交Web工作和SIP_Dev正在开发的客户端文件。当前CI权限不包含修改工作流权限，本批复用原有已匹配的文件路径触发部署；以后若只改新增产品模块而未触发发布，使用已有手动部署入口，不把推送成功当作部署成功。
