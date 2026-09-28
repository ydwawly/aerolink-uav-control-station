import argparse
import binascii
import csv
import json
import math
import struct
from pathlib import Path

import numpy as np
from scipy import signal


FRAME_HEADER = struct.Struct("<HBBHHIQ")
IMU_PAYLOAD = struct.Struct("<II3h3hhH3f3ff")
CONTROL_PAYLOAD_V1 = struct.Struct("<II54f4B")
CONTROL_PAYLOAD_V2 = struct.Struct("<II54f4B10f4B")
CONTROL_PAYLOAD_V3 = struct.Struct("<II54f4B10f4B2H4B")
CONTROL_PAYLOAD_V4 = struct.Struct("<II54f4B10f4B2H4B3f4B")
NOTCH_PAYLOAD_V1 = struct.Struct("<ffIB3x")
NOTCH_PAYLOAD_V2 = struct.Struct("<6f3I3B1x")
ESTIMATOR_PAYLOAD_V1 = struct.Struct("<8I15f4B")
# V2 keeps the complete 96-byte V1 prefix, including valid_flags/reserved,
# then appends 16 floats and the observation counters/status fields.
ESTIMATOR_PAYLOAD_V2 = struct.Struct("<8I15f4B16f8IH6B")
MAGIC = 0xA55A


def crc16_ccitt(data: bytes) -> int:
    return binascii.crc_hqx(data, 0xFFFF)


def read_range(path: Path, start: int, length: int | None) -> bytes:
    with path.open("rb") as stream:
        stream.seek(start)
        return stream.read() if length is None else stream.read(length)


def parse_fragment(data: bytes) -> dict:
    frames = []
    offset = 0
    crc_failures = 0
    truncated_tail = False
    while offset + FRAME_HEADER.size + 2 <= len(data):
        if data[offset : offset + 2] != b"\x5a\xa5":
            offset += 1
            continue
        magic, message_id, version, payload_length, flags, sequence, timestamp_us = FRAME_HEADER.unpack_from(data, offset)
        frame_length = FRAME_HEADER.size + payload_length + 2
        if magic != MAGIC or payload_length > 300:
            offset += 1
            continue
        if offset + frame_length > len(data):
            truncated_tail = True
            break
        expected = struct.unpack_from("<H", data, offset + FRAME_HEADER.size + payload_length)[0]
        actual = crc16_ccitt(data[offset : offset + FRAME_HEADER.size + payload_length])
        if actual != expected:
            crc_failures += 1
            offset += 1
            continue
        payload = data[offset + FRAME_HEADER.size : offset + FRAME_HEADER.size + payload_length]
        frames.append(
            {
                "message_id": message_id,
                "version": version,
                "flags": flags,
                "sequence": sequence,
                "timestamp_us": timestamp_us,
                "payload": payload,
            }
        )
        offset += frame_length
    return {"frames": frames, "crc_failures": crc_failures, "truncated_tail": truncated_tail}


def decode_imu(frame: dict) -> dict | None:
    if frame["message_id"] != 3 or frame["version"] != 1 or len(frame["payload"]) != IMU_PAYLOAD.size:
        return None
    values = IMU_PAYLOAD.unpack(frame["payload"])
    return {
        "timestamp_us": frame["timestamp_us"],
        "frame_sequence": frame["sequence"],
        "sample_sequence": values[0],
        "sensor_time": values[1],
        "validity": values[9],
        "accel": np.asarray(values[10:13], dtype=float),
        "gyro": np.asarray(values[13:16], dtype=float),
        "temperature_c": values[16],
    }


