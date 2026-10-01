import assert from 'node:assert/strict';
import test from 'node:test';
import { RoonPool } from './roon';

class FakeClient {
  conn = { onclosed: () => { this.originalCloseCalls += 1; } };
  originalCloseCalls = 0;
  connectCalls = 0;
  connectImpl: () => Promise<void> = async () => {};

  connect(): Promise<void> {
    this.connectCalls += 1;
    return this.connectImpl();
  }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('coalesces concurrent connects onto one fresh client', async () => {
  const gate = deferred();
  const clients: FakeClient[] = [];
  const pool = new RoonPool(() => {
    const client = new FakeClient();
    client.connectImpl = () => gate.promise;
    clients.push(client);
    return client;
  });

  const first = pool.get();
  const second = pool.get();
  assert.equal(clients.length, 1);
  gate.resolve();
  assert.equal(await first, await second);
  assert.equal(clients[0].connectCalls, 1);
  assert.deepEqual(pool.health(), { connected: true, connecting: false });
});

test('failed recovery clears connecting state and allows a fresh client', async () => {
  const clients: FakeClient[] = [];
  const pool = new RoonPool(() => {
    const client = new FakeClient();
    if (clients.length === 0) client.connectImpl = async () => { throw new Error('core unavailable'); };
    clients.push(client);
    return client;
  });

  await assert.rejects(pool.get(), /core unavailable/);
  assert.deepEqual(pool.health(), { connected: false, connecting: false });
  const recovered = await pool.get();
  assert.equal(recovered, clients[1]);
});

test('terminal close preserves the SDK callback and recovers with a fresh client', async () => {
  const clients: FakeClient[] = [];
  const pool = new RoonPool(() => {
    const client = new FakeClient();
    clients.push(client);
    return client;
  });

  const first = await pool.get();
  first.conn.onclosed();
  assert.equal(first.originalCloseCalls, 1);
  assert.equal(pool.current(), null);
  assert.deepEqual(pool.health(), { connected: false, connecting: false });

  const second = await pool.get();
  assert.notEqual(second, first);
  assert.equal(clients.length, 2);
});

test('a late close callback from an old client cannot evict the current client', async () => {
  const clients: FakeClient[] = [];
  const pool = new RoonPool(() => {
    const client = new FakeClient();
    clients.push(client);
    return client;
  });

  const first = await pool.get();
  first.conn.onclosed();
  const second = await pool.get();
  first.conn.onclosed();
  assert.equal(pool.current(), second);
  assert.deepEqual(pool.health(), { connected: true, connecting: false });
});

test('a client that closes before connect settles is never published', async () => {
  const gate = deferred();
  let attempts = 0;
  let candidate: FakeClient | null = null;
  const pool = new RoonPool(() => {
    const client = new FakeClient();
    candidate = client;
    if (attempts++ === 0) client.connectImpl = () => gate.promise;
    return client;
  });

  const pending = pool.get();
  candidate!.conn.onclosed();
  gate.resolve();
  await assert.rejects(pending, /closed while connecting/);
  assert.equal(pool.current(), null);
  assert.ok(await pool.get());
});
