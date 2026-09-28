# STM32H7 飞控接入说明

## USB CDC 与任务结构

Windows 端使用标准 CDC ACM/`usbser.sys`。固件 USB 描述符应提供稳定的 VID、PID、产品名和序列号。CDC 的 921600 line coding 仅用于界面显示，不是 USB 物理速率。

建议任务优先级由高到低为：控制环、`MavlinkRxTask`/`HilInputTask`、`MavlinkTxTask`、`TelemetryTask`、`LogTransferTask`/`LogTask`。USB 接收回调只把数据复制到至少 16 KiB 的环形缓冲，逐字节 MAVLink 解析放在任务中。STM32H7 的 USB DMA 缓冲必须位于非缓存 MPU 区域，或严格执行 cache-line 对齐的 D-Cache clean/invalidate。

TX 优先级为：`COMMAND_ACK`/心跳、HIL、普通遥测、参数与日志。日志传输建议限制在链路带宽的 30–50%。任何控制任务不得阻塞等待 USB 发送。

## 飞控主动发送

| 消息 | 默认频率 | 关键内容与单位 |
|---|---:|---|
| `HEARTBEAT` | 1 Hz | sys/comp=1/1、Quadrotor、解锁位、HIL 位 |
| `SYS_STATUS` | 2 Hz | 传感器位、电压 mV、电流 cA、通信错误 |
| `SYSTEM_TIME` | 1 Hz | UTC µs、启动时间 ms |
| `ATTITUDE_QUATERNION` | 50 Hz | 四元数、FRD 角速度 rad/s |
| `HIGHRES_IMU` | 100 Hz | m/s²、rad/s、Gauss、hPa、°C |
| `LOCAL_POSITION_NED` | 20 Hz | NED 位置 m、速度 m/s |
| `GLOBAL_POSITION_INT` | 10 Hz | degE7、高度 mm、速度 cm/s、航向 cdeg |
| `GPS_RAW_INT` | 5 Hz | fix、卫星数、HDOP/VDOP、定位精度 |
| `BATTERY_STATUS` | 2 Hz | 电压 mV、电流 cA、剩余百分比、温度 |
| `RC_CHANNELS` | 10 Hz | 最多 18 通道与 RSSI |
| `ACTUATOR_OUTPUT_STATUS` | 50 Hz | 普通模式前四路归一化输出 0..1 |
| `ESTIMATOR_STATUS` | 5 Hz | EKF 标志与创新检验比 |
| `EXTENDED_SYS_STATE` | 2 Hz | 着陆状态 |
| `CURRENT_MODE` | 0.5 Hz/变化时 | 标准模式和自定义模式 |
| `STATUSTEXT` | 事件触发 | 预检、存储、故障、标定进度 |
| `AUTOPILOT_VERSION` | 请求时 | 能力位、固件/硬件版本 |
| `HOME_POSITION` | 请求/变化时 | 起飞点和返航点 |
| `COMMAND_ACK` | 每个命令 | 结果、进度、目标 ID |
| `PARAM_VALUE` | 参数响应/变化 | 类型、索引、总数；写入后回读当前值 |

导航坐标统一 NED，机体系统一 FRD。时间戳使用 MAVLink 字段规定的 `uint64_t` 微秒；两端不能用 JavaScript 毫秒时间代替仿真时间。

## 飞控必须接收

- `HEARTBEAT`、`PING`、`TIMESYNC`。
- `MAV_CMD_REQUEST_MESSAGE`、`MAV_CMD_SET_MESSAGE_INTERVAL`、`MAV_CMD_GET_MESSAGE_INTERVAL`。
- `MAV_CMD_COMPONENT_ARM_DISARM`、`MAV_CMD_DO_SET_MODE`。
- `MAV_CMD_PREFLIGHT_CALIBRATION`、`MAV_CMD_RUN_PREARM_CHECKS`。
- `MAV_CMD_PREFLIGHT_STORAGE`、`MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN`。
- `MAV_CMD_ACTUATOR_TEST` (310)：已解锁时必须返回 `MAV_RESULT_TEMPORARILY_REJECTED`，测试时长限制 0–3 秒。
- `PARAM_REQUEST_LIST`、`PARAM_REQUEST_READ`、`PARAM_SET`。
- `LOG_REQUEST_LIST`、`LOG_REQUEST_DATA`、`LOG_REQUEST_END`、`LOG_ERASE`。

参数名最多 16 字节。`REAL32` 直接编码；`INT32` 必须把四个整数原始字节复制到 `param_value`，不能做数值强制转换。无论 `PARAM_SET` 接受或拒绝，都返回同名 `PARAM_VALUE` 的最终当前值。

## HIL 安全闭环

上位机先发送 `MAV_CMD_DO_SET_MODE` 并置 `MAV_MODE_FLAG_HIL_ENABLED`。飞控必须在未解锁时才允许进入，并在下一帧 `HEARTBEAT.base_mode` 中确认 HIL 位；上位机收到确认后才启动闭环。

进入 HIL 后飞控必须：

1. 将传感器源切换到 HIL 输入。
2. 硬件层禁止真实 PWM/CAN 电机输出，虚拟解锁只允许控制算法运行。
3. 接收 `HIL_SENSOR` 500 Hz、`HIL_GPS` 10 Hz、`HIL_STATE_QUATERNION` 50 Hz。
4. 返回 `HIL_ACTUATOR_CONTROLS` 500 Hz：通道 0 前左 CCW、1 前右 CW、2 后右 CCW、3 后左 CW，范围 0..1。
5. 50 ms 未收到 `HIL_SENSOR` 进入 HIL failsafe，100 ms 后自动上锁。

可选接收 `DISTANCE_SENSOR` 20 Hz 和 `OPTICAL_FLOW_RAD` 30 Hz。退出 HIL 后才恢复真实传感器源；真实执行器恢复必须重新完成预检，不可继承虚拟解锁状态。

## 参数持久化和 MicroSD 日志

`firmware_reference/src/aerolink_param_store.c` 提供 A/B 双槽参考：`magic + version + generation + count + CRC32`。先写非活动槽，全部记录写完并校验后才提升 generation。板级 Flash 回调需要处理 H7 擦除粒度、写入对齐和掉电行为。

控制环只把日志记录推入队列，`LogTask` 后台批量写 FatFS。拔卡、满盘或写失败只能产生故障状态/`STATUSTEXT`，不能阻塞控制任务。`LOG_DATA` 每帧最多 90 字节，必须支持按任意 offset 重读和中断续传。

## 联调与验收顺序

1. 只开 1 Hz 心跳，确认 2 秒内建立连接。
2. 验证 CRC、序号回绕、PING/TIMESYNC、分包和粘包。
3. 同步 1000+ 参数，故意丢一项验证按索引补读；验证 INT32/REAL32 写入、掉电保持。
4. 测试命令成功、拒绝、超时、重试和 `IN_PROGRESS`。
5. 测试空日志目录、断点下载、损坏块、拔卡和删除。
6. 最后进入 HIL：验证静止、自由落体、悬停、姿态响应、100 ms 执行器超时和单电机效率故障。
7. 连接实际板卡连续运行 30 分钟，确认无 USB 溢出、D-Cache 错误或高优先级任务阻塞。
