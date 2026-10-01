import assert from 'node:assert/strict';
import test from 'node:test';

class FakeClassList {
  private readonly names = new Set<string>();
  contains(name: string) { return this.names.has(name); }
  toggle(name: string, force?: boolean) {
    const enabled = force ?? !this.names.has(name);
    if (enabled) this.names.add(name); else this.names.delete(name);
    return enabled;
  }
}

class FakeElement {
  value = '';
  innerHTML = '';
  textContent = '';
  className = '';
  title = '';
  disabled = false;
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  listeners = new Map<string, (event: any) => void>();
  actionNodes: FakeElement[] = [];

  constructor(readonly id = '') {}
  addEventListener(name: string, listener: (event: any) => void) { this.listeners.set(name, listener); }
  querySelectorAll(selector: string) { return selector.includes('[data-action') ? this.actionNodes : []; }
  setAttribute(name: string, value: string) { (this as any)[name] = value; }
  removeAttribute(name: string) { delete (this as any)[name]; }
  appendChild() {}
  remove() {}
}

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string) { sockets.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
}

const sockets: FakeWebSocket[] = [];

test('app wiring invalidates old entities and correlates repeated searches across sessions', async () => {
  const ids = [
    'status', 'app', 'q', 'target', 'api-filter', 'search-results', 'zones-count', 'zones',
    'dev-count', 'devices', 'lib-count', 'library', 'api-count', 'api-list',
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
  const app = elements.get('app')!;
  const body = new FakeElement('body');
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  let serverGeneration = 1;

  const fakeSetTimeout = (callback: () => void, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  };
  const runDelay = (delay: number) => {
    const match = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(match, `missing ${delay}ms timer`);
    timers.delete(match[0]);
    match[1].callback();
  };

  const globals = globalThis as any;
  const originals = {
    document: globals.document,
    window: globals.window,
    location: globals.location,
    WebSocket: globals.WebSocket,
    fetch: globals.fetch,
    confirm: globals.confirm,
    setTimeout: globals.setTimeout,
    clearTimeout: globals.clearTimeout,
  };

  globals.document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => new FakeElement(),
    body,
  };
  globals.window = { setTimeout: fakeSetTimeout, clearTimeout: (id: number) => timers.delete(id) };
  globals.location = { host: 'test.local' };
  globals.WebSocket = FakeWebSocket;
  globals.confirm = () => true;
  globals.setTimeout = fakeSetTimeout;
  globals.clearTimeout = (id: number) => timers.delete(id);
  globals.fetch = async (url: string) => ({
    json: async () => url === '/api/catalog'
      ? { source: 'test', serviceCount: 0, methodCount: 0, services: [] }
      : {
          generation: serverGeneration,
          albums: [{ oid: '10', title: `Album ${serverGeneration}`, favorite: false }],
          artists: [],
        },
  });

  try {
    await import('./app');
    assert.equal(sockets.length, 1);
    const firstSocket = sockets[0];
    firstSocket.onopen?.();
    firstSocket.onmessage?.({ data: JSON.stringify({ t: 'snapshot', generation: 1, zones: [], devices: [] }) });
    await Promise.resolve();
    await Promise.resolve();

    const oldFavorite = new FakeElement('old-favorite');
    oldFavorite.dataset = { action: 'favorite', oid: '10' };
    app.actionNodes = [oldFavorite];
    app.listeners.get('click')?.({ target: { closest: () => oldFavorite } });
    assert.deepEqual(firstSocket.sent.at(-1), { t: 'favorite', oid: '10', on: true, generation: 1 });
    assert.equal(oldFavorite.disabled, true);

    firstSocket.onclose?.();
    assert.equal(oldFavorite.disabled, true);
    assert.match(elements.get('library')!.innerHTML, /reconnecting/);
    assert.equal(elements.get('search-results')!.innerHTML, '');

    runDelay(1500);
    assert.equal(sockets.length, 2);
    serverGeneration = 2;
    const secondSocket = sockets[1];
    secondSocket.onopen?.();
    secondSocket.onmessage?.({ data: JSON.stringify({ t: 'snapshot', generation: 2, zones: [], devices: [] }) });
    await Promise.resolve();
    await Promise.resolve();
    assert.match(elements.get('library')!.innerHTML, /Album 2/);

    const newFavorite = new FakeElement('new-favorite');
    newFavorite.dataset = { action: 'favorite', oid: '10' };
    app.actionNodes = [newFavorite];
    app.listeners.get('click')?.({ target: { closest: () => newFavorite } });
    assert.deepEqual(secondSocket.sent.at(-1), { t: 'favorite', oid: '10', on: true, generation: 2 });
    secondSocket.onmessage?.({ data: JSON.stringify({ t: 'result', action: 'favorite', oid: '10', ok: true, generation: 1 }) });
    assert.equal(newFavorite.disabled, true);
    secondSocket.onmessage?.({ data: JSON.stringify({ t: 'result', action: 'favorite', oid: '10', ok: false, generation: 2 }) });
    assert.equal(newFavorite.disabled, false);
    assert.equal(newFavorite.textContent, '♡');

    const query = elements.get('q')!;
    query.value = 'same query';
    query.listeners.get('input')?.({});
    runDelay(250);
    const firstSearch = secondSocket.sent.at(-1);
    query.listeners.get('input')?.({});
    runDelay(250);
    const secondSearch = secondSocket.sent.at(-1);
    assert.notEqual(firstSearch.id, secondSearch.id);
    assert.equal(secondSearch.generation, 2);

    secondSocket.onmessage?.({ data: JSON.stringify({
      t: 'searchResults', id: secondSearch.id, q: secondSearch.q, generation: 2,
      albums: [{ oid: '22', title: 'Second result' }], artists: [], playlists: [], genres: [], tracks: [], works: [],
    }) });
    secondSocket.onmessage?.({ data: JSON.stringify({
      t: 'searchResults', id: firstSearch.id, q: firstSearch.q, generation: 2,
      albums: [{ oid: '21', title: 'Stale result' }], artists: [], playlists: [], genres: [], tracks: [], works: [],
    }) });
    assert.match(elements.get('search-results')!.innerHTML, /Second result/);
    assert.doesNotMatch(elements.get('search-results')!.innerHTML, /Stale result/);
  } finally {
    Object.assign(globals, originals);
  }
});
