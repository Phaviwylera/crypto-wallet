import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureScalarFocus, restoreScalarFocus } from '../src/input-focus.js';

test('scalar field focus and selection survive a rerender', () => {
  for (const id of ['search-lower', 'search-upper', 'point-search-lower', 'point-search-upper']) {
    const state = captureScalarFocus({ activeElement: { id, selectionStart: 2, selectionEnd: 5, selectionDirection: 'backward' } });
    let focused = false, selection;
    const input = { disabled: false, focus: (opts) => { focused = opts.preventScroll; }, setSelectionRange: (...args) => { selection = args; } };
    restoreScalarFocus({ getElementById: (name) => name === id ? input : null }, state);
    assert.equal(focused, true);
    assert.deepEqual(selection, [2, 5, 'backward']);
  }
  assert.equal(captureScalarFocus({ activeElement: { id: 'other' } }), null);
});
