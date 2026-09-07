# MQTT 自建节点

2026-09-07：按项目所有者决定，复用甲骨文节点一运行轻量 Mosquitto，替代尚未开通的托管 EMQX。现有 `stream.elfradio.net`、XRay 和 CF 隧道保持原配置。设备入口为 `mqtt.elfradio.net:8883`，DNS 不开启 CF 代理；普通 CF 隧道不能直接替代原生 MQTT/TLS 入口。

## 部署

- Ubuntu 22.04 软件包：`mosquitto`、`mosquitto-clients`、`certbot`、`python3-paho-mqtt`。没有安装容器或管理控制台。
- 先为域名配置正确 DNS，确认 80 和 8883 入站可达。80 只用于证书申请和自动续期的临时验证监听，不能随后关闭而不调整续期方式。
- 使用 Certbot 的独立 HTTP 验证取得证书后，检查脚本，首次运行 `sudo sh install.sh`。脚本拒绝覆盖既有项目配置；证书申请和系统软件安装不隐含在脚本中。
- 凭据原件保存在服务器 `/etc/elfremote-mqtt/credentials.json`，目录权限 0700、文件 0600；只允许服务器管理员读取，不能提交 GitHub 或写入日志。
- `sudo python3 /usr/local/lib/elfremote-mqtt/provision.py <用户名>` 创建独立设备连接身份，重复运行保留原密码；加 `--delete` 删除凭据。该本机工具供后续控制面接线使用，尚未实现设备自动发放接口。
- 设备只接收 `elfremote/<用户名>/notify`；`control-plane` 只能发布通知。主题 ACL 是设备协议隔离，不是管理员操作审批。通知仍需后续实现编号、过期和应用去重。
- `certbot.timer` 自动续期，部署钩子仅处理本项目证书并重载 Mosquitto。私钥副本权限为 root 所有、mosquitto 组可读，0640。

## 验证与边界

运行 `sudo python3 smoke.py` 验证可信 TLS、匿名和错误密码拒绝、通知送达、跨设备读取隔离以及禁止设备发布通知。测试使用 Paho 实现 MQTT 协议；临时账号在结束时删除。中断或断电后若遗留 `test-` 账号，核对没有在运行的测试再通过凭据工具删除。

公网 TLS 还需从节点外验证主机名和证书信任链。部署后检查 `systemctl show xray cloudflared -p MainPID -p ActiveState` 与部署前一致，检查 MQTT 只监听 8883，不暴露明文 1883。

本步骤只建立 MQTT 服务，尚不代表 Worker 发布接口、设备自动配发身份、Android 推送通道或 24 小时流量验收已完成。后续复用 CF 隧道增加受服务凭据保护的本机发布/发放入口，经 Worker 发通知；设备状态仍经已有 HTTPS 回传，不建设双向桥。

## 回退

停止并禁用 Mosquitto，移走本项目 `/etc/mosquitto/conf.d/elfremote.conf`，保留凭据和证书以便恢复；若完全撤销服务，再删除新增 MQTT DNS 记录与项目证书续期钩子。不要删除现有 XRay、隧道配置或重启其它服务。回退操作必须按实际范围执行，不能用卸载整机组件代替。

## 2026-09-07 部署结果

已部署并通过脚本语法检查、实际通知与权限测试、节点外系统信任链验证以及 Certbot 模拟续期。初次测试暴露 Paho 1.5.1 的等待接口差异，已改为有界轮询并重测通过。临时测试账号均已删除。

部署前后 XRay 与 cloudflared 主进程编号不变且状态正常；MQTT 短时内存约 2.3MB，没有监听明文端口。此结果仅证明当前 Broker 服务可用，Android、Worker 接线与长测仍按前述边界待验收。

## 本机发布入口

`api.py` 仅监听 `127.0.0.1:8787`，通过既有隧道的独立域名 `mqtt-api.elfradio.net` 提供服务。`stream` 路由保持原内容。首次安装使用 `sudo sh install-api.sh`，服务名为 `elfremote-mqtt-api`；独立随机服务凭据在 `/etc/elfremote-mqtt/api-token`，不向设备发放。

接口均为 `POST` 并检查服务凭据：`/v1/credentials` 发放独立设备身份，`/v1/publish` 仅发布有界的状态通知，`/v1/revoke` 删除身份。设备名限于由 Worker 生成的 `d_` 加 64 位摘要，不能发放 `control-plane` 身份。状态通知只含编号、递增版本和有效期，不包含执行命令。服务因需要维护密码文件及重载 Mosquitto，以管理员身份运行；systemd 限制文件写入目录，接口不接收路径或任意命令。

运行 `python3 -m unittest -v test_api` 验证接口边界，`sudo python3 smoke_api.py` 经真实 HTTPS 隧道与 MQTT/TLS 检查通知送达。客户端使用明确的 `elfRemote` 服务标识；默认 Python 请求曾收到 CF 403，补充标识后通过，未更改 CF 防火墙。回退本步骤只停用新增 API 服务并移除新增隧道路由及 DNS，Broker 与原业务继续保留。

Worker 配置项为 `MQTT_API_URL=https://mqtt-api.elfradio.net` 和 Secret `MQTT_API_TOKEN`。设备通过现有配对令牌调用 `/api/devices/push-config` 取得自己的连接参数、调用 `/api/devices/push-sync` 补领状态请求。管理员接口为 `POST /api/devices/request-status` 与 `GET /api/devices/status-request?device_id=...`。请求先写入现有 Durable Object，再在事务外发布；发布最多尝试三次，同一待处理请求合并，五分钟过期；发布失败保留待处理状态，只有带匹配关联号的设备状态上报才记完成。此处服务端代码已完成，生产 Worker 尚未部署。
