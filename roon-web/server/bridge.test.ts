import assert from 'node:assert/strict';
import test from 'node:test';
import { library, search } from './bridge';
import type { RoonObject } from '../../roon-internal-api/src/proto/objects';

function object(oid: bigint, title: string, favorite?: boolean): RoonObject {
  const fields: Record<string, unknown> = {
    'Sooloos.Broker.Api.Album::Title': title,
  };
  if (favorite !== undefined) fields['Sooloos.Broker.Api.Album::IsFavorite'] = favorite;
  return { oid, typeId: 1, typeName: 'Sooloos.Broker.Api.Album', fields };
}

test('library rows preserve true, false, and unknown IsFavorite states', () => {
  const albums = [object(1n, 'Favorite', true), object(2n, 'Plain', false), object(3n, 'Unknown')];
  const roon = {
    graph: {
      findByType(type: string) {
        if (type === 'Album') return albums;
        return [];
      },
    },
  };

  assert.deepEqual(library(roon as never).albums.map(({ oid, favorite }) => ({ oid, favorite })), [
    { oid: '1', favorite: true },
    { oid: '2', favorite: false },
    { oid: '3', favorite: undefined },
  ]);
});

test('search maps only the current UnifiedSearch result identities', async () => {
  const current = [
    object(10n, 'Current Album', true),
    { ...object(11n, 'Current Track'), typeName: 'Sooloos.Broker.Api.TrackLite' },
    { ...object(12n, 'Current Artist'), typeName: 'Sooloos.Broker.Api.PerformerLite' },
    { ...object(13n, 'Current Work'), typeName: 'Sooloos.Broker.Api.WorkLite' },
  ];
  const roon = {
    search: async (q: string) => {
      assert.equal(q, 'current query');
      return current;
    },
    graph: {
      objects: new Map([['999', object(999n, 'Stale Graph Album')]]),
      findByType: () => [object(999n, 'Stale Graph Album')],
    },
  };

  const result = await search(roon as never, ' current query ');
  assert.deepEqual(result.albums.map((row) => row.oid), ['10']);
  assert.deepEqual(result.tracks.map((row) => row.oid), ['11']);
  assert.deepEqual(result.artists.map((row) => row.oid), ['12']);
  assert.deepEqual(result.works.map((row) => row.oid), ['13']);
});

test('a repeated term does not reuse identities absent from the current SDK graph diff', async () => {
  let call = 0;
  const roon = {
    search: async () => call++ === 0 ? [object(1n, 'First result')] : [],
  };

  assert.deepEqual((await search(roon as never, 'same')).albums.map((row) => row.oid), ['1']);
  assert.deepEqual((await search(roon as never, 'same')).albums, []);
});
