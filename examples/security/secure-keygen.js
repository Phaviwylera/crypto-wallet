// TRAINING FIXTURE: raw entropy only; no wallet is created or funded.
// A secure API call still needs correct integration, error handling and review.
export function secureEntropy() {
  const entropy = new Uint8Array(32);
  globalThis.crypto.getRandomValues(entropy);
  return entropy;
}
