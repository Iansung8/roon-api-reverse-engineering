import assert from 'node:assert/strict';
import test from 'node:test';
import { FavoriteState } from './favorite-state';

test('an initially favorited album unfavorites once while pending', () => {
  const state = new FavoriteState();
  state.seed('42', true);

  assert.equal(state.begin('42'), false);
  assert.deepEqual(state.view('42'), { favorite: true, pending: true, target: false });
  assert.equal(state.begin('42'), null);

  state.settle('42', true);
  assert.deepEqual(state.view('42'), { favorite: false, pending: false });
});

test('a failed favorite keeps the last confirmed state', () => {
  const state = new FavoriteState();
  state.seed('42', false);

  assert.equal(state.begin('42'), true);
  state.settle('42', false);
  assert.deepEqual(state.view('42'), { favorite: false, pending: false });
});

test('unknown favorite state cannot be toggled as if it were false', () => {
  const state = new FavoriteState();
  state.seed('42', undefined);

  assert.equal(state.begin('42'), null);
  assert.deepEqual(state.view('42'), { favorite: undefined, pending: false });
});
