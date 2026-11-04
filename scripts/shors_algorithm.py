#!/usr/bin/env python3
"""Educational Shor factoring demo compiled specifically for N=15.

This is a local Qiskit Aer *simulator* demo. It is not quantum hardware, not a
general factoring implementation, and not a wallet/cryptocurrency attack tool.
It accepts no addresses, public keys, private keys, or wallet data.

Corrected from the user-supplied snippet:
* ``math.fraction`` does not exist; use ``fractions.Fraction``.
* The second factor is the cofactor ``N // p``; ``gcd(x+1, N)`` is not always it.
* A continued-fraction denominator can be a divisor of the true order, so the
  candidate period is validated (and small multiples are checked) before use.
* The modulus is explicitly restricted to 15 instead of silently ignoring N.
* Qiskit/Aer imports are optional until the quantum subroutine is actually run.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from fractions import Fraction
from typing import Callable

N_ALLOWED = 15
COUNT_QUBITS = 8
TARGET_QUBITS = 4
COPRIME_BASES = (2, 4, 7, 8, 11, 13)
INSTALL_HINT = "Install the optional simulator with: bash scripts/setup-shors-lab.sh"

try:
    from qiskit import QuantumCircuit, transpile
    from qiskit_aer import AerSimulator
    import qiskit
    import qiskit_aer
    HAVE_QISKIT = True
except ImportError:  # pragma: no cover - exercised by environment, not unit logic
    QuantumCircuit = None
    transpile = None
    AerSimulator = None
    qiskit = None
    qiskit_aer = None
    HAVE_QISKIT = False


def validate_modulus(N: int) -> None:
    if N != N_ALLOWED:
        raise ValueError("This compiled educational circuit supports only N=15. It is not a general factoring or ECC implementation.")


def validate_base(a: int) -> None:
    if a not in COPRIME_BASES:
        raise ValueError("'a' must be one of the bases coprime to 15: 2, 4, 7, 8, 11, 13.")


def c_amod15(a: int, power: int):
    """Controlled U|y> = |a**power * y mod 15> on the 4-qubit target register.

    Compiled SWAP/X implementation for N=15 only. ``power`` is a nonnegative
    integer; the phase-estimation circuit uses powers 1,2,4,...,128.
    """
    validate_base(a)
    if not isinstance(power, int) or isinstance(power, bool) or power < 0:
        raise ValueError("power must be a nonnegative integer.")
    if not HAVE_QISKIT:
        raise RuntimeError(f"Qiskit is not installed. {INSTALL_HINT}")
    U = QuantumCircuit(4)
    for _ in range(power):
        if a in (2, 13):
            U.swap(0, 1)
            U.swap(1, 2)
            U.swap(2, 3)
        if a in (7, 8):
            U.swap(2, 3)
            U.swap(1, 2)
            U.swap(0, 1)
        if a in (4, 11):
            U.swap(0, 2)
            U.swap(1, 3)
        if a in (7, 11, 13):
            for q in range(4):
                U.x(q)
    U = U.to_gate()
    U.name = f"{a}^{power} mod 15"
    return U.control()


def qft_dagger(n: int):
    """n-qubit inverse QFT, with Qiskit little-endian qubit ordering."""
    if not HAVE_QISKIT:
        raise RuntimeError(f"Qiskit is not installed. {INSTALL_HINT}")
    if not isinstance(n, int) or n < 1:
        raise ValueError("n must be a positive integer.")
    qc = QuantumCircuit(n)
    for j in range(n // 2):
        qc.swap(j, n - j - 1)
    for j in range(n):
        for m in range(j):
            qc.cp(-math.pi / float(2 ** (j - m)), m, j)
        qc.h(j)
    qc.name = "QFT†"
    return qc


def build_period_circuit(a: int, N: int = 15, counting_qubits: int = COUNT_QUBITS):
    validate_modulus(N)
    validate_base(a)
    if counting_qubits != COUNT_QUBITS:
        raise ValueError("This demo fixes the precision register at 8 counting qubits.")
    if not HAVE_QISKIT:
        raise RuntimeError(f"Qiskit is not installed. {INSTALL_HINT}")
    qc = QuantumCircuit(COUNT_QUBITS + TARGET_QUBITS, COUNT_QUBITS)
    for q in range(COUNT_QUBITS):
        qc.h(q)
    qc.x(COUNT_QUBITS)  # target register |0001> = decimal 1, little-endian
    for q in range(COUNT_QUBITS):
        qc.append(c_amod15(a, 2 ** q), [q] + [COUNT_QUBITS + i for i in range(TARGET_QUBITS)])
    qc.append(qft_dagger(COUNT_QUBITS), range(COUNT_QUBITS))
    qc.measure(range(COUNT_QUBITS), range(COUNT_QUBITS))
    return qc


def run_period_finder(a: int, N: int = 15, *, shots: int = 1, seed: int | None = None) -> dict:
    """Run the compiled phase-estimation circuit on local Aer and return samples."""
    validate_modulus(N)
    validate_base(a)
    if not isinstance(shots, int) or isinstance(shots, bool) or not 1 <= shots <= 1024:
        raise ValueError("shots must be an integer from 1 through 1024.")
    if seed is not None and (not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 2 ** 32 - 1):
        raise ValueError("seed must be an integer from 0 through 2^32-1.")
    if not HAVE_QISKIT:
        raise RuntimeError(f"Qiskit/Aer is not installed. {INSTALL_HINT}")
    qc = build_period_circuit(a, N)
    simulator = AerSimulator()
    # Aer requires the compiled custom modular-multiplication gates to be
    # decomposed/transpiled into its supported basis before execution.
    transpiled = transpile(qc, simulator, optimization_level=1, seed_transpiler=seed)
    kwargs = {"shots": shots, "memory": True}
    if seed is not None:
        kwargs["seed_simulator"] = seed
    result = simulator.run(transpiled, **kwargs).result()
    if not result.success:
        raise RuntimeError(f"Aer simulation failed: {getattr(result, 'status', 'unknown')}")
    memory = result.get_memory()
    counts = dict(result.get_counts())
    samples = []
    for bitstring in memory:
        # Qiskit memory is c[7]...c[0], so normal binary parsing is correct.
        value = int(bitstring, 2)
        samples.append({"bitstring": bitstring, "value": value, "phase": value / (2 ** COUNT_QUBITS)})
    return {
        "backend": "qiskit-aer",
        "hardware": False,
        "a": a,
        "N": N,
        "countingQubits": COUNT_QUBITS,
        "targetQubits": TARGET_QUBITS,
        "shots": shots,
        "seed": seed,
        "samples": samples,
        "counts": counts,
        "phase": samples[0]["phase"],
        "bitstring": samples[0]["bitstring"],
        "qiskitVersion": qiskit.__version__,
        "aerVersion": qiskit_aer.__version__,
        "circuit": {"width": qc.num_qubits, "depth": qc.depth(), "size": qc.size(), "ops": dict(qc.count_ops())},
    }


def period_finder(a: int, N: int = 15, *, shots: int = 1, seed: int | None = None) -> float:
    """Compatibility helper matching the snippet: return the first measured phase."""
    return run_period_finder(a, N, shots=shots, seed=seed)["phase"]


def infer_period(phase: float, a: int, N: int = 15) -> dict:
    """Continued-fraction post-processing with explicit period validation.

    The measured fraction approximates s/r. After reduction the denominator may
    be a proper divisor of r, so we validate a^r == 1 mod N and try small
    multiples of the denominator before giving up.
    """
    validate_modulus(N)
    validate_base(a)
    if not 0 <= phase < 1:
        raise ValueError("phase must be in [0,1).")
    frac = Fraction(phase).limit_denominator(N - 1)
    candidate = frac.denominator
    info = {"phase": phase, "numerator": frac.numerator, "denominator": candidate, "candidatePeriod": candidate, "period": None, "method": None}
    if phase == 0 or candidate < 1:
        return info
    multiple = 1
    while candidate * multiple < N:
        r = candidate * multiple
        if pow(a, r, N) == 1:
            info["period"] = r
            info["method"] = "continued-fraction" if multiple == 1 else f"validated-multiple-x{multiple}"
            return info
        multiple += 1
    return info


def factors_from_period(a: int, r: int, N: int = 15) -> dict:
    """Apply Shor's classical period conditions and return nontrivial factors."""
    validate_modulus(N)
    validate_base(a)
    if r <= 0 or r % 2 != 0:
        return {"ok": False, "reason": "odd-period", "detail": f"Period r={r} is not a positive even integer."}
    x = pow(a, r // 2, N)
    if x == N - 1:
        return {"ok": False, "reason": "trivial-minus-one", "detail": f"a^(r/2) ≡ -1 mod {N}; retry with another base/phase.", "x": x}
    g1 = math.gcd(x - 1, N)
    g2 = math.gcd(x + 1, N)
    p = g1 if 1 < g1 < N else g2 if 1 < g2 < N else None
    if p is None:
        return {"ok": False, "reason": "no-nontrivial-gcd", "detail": "Neither GCD produced a nontrivial factor.", "x": x, "gcdMinus": g1, "gcdPlus": g2}
    q = N // p
    if p * q != N or not (1 < p < N and 1 < q < N):
        return {"ok": False, "reason": "cofactor-check-failed", "detail": "Candidate factors failed verification."}
    factors = tuple(sorted((p, q)))
    return {"ok": True, "factors": factors, "x": x, "gcdMinus": g1, "gcdPlus": g2, "detail": f"{factors[0]} × {factors[1]} = {N}"}


def shors_algorithm(
    N: int = 15,
    *,
    max_attempts: int = 10,
    seed: int | None = None,
    shots: int = 1,
    base: int | None = None,
    period_runner: Callable[..., dict] | None = None,
    on_event: Callable[[dict], None] | None = None,
) -> tuple[int, int] | None:
    """Complete classical/quantum-simulator hybrid pipeline for N=15.

    Returns a sorted factor tuple, or None after max_attempts. ``period_runner``
    can be injected for deterministic tests; production uses local Qiskit Aer.
    """
    validate_modulus(N)
    if not isinstance(max_attempts, int) or not 1 <= max_attempts <= 10:
        raise ValueError("max_attempts must be 1 through 10.")
    if base is not None:
        validate_base(base)
    rng = random.Random(seed)
    runner = period_runner or run_period_finder
    emit = on_event or (lambda event: None)
    emit({"type": "start", "N": N, "maxAttempts": max_attempts, "seed": seed, "shots": shots, "base": base})
    # Retained classical guard from the snippet; the fixed N=15 demo never hits it.
    if N % 2 == 0:
        factors = (2, N // 2)
        emit({"type": "classical-gcd", "factors": factors})
        return factors
    for attempt in range(1, max_attempts + 1):
        a = base if base is not None else rng.randint(2, N - 1)
        gcd = math.gcd(a, N)
        if gcd != 1:
            factors = tuple(sorted((gcd, N // gcd)))
            emit({"type": "classical-gcd", "attempt": attempt, "a": a, "gcd": gcd, "factors": factors})
            return factors
        validate_base(a)
        emit({"type": "attempt", "attempt": attempt, "a": a})
        attempt_seed = None if seed is None else (seed + attempt - 1) % (2 ** 32)
        quantum = runner(a, N, shots=shots, seed=attempt_seed)
        phase = quantum["phase"]
        event = {"type": "phase", "attempt": attempt, "a": a, **quantum}
        emit(event)
        if phase == 0:
            emit({"type": "retry", "attempt": attempt, "reason": "zero-phase"})
            continue
        period_info = infer_period(phase, a, N)
        emit({"type": "period", "attempt": attempt, "a": a, **period_info})
        r = period_info["period"]
        if r is None:
            emit({"type": "retry", "attempt": attempt, "reason": "period-not-validated"})
            continue
        result = factors_from_period(a, r, N)
        emit({"type": "factor-check", "attempt": attempt, "a": a, "r": r, **result})
        if result["ok"]:
            emit({"type": "success", "attempt": attempt, "a": a, "r": r, "factors": result["factors"]})
            return result["factors"]
    emit({"type": "failure", "reason": "max-attempts"})
    return None


def experiment(args) -> dict:
    started = time.perf_counter()
    events = []
    factors = shors_algorithm(
        15,
        max_attempts=args.max_attempts,
        seed=args.seed,
        shots=args.shots,
        base=args.base,
        on_event=events.append,
    )
    return {
        "schemaVersion": "1.0.0",
        "kind": "shor-n15",
        "backend": "qiskit-aer",
        "hardware": False,
        "N": 15,
        "countingQubits": COUNT_QUBITS,
        "targetQubits": TARGET_QUBITS,
        "shots": args.shots,
        "seed": args.seed,
        "base": args.base,
        "maxAttempts": args.max_attempts,
        "success": factors is not None,
        "factors": list(factors) if factors else None,
        "events": events,
        "elapsedMs": round((time.perf_counter() - started) * 1000, 3),
        "qiskitVersion": qiskit.__version__ if HAVE_QISKIT else None,
        "aerVersion": qiskit_aer.__version__ if HAVE_QISKIT else None,
        "scope": "Educational N=15 factoring only. No wallet, address, public-key, or private-key input.",
    }


def print_human(result: dict) -> None:
    print("--- Factoring N = 15 using Shor's Algorithm (local Aer simulator) ---")
    for event in result["events"]:
        kind = event["type"]
        if kind == "attempt":
            print(f"\n[Attempt {event['attempt']}] Testing base a = {event['a']}...")
        elif kind == "phase":
            print(f"  -> Measured phase: {event['phase']:.6f} (bits {event['bitstring']})")
        elif kind == "period":
            print(f"  -> Fraction {event['numerator']}/{event['denominator']}; validated period r = {event['period']}")
        elif kind == "retry":
            print(f"  -> Retry: {event['reason']}")
        elif kind == "factor-check" and not event["ok"]:
            print(f"  -> {event['detail']}")
        elif kind == "classical-gcd":
            print(f"[Classical] Initial GCD found factors {event['factors']}")
    if result["success"]:
        p, q = result["factors"]
        print(f"\nSuccessfully found factors: ({p}, {q})")
    else:
        print("\nNo factors found within the attempt limit.")
    print(f"Elapsed: {result['elapsedMs']} ms. Simulator only; not quantum hardware.")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Educational Shor N=15 factoring with local Qiskit Aer")
    parser.add_argument("--base", type=int, choices=COPRIME_BASES, help="Fix the coprime base; default chooses randomly each attempt")
    parser.add_argument("--seed", type=int, help="Reproducible random/simulator seed (0..2^32-1)")
    parser.add_argument("--shots", type=int, default=1, help="Shots per period-finding attempt (1..1024)")
    parser.add_argument("--max-attempts", type=int, default=10, help="Maximum hybrid attempts (1..10)")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON only")
    args = parser.parse_args(argv)
    try:
        result = experiment(args)
    except (ValueError, RuntimeError) as error:
        if args.json:
            print(json.dumps({"ok": False, "error": str(error)}))
        else:
            print(f"Error: {error}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, separators=(",", ":")))
    else:
        print_human(result)
    return 0 if result["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
