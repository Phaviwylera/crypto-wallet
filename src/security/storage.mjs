const KEY = 'seedlab.security.workspace.v1';
const MAX_BYTES = 256 * 1024;

/** Only non-secret workflow metadata is persisted. Samples and source never enter localStorage. */
export function loadWorkspace(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return { version: 1, programs: {}, customPrograms: [], selectedProgramId: '1inch-wallet' };
    if (raw.length > MAX_BYTES) throw new Error('Workspace metadata is too large.');
    const value = JSON.parse(raw);
    if (value.version !== 1 || !Array.isArray(value.customPrograms) || typeof value.programs !== 'object' || !value.programs) throw new Error('Unsupported workspace data.');
    return { version: 1, programs: value.programs, customPrograms: value.customPrograms.slice(0, 30), selectedProgramId: String(value.selectedProgramId ?? '1inch-wallet') };
  } catch {
    return { version: 1, programs: {}, customPrograms: [], selectedProgramId: '1inch-wallet', recoveryNotice: 'Saved metadata could not be read; a fresh local workspace was opened.' };
  }
}

export function saveWorkspace(workspace, storage = globalThis.localStorage) {
  const value = { version: 1, programs: workspace.programs ?? {}, customPrograms: (workspace.customPrograms ?? []).slice(0, 30), selectedProgramId: workspace.selectedProgramId };
  const raw = JSON.stringify(value);
  if (new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error('Workspace metadata limit reached. Remove old notes or custom programs.');
  if (!storage?.setItem) throw new Error('Local storage is unavailable. Export your report before closing this page.');
  storage.setItem(KEY, raw);
}

export function clearWorkspace(storage = globalThis.localStorage) {
  storage?.removeItem?.(KEY);
}