def decode_control(frame: dict) -> dict | None:
    if frame["message_id"] != 4:
        return None
    if frame["version"] == 1 and len(frame["payload"]) == CONTROL_PAYLOAD_V1.size:
        values = CONTROL_PAYLOAD_V1.unpack(frame["payload"])
        altitude = {
            "height_target_m": math.nan,
            "height_measure_m": math.nan,
            "height_error_m": math.nan,
            "vertical_speed_ref_mps": math.nan,
            "vertical_speed_measure_mps": math.nan,
            "vertical_speed_error_mps": math.nan,
            "vertical_speed_pid_p": math.nan,
            "vertical_speed_pid_i": math.nan,
            "altitude_base_throttle": math.nan,
            "altitude_throttle_correction": math.nan,
            "altitude_hold_request": 0,
            "altitude_hold_active": 0,
            "navigation_valid": 0,
        }
    elif frame["version"] in (2, 3, 4):
        payload_format = {
            2: CONTROL_PAYLOAD_V2,
            3: CONTROL_PAYLOAD_V3,
            4: CONTROL_PAYLOAD_V4,
        }[frame["version"]]
        if len(frame["payload"]) != payload_format.size:
            return None
        values = payload_format.unpack(frame["payload"])
        altitude_floats = values[60:70]
        altitude_states = values[70:74]
        altitude = {
            "height_target_m": altitude_floats[0],
            "height_measure_m": altitude_floats[1],
            "height_error_m": altitude_floats[2],
            "vertical_speed_ref_mps": altitude_floats[3],
            "vertical_speed_measure_mps": altitude_floats[4],
            "vertical_speed_error_mps": altitude_floats[5],
            "vertical_speed_pid_p": altitude_floats[6],
            "vertical_speed_pid_i": altitude_floats[7],
            "altitude_base_throttle": altitude_floats[8],
            "altitude_throttle_correction": altitude_floats[9],
            "altitude_hold_request": altitude_states[0],
            "altitude_hold_active": altitude_states[1],
            "navigation_valid": altitude_states[2],
        }
        if frame["version"] >= 3:
            altitude.update(
                {
                    "throttle_raw": values[74],
                    "altitude_mode_raw": values[75],
                    "altitude_mode_state": values[76],
                }
            )
    else:
        return None
    floats = np.asarray(values[2:56], dtype=float)
    states = values[56:60]
    decoded = {
        "timestamp_us": frame["timestamp_us"],
        "frame_sequence": frame["sequence"],
        "version": frame["version"],
        "sample_sequence": values[0],
        "predict_count": values[1],
        "dt_s": floats[0],
        "q": floats[1:5],
        "euler": floats[5:8],
        "position": floats[8:11],
        "velocity": floats[11:14],
        "gyro": floats[14:17],
        "accel": floats[17:20],
        "gyro_bias": floats[20:23],
        "accel_bias": floats[23:26],
        "attitude_ref": floats[26:28],
        "attitude_error": floats[28:31],
        "rate_ref": floats[31:34],
        "rate_measure": floats[34:37],
        "pid_p": floats[37:40],
        "pid_i": floats[40:43],
        "pid_d": floats[43:46],
        "pid_output": floats[46:49],
        "motors": floats[49:53],
        "throttle": floats[53],
        "arm_request": states[0],
        "failsafe": states[1],
        "motor_armed": states[2],
        "control_active": states[3],
    }
    decoded.update(altitude)
    decoded.setdefault("throttle_raw", 0)
    decoded.setdefault("altitude_mode_raw", 0)
    decoded.setdefault("altitude_mode_state", 0)
    if frame["version"] == 4:
        decoded.update(
            {
                "pilot_throttle": values[80],
                "effective_throttle": values[81],
                "yaw_target_rad": values[82],
                "motor_armed": values[83],
                "motor_output_valid": values[84],
                "closed_loop_active": values[85],
                # Keep historical analysis scripts working with the explicit V4 meaning.
                "throttle": values[81],
                "control_active": values[85],
            }
        )
    else:
        # Older layouts did not distinguish these states; expose conservative aliases.
        decoded["pilot_throttle"] = decoded["throttle"]
        decoded["effective_throttle"] = decoded["throttle"]
        decoded["motor_output_valid"] = decoded["motor_armed"]
        decoded["closed_loop_active"] = decoded["control_active"]
        decoded["yaw_target_rad"] = math.nan
    return decoded


def decode_notch(frame: dict) -> dict | None:
    if frame["message_id"] != 5:
        return None
    if frame["version"] == 1 and len(frame["payload"]) == NOTCH_PAYLOAD_V1.size:
        center_hz, peak_snr, update_count, tracking_valid = NOTCH_PAYLOAD_V1.unpack(frame["payload"])
        center_hz_axis = np.full(3, center_hz, dtype=float)
        peak_snr_axis = np.full(3, peak_snr, dtype=float)
        update_count_axis = np.full(3, update_count, dtype=np.uint32)
        tracking_valid_axis = np.full(3, tracking_valid, dtype=np.uint8)
    elif frame["version"] == 2 and len(frame["payload"]) == NOTCH_PAYLOAD_V2.size:
        values = NOTCH_PAYLOAD_V2.unpack(frame["payload"])
        center_hz_axis = np.asarray(values[0:3], dtype=float)
        peak_snr_axis = np.asarray(values[3:6], dtype=float)
        update_count_axis = np.asarray(values[6:9], dtype=np.uint32)
        tracking_valid_axis = np.asarray(values[9:12], dtype=np.uint8)
        valid = tracking_valid_axis != 0
        center_hz = float(np.mean(center_hz_axis[valid] if np.any(valid) else center_hz_axis))
        peak_snr = float(np.max(peak_snr_axis[valid] if np.any(valid) else peak_snr_axis))
        update_count = int(np.max(update_count_axis))
        tracking_valid = int(np.any(valid))
    else:
        return None
    return {
        "timestamp_us": frame["timestamp_us"],
        "frame_sequence": frame["sequence"],
        "version": frame["version"],
        "center_hz": center_hz,
        "peak_snr": peak_snr,
        "update_count": update_count,
        "tracking_valid": tracking_valid,
        "center_hz_axis": center_hz_axis,
        "peak_snr_axis": peak_snr_axis,
        "update_count_axis": update_count_axis,
        "tracking_valid_axis": tracking_valid_axis,
    }


