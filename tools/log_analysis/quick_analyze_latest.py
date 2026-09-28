#!/usr/bin/env python3
"""One-command, cached analysis for the UAV binary blackbox log."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import shutil
import subprocess
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

import matplotlib
import numpy as np
from scipy import signal

matplotlib.use("Agg")
import matplotlib.pyplot as plt

import analyze_flog as flog


ANALYZER_VERSION = 1
AXES = ("roll", "pitch", "yaw")
RAD_TO_DEG = 180.0 / math.pi
TARGET_COLOR = "#1f5aa6"
MEASURE_COLOR = "#d48806"
OLIVE_COLOR = "#6f7d1f"
PINK_COLOR = "#a64d79"
INK_COLOR = "#263238"
GRID_COLOR = "#cfd8dc"
SCRIPT_DIR = Path(__file__).resolve().parent
UPPER_ROOT = SCRIPT_DIR.parents[1]
DEVICE_TOOL = SCRIPT_DIR / "sd_log_tool.cjs"


def source_fingerprint() -> str:
    digest = hashlib.sha256()
    digest.update(Path(__file__).read_bytes())
    digest.update((SCRIPT_DIR / "analyze_flog.py").read_bytes())
    return digest.hexdigest()[:12]


ANALYZER_FINGERPRINT = source_fingerprint()


def analyzer_fingerprint() -> str:
    return ANALYZER_FINGERPRINT


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def run_device_tool(arguments: list[str]) -> str:
    command = ["node", str(DEVICE_TOOL), *arguments]
    result = subprocess.run(command, cwd=UPPER_ROOT, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}"
        raise RuntimeError(f"SD log tool failed: {detail}")
    return result.stdout.strip()


def device_log_size(entry: dict) -> int:
    for name in ("size", "size_bytes"):
        if name in entry:
            return int(entry[name])
    raise RuntimeError(f"log entry has no size: {entry}")


def device_entry_identity(entry: dict) -> dict:
    return {
        "id": int(entry["id"]),
        "size": device_log_size(entry),
        "time_utc": int(entry.get("timeUtc", entry.get("time_utc", 0)) or 0),
    }


def remote_prefix_matches(port: str, log_id: int, path: Path, size: int) -> bool:
    length = min(size, 4096)
    if length <= 0:
        return False
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".probe", delete=False) as temporary:
            temporary_path = Path(temporary.name)
        run_device_tool(
            [
                "window",
                "--port",
                port,
                "--id",
                str(log_id),
                "--offset",
                "0",
                "--length",
                str(length),
                "--output",
                str(temporary_path),
            ]
        )
        with path.open("rb") as local_stream:
            return temporary_path.read_bytes() == local_stream.read(length)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
            Path(f"{temporary_path}.json").unlink(missing_ok=True)


def download_device_log(port: str, log_id: int | None, skip_newest: int, output_root: Path) -> tuple[Path, dict]:
    entries = json.loads(run_device_tool(["list", "--port", port]))
    entries = sorted(entries, key=lambda entry: int(entry["id"]))
    if not entries:
        raise RuntimeError("flight controller returned an empty SD log list")

    if log_id is None:
        selected_index = len(entries) - 1 - skip_newest
        if selected_index < 0:
            raise RuntimeError(f"only {len(entries)} logs are available; cannot skip {skip_newest}")
        selected = entries[selected_index]
    else:
        selected = next((entry for entry in entries if int(entry["id"]) == log_id), None)
        if selected is None:
            raise RuntimeError(f"log id {log_id} is not present on the SD card")

    selected_id = int(selected["id"])
    selected_size = device_log_size(selected)
    raw_dir = output_root / "device-logs"
    raw_dir.mkdir(parents=True, exist_ok=True)
    destination = raw_dir / f"LOG{selected_id:05d}.BIN"
    metadata_path = destination.with_suffix(".device.json")
    identity = device_entry_identity(selected)
    previous_identity = None
    if metadata_path.is_file():
        try:
            previous_identity = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            previous_identity = None

    reusable_size = destination.is_file() and destination.stat().st_size == selected_size
    metadata_matches = previous_identity == identity
    if reusable_size and metadata_matches and identity["time_utc"] != 0:
        reused = True
    elif reusable_size and metadata_matches:
        reused = remote_prefix_matches(port, selected_id, destination, selected_size)
    else:
        reused = False
    if not reused:
        run_device_tool(
            [
                "window",
                "--port",
                port,
                "--id",
                str(selected_id),
                "--offset",
                "0",
                "--length",
                str(selected_size),
                "--output",
                str(destination),
            ]
        )
        if not destination.is_file() or destination.stat().st_size != selected_size:
            raise RuntimeError(
                f"download size mismatch: expected {selected_size}, got "
                f"{destination.stat().st_size if destination.exists() else 'missing'}"
            )
        metadata_path.write_text(json.dumps(identity, ensure_ascii=False, indent=2), encoding="utf-8")
    return destination, {
        "mode": "device",
        "port": port,
        "log_id": selected_id,
        "listed_size": selected_size,
        "skipped_newest": skip_newest if log_id is None else None,
        "download_reused": reused,
    }


def resolve_input(args: argparse.Namespace, output_root: Path) -> tuple[Path, dict]:
    if args.input is not None:
        path = args.input.resolve()
        if not path.is_file():
            raise FileNotFoundError(path)
        return path, {"mode": "local"}
    return download_device_log(args.port, args.log_id, args.skip_newest, output_root)


def split_armed_segments(controls: list[dict], maximum_gap_us: int = 500_000) -> list[list[dict]]:
    segments: list[list[dict]] = []
    current: list[dict] = []
    for record in controls:
        armed = record["motor_armed"] != 0
        gap_too_large = current and record["timestamp_us"] - current[-1]["timestamp_us"] > maximum_gap_us
        if armed:
            if gap_too_large:
                segments.append(current)
                current = []
            current.append(record)
        elif current:
            segments.append(current)
            current = []
    if current:
        segments.append(current)
    return [segment for segment in segments if len(segment) >= 2]


def segment_summary(segment: list[dict], log_t0_us: int) -> dict:
    throttle = flog.array(segment, "throttle")
    return {
        "start_s": (segment[0]["timestamp_us"] - log_t0_us) * 1.0e-6,
        "end_s": (segment[-1]["timestamp_us"] - log_t0_us) * 1.0e-6,
        "duration_s": (segment[-1]["timestamp_us"] - segment[0]["timestamp_us"]) * 1.0e-6,
        "samples": len(segment),
        "throttle_mean": float(np.mean(throttle)),
        "throttle_max": float(np.max(throttle)),
    }


def select_primary_segment(segments: list[list[dict]], minimum_duration_s: float = 5.0) -> tuple[int | None, str]:
    if not segments:
        return None, "整份日志（未识别到解锁段）"
    substantial = [
        index
        for index, segment in enumerate(segments)
        if (segment[-1]["timestamp_us"] - segment[0]["timestamp_us"]) * 1.0e-6 >= minimum_duration_s
    ]
    if substantial:
        return substantial[-1], f"最后一个持续至少 {minimum_duration_s:g} 秒的解锁段"
    return max(range(len(segments)), key=lambda index: len(segments[index])), "最长解锁段（所有段均不足5秒）"


def records_in_window(records: list[dict], start_us: int, end_us: int) -> list[dict]:
    return [record for record in records if start_us <= record["timestamp_us"] <= end_us]


def select_idle_imu(imu: list[dict], armed_segments: list[list[dict]], maximum_samples: int = 30_000) -> list[dict]:
    windows = [
        (segment[0]["timestamp_us"] - 1_000_000, segment[-1]["timestamp_us"] + 1_000_000)
        for segment in armed_segments
    ]
    candidates = [
        record
        for record in imu
        if not any(start_us <= record["timestamp_us"] <= end_us for start_us, end_us in windows)
    ]
    if not candidates:
        return imu[: min(maximum_samples, len(imu))]

    groups: list[list[dict]] = []
    current: list[dict] = []
    for record in candidates:
        if current and record["timestamp_us"] - current[-1]["timestamp_us"] > 5_000:
            groups.append(current)
            current = []
        current.append(record)
    if current:
        groups.append(current)
    selected = max(groups, key=len)
    return selected[-maximum_samples:]


def decode_log(path: Path) -> tuple[dict, list[dict], list[dict], list[dict], list[dict]]:
    parsed = flog.parse_fragment(path.read_bytes())
    imu: list[dict] = []
    controls: list[dict] = []
    notches: list[dict] = []
    estimators: list[dict] = []
    frame_counts: Counter[str] = Counter()
    for frame in parsed["frames"]:
        frame_counts[f"id{frame['message_id']}_v{frame['version']}"] += 1
        decoded = None
        if frame["message_id"] == 3:
            decoded = flog.decode_imu(frame)
            if decoded is not None:
                imu.append(decoded)
        elif frame["message_id"] == 4:
            decoded = flog.decode_control(frame)
            if decoded is not None:
                controls.append(decoded)
        elif frame["message_id"] == 5:
            decoded = flog.decode_notch(frame)
            if decoded is not None:
                notches.append(decoded)
        elif frame["message_id"] == 6:
            decoded = flog.decode_estimator_comparison(frame)
            if decoded is not None:
                estimators.append(decoded)
    quality = {
        "valid_frames": len(parsed["frames"]),
        "crc_failures": parsed["crc_failures"],
        "truncated_tail": parsed["truncated_tail"],
        "frame_counts": dict(sorted(frame_counts.items())),
        "decoded": {
            "imu": len(imu),
            "control": len(controls),
            "notch": len(notches),
            "estimator": len(estimators),
        },
    }
    return quality, imu, controls, notches, estimators


def finite_stats(values: np.ndarray) -> dict | None:
    values = np.asarray(values, dtype=float)
    values = values[np.isfinite(values)]
    return flog.scalar_stats(values) if values.size else None


def json_compatible(item):
    if isinstance(item, dict):
        return {key: json_compatible(value) for key, value in item.items()}
    if isinstance(item, (list, tuple)):
        return [json_compatible(value) for value in item]
    if isinstance(item, np.generic):
        item = item.item()
    if isinstance(item, float) and not math.isfinite(item):
        return None
    return item


def estimator_navigation_summary(records: list[dict]) -> dict | None:
    records = [record for record in records if record["version"] >= 2]
    if not records:
        return None
    positions = flog.array(records, "eskf_position")
    velocities = flog.array(records, "eskf_velocity")
    flow = flog.array(records, "flow_velocity_body_xy")
    position_range = []
    for axis_values in positions.T:
        finite_values = axis_values[np.isfinite(axis_values)]
        position_range.append(float(np.ptp(finite_values)) if finite_values.size else None)
    result = {
        "position_range_m": position_range,
        "velocity_norm_mps": finite_stats(np.linalg.norm(velocities, axis=1)),
        "flow_velocity_norm_mps": finite_stats(np.linalg.norm(flow, axis=1)),
    }
    counter_names = (
        "flow_measurement_count",
        "flow_fusion_count",
        "mtf_range_measurement_count",
        "mtf_range_fusion_count",
        "tfmini_range_measurement_count",
        "tfmini_range_fusion_count",
    )
    result["counter_delta"] = {
        name: max(0, int(records[-1][name]) - int(records[0][name])) for name in counter_names
    }
    return result


def notch_summary(records: list[dict]) -> dict:
    if not records:
        return {"samples": 0}
    centers = flog.array(records, "center_hz_axis")
    snr = flog.array(records, "peak_snr_axis")
    valid = flog.array(records, "tracking_valid_axis")
    return {
        "samples": len(records),
        "center_hz": {axis: finite_stats(centers[:, index]) for index, axis in enumerate(AXES)},
        "peak_snr": {axis: finite_stats(snr[:, index]) for index, axis in enumerate(AXES)},
        "valid_rate": {axis: float(np.mean(valid[:, index] != 0)) for index, axis in enumerate(AXES)},
    }


def low_frequency_rate_tracking(records: list[dict], cutoff_hz: float = 20.0) -> tuple[dict, np.ndarray, np.ndarray]:
    timestamps = flog.array(records, "timestamp_us")
    sample_rate_hz = (len(records) - 1) * 1.0e6 / (timestamps[-1] - timestamps[0])
    effective_cutoff_hz = min(cutoff_hz, sample_rate_hz * 0.4)
    sos = signal.butter(3, effective_cutoff_hz, btype="lowpass", fs=sample_rate_hz, output="sos")
    rate_ref = flog.array(records, "rate_ref") * RAD_TO_DEG
    rate_measure = flog.array(records, "rate_measure") * RAD_TO_DEG
    filtered_ref = signal.sosfiltfilt(sos, rate_ref, axis=0)
    filtered_measure = signal.sosfiltfilt(sos, rate_measure, axis=0)
    error = filtered_ref - filtered_measure
    return (
        {
            "cutoff_hz": effective_cutoff_hz,
            "sample_rate_hz": sample_rate_hz,
            "error_deg_s": {
                axis: flog.error_stats(error[:, index]) for index, axis in enumerate(AXES)
            },
        },
        filtered_ref,
        filtered_measure,
    )


def build_warnings(summary: dict) -> list[str]:
    warnings: list[str] = []
    quality = summary["quality"]
    if quality["crc_failures"]:
        warnings.append(f"日志存在 {quality['crc_failures']} 个 CRC 错误。")
    if quality["truncated_tail"]:
        warnings.append("日志尾部不完整，最后一帧已忽略。")
    if not summary["flight"]["armed_segments"]:
        warnings.append("没有识别到解锁飞行段；控制统计使用整个日志。")

    control = summary.get("control")
    if control:
        if control["state_counts"]["failsafe"]:
            warnings.append(f"飞行段记录到 {control['state_counts']['failsafe']} 个 failsafe 采样点。")
        if control["motor"]["nonfinite"]:
            warnings.append("电机命令中存在非有限数值。")
        if control["motor"]["high_saturation_rate"] > 0.01:
            warnings.append("电机高端饱和比例超过 1%。")

    estimator = summary.get("estimator")
    if estimator and estimator.get("samples", 0):
        if estimator["validity_rate"]["control_source_vqf"] < 0.999:
            warnings.append("VQF 控制源标志并非始终有效。")
        if estimator["eskf_counters_final"]["numerical_failures"]:
            warnings.append("ESKF 记录到数值失败。")
        euler_difference = estimator["euler_difference_deg"]
        if euler_difference["yaw"]["p95_abs"] > 45.0:
            warnings.append("旁路 ESKF 与 VQF 的航向差超过 45°，ESKF航向尚未对齐，不能切换为控制源。")
        counters = estimator.get("eskf_counters_delta")
        if counters:
            gravity_attempts = (
                counters["gravity_accepted"]
                + counters["gravity_rejected"]
                + counters["gravity_gate_rejections"]
            )
            if gravity_attempts and counters["gravity_accepted"] / gravity_attempts < 0.001:
                warnings.append("飞行段 ESKF 重力校正接受率低于 0.1%，倾角主要依赖陀螺预测。")
        navigation = summary.get("estimator_navigation")
        if navigation and navigation["velocity_norm_mps"] and navigation["velocity_norm_mps"]["max"] > 20.0:
            warnings.append("旁路 ESKF 速度超过 20 m/s，导航状态不可直接使用。")
        if navigation:
            counters = navigation["counter_delta"]
            if counters["flow_measurement_count"] and not counters["flow_fusion_count"]:
                warnings.append("收到光流观测，但飞行段没有任何光流通过融合。")
    return warnings


def write_key_timeseries(path: Path, records: list[dict], target_rate_hz: float = 50.0) -> None:
    if not records:
        return
    interval_us = int(1_000_000 / target_rate_hz)
    next_timestamp = records[0]["timestamp_us"]
    t0 = records[0]["timestamp_us"]
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(
            [
                "time_s",
                "roll_deg",
                "pitch_deg",
                "yaw_deg",
                "roll_target_deg",
                "pitch_target_deg",
                "yaw_target_deg",
                "roll_rate_ref_deg_s",
                "pitch_rate_ref_deg_s",
                "yaw_rate_ref_deg_s",
                "roll_rate_measure_deg_s",
                "pitch_rate_measure_deg_s",
                "yaw_rate_measure_deg_s",
                "roll_pid_output",
                "pitch_pid_output",
                "yaw_pid_output",
                "throttle",
                "pilot_throttle",
                "effective_throttle",
                "m1",
                "m2",
                "m3",
                "m4",
                "height_target_m",
                "height_measure_m",
                "vertical_speed_ref_mps",
                "vertical_speed_measure_mps",
                "altitude_base_throttle",
                "altitude_throttle_correction",
                "altitude_hold_request",
                "altitude_hold_active",
                "navigation_valid",
                "throttle_raw",
                "altitude_mode_raw",
                "altitude_mode_state",
                "motor_armed",
                "motor_output_valid",
                "closed_loop_active",
            ]
        )
        for record in records:
            if record["timestamp_us"] < next_timestamp:
                continue
            next_timestamp = record["timestamp_us"] + interval_us
            writer.writerow(
                [
                    (record["timestamp_us"] - t0) * 1.0e-6,
                    *(record["euler"] * RAD_TO_DEG),
                    *(record["attitude_ref"] * RAD_TO_DEG),
                    record.get("yaw_target_rad", math.nan) * RAD_TO_DEG,
                    *(record["rate_ref"] * RAD_TO_DEG),
                    *(record["rate_measure"] * RAD_TO_DEG),
                    *record["pid_output"],
                    record["throttle"],
                    record.get("pilot_throttle", record["throttle"]),
                    record.get("effective_throttle", record["throttle"]),
                    *record["motors"],
                    record["height_target_m"],
                    record["height_measure_m"],
                    record["vertical_speed_ref_mps"],
                    record["vertical_speed_measure_mps"],
                    record["altitude_base_throttle"],
                    record["altitude_throttle_correction"],
                    record["altitude_hold_request"],
                    record["altitude_hold_active"],
                    record["navigation_valid"],
                    record.get("throttle_raw", 0),
                    record.get("altitude_mode_raw", 0),
                    record.get("altitude_mode_state", 0),
                    record.get("motor_armed", 0),
                    record.get("motor_output_valid", record.get("motor_armed", 0)),
                    record.get("closed_loop_active", record.get("control_active", 0)),
                ]
            )


def write_estimator_csv(path: Path, records: list[dict]) -> None:
    if not records:
        return
    t0 = records[0]["timestamp_us"]
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(
            [
                "time_s",
                "vqf_roll_deg",
                "vqf_pitch_deg",
                "vqf_yaw_deg",
                "eskf_roll_deg",
                "eskf_pitch_deg",
                "eskf_yaw_deg",
                "vqf_time_us",
                "eskf_time_us",
                "eskf_vel_n_mps",
                "eskf_vel_e_mps",
                "eskf_vel_d_mps",
                "flow_vel_x_mps",
                "flow_vel_y_mps",
                "mtf_range_m",
                "tfmini_range_m",
                "last_nis",
                "nis_threshold",
                "valid_flags",
                "observation_flags",
            ]
        )
        for record in records:
            vqf_euler = flog.quaternion_to_euler(np.asarray([record["vqf_q"]]))[0] * RAD_TO_DEG
            eskf_euler = flog.quaternion_to_euler(np.asarray([record["eskf_q"]]))[0] * RAD_TO_DEG
            writer.writerow(
                [
                    (record["timestamp_us"] - t0) * 1.0e-6,
                    *vqf_euler,
                    *eskf_euler,
                    record["vqf_time_us"],
                    record["eskf_time_us"],
                    *record["eskf_velocity"],
                    *record["flow_velocity_body_xy"],
                    record["mtf_range_m"],
                    record["tfmini_range_m"],
                    record["last_nis"],
                    record["last_chi_square_threshold"],
                    record["valid_flags"],
                    record["observation_flags"],
                ]
            )


def plot_control(path: Path, records: list[dict]) -> None:
    if len(records) < 2:
        return
    step = max(1, len(records) // 5000)
    records = records[::step]
    time_s = (flog.array(records, "timestamp_us") - records[0]["timestamp_us"]) * 1.0e-6
    rate_ref = flog.array(records, "rate_ref") * RAD_TO_DEG
    rate_measure = flog.array(records, "rate_measure") * RAD_TO_DEG
    figure, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True)
    for index, axis_name in enumerate(AXES):
        axes[index].plot(time_s, rate_ref[:, index], label="target", color=TARGET_COLOR, linewidth=1.1)
        axes[index].plot(
            time_s,
            rate_measure[:, index],
            label="measure",
            color=MEASURE_COLOR,
            linewidth=0.8,
            alpha=0.9,
        )
        axes[index].set_ylabel(f"{axis_name}\n(deg/s)")
        axes[index].grid(True, color=GRID_COLOR, alpha=0.55, linewidth=0.6)
    axes[0].legend(loc="upper right")
    axes[-1].set_xlabel("Time (s)")
    figure.suptitle("Angular-rate tracking")
    figure.tight_layout()
    figure.savefig(path, dpi=140)
    plt.close(figure)


def plot_rate_tracking_detail(path: Path, records: list[dict]) -> None:
    if len(records) < 2:
        return
    tracking, rate_ref, rate_measure = low_frequency_rate_tracking(records)
    step = max(1, len(records) // 5000)
    timestamps = flog.array(records, "timestamp_us")
    time_s = (timestamps - timestamps[0]) * 1.0e-6
    figure, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True)
    for index, axis_name in enumerate(AXES):
        axes[index].plot(
            time_s[::step], rate_ref[::step, index], label="target", color=TARGET_COLOR, linewidth=1.1
        )
        axes[index].plot(
            time_s[::step],
            rate_measure[::step, index],
            label="measure",
            color=MEASURE_COLOR,
            linewidth=0.9,
        )
        axes[index].set_ylabel(f"{axis_name}\n(deg/s)")
        axes[index].grid(True, color=GRID_COLOR, alpha=0.55, linewidth=0.6)
    axes[0].legend(loc="upper right")
    axes[-1].set_xlabel("Time (s)")
    figure.suptitle(f"Angular-rate tracking detail (offline zero-phase {tracking['cutoff_hz']:.0f} Hz LPF)")
    figure.text(
        0.5,
        0.01,
        "Display-only filter; raw controller measurements and firmware are unchanged.",
        ha="center",
        fontsize=8,
        color=INK_COLOR,
    )
    figure.tight_layout(rect=(0, 0.03, 1, 0.97))
    figure.savefig(path, dpi=140)
    plt.close(figure)


def plot_attitude(path: Path, records: list[dict]) -> None:
    if len(records) < 2:
        return
    step = max(1, len(records) // 5000)
    records = records[::step]
    time_s = (flog.array(records, "timestamp_us") - records[0]["timestamp_us"]) * 1.0e-6
    euler_rad = flog.array(records, "euler")
    attitude_ref = flog.array(records, "attitude_ref")
    attitude_error = flog.array(records, "attitude_error")
    measure_deg = euler_rad * RAD_TO_DEG
    measure_deg[:, 2] = np.unwrap(euler_rad[:, 2]) * RAD_TO_DEG
    target_deg = np.empty_like(measure_deg)
    target_deg[:, :2] = attitude_ref * RAD_TO_DEG
    reconstructed_yaw = np.angle(np.exp(1j * (euler_rad[:, 2] + attitude_error[:, 2])))
    direct_yaw = np.asarray([record.get("yaw_target_rad", math.nan) for record in records], dtype=float)
    direct_valid = np.isfinite(direct_yaw)
    yaw_target = reconstructed_yaw
    yaw_target[direct_valid] = direct_yaw[direct_valid]
    target_deg[:, 2] = np.unwrap(yaw_target) * RAD_TO_DEG

    figure, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True)
    for index, axis_name in enumerate(AXES):
        label = "target" if index < 2 or np.all(direct_valid) else "target (partly reconstructed)"
        axes[index].plot(time_s, target_deg[:, index], label=label, color=TARGET_COLOR, linewidth=1.1)
        axes[index].plot(
            time_s,
            measure_deg[:, index],
            label="measure",
            color=MEASURE_COLOR,
            linewidth=0.9,
        )
        axes[index].set_ylabel(f"{axis_name}\n(deg)")
        axes[index].grid(True, color=GRID_COLOR, alpha=0.55, linewidth=0.6)
    axes[0].legend(loc="upper right")
    axes[2].legend(loc="upper right")
    axes[-1].set_xlabel("Time (s)")
    figure.suptitle("Attitude target and measurement")
    figure.text(
        0.5,
        0.012,
        "V4 logs contain the direct Yaw target; older records are reconstructed from measured Yaw plus attitude error.",
        ha="center",
        fontsize=8,
        color=INK_COLOR,
    )
    figure.tight_layout(rect=(0, 0.035, 1, 0.97))
    figure.savefig(path, dpi=140)
    plt.close(figure)


def plot_pid_terms(path: Path, records: list[dict]) -> None:
    if len(records) < 2:
        return
    step = max(1, len(records) // 5000)
    records = records[::step]
    time_s = (flog.array(records, "timestamp_us") - records[0]["timestamp_us"]) * 1.0e-6
    series = (
        ("P", flog.array(records, "pid_p"), TARGET_COLOR, "-"),
        ("I", flog.array(records, "pid_i"), OLIVE_COLOR, "-"),
        ("D", flog.array(records, "pid_d"), PINK_COLOR, "-"),
        ("Output", flog.array(records, "pid_output"), INK_COLOR, "--"),
    )
    figure, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True)
    for index, axis_name in enumerate(AXES):
        for label, values, color, line_style in series:
            axes[index].plot(
                time_s,
                values[:, index],
                label=label,
                color=color,
                linestyle=line_style,
                linewidth=0.9,
                alpha=0.9,
            )
        axes[index].axhline(0.0, color="#78909c", linewidth=0.6)
        axes[index].set_ylabel(f"{axis_name}\n(normalized)")
        axes[index].grid(True, color=GRID_COLOR, alpha=0.55, linewidth=0.6)
    axes[0].legend(ncol=4, loc="upper right")
    axes[-1].set_xlabel("Time (s)")
    figure.suptitle("Angular-rate PID terms and output")
    figure.tight_layout()
    figure.savefig(path, dpi=140)
    plt.close(figure)


def plot_motors(path: Path, records: list[dict]) -> None:
    if len(records) < 2:
        return
    step = max(1, len(records) // 5000)
    records = records[::step]
    time_s = (flog.array(records, "timestamp_us") - records[0]["timestamp_us"]) * 1.0e-6
    motors = flog.array(records, "motors")
    throttle = flog.array(records, "effective_throttle")
    pilot_throttle = flog.array(records, "pilot_throttle")
    figure, axis = plt.subplots(figsize=(12, 5))
    axis.plot(time_s, throttle, "k--", label="effective throttle", linewidth=1.0)
    if any(record.get("version", 0) >= 4 for record in records):
        axis.plot(time_s, pilot_throttle, color=OLIVE_COLOR, label="pilot throttle", linewidth=0.9)
    for index in range(4):
        axis.plot(time_s, motors[:, index], label=f"m{index + 1}", linewidth=0.8)
    axis.set(xlabel="Time (s)", ylabel="Normalized output", title="Throttle and motor outputs", ylim=(-0.05, 1.05))
    axis.grid(True, alpha=0.25)
    axis.legend(ncol=5, loc="upper right")
    figure.tight_layout()
    figure.savefig(path, dpi=140)
    plt.close(figure)


def altitude_control_summary(records: list[dict]) -> dict | None:
    if not records or not any(record.get("version", 0) >= 2 for record in records):
        return None
    active = flog.array(records, "altitude_hold_active") != 0
    navigation_valid = flog.array(records, "navigation_valid") != 0
    height_error = flog.array(records, "height_error_m")
    speed_error = flog.array(records, "vertical_speed_error_mps")
    active_height_error = height_error[active & np.isfinite(height_error)]
    active_speed_error = speed_error[active & np.isfinite(speed_error)]
    return {
        "samples": len(records),
        "requested_rate": float(np.mean(flog.array(records, "altitude_hold_request") != 0)),
        "active_rate": float(np.mean(active)),
        "navigation_valid_rate": float(np.mean(navigation_valid)),
        "height_error_m": flog.error_stats(active_height_error) if active_height_error.size else None,
        "vertical_speed_error_mps": flog.error_stats(active_speed_error) if active_speed_error.size else None,
    }


def plot_altitude_control(path: Path, records: list[dict]) -> bool:
    if len(records) < 2 or not any(record.get("version", 0) >= 2 for record in records):
        return False
    step = max(1, len(records) // 5000)
    records = records[::step]
    time_s = (flog.array(records, "timestamp_us") - records[0]["timestamp_us"]) * 1.0e-6
    active = flog.array(records, "altitude_hold_active") != 0
    height_target = flog.array(records, "height_target_m")
    height_measure = flog.array(records, "height_measure_m")
    speed_target = flog.array(records, "vertical_speed_ref_mps")
    speed_measure = flog.array(records, "vertical_speed_measure_mps")
    base_throttle = flog.array(records, "altitude_base_throttle")
    correction = flog.array(records, "altitude_throttle_correction")
    effective_throttle = flog.array(records, "effective_throttle")
    pilot_throttle = flog.array(records, "pilot_throttle")

    figure, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True)
    axes[0].plot(time_s, height_target, label="target", color=TARGET_COLOR, linewidth=1.1)
    axes[0].plot(time_s, height_measure, label="measure", color=MEASURE_COLOR, linewidth=0.9)
    axes[0].set_ylabel("height (m)")
    axes[1].plot(time_s, speed_target, label="target", color=TARGET_COLOR, linewidth=1.1)
    axes[1].plot(time_s, speed_measure, label="measure", color=MEASURE_COLOR, linewidth=0.9)
    axes[1].set_ylabel("up speed (m/s)")
    axes[2].plot(time_s, effective_throttle, label="effective throttle", color=INK_COLOR, linewidth=1.0)
    if any(record.get("version", 0) >= 4 for record in records):
        axes[2].plot(time_s, pilot_throttle, label="pilot throttle", color=TARGET_COLOR, linewidth=0.9)
    axes[2].plot(time_s, base_throttle, label="base", color=OLIVE_COLOR, linewidth=0.9)
    axes[2].plot(time_s, correction, label="velocity PI", color=PINK_COLOR, linewidth=0.9)
    axes[2].set_ylabel("normalized")
    axes[2].set_xlabel("Time (s)")
    for axis in axes:
        axis.fill_between(time_s, 0.0, 1.0, where=active, transform=axis.get_xaxis_transform(), color="#90caf9", alpha=0.12)
        axis.grid(True, color=GRID_COLOR, alpha=0.55, linewidth=0.6)
        axis.legend(loc="upper right")
    figure.suptitle("Altitude position and vertical-speed control (blue: active)")
    figure.tight_layout()
    figure.savefig(path, dpi=140)
    plt.close(figure)
    return True


def plot_estimators(path: Path, records: list[dict]) -> None:
    if len(records) < 2:
        return
    time_s = (flog.array(records, "timestamp_us") - records[0]["timestamp_us"]) * 1.0e-6
    vqf = flog.quaternion_to_euler(flog.array(records, "vqf_q")) * RAD_TO_DEG
    eskf = flog.quaternion_to_euler(flog.array(records, "eskf_q")) * RAD_TO_DEG
    figure, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True)
    for index, axis_name in enumerate(AXES):
        axes[index].plot(time_s, vqf[:, index], label="VQF", linewidth=1.0)
        axes[index].plot(time_s, eskf[:, index], label="ESKF", linewidth=0.8)
        axes[index].set_ylabel(f"{axis_name}\n(deg)")
        axes[index].grid(True, alpha=0.25)
    axes[0].legend(loc="upper right")
    axes[-1].set_xlabel("Time (s)")
    figure.suptitle("VQF and diagnostic ESKF")
    figure.tight_layout()
    figure.savefig(path, dpi=140)
    plt.close(figure)


def plot_estimator_health(path: Path, records: list[dict]) -> None:
    if len(records) < 2:
        return
    time_s = (flog.array(records, "timestamp_us") - records[0]["timestamp_us"]) * 1.0e-6
    vqf_q = flog.array(records, "vqf_q")
    eskf_q = flog.array(records, "eskf_q")
    vqf_q /= np.maximum(np.linalg.norm(vqf_q, axis=1, keepdims=True), 1.0e-12)
    eskf_q /= np.maximum(np.linalg.norm(eskf_q, axis=1, keepdims=True), 1.0e-12)
    difference_deg = 2.0 * np.arccos(np.clip(np.abs(np.sum(vqf_q * eskf_q, axis=1)), 0.0, 1.0)) * RAD_TO_DEG
    vqf_bias_norm = np.linalg.norm(flog.array(records, "vqf_gyro_bias"), axis=1)
    eskf_bias_norm = np.linalg.norm(flog.array(records, "eskf_gyro_bias"), axis=1)
    vqf_time = flog.array(records, "vqf_time_us")
    eskf_time = flog.array(records, "eskf_time_us")

    has_v2 = any(record["version"] >= 2 for record in records)
    panel_count = 4 if has_v2 else 3
    figure, axes = plt.subplots(panel_count, 1, figsize=(12, 9 if has_v2 else 7), sharex=True)
    axes[0].plot(time_s, difference_deg, color=MEASURE_COLOR, linewidth=0.9)
    axes[0].set_ylabel("attitude diff\n(deg)")
    axes[1].plot(time_s, vqf_bias_norm, label="VQF", color=TARGET_COLOR, linewidth=0.9)
    axes[1].plot(time_s, eskf_bias_norm, label="ESKF", color=MEASURE_COLOR, linewidth=0.9)
    axes[1].set_ylabel("gyro bias norm\n(rad/s)")
    axes[1].legend(loc="upper right")
    axes[2].plot(time_s, vqf_time, label="VQF", color=TARGET_COLOR, linewidth=0.8)
    axes[2].plot(time_s, eskf_time, label="ESKF", color=MEASURE_COLOR, linewidth=0.8)
    axes[2].set_ylabel("runtime\n(us)")
    axes[2].legend(loc="upper right")
    if has_v2:
        nis = flog.array(records, "last_nis")
        threshold = flog.array(records, "last_chi_square_threshold")
        axes[3].plot(time_s, nis, label="NIS", color=MEASURE_COLOR, linewidth=0.8)
        axes[3].plot(time_s, threshold, label="threshold", color=INK_COLOR, linestyle="--", linewidth=0.9)
        axes[3].set_ylabel("gravity NIS")
        axes[3].legend(loc="upper right")
    for axis in axes:
        axis.grid(True, color=GRID_COLOR, alpha=0.55, linewidth=0.6)
    axes[-1].set_xlabel("Time (s)")
    figure.suptitle("VQF and diagnostic ESKF health")
    figure.tight_layout()
    figure.savefig(path, dpi=140)
    plt.close(figure)


def plot_eskf_navigation(path: Path, records: list[dict]) -> bool:
    records = [record for record in records if record["version"] >= 2]
    if len(records) < 2:
        return False
    time_s = (flog.array(records, "timestamp_us") - records[0]["timestamp_us"]) * 1.0e-6
    position = flog.array(records, "eskf_position")
    velocity = flog.array(records, "eskf_velocity")
    flow = flog.array(records, "flow_velocity_body_xy")
    mtf_range = flog.array(records, "mtf_range_m")
    tfmini_range = flog.array(records, "tfmini_range_m")

    figure, axes = plt.subplots(4, 1, figsize=(12, 10), sharex=True)
    for index, label in enumerate(("N", "E", "D")):
        axes[0].plot(time_s, position[:, index], label=label, linewidth=0.9)
        axes[1].plot(time_s, velocity[:, index], label=label, linewidth=0.9)
    axes[0].set_ylabel("position (m)")
    axes[1].set_ylabel("velocity (m/s)")
    axes[0].legend(ncol=3, loc="upper right")
    axes[1].legend(ncol=3, loc="upper right")
    axes[2].plot(time_s, flow[:, 0], label="flow x", color=TARGET_COLOR, linewidth=0.8)
    axes[2].plot(time_s, flow[:, 1], label="flow y", color=MEASURE_COLOR, linewidth=0.8)
    axes[2].set_ylabel("flow velocity\n(m/s)")
    axes[2].legend(loc="upper right")
    axes[3].plot(time_s, mtf_range, label="MTF02", color=TARGET_COLOR, linewidth=0.8)
    axes[3].plot(time_s, tfmini_range, label="TFmini", color=MEASURE_COLOR, linewidth=0.8)
    axes[3].set_ylabel("range (m)")
    axes[3].set_xlabel("Time (s)")
    axes[3].legend(loc="upper right")
    for axis in axes:
        axis.grid(True, color=GRID_COLOR, alpha=0.55, linewidth=0.6)
    figure.suptitle("Diagnostic ESKF navigation states and observations")
    figure.tight_layout()
    figure.savefig(path, dpi=140)
    plt.close(figure)
    return True


def plot_gyro_psd(path: Path, active: dict, idle: dict) -> None:
    figure, axes = plt.subplots(3, 1, figsize=(10, 8), sharex=True)
    for index, axis_name in enumerate(("x", "y", "z")):
        for label, spectra in (("active", active), ("idle", idle)):
            frequency, psd = spectra[f"gyro_{axis_name}"]
            mask = frequency <= 400.0
            axes[index].semilogy(frequency[mask], np.maximum(psd[mask], 1.0e-14), label=label)
        axes[index].set_ylabel(f"gyro {axis_name}")
        axes[index].grid(True, alpha=0.25)
    axes[0].legend(loc="upper right")
    axes[-1].set(xlabel="Frequency (Hz)", xlim=(0, 400))
    figure.suptitle("Gyroscope PSD")
    figure.tight_layout()
    figure.savefig(path, dpi=140)
    plt.close(figure)


def value(value: float | None, digits: int = 2) -> str:
    if value is None or not math.isfinite(float(value)):
        return "n/a"
    return f"{float(value):.{digits}f}"


def markdown_report(summary: dict, artifact_names: list[str]) -> str:
    source = summary["source"]
    flight = summary["flight"]
    control = summary.get("control")
    lines = [
        "# 最新飞行日志快速报告",
        "",
        f"- 源文件：`{source['file_name']}`（{source['size_bytes'] / 1048576.0:.2f} MiB）",
        f"- SHA-256：`{source['sha256']}`",
        f"- 分析器版本：{ANALYZER_VERSION}（`{summary['analyzer_fingerprint']}`）",
        f"- 生成时间：{summary['generated_local_time']}",
        f"- 主段选择：{flight['selection']}",
        "",
        "## 结论",
        "",
    ]
    warnings = summary["warnings"]
    if warnings:
        lines.extend([f"- {warning}" for warning in warnings])
    else:
        lines.append("- 没有触发快速分析的固定异常门限；仍需结合波形判断控制品质。")

    lines.extend(["", "## 飞行段", ""])
    if flight["armed_segments"]:
        lines.extend(["| 段 | 开始(s) | 结束(s) | 时长(s) | 平均油门 | 最大油门 |", "|---:|---:|---:|---:|---:|---:|"])
        for index, segment in enumerate(flight["armed_segments"], 1):
            marker = "（主段）" if index - 1 == flight["primary_index"] else ""
            lines.append(
                f"| {index}{marker} | {segment['start_s']:.2f} | {segment['end_s']:.2f} | "
                f"{segment['duration_s']:.2f} | {segment['throttle_mean'] * 100.0:.1f}% | "
                f"{segment['throttle_max'] * 100.0:.1f}% |"
            )
    else:
        lines.append("未识别到 `motor_armed` 飞行段。")

    if control:
        lines.extend(
            [
                "",
                "## 三轴角速度与 PID",
                "",
                "| 轴 | 角度误差P95绝对值(°) | 原始角速度误差RMS(°/s) | 20Hz内误差RMS(°/s) | 20Hz内误差P95(°/s) | PID输出RMS |",
                "|---|---:|---:|---:|---:|---:|",
            ]
        )
        for axis in AXES:
            lines.append(
                f"| {axis} | {value(control['attitude_error_deg'][axis]['p95_abs'])} | "
                f"{value(control['rate_error_deg_s'][axis]['rms'])} | "
                f"{value(summary['rate_tracking_low_frequency']['error_deg_s'][axis]['rms'])} | "
                f"{value(summary['rate_tracking_low_frequency']['error_deg_s'][axis]['p95_abs'])} | "
                f"{value(control['pid']['output_rms'][axis], 4)} |"
            )
        lines.extend(
            [
                "",
                "## 电机输出",
                "",
                f"- 平均油门：{control['throttle']['mean'] * 100.0:.1f}%",
                f"- 四电机差值 P95：{control['motor']['spread']['p95']:.3f}",
                f"- 低端饱和比例：{control['motor']['low_saturation_rate'] * 100.0:.3f}%",
                f"- 高端饱和比例：{control['motor']['high_saturation_rate'] * 100.0:.3f}%",
                f"- Failsafe采样点：{control['state_counts']['failsafe']}",
                "",
                "### 角度、角速度与PID波形",
                "",
                "![三轴角度目标与测量](attitude_tracking.png)",
                "",
                "> Roll/Pitch目标来自日志原始字段；Yaw目标由测量Yaw与日志中的Yaw姿态误差重建。",
                "",
                "![三轴角速度目标与测量](rate_tracking.png)",
                "",
                "![三轴角速度20Hz内目标与测量](rate_tracking_detail.png)",
                "",
                "> 20 Hz图仅使用离线零相位低通帮助观察控制带宽内跟踪，不改变固件或原始统计。",
                "",
                "![三轴角速度PID分项与输出](pid_terms.png)",
            ]
        )

        altitude = summary.get("altitude_control")
        if altitude:
            height_error = altitude.get("height_error_m")
            speed_error = altitude.get("vertical_speed_error_mps")
            lines.extend(
                [
                    "",
                    "## 定高控制",
                    "",
                    f"- 定高请求采样比例：{altitude['requested_rate'] * 100.0:.1f}%",
                    f"- 定高实际激活比例：{altitude['active_rate'] * 100.0:.1f}%",
                    f"- ESKF-Z导航有效比例：{altitude['navigation_valid_rate'] * 100.0:.1f}%",
                    f"- 激活期间高度误差RMSE：{value(height_error['rms'] if height_error else None, 3)} m",
                    f"- 激活期间上升速度误差RMSE：{value(speed_error['rms'] if speed_error else None, 3)} m/s",
                    "",
                    "![高度外环与垂直速度内环](altitude_control.png)",
                ]
            )

    active_imu = summary.get("active_imu")
    idle_imu = summary.get("idle_imu")
    if active_imu and idle_imu:
        lines.extend(
            [
                "",
                "## IMU 与振动",
                "",
                "| 轴 | 飞行陀螺标准差(rad/s) | 静止陀螺标准差(rad/s) | 80–150 Hz RMS | 主要峰值(Hz) |",
                "|---|---:|---:|---:|---:|",
            ]
        )
        for index, axis in enumerate(("x", "y", "z")):
            spectrum = active_imu["gyro_spectrum"][axis]
            peak = spectrum["peaks"][0]["frequency_hz"] if spectrum["peaks"] else None
            lines.append(
                f"| {axis} | {active_imu['gyro_axis_std_rps'][index]:.4f} | "
                f"{idle_imu['gyro_axis_std_rps'][index]:.4f} | {spectrum['rms_80_150']:.4f} | {value(peak)} |"
            )

    notch = summary.get("notch")
    if notch and notch.get("samples", 0):
        lines.extend(
            [
                "",
                "## 自适应陷波",
                "",
                "| 轴 | 中心频率中位数(Hz) | 中心频率P95(Hz) | 跟踪有效率 |",
                "|---|---:|---:|---:|",
            ]
        )
        for axis in AXES:
            center_stats = notch["center_hz"].get(axis) or {}
            lines.append(
                f"| {axis} | {value(center_stats.get('median'))} | "
                f"{value(center_stats.get('p95'))} | {notch['valid_rate'][axis] * 100.0:.1f}% |"
            )

    estimator = summary.get("estimator")
    if estimator and estimator.get("samples", 0):
        combined_p95 = summary["estimator_timing"]["combined_p95_us"]
        eskf_delta = estimator["eskf_counters_delta"]
        lines.extend(
            [
                "",
                "## VQF 与旁路 ESKF",
                "",
                f"- 样本数：{estimator['samples']}",
                f"- VQF耗时 P95：{estimator['vqf_time_us']['p95']:.2f} μs",
                f"- ESKF耗时 P95：{estimator['eskf_time_us']['p95']:.2f} μs",
                f"- 同周期合计耗时 P95：{combined_p95:.2f} μs",
                f"- VQF控制源有效率：{estimator['validity_rate']['control_source_vqf'] * 100.0:.2f}%",
                f"- ESKF预测有效率：{estimator['validity_rate']['eskf_predict'] * 100.0:.2f}%",
                f"- 姿态差异 P95：{estimator['attitude_difference_deg']['p95']:.2f}°",
                f"- Roll/Pitch/Yaw差异 P95：{estimator['euler_difference_deg']['roll']['p95_abs']:.2f}° / "
                f"{estimator['euler_difference_deg']['pitch']['p95_abs']:.2f}° / "
                f"{estimator['euler_difference_deg']['yaw']['p95_abs']:.2f}°",
                f"- Yaw零偏差异 P95：{estimator['gyro_bias_difference_rps']['yaw']['p95_abs'] * RAD_TO_DEG:.3f}°/s",
                f"- 本段重力更新：接受 {eskf_delta['gravity_accepted']}，观测拒绝 {eskf_delta['gravity_rejected']}，动态门控拒绝 {eskf_delta['gravity_gate_rejections']}",
                f"- 本段ESKF数值失败：{eskf_delta['numerical_failures']}",
                "",
                "![VQF与ESKF姿态对比](estimator_comparison.png)",
                "",
                "![VQF与ESKF健康状态](estimator_health.png)",
                "",
            ]
        )
        navigation = summary.get("estimator_navigation")
        if navigation:
            counters = navigation["counter_delta"]
            lines.extend(
                [
                    f"- 光流：测量 {counters['flow_measurement_count']}，融合 {counters['flow_fusion_count']}",
                    f"- MTF02测距：测量 {counters['mtf_range_measurement_count']}，融合 {counters['mtf_range_fusion_count']}",
                    f"- TFmini测距：测量 {counters['tfmini_range_measurement_count']}，融合 {counters['tfmini_range_fusion_count']}",
                    f"- ESKF速度模长最大值：{value(navigation['velocity_norm_mps']['max'] if navigation['velocity_norm_mps'] else None)} m/s",
                    f"- ESKF位置变化 N/E/D：{' / '.join(value(item) for item in navigation['position_range_m'])} m",
                    "",
                    "![旁路ESKF导航状态与观测](eskf_navigation.png)",
                ]
            )
        else:
            lines.append("- Estimator V1日志不包含光流、测距、位置和速度诊断字段。")

    lines.extend(["", "## 输出文件", ""])
    descriptions = {
        "summary.json": "机器可读精简统计",
        "key_timeseries.csv": "主飞行段50 Hz关键控制序列",
        "estimator.csv": "VQF/ESKF及观测序列",
        "attitude_tracking.png": "三轴角度目标/测量",
        "rate_tracking.png": "三轴角速度目标/测量",
        "rate_tracking_detail.png": "三轴角速度20Hz内目标/测量细节",
        "pid_terms.png": "三轴角速度PID分项/输出",
        "altitude_control.png": "高度外环、垂直速度内环与油门修正",
        "motor_output.png": "油门与四路电机输出",
        "estimator_comparison.png": "VQF/ESKF姿态对比",
        "estimator_health.png": "VQF/ESKF姿态差、零偏、耗时与NIS",
        "eskf_navigation.png": "旁路ESKF位置、速度及观测",
        "gyro_psd.png": "飞行/静止陀螺仪PSD",
    }
    for name in artifact_names:
        lines.append(f"- [{name}]({name})：{descriptions.get(name, '分析产物')}")
    lines.extend(
        [
            "",
            "> 后续分析应先读取本报告和 `summary.json`；只有出现异常时，再读取对应 CSV 或原始 BIN。",
            "",
        ]
    )
    return "\n".join(lines)


def publish_latest(output_root: Path, cache_key: str, cache_dir: Path) -> None:
    summary_path = cache_dir / "summary.json"
    report_path = cache_dir / "report.md"
    shutil.copy2(summary_path, output_root / "latest_summary.json")
    report = report_path.read_text(encoding="utf-8")
    for name in (
        "summary.json",
        "key_timeseries.csv",
        "estimator.csv",
        "attitude_tracking.png",
        "rate_tracking.png",
        "rate_tracking_detail.png",
        "pid_terms.png",
        "motor_output.png",
        "estimator_comparison.png",
        "estimator_health.png",
        "eskf_navigation.png",
        "gyro_psd.png",
    ):
        report = report.replace(f"]({name})", f"](_cache/{cache_key}/{name})")
    (output_root / "latest_report.md").write_text(report, encoding="utf-8")
    (output_root / "latest_manifest.json").write_text(
        json.dumps(
            {
                "analyzer_version": ANALYZER_VERSION,
                "analyzer_fingerprint": analyzer_fingerprint(),
                "cache_key": cache_key,
                "cache_dir": str(cache_dir),
                "report": str(output_root / "latest_report.md"),
                "summary": str(output_root / "latest_summary.json"),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def analyse(path: Path, source_metadata: dict, output_root: Path, force: bool) -> dict:
    started = time.perf_counter()
    digest = sha256_file(path)
    fingerprint = analyzer_fingerprint()
    cache_key = digest[:16]
    cache_dir = output_root / "_cache" / cache_key
    manifest_path = cache_dir / "manifest.json"
    if not force and manifest_path.is_file() and (cache_dir / "report.md").is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (
            manifest.get("analyzer_version") == ANALYZER_VERSION
            and manifest.get("analyzer_fingerprint") == fingerprint
            and manifest.get("source_sha256") == digest
        ):
            output_root.mkdir(parents=True, exist_ok=True)
            publish_latest(output_root, cache_key, cache_dir)
            return {"cached": True, "cache_dir": str(cache_dir), "elapsed_s": time.perf_counter() - started}

    quality, imu, controls, notches, estimators = decode_log(path)
    if len(imu) < 2 or len(controls) < 2:
        raise RuntimeError(f"insufficient data: imu={len(imu)}, control={len(controls)}")

    log_t0_us = min(imu[0]["timestamp_us"], controls[0]["timestamp_us"])
    armed_segments = split_armed_segments(controls)
    primary_index, primary_selection = select_primary_segment(armed_segments)
    primary_controls = armed_segments[primary_index] if primary_index is not None else controls
    start_us = primary_controls[0]["timestamp_us"]
    end_us = primary_controls[-1]["timestamp_us"]
    active_imu = records_in_window(imu, start_us, end_us)
    idle_imu = select_idle_imu(imu, armed_segments)
    primary_estimators = records_in_window(estimators, start_us, end_us)

    if len(active_imu) < 2:
        active_imu = imu
    if len(idle_imu) < 2:
        idle_imu = imu[: min(30_000, len(imu))]

    active_imu_summary, active_spectra = flog.analyse_imu(active_imu)
    idle_imu_summary, idle_spectra = flog.analyse_imu(idle_imu)
    control_summary = flog.analyse_control(primary_controls)
    rate_tracking_low_frequency, _, _ = low_frequency_rate_tracking(primary_controls)
    estimator_summary = flog.analyse_estimators(primary_estimators) if len(primary_estimators) >= 2 else {"samples": 0}
    navigation_summary = estimator_navigation_summary(primary_estimators)

    summary = {
        "analyzer_version": ANALYZER_VERSION,
        "analyzer_fingerprint": fingerprint,
        "generated_local_time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": {
            "file": str(path),
            "file_name": path.name,
            "size_bytes": path.stat().st_size,
            "sha256": digest,
            **source_metadata,
        },
        "quality": quality,
        "flight": {
            "armed_segments": [segment_summary(segment, log_t0_us) for segment in armed_segments],
            "primary_index": primary_index,
            "selection": primary_selection,
            "primary_start_us": start_us,
            "primary_end_us": end_us,
        },
        "control": control_summary,
        "altitude_control": altitude_control_summary(primary_controls),
        "rate_tracking_low_frequency": rate_tracking_low_frequency,
        "active_imu": active_imu_summary,
        "idle_imu": idle_imu_summary,
        "vibration_ratio_active_to_idle": {
            "gyro_axis_std": (
                np.asarray(active_imu_summary["gyro_axis_std_rps"])
                / np.maximum(np.asarray(idle_imu_summary["gyro_axis_std_rps"]), 1.0e-12)
            ).tolist(),
            "accel_axis_std": (
                np.asarray(active_imu_summary["accel_axis_std_mps2"])
                / np.maximum(np.asarray(idle_imu_summary["accel_axis_std_mps2"]), 1.0e-12)
            ).tolist(),
        },
        "notch": notch_summary(records_in_window(notches, start_us, end_us)),
        "estimator": estimator_summary,
        "estimator_navigation": navigation_summary,
    }
    if primary_estimators:
        combined_time = flog.array(primary_estimators, "vqf_time_us") + flog.array(primary_estimators, "eskf_time_us")
        summary["estimator_timing"] = {
            "combined_p95_us": float(np.percentile(combined_time, 95)),
            "combined_max_us": float(np.max(combined_time)),
        }
    else:
        summary["estimator_timing"] = None
    summary["warnings"] = build_warnings(summary)

    cache_dir.mkdir(parents=True, exist_ok=True)
    artifacts = [
        "summary.json",
        "key_timeseries.csv",
        "attitude_tracking.png",
        "rate_tracking.png",
        "rate_tracking_detail.png",
        "pid_terms.png",
        "motor_output.png",
        "gyro_psd.png",
    ]
    write_key_timeseries(cache_dir / "key_timeseries.csv", primary_controls)
    plot_attitude(cache_dir / "attitude_tracking.png", primary_controls)
    plot_control(cache_dir / "rate_tracking.png", primary_controls)
    plot_rate_tracking_detail(cache_dir / "rate_tracking_detail.png", primary_controls)
    plot_pid_terms(cache_dir / "pid_terms.png", primary_controls)
    plot_motors(cache_dir / "motor_output.png", primary_controls)
    if plot_altitude_control(cache_dir / "altitude_control.png", primary_controls):
        artifacts.append("altitude_control.png")
    plot_gyro_psd(cache_dir / "gyro_psd.png", active_spectra, idle_spectra)
    if primary_estimators:
        artifacts.extend(["estimator.csv", "estimator_comparison.png", "estimator_health.png"])
        write_estimator_csv(cache_dir / "estimator.csv", primary_estimators)
        plot_estimators(cache_dir / "estimator_comparison.png", primary_estimators)
        plot_estimator_health(cache_dir / "estimator_health.png", primary_estimators)
        if plot_eskf_navigation(cache_dir / "eskf_navigation.png", primary_estimators):
            artifacts.append("eskf_navigation.png")

    (cache_dir / "summary.json").write_text(
        json.dumps(json_compatible(summary), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (cache_dir / "report.md").write_text(markdown_report(summary, artifacts), encoding="utf-8")
    (cache_dir / "manifest.json").write_text(
        json.dumps(
            {
                "analyzer_version": ANALYZER_VERSION,
                "analyzer_fingerprint": fingerprint,
                "source_sha256": digest,
                "source_file": str(path),
                "artifacts": artifacts + ["report.md", "manifest.json"],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    output_root.mkdir(parents=True, exist_ok=True)
    publish_latest(output_root, cache_key, cache_dir)
    return {"cached": False, "cache_dir": str(cache_dir), "elapsed_s": time.perf_counter() - started}


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="下载或读取最新黑匣子日志并生成精简、可缓存的飞行报告。")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path, help="已下载的 LOGxxxxx.BIN 文件")
    source.add_argument("--device", action="store_true", help="从飞控 SD 卡自动下载日志")
    parser.add_argument("--port", default="COM11", help="设备模式串口，默认 COM11")
    parser.add_argument("--log-id", type=int, help="设备模式指定日志编号")
    parser.add_argument(
        "--skip-newest",
        type=int,
        default=1,
        help="未指定日志编号时跳过最高编号日志的数量；默认1，避开当前正在写入的USB会话",
    )
    parser.add_argument("--output-dir", type=Path, default=SCRIPT_DIR / "quick-analysis")
    parser.add_argument("--force", action="store_true", help="忽略已有哈希缓存并重新分析")
    return parser.parse_args()


def main() -> None:
    args = parse_arguments()
    if args.skip_newest < 0:
        raise ValueError("--skip-newest must be non-negative")
    output_root = args.output_dir.resolve()
    path, source_metadata = resolve_input(args, output_root)
    result = analyse(path, source_metadata, output_root, args.force)
    result.update(
        {
            "source": str(path),
            "latest_report": str(output_root / "latest_report.md"),
            "latest_summary": str(output_root / "latest_summary.json"),
        }
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"quick analysis failed: {error}", file=sys.stderr)
        raise
