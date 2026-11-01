// Preserve editable scalar input and cursor across whole-app progress renders.
const SCALAR_INPUT_IDS = new Set(['search-lower', 'search-upper', 'point-search-lower', 'point-search-upper']);

export function captureScalarFocus(document) {
  const input = document.activeElement;
  if (!input || !SCALAR_INPUT_IDS.has(input.id)) return null;
  return { id: input.id, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
}

export function restoreScalarFocus(document, state) {
  if (!state) return;
  const input = document.getElementById(state.id);
  if (!input || input.disabled) return;
  input.focus({ preventScroll: true });
  if (state.start !== null && state.end !== null) input.setSelectionRange(state.start, state.end, state.direction);
}