def decode_estimator_comparison(frame: dict) -> dict | None:
    if frame["message_id"] != 6:
        return None
    if frame["version"] == 1 and len(frame["payload"]) == ESTIMATOR_PAYLOAD_V1.size:
        values = ESTIMATOR_PAYLOAD_V1.unpack(frame["payload"])
        floats = np.asarray(values[8:23], dtype=float)
        extended = {
            "eskf_position": np.full(3, math.nan),
            "eskf_velocity": np.full(3, math.nan),
            "flow_velocity_body_xy": np.full(2, math.nan),
            "mtf_range_m": math.nan,
            "tfmini_range_m": math.nan,
            "gravity_accel_norm_mps2": math.nan,
            "gravity_gyro_norm_rps": math.nan,
            "gravity_speed_norm_mps": math.nan,
            "gravity_innovation_rad": math.nan,
            "last_nis": math.nan,
            "last_chi_square_threshold": math.nan,
            "flow_measurement_count": 0,
            "flow_fusion_count": 0,
            "mtf_range_measurement_count": 0,
            "mtf_range_fusion_count": 0,
            "tfmini_range_measurement_count": 0,
            "tfmini_range_fusion_count": 0,
            "sensor_update_flags": 0,
            "observation_flags": 0,
            "tfmini_strength": 0,
            "flow_quality": 0,
            "flow_protocol": 0,
            "mtf_range_quality": 0,
            "mtf_range_status": 0,
            "tfmini_valid": 0,
        }
        valid_flags = values[23]
    elif frame["version"] == 2 and len(frame["payload"]) == ESTIMATOR_PAYLOAD_V2.size:
        values = ESTIMATOR_PAYLOAD_V2.unpack(frame["payload"])
        floats = np.asarray(values[8:23], dtype=float)
        extended_floats = np.asarray(values[27:43], dtype=float)
        extended = {
            "eskf_position": extended_floats[0:3],
            "eskf_velocity": extended_floats[3:6],
            "flow_velocity_body_xy": extended_floats[6:8],
            "mtf_range_m": extended_floats[8],
            "tfmini_range_m": extended_floats[9],
            "gravity_accel_norm_mps2": extended_floats[10],
            "gravity_gyro_norm_rps": extended_floats[11],
            "gravity_speed_norm_mps": extended_floats[12],
            "gravity_innovation_rad": extended_floats[13],
            "last_nis": extended_floats[14],
            "last_chi_square_threshold": extended_floats[15],
            "flow_measurement_count": values[43],
            "flow_fusion_count": values[44],
            "mtf_range_measurement_count": values[45],
            "mtf_range_fusion_count": values[46],
            "tfmini_range_measurement_count": values[47],
            "tfmini_range_fusion_count": values[48],
            "sensor_update_flags": values[49],
            "observation_flags": values[50],
            "tfmini_strength": values[51],
            "flow_quality": values[52],
            "flow_protocol": values[53],
            "mtf_range_quality": values[54],
            "mtf_range_status": values[55],
            "tfmini_valid": values[56],
        }
        valid_flags = values[23]
    else:
        return None
    core_clock_hz = values[1]
    cycles_to_us = 1e6 / core_clock_hz if core_clock_hz else math.nan
    result = {
        "timestamp_us": frame["timestamp_us"],
        "frame_sequence": frame["sequence"],
        "version": frame["version"],
        "sample_sequence": values[0],
        "core_clock_hz": core_clock_hz,
        "vqf_cycles": values[2],
        "eskf_cycles": values[3],
        "vqf_time_us": values[2] * cycles_to_us,
        "eskf_time_us": values[3] * cycles_to_us,
        "gravity_accepted": values[4],
        "gravity_rejected": values[5],
        "gravity_gate_rejections": values[6],
        "numerical_failures": values[7],
        "dt_s": floats[0],
        "vqf_q": floats[1:5],
        "eskf_q": floats[5:9],
        "vqf_gyro_bias": floats[9:12],
        "eskf_gyro_bias": floats[12:15],
        "valid_flags": valid_flags,
    }
    result.update(extended)
    return result


