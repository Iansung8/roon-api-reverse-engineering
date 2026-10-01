import assert from 'node:assert/strict';
import test from 'node:test';
import { SearchState } from './search-state';

function request(state: SearchState, q: string) {
  const input = state.input(q);
  if (input.clear) throw new Error(`expected a request for ${q}`);
  return input.request;
}

test('only the current request may render an out-of-order response', () => {
  const state = new SearchState();
  const first = request(state, 'abbey');
  const second = request(state, 'abbey road');

  assert.equal(state.accept(first.id, first.q), false);
  assert.equal(state.accept(second.id, second.q), true);
});

test('short or empty input clears and invalidates an in-flight search', () => {
  const state = new SearchState();
  const pending = request(state, 'beatles');

  assert.deepEqual(state.input('b'), { clear: true });
  assert.equal(state.accept(pending.id, pending.q), false);
  assert.deepEqual(state.input('  '), { clear: true });
});

test('repeating a term creates a new identity for response correlation', () => {
  const state = new SearchState();
  const first = request(state, 'radiohead');
  const second = request(state, 'radiohead');

  assert.notEqual(first.id, second.id);
  assert.equal(state.accept(first.id, first.q), false);
  assert.equal(state.accept(second.id, second.q), true);
});
