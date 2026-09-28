# 快速分析最新飞行日志

本文是一份操作指南，供飞行测试人员和后续负责诊断的 Codex 使用。目标是通过一条命令生成固定格式的小型报告，避免重复下载、重复解析日志，以及反复读取包含完整时间序列的超大 JSON。

该流程只读取和下载日志，不会删除 SD 卡文件，不会修改 PID，也不会烧录固件。

## 准备工作

设备下载模式需要：

- 飞控通过 USB 连接电脑；
- 上位机和其他串口工具已关闭，避免占用同一个 COM 口；
- 上位机项目已经执行过 `npm install`；
- Python 环境包含 NumPy、SciPy 和 Matplotlib。

当前电脑的默认端口是 `COM11`。端口变化时在命令中指定实际端口。

## 从飞控分析上一次完整飞行日志

飞行结束、飞控重新上电并连接 USB 后，运行：

```bat
cd /d <仓库目录>
npm run analyze:log -- --port COM11
```

飞控上电后会创建一个仍在写入的新日志。因此设备模式默认跳过最高编号日志，选择上一个完整日志。

如需明确指定日志编号：

```bat
python tools\log_analysis\quick_analyze_latest.py --device --port COM11 --log-id 40
```

如确认最高编号日志已经关闭，可以取消跳过：

```bat
python tools\log_analysis\quick_analyze_latest.py --device --port COM11 --skip-newest 0
```

## 分析已经下载的 BIN 文件

```bat
python tools\log_analysis\quick_analyze_latest.py ^
  --input artifacts\sd-downloads\latest-2026-08-28-log41\LOG00040.BIN
```

脚本按文件 SHA-256 建立缓存。相同文件再次运行时只重新发布最新报告，不重复解码、FFT或绘图。

需要验证分析器的新逻辑或强制重算时添加：

```bat
python tools\log_analysis\quick_analyze_latest.py --input <日志目录>\LOG00040.BIN --force
```

分析器指纹同时包含 `quick_analyze_latest.py` 和底层 `analyze_flog.py`。任一脚本发生修改，旧缓存会自动失效。

## 查看结果

固定入口位于：

```text
tools/log_analysis/quick-analysis/
├── latest_report.md
├── latest_summary.json
├── latest_manifest.json
└── _cache/<日志哈希前16位>/
    ├── report.md
    ├── summary.json
    ├── key_timeseries.csv
    ├── estimator.csv
    ├── attitude_tracking.png
    ├── rate_tracking.png
    ├── rate_tracking_detail.png
    ├── pid_terms.png
    ├── motor_output.png
    ├── estimator_comparison.png
    ├── estimator_health.png
    ├── eskf_navigation.png
    └── gyro_psd.png
```

- `latest_report.md`：优先阅读的结论、关键表格和图表链接，通常只有几 KB。
- `latest_summary.json`：机器可读的精简统计，不包含完整时间序列。
- `key_timeseries.csv`：主分析解锁段的50 Hz降采样控制数据。
- `estimator.csv`：日志具有 Estimator V1/V2 数据时生成。
- `attitude_tracking.png`、`rate_tracking.png`、`rate_tracking_detail.png`、`pid_terms.png`：角度、原始角速度、离线零相位20 Hz低通后的控制带宽内角速度，以及PID波形；Yaw角度目标是根据日志姿态误差重建值。显示低通不会修改固件或原始数据。
- `estimator_comparison.png`、`estimator_health.png`：VQF/ESKF姿态、零偏、耗时和NIS对比。
- `eskf_navigation.png`：Estimator V2日志中的旁路ESKF位置、速度、光流与测距波形。
- `_cache`：按日志内容寻址的分析结果；不要把它当作新的原始日志来源。

以后请求 Codex 分析时，可以直接说：

> 按快速日志流程分析 `quick-analysis/latest_report.md`，只有发现异常时再读取对应 CSV 或原始 BIN。

这样通常只需读取几 KB 报告和约几十 KB统计，而不是几十 MB的完整分析文件。

## 报告包含的固定检查

报告会自动完成：

1. CRC、截断和消息版本检查；
2. 解锁飞行段识别，并选择最后一个持续至少5秒的完整解锁段作为主分析段；如果所有段都不足5秒，则选择最长段；
3. 三轴角度误差、角速度误差和 PID 输出统计；
4. 四路电机差值、饱和和 failsafe 检查；
5. 飞行与静止 IMU 标准差、PSD和主要振动峰值；
6. 自适应陷波中心和有效率统计；
7. VQF/ESKF姿态差异与运行时间；
8. Estimator V2中的光流、MTF02测距、TFmini测距及旁路ESKF状态。

快速报告不会自动修改控制参数。参数调整仍需结合机体状态、波形和前后两次飞行对比，每次只修改少量参数。

## 何时读取完整数据

只有出现以下情况时才进入深度分析：

- 电机突然停止、failsafe或输出饱和；
- 角速度出现尖峰或持续振荡；
- PID目标与测量存在明显延迟或反向；
- VQF控制源标志异常；
- ESKF数值失败、速度发散或观测长期无法融合；
- 需要确认特定时间点的电机、遥控器或传感器事件。

进入深度分析后，先读取相应 PNG 和降采样 CSV；只有这些数据不足时才解析原始 BIN 的局部时间窗口。

## 常见问题

### 串口无法打开

关闭 AeroLink、Ozone串口终端和其他占用该 COM 口的软件，然后重新运行命令。

### 选错日志

先查看设备日志列表：

```bat
node tools\log_analysis\sd_log_tool.cjs list --port COM11
```

然后使用 `--log-id` 指定正确编号。

### 没有识别到飞行段

脚本依据日志中的 `motor_armed` 状态识别飞行段。没有解锁记录时，报告会使用整个控制数据区间并明确给出提示。

### 重复运行仍然重新分析

以下情况会使缓存失效：

- BIN内容或文件长度发生变化；
- 快速分析脚本发生变化；
- 底层日志协议分析器发生变化；
- 使用了 `--force`。
