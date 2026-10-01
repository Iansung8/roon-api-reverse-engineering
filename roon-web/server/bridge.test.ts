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
    { ...object(14n, 'Full Track'), typeName: 'Sooloos.Broker.Api.Track' },
    { ...object(15n, 'Full Artist'), typeName: 'Sooloos.Broker.Api.Performer' },
    { ...object(16n, 'Full Work'), typeName: 'Sooloos.Broker.Api.Work' },
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
  assert.deepEqual(result.tracks.map((row) => row.oid), ['11', '14']);
  assert.deepEqual(result.artists.map((row) => row.oid), ['12', '15']);
  assert.deepEqual(result.works.map((row) => row.oid), ['13', '16']);
});

test('concurrent repeated terms retain each SDK callback result identity set', async () => {
  const pending: Array<(objects: RoonObject[]) => void> = [];
  const roon = {
    search: () => new Promise<RoonObject[]>((resolve) => pending.push(resolve)),
  };

  const first = search(roon as never, 'same');
  const second = search(roon as never, 'same');
  pending[1]([object(2n, 'Second callback')]);
  pending[0]([object(1n, 'First callback')]);

  assert.deepEqual((await second).albums.map((row) => row.oid), ['2']);
  assert.deepEqual((await first).albums.map((row) => row.oid), ['1']);
});
