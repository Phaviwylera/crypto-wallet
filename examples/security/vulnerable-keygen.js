// INTENTIONALLY INSECURE TRAINING FIXTURE. Never use for a real wallet.
// This file is only static-scanner input; the auditor never executes it.
export function insecureEntropy() {
  const entropy = new Uint8Array(32);
  for (let i = 0; i < entropy.length; i++) entropy[i] = Math.floor(Math.random() * 256);
  return entropy;
}
export function clockSeed() {
  const seed = Date.now();
  return seed;
}
