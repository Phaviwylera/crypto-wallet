# INTENTIONALLY INSECURE TRAINING FIXTURE. Never use for a real wallet.
import random

def insecure_seed_bytes():
    return random.getrandbits(256).to_bytes(32, "big")