def array(records: list[dict], key: str) -> np.ndarray:
    return np.asarray([record[key] for record in records], dtype=float)


def scalar_stats(values: np.ndarray) -> dict:
    values = np.asarray(values, dtype=float)
    return {
        "mean": float(np.mean(values)),
        "std": float(np.std(values)),
        "min": float(np.min(values)),
        "p05": float(np.percentile(values, 5)),
        "median": float(np.median(values)),
        "p95": float(np.percentile(values, 95)),
        "max": float(np.max(values)),
    }


def error_stats(values: np.ndarray) -> dict:
    absolute = np.abs(values)
    return {
        "mean": float(np.mean(values)),
        "rms": float(np.sqrt(np.mean(values**2))),
        "mae": float(np.mean(absolute)),
        "p95_abs": float(np.percentile(absolute, 95)),
        "max_abs": float(np.max(absolute)),
    }


def quaternion_to_euler(quaternions: np.ndarray) -> np.ndarray:
    quaternions = np.asarray(quaternions, dtype=float)
    norm = np.linalg.norm(quaternions, axis=1, keepdims=True)
    q = quaternions / np.maximum(norm, 1e-12)
    w, x, y, z = q.T
    roll = np.arctan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y))
    pitch = np.arcsin(np.clip(2.0 * (w * y - z * x), -1.0, 1.0))
    yaw = np.arctan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))
    return np.column_stack((roll, pitch, yaw))


def sequence_quality(values: np.ndarray, expected_step: int | None = None) -> dict:
    if len(values) < 2:
        return {"samples": int(len(values)), "median_step": None, "gap_events": 0, "missing": 0}
    delta = np.diff(values.astype(np.int64))
    step = int(np.median(delta)) if expected_step is None else expected_step
    positive = delta[delta > step]
    return {
        "samples": int(len(values)),
        "median_step": float(np.median(delta)),
        "p95_step": float(np.percentile(delta, 95)),
        "gap_events": int(np.sum(delta > step)),
        "missing": int(np.sum(np.maximum(0, np.rint(delta / max(step, 1)).astype(int) - 1))),
        "nonpositive_steps": int(np.sum(delta <= 0)),
    }


def sampling_quality(records: list[dict]) -> dict:
    timestamps = array(records, "timestamp_us")
    delta_us = np.diff(timestamps)
    return {
        "duration_s": float((timestamps[-1] - timestamps[0]) * 1e-6),
        "rate_hz": float((len(timestamps) - 1) * 1e6 / (timestamps[-1] - timestamps[0])),
        "dt_us": scalar_stats(delta_us),
    }


def band_rms(freq: np.ndarray, psd: np.ndarray, low: float, high: float) -> float:
    mask = (freq >= low) & (freq < high)
    return float(math.sqrt(max(0.0, np.trapezoid(psd[mask], freq[mask])))) if np.count_nonzero(mask) > 1 else 0.0


