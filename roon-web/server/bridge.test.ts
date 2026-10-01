import assert from 'node:assert/strict';
import test from 'node:test';
import { library } from './bridge';
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
