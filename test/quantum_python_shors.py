import json
import math
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import shors_algorithm as shor


class ClassicalTests(unittest.TestCase):
    def test_modulus_and_base_validation(self):
        shor.validate_modulus(15)
        for n in (14, 16, 21, 35):
            with self.assertRaises(ValueError):
                shor.validate_modulus(n)
        for a in shor.COPRIME_BASES:
            shor.validate_base(a)
        for a in (1, 3, 5, 15, 0):
            with self.assertRaises(ValueError):
                shor.validate_base(a)

    def test_infer_period_validates_and_lifts_divisors(self):
        self.assertEqual(shor.infer_period(0.25, 7)["period"], 4)
        lifted = shor.infer_period(0.5, 7)
        self.assertEqual(lifted["candidatePeriod"], 2)
        self.assertEqual(lifted["period"], 4)
        self.assertEqual(lifted["method"], "validated-multiple-x2")
        self.assertIsNone(shor.infer_period(0.0, 7)["period"])

    def test_factors_from_period(self):
        for a, r in [(2, 4), (4, 2), (7, 4), (8, 4), (11, 2), (13, 4)]:
            result = shor.factors_from_period(a, r)
            self.assertTrue(result["ok"], (a, r, result))
            self.assertEqual(result["factors"], (3, 5))
        self.assertFalse(shor.factors_from_period(7, 3)["ok"])
        self.assertEqual(shor.factors_from_period(7, 3)["reason"], "odd-period")

    def test_hybrid_pipeline_with_injected_runner(self):
        phases = iter([0.0, 0.25])
        events = []

        def runner(a, N, *, shots, seed):
            phase = next(phases)
            return {"phase": phase, "bitstring": format(round(phase * 256), "08b"), "backend": "test"}

        factors = shor.shors_algorithm(15, base=7, max_attempts=3, period_runner=runner, on_event=events.append)
        self.assertEqual(factors, (3, 5))
        self.assertTrue(any(e["type"] == "retry" and e["reason"] == "zero-phase" for e in events))
        self.assertTrue(any(e["type"] == "success" for e in events))

    def test_hybrid_failure_after_zero_phases(self):
        def runner(a, N, *, shots, seed):
            return {"phase": 0.0, "bitstring": "00000000"}

        self.assertIsNone(shor.shors_algorithm(15, base=7, max_attempts=2, period_runner=runner))

    def test_invalid_options(self):
        with self.assertRaises(ValueError):
            shor.shors_algorithm(15, max_attempts=0)
        with self.assertRaises(ValueError):
            shor.shors_algorithm(15, max_attempts=11)
        with self.assertRaises(ValueError):
            shor.shors_algorithm(15, base=3)


@unittest.skipUnless(shor.HAVE_QISKIT, "Qiskit/Aer not installed")
class QiskitTests(unittest.TestCase):
    def test_compiled_circuit_shape(self):
        qc = shor.build_period_circuit(7)
        self.assertEqual(qc.num_qubits, 12)
        self.assertEqual(qc.num_clbits, 8)
        self.assertGreater(qc.depth(), 0)

    def test_period_finder_peaks_for_every_base(self):
        expected_orders = {2: 4, 4: 2, 7: 4, 8: 4, 11: 2, 13: 4}
        for a, order in expected_orders.items():
            result = shor.run_period_finder(a, shots=64, seed=100 + a)
            allowed = {format((k * 256 // order), "08b") for k in range(order)}
            self.assertTrue(set(result["counts"]).issubset(allowed), (a, result["counts"]))
            nonzero = [s for s in result["samples"] if s["phase"] != 0]
            self.assertTrue(nonzero, a)
            info = shor.infer_period(nonzero[0]["phase"], a)
            self.assertEqual(info["period"], order, (a, info))
            self.assertTrue(shor.factors_from_period(a, info["period"])["ok"])

    def test_period_finder_reproducible_with_seed(self):
        a = shor.run_period_finder(7, shots=16, seed=42)
        b = shor.run_period_finder(7, shots=16, seed=42)
        self.assertEqual(a["counts"], b["counts"])
        self.assertEqual(a["samples"], b["samples"])

    def test_invalid_shots_and_seed(self):
        with self.assertRaises(ValueError):
            shor.run_period_finder(7, shots=0)
        with self.assertRaises(ValueError):
            shor.run_period_finder(7, shots=1025)
        with self.assertRaises(ValueError):
            shor.run_period_finder(7, seed=-1)

    def test_cli_json(self):
        completed = subprocess.run(
            [sys.executable, str(ROOT / "scripts/shors_algorithm.py"), "--base", "7", "--seed", "42", "--shots", "8", "--max-attempts", "5", "--json"],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertTrue(result["success"])
        self.assertEqual(result["factors"], [3, 5])
        self.assertEqual(result["backend"], "qiskit-aer")
        self.assertFalse(result["hardware"])


if __name__ == "__main__":
    unittest.main()