def spectral_summary(values: np.ndarray, fs: float, low: float = 5.0, high: float = 450.0) -> tuple[dict, np.ndarray, np.ndarray]:
    values = signal.detrend(np.asarray(values, dtype=float))
    nperseg = min(2048, len(values))
    freq, psd = signal.welch(values, fs=fs, window="hann", nperseg=nperseg, noverlap=nperseg // 2)
    mask = (freq >= low) & (freq <= min(high, fs * 0.49))
    peaks, _ = signal.find_peaks(psd[mask])
    candidate = np.flatnonzero(mask)[peaks]
    if not len(candidate):
        candidate = np.flatnonzero(mask)
    ranked = candidate[np.argsort(psd[candidate])[::-1]] if len(candidate) else np.array([], dtype=int)
    chosen = []
    for index in ranked:
        if all(abs(freq[index] - freq[old]) >= 3.0 for old in chosen):
            chosen.append(int(index))
        if len(chosen) == 3:
            break
    summary = {
        "peaks": [{"frequency_hz": float(freq[i]), "psd": float(psd[i])} for i in chosen],
        "rms_5_20": band_rms(freq, psd, 5, 20),
        "rms_20_80": band_rms(freq, psd, 20, 80),
        "rms_80_150": band_rms(freq, psd, 80, 150),
        "rms_150_300": band_rms(freq, psd, 150, 300),
    }
    return summary, freq, psd


def analyse_imu(records: list[dict]) -> tuple[dict, dict[str, tuple[np.ndarray, np.ndarray]]]:
    timestamps = array(records, "timestamp_us")
    accel = array(records, "accel")
    gyro = array(records, "gyro")
    fs = (len(records) - 1) * 1e6 / (timestamps[-1] - timestamps[0])
    result = {
        "samples": len(records),
        "sampling": sampling_quality(records),
        "sample_sequence": sequence_quality(array(records, "sample_sequence"), 1),
        "temperature_c": scalar_stats(array(records, "temperature_c")),
        "accel_magnitude_mps2": scalar_stats(np.linalg.norm(accel, axis=1)),
        "accel_axis_std_mps2": np.std(accel, axis=0).tolist(),
        "gyro_axis_std_rps": np.std(gyro, axis=0).tolist(),
    }
    spectra = {}
    for axis, name in enumerate(("x", "y", "z")):
        gyro_summary, freq, psd = spectral_summary(gyro[:, axis], fs)
        accel_summary, accel_freq, accel_psd = spectral_summary(accel[:, axis], fs)
        result.setdefault("gyro_spectrum", {})[name] = gyro_summary
        result.setdefault("accel_spectrum", {})[name] = accel_summary
        spectra[f"gyro_{name}"] = (freq, psd)
        spectra[f"accel_{name}"] = (accel_freq, accel_psd)
    return result, spectra


def analyse_control(records: list[dict]) -> dict:
    rad_to_deg = 180.0 / math.pi
    timestamps = array(records, "timestamp_us")
    attitude_error = array(records, "attitude_error") * rad_to_deg
    rate_ref = array(records, "rate_ref") * rad_to_deg
    rate_measure = array(records, "rate_measure") * rad_to_deg
    rate_error = rate_ref - rate_measure
    q_norm = np.linalg.norm(array(records, "q"), axis=1)
    motors = array(records, "motors")
    pid_p, pid_i, pid_d, pid_output = (array(records, key) for key in ("pid_p", "pid_i", "pid_d", "pid_output"))
    names = ("roll", "pitch", "yaw")
    result = {
        "samples": len(records),
        "sampling": sampling_quality(records),
        "sample_sequence": sequence_quality(array(records, "sample_sequence")),
        "dt_s": scalar_stats(array(records, "dt_s")),
        "quaternion_norm": {**scalar_stats(q_norm), "max_abs_error": float(np.max(np.abs(q_norm - 1.0)))},
        "state_counts": {
            key: int(np.sum(array(records, key) != 0))
            for key in ("arm_request", "failsafe", "motor_armed", "control_active")
        },
        "throttle": scalar_stats(array(records, "throttle")),
        "motor": {
            "per_motor": {f"m{index}": scalar_stats(motors[:, index]) for index in range(4)},
            "spread": scalar_stats(np.max(motors, axis=1) - np.min(motors, axis=1)),
            "low_saturation_rate": float(np.mean(motors <= 0.001)),
            "high_saturation_rate": float(np.mean(motors >= 0.999)),
            "nonfinite": int(np.sum(~np.isfinite(motors))),
        },
        "attitude_error_deg": {name: error_stats(attitude_error[:, index]) for index, name in enumerate(names)},
        "rate_ref_deg_s": {name: scalar_stats(rate_ref[:, index]) for index, name in enumerate(names)},
        "rate_measure_deg_s": {name: scalar_stats(rate_measure[:, index]) for index, name in enumerate(names)},
        "rate_error_deg_s": {name: error_stats(rate_error[:, index]) for index, name in enumerate(names)},
        "pid": {
            "p_rms": dict(zip(names, np.sqrt(np.mean(pid_p**2, axis=0)).tolist())),
            "i_rms": dict(zip(names, np.sqrt(np.mean(pid_i**2, axis=0)).tolist())),
            "d_rms": dict(zip(names, np.sqrt(np.mean(pid_d**2, axis=0)).tolist())),
            "output_rms": dict(zip(names, np.sqrt(np.mean(pid_output**2, axis=0)).tolist())),
            "p_output_max_abs_diff": float(np.max(np.abs(pid_p - pid_output))),
        },
        "euler_deg": {name: scalar_stats(array(records, "euler")[:, index] * rad_to_deg) for index, name in enumerate(names)},
        "attitude_ref_deg": {
            "roll": scalar_stats(array(records, "attitude_ref")[:, 0] * rad_to_deg),
            "pitch": scalar_stats(array(records, "attitude_ref")[:, 1] * rad_to_deg),
        },
    }
    fs = (len(records) - 1) * 1e6 / (timestamps[-1] - timestamps[0])
    result["rate_measure_spectrum"] = {}
    result["motor_spectrum"] = {}
    for axis, name in enumerate(names):
        summary, _, _ = spectral_summary(rate_measure[:, axis], fs, 1.0, 90.0)
        result["rate_measure_spectrum"][name] = summary
    for index in range(4):
        summary, _, _ = spectral_summary(motors[:, index], fs, 1.0, 90.0)
        result["motor_spectrum"][f"m{index}"] = summary
    return result


def analyse_estimators(records: list[dict]) -> dict:
    rad_to_deg = 180.0 / math.pi
    names = ("roll", "pitch", "yaw")
    vqf_q = array(records, "vqf_q")
    eskf_q = array(records, "eskf_q")
    vqf_q_normalized = vqf_q / np.maximum(np.linalg.norm(vqf_q, axis=1, keepdims=True), 1e-12)
    eskf_q_normalized = eskf_q / np.maximum(np.linalg.norm(eskf_q, axis=1, keepdims=True), 1e-12)
    quaternion_dot = np.abs(np.sum(vqf_q_normalized * eskf_q_normalized, axis=1))
    attitude_delta_deg = 2.0 * np.arccos(np.clip(quaternion_dot, 0.0, 1.0)) * rad_to_deg

    vqf_euler = quaternion_to_euler(vqf_q)
    eskf_euler = quaternion_to_euler(eskf_q)
    euler_delta = (eskf_euler - vqf_euler + math.pi) % (2.0 * math.pi) - math.pi
    bias_delta = array(records, "eskf_gyro_bias") - array(records, "vqf_gyro_bias")
    flags = array(records, "valid_flags").astype(np.uint8)

    result = {
        "samples": len(records),
        "sample_sequence": sequence_quality(array(records, "sample_sequence")),
        "core_clock_hz": scalar_stats(array(records, "core_clock_hz")),
        "vqf_time_us": scalar_stats(array(records, "vqf_time_us")),
        "eskf_time_us": scalar_stats(array(records, "eskf_time_us")),
        "attitude_difference_deg": scalar_stats(attitude_delta_deg),
        "euler_difference_deg": {
            name: error_stats(euler_delta[:, axis] * rad_to_deg) for axis, name in enumerate(names)
        },
        "gyro_bias_difference_rps": {
            name: error_stats(bias_delta[:, axis]) for axis, name in enumerate(names)
        },
        "validity_rate": {
            "vqf": float(np.mean((flags & 0x01) != 0)),
            "eskf_predict": float(np.mean((flags & 0x02) != 0)),
            "eskf_gravity_update": float(np.mean((flags & 0x04) != 0)),
            "control_source_vqf": float(np.mean((flags & 0x08) != 0)),
        },
        "eskf_counters_final": {
            "gravity_accepted": int(records[-1]["gravity_accepted"]),
            "gravity_rejected": int(records[-1]["gravity_rejected"]),
            "gravity_gate_rejections": int(records[-1]["gravity_gate_rejections"]),
            "numerical_failures": int(records[-1]["numerical_failures"]),
        },
        "eskf_counters_delta": {
            "gravity_accepted": max(0, int(records[-1]["gravity_accepted"]) - int(records[0]["gravity_accepted"])),
            "gravity_rejected": max(0, int(records[-1]["gravity_rejected"]) - int(records[0]["gravity_rejected"])),
            "gravity_gate_rejections": max(
                0, int(records[-1]["gravity_gate_rejections"]) - int(records[0]["gravity_gate_rejections"])
            ),
            "numerical_failures": max(
                0, int(records[-1]["numerical_failures"]) - int(records[0]["numerical_failures"])
            ),
        },
    }
    version_2_records = [record for record in records if record["version"] >= 2]
    if version_2_records:
        latest = version_2_records[-1]
        observation_flags = array(version_2_records, "observation_flags").astype(np.uint32)
        sensor_update_flags = array(version_2_records, "sensor_update_flags").astype(np.uint32)
        result["gravity_diagnostics"] = {
            "accel_norm_mps2": scalar_stats(array(version_2_records, "gravity_accel_norm_mps2")),
            "gyro_norm_rps": scalar_stats(array(version_2_records, "gravity_gyro_norm_rps")),
            "speed_norm_mps": scalar_stats(array(version_2_records, "gravity_speed_norm_mps")),
            "innovation_rad": scalar_stats(array(version_2_records, "gravity_innovation_rad")),
            "last_nis": scalar_stats(array(version_2_records, "last_nis")),
            "last_chi_square_threshold": scalar_stats(
                array(version_2_records, "last_chi_square_threshold")
            ),
        }
        result["observation_rate"] = {
            "flow_update": float(np.mean((sensor_update_flags & 0x01) != 0)),
            "range_update": float(np.mean((sensor_update_flags & 0x02) != 0)),
            "mtf_range_valid": float(np.mean((observation_flags & 0x01) != 0)),
            "mtf_range_fused": float(np.mean((observation_flags & 0x02) != 0)),
            "flow_valid": float(np.mean((observation_flags & 0x04) != 0)),
            "flow_fused": float(np.mean((observation_flags & 0x08) != 0)),
            "tfmini_valid": float(np.mean((observation_flags & 0x10) != 0)),
            "tfmini_fused": float(np.mean((observation_flags & 0x20) != 0)),
        }
        result["observation_counters_final"] = {
            "flow_measurement": int(latest["flow_measurement_count"]),
            "flow_fusion": int(latest["flow_fusion_count"]),
            "mtf_range_measurement": int(latest["mtf_range_measurement_count"]),
            "mtf_range_fusion": int(latest["mtf_range_fusion_count"]),
            "tfmini_range_measurement": int(latest["tfmini_range_measurement_count"]),
            "tfmini_range_fusion": int(latest["tfmini_range_fusion_count"]),
        }
    if len(records) > 1:
        result["sampling"] = sampling_quality(records)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--active", type=Path, required=True)
    parser.add_argument("--idle", type=Path, required=True)
    parser.add_argument("--idle-start", type=int, required=True)
    parser.add_argument("--idle-length", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    active_parsed = parse_fragment(args.active.read_bytes())
    idle_parsed = parse_fragment(read_range(args.idle, args.idle_start, args.idle_length))
    active_imu = [decoded for frame in active_parsed["frames"] if (decoded := decode_imu(frame)) is not None]
    idle_imu = [decoded for frame in idle_parsed["frames"] if (decoded := decode_imu(frame)) is not None]
    controls = [decoded for frame in active_parsed["frames"] if (decoded := decode_control(frame)) is not None]
    estimators = [
        decoded
        for frame in active_parsed["frames"]
        if (decoded := decode_estimator_comparison(frame)) is not None
    ]
    if len(active_imu) < 1000 or len(idle_imu) < 500 or len(controls) < 100:
        raise RuntimeError(f"insufficient decoded data: active_imu={len(active_imu)}, idle_imu={len(idle_imu)}, control={len(controls)}")

    active_imu_result, active_spectra = analyse_imu(active_imu)
    idle_imu_result, idle_spectra = analyse_imu(idle_imu)
    frame_sequences = np.asarray([frame["sequence"] for frame in active_parsed["frames"]], dtype=np.int64)
    result = {
        "source": {
            "active_file": str(args.active.resolve()),
            "idle_file": str(args.idle.resolve()),
            "idle_range": [args.idle_start, args.idle_start + args.idle_length],
        },
        "quality": {
            "active_bytes": args.active.stat().st_size,
            "active_valid_frames": len(active_parsed["frames"]),
            "active_crc_failures": active_parsed["crc_failures"],
            "active_truncated_tail": active_parsed["truncated_tail"],
            "active_frame_sequence": sequence_quality(frame_sequences, 1),
            "idle_valid_frames": len(idle_parsed["frames"]),
            "idle_crc_failures": idle_parsed["crc_failures"],
        },
        "active_imu": active_imu_result,
        "idle_imu": idle_imu_result,
        "control": analyse_control(controls),
        "estimator_comparison": analyse_estimators(estimators) if estimators else {"samples": 0},
    }
    result["vibration_ratio_active_to_idle"] = {
        "gyro_axis_std": (np.asarray(active_imu_result["gyro_axis_std_rps"]) / np.asarray(idle_imu_result["gyro_axis_std_rps"])).tolist(),
        "accel_axis_std": (np.asarray(active_imu_result["accel_axis_std_mps2"]) / np.asarray(idle_imu_result["accel_axis_std_mps2"])).tolist(),
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    chart_path = args.output.with_name("flight_timeseries.csv")
    t0 = controls[0]["timestamp_us"]
    with chart_path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(["time_s", "roll_deg", "pitch_deg", "roll_ref_deg", "pitch_ref_deg", "roll_rate_deg_s", "pitch_rate_deg_s", "yaw_rate_deg_s", "throttle", "m1", "m2", "m3", "m4"])
        for record in controls[::4]:
            writer.writerow(
                [
                    (record["timestamp_us"] - t0) * 1e-6,
                    record["euler"][0] * 180 / math.pi,
                    record["euler"][1] * 180 / math.pi,
                    record["attitude_ref"][0] * 180 / math.pi,
                    record["attitude_ref"][1] * 180 / math.pi,
                    *(record["rate_measure"] * 180 / math.pi),
                    record["throttle"],
                    *record["motors"],
                ]
            )

    psd_path = args.output.with_name("imu_psd.csv")
    with psd_path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(["state", "signal", "axis", "frequency_hz", "psd"])
        for state, spectra in (("active", active_spectra), ("idle", idle_spectra)):
            for key, (freq, psd) in spectra.items():
                signal_name, axis = key.split("_")
                for index in range(0, len(freq), 2):
                    if freq[index] <= 400:
                        writer.writerow([state, signal_name, axis, freq[index], psd[index]])

    estimator_path = args.output.with_name("estimator_comparison.csv")
    if estimators:
        estimator_t0 = estimators[0]["timestamp_us"]
        with estimator_path.open("w", newline="", encoding="utf-8") as stream:
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
                    "vqf_bias_x_rps",
                    "vqf_bias_y_rps",
                    "vqf_bias_z_rps",
                    "eskf_bias_x_rps",
                    "eskf_bias_y_rps",
                    "eskf_bias_z_rps",
                    "valid_flags",
                    "eskf_pos_n_m",
                    "eskf_pos_e_m",
                    "eskf_pos_d_m",
                    "eskf_vel_n_mps",
                    "eskf_vel_e_mps",
                    "eskf_vel_d_mps",
                    "flow_vel_body_x_mps",
                    "flow_vel_body_y_mps",
                    "mtf_range_m",
                    "tfmini_range_m",
                    "gravity_accel_norm_mps2",
                    "gravity_gyro_norm_rps",
                    "gravity_speed_norm_mps",
                    "gravity_innovation_rad",
                    "last_nis",
                    "last_chi_square_threshold",
                    "flow_measurement_count",
                    "flow_fusion_count",
                    "mtf_range_measurement_count",
                    "mtf_range_fusion_count",
                    "tfmini_range_measurement_count",
                    "tfmini_range_fusion_count",
                    "sensor_update_flags",
                    "observation_flags",
                    "flow_quality",
                    "flow_protocol",
                    "mtf_range_quality",
                    "mtf_range_status",
                    "tfmini_strength",
                    "tfmini_valid",
                ]
            )
            for record in estimators:
                vqf_euler_deg = quaternion_to_euler(np.asarray([record["vqf_q"]]))[0] * 180.0 / math.pi
                eskf_euler_deg = quaternion_to_euler(np.asarray([record["eskf_q"]]))[0] * 180.0 / math.pi
                writer.writerow(
                    [
                        (record["timestamp_us"] - estimator_t0) * 1e-6,
                        *vqf_euler_deg,
                        *eskf_euler_deg,
                        record["vqf_time_us"],
                        record["eskf_time_us"],
                        *record["vqf_gyro_bias"],
                        *record["eskf_gyro_bias"],
                        record["valid_flags"],
                        *record["eskf_position"],
                        *record["eskf_velocity"],
                        *record["flow_velocity_body_xy"],
                        record["mtf_range_m"],
                        record["tfmini_range_m"],
                        record["gravity_accel_norm_mps2"],
                        record["gravity_gyro_norm_rps"],
                        record["gravity_speed_norm_mps"],
                        record["gravity_innovation_rad"],
                        record["last_nis"],
                        record["last_chi_square_threshold"],
                        record["flow_measurement_count"],
                        record["flow_fusion_count"],
                        record["mtf_range_measurement_count"],
                        record["mtf_range_fusion_count"],
                        record["tfmini_range_measurement_count"],
                        record["tfmini_range_fusion_count"],
                        record["sensor_update_flags"],
                        record["observation_flags"],
                        record["flow_quality"],
                        record["flow_protocol"],
                        record["mtf_range_quality"],
                        record["mtf_range_status"],
                        record["tfmini_strength"],
                        record["tfmini_valid"],
                    ]
                )

    outputs = {"analysis": str(args.output), "timeseries": str(chart_path), "psd": str(psd_path)}
    if estimators:
        outputs["estimator_comparison"] = str(estimator_path)
    print(json.dumps(outputs, ensure_ascii=False))


if __name__ == "__main__":
    main()
