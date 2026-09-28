#!/usr/bin/env python3
"""Small regression checks for the one-command blackbox analysis helpers."""

from __future__ import annotations

import importlib.util
import json
import math
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = PROJECT_ROOT / "tools" / "log_analysis" / "quick_analyze_latest.py"
sys.path.insert(0, str(SCRIPT_PATH.parent))
spec = importlib.util.spec_from_file_location("quick_analyze_latest", SCRIPT_PATH)
quick = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(quick)


class QuickAnalysisRegressionTests(unittest.TestCase):
    def test_estimator_v2_layout_preserves_v1_prefix(self):
        import analyze_flog as flog

        self.assertEqual(200, flog.ESTIMATOR_PAYLOAD_V2.size)
        self.assertEqual("<8I15f4B16f8IH6B", flog.ESTIMATOR_PAYLOAD_V2.format)
        self.assertEqual(96, struct.calcsize("<8I15f4B"))

    def test_control_v2_layout_preserves_v1_prefix_and_altitude_fields(self):
        import analyze_flog as flog

        self.assertEqual(228, flog.CONTROL_PAYLOAD_V1.size)
        self.assertEqual(272, flog.CONTROL_PAYLOAD_V2.size)
        values = [1, 2] + [0.0] * 54 + [1, 0, 1, 1] + [float(index) for index in range(10)] + [1, 1, 1, 0]
        frame = {
            "message_id": 4,
            "version": 2,
            "timestamp_us": 123,
            "sequence": 9,
            "payload": flog.CONTROL_PAYLOAD_V2.pack(*values),
        }
        decoded = flog.decode_control(frame)
        self.assertIsNotNone(decoded)
        self.assertEqual(3.0, decoded["vertical_speed_ref_mps"])
        self.assertEqual(1, decoded["altitude_hold_active"])
        self.assertEqual(1, decoded["navigation_valid"])

    def test_control_v3_appends_raw_channels_and_mode_state(self):
        import analyze_flog as flog

        self.assertEqual(280, flog.CONTROL_PAYLOAD_V3.size)
        values = (
            [1, 2]
            + [0.0] * 54
            + [1, 0, 1, 1]
            + [float(index) for index in range(10)]
            + [1, 1, 1, 0]
            + [1025, 250]
            + [3, 0, 0, 0]
        )
        frame = {
            "message_id": 4,
            "version": 3,
            "timestamp_us": 123,
            "sequence": 9,
            "payload": flog.CONTROL_PAYLOAD_V3.pack(*values),
        }
        decoded = flog.decode_control(frame)
        self.assertIsNotNone(decoded)
        self.assertEqual(1025, decoded["throttle_raw"])
        self.assertEqual(250, decoded["altitude_mode_raw"])
        self.assertEqual(3, decoded["altitude_mode_state"])

    def test_control_v4_separates_pilot_effective_and_motor_states(self):
        import analyze_flog as flog

        self.assertEqual(296, flog.CONTROL_PAYLOAD_V4.size)
        values = (
            [1, 2]
            + [0.0] * 54
            + [1, 0, 1, 1]
            + [float(index) for index in range(10)]
            + [1, 1, 1, 0]
            + [1025, 1800]
            + [3, 0, 0, 0]
            + [0.75, 0.43, 1.25]
            + [1, 1, 0, 0]
        )
        frame = {
            "message_id": 4,
            "version": 4,
            "timestamp_us": 123,
            "sequence": 9,
            "payload": flog.CONTROL_PAYLOAD_V4.pack(*values),
        }
        decoded = flog.decode_control(frame)
        self.assertIsNotNone(decoded)
        self.assertAlmostEqual(0.75, decoded["pilot_throttle"])
        self.assertAlmostEqual(0.43, decoded["effective_throttle"])
        self.assertAlmostEqual(1.25, decoded["yaw_target_rad"])
        self.assertAlmostEqual(0.43, decoded["throttle"])
        self.assertEqual(1, decoded["motor_armed"])
        self.assertEqual(1, decoded["motor_output_valid"])
        self.assertEqual(0, decoded["closed_loop_active"])
        self.assertEqual(0, decoded["control_active"])

    def test_split_armed_segments_honours_state_and_large_time_gap(self):
        controls = [
            {"timestamp_us": 0, "motor_armed": 0},
            {"timestamp_us": 1_000, "motor_armed": 1},
            {"timestamp_us": 2_000, "motor_armed": 1},
            {"timestamp_us": 800_000, "motor_armed": 1},
            {"timestamp_us": 801_000, "motor_armed": 1},
            {"timestamp_us": 802_000, "motor_armed": 0},
        ]
        segments = quick.split_armed_segments(controls)
        self.assertEqual([[1_000, 2_000], [800_000, 801_000]], [
            [record["timestamp_us"] for record in segment] for segment in segments
        ])

    def test_nonfinite_json_values_become_null(self):
        compatible = quick.json_compatible({"nan": math.nan, "inf": math.inf, "ok": 1.5})
        self.assertEqual({"nan": None, "inf": None, "ok": 1.5}, compatible)
        json.dumps(compatible, allow_nan=False)

    def test_primary_segment_is_latest_substantial_flight(self):
        def segment(start_s, end_s):
            return [
                {"timestamp_us": int(start_s * 1_000_000)},
                {"timestamp_us": int(end_s * 1_000_000)},
            ]

        index, reason = quick.select_primary_segment(
            [segment(0, 12), segment(20, 42), segment(50, 51), segment(60, 71)]
        )
        self.assertEqual(3, index)
        self.assertIn("最后", reason)

    def test_device_download_reuses_only_verified_file(self):
        listing = [{"id": 7, "size": 4, "timeUtc": 0}]
        calls = []

        def fake_device_tool(arguments):
            calls.append(arguments)
            if arguments[0] == "list":
                return json.dumps(listing)
            output = Path(arguments[arguments.index("--output") + 1])
            output.write_bytes(b"FLOG")
            Path(f"{output}.json").write_text("{}", encoding="utf-8")
            return json.dumps({"ok": True})

        with tempfile.TemporaryDirectory() as temporary:
            output_root = Path(temporary)
            with mock.patch.object(quick, "run_device_tool", side_effect=fake_device_tool):
                first_path, first_metadata = quick.download_device_log("COM11", 7, 1, output_root)
                second_path, second_metadata = quick.download_device_log("COM11", 7, 1, output_root)

            self.assertEqual(first_path, second_path)
            self.assertFalse(first_metadata["download_reused"])
            self.assertTrue(second_metadata["download_reused"])
            self.assertEqual(2, sum(arguments[0] == "window" for arguments in calls))
            self.assertEqual([], list(output_root.rglob("*.probe")))
            self.assertEqual([], list(output_root.rglob("*.probe.json")))


if __name__ == "__main__":
    unittest.main()
