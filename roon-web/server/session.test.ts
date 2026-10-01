import assert from 'node:assert/strict';
import test from 'node:test';
import { messageMatchesSession } from './session';

test('all entity controls reject object ids from another Core generation', () => {
  for (const t of ['transport', 'volume', 'favorite', 'play', 'power']) {
    assert.equal(messageMatchesSession({ t, generation: 7 }, 8), false, t);
    assert.equal(messageMatchesSession({ t, generation: 8 }, 8), true, t);
  }
});

test('search is correlated to a session while snapshot remains the recovery request', () => {
  assert.equal(messageMatchesSession({ t: 'search', generation: 7 }, 8), false);
  assert.equal(messageMatchesSession({ t: 'search', generation: 8 }, 8), true);
  assert.equal(messageMatchesSession({ t: 'snapshot' }, 8), true);
});
