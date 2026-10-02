---
title: Recipes
description: The bits that worked when I tried them — favorites, playback, transport, standby, a metadata edit, search, and the generated method surface.
sidebar:
  order: 2
---

These map to runnable scripts in
[`roon-internal-api/examples/`](https://github.com/arthursoares/roon-api-reverse-engineering/tree/main/roon-internal-api/examples).
All assume a connected `roon: RoonClient` (see [Getting started](/api/getting-started/)) and
your own zone/album names. Each of these worked against my Core when I tried it by hand —
that's the extent of the testing.

## Favorite an album

```ts
const album = roon.findByTitle('AlbumLite', 'Kind of Blue');
if (album) await roon.favoriteAlbum(roon.albumIdOf(album)!, true);   // false to un-favorite
```

Showed up in the Roon UI; reversible. `examples/live-favorite.ts`.

## Play

```ts
// by oids
await roon.playAlbum(zoneOid, albumOid);
await roon.playTrack(zoneOid, trackOid);

// or by name, in one call
await roon.playAlbumOnZone('Living Room', 'Kind of Blue');
```

`examples/live-play.ts`. **This produces sound** — point it at a zone you don't mind
interrupting.

## Transport & power

```ts
const zone = roon.zoneByName('Living Room')!;
roon.zoneControl(zone, 'Pause');  // 'Play' | 'PlayPause' | 'Stop' | 'Next' | 'Previous'

const ep = roon.endpointByName('Living Room')!;
roon.standby(ep);          // fire-and-forget standby
await roon.powerOn(ep);    // ConvenienceSwitch power-on
```

`examples/live-pause.ts`, `examples/live-standby.ts`.

## Metadata editing

The original reason for the whole experiment — things the public extension API can't do.
This goes through `Library::Edit`. It worked and was reversible in my testing, but it's
editing real library metadata, so be careful.

```ts
// read current editable metadata
const info = await roon.getAlbumEditInfo(albumOid);

// edit rating (1–5)
await roon.editAlbumRating(albumId, 5);

// edit several fields at once
await roon.editAlbum(albumId, {
  title: 'New Title',
  genres: ['Jazz'],
  labels: ['Columbia'],
});

// drop the title edit again (sends Title.ClearEdits)
await roon.editAlbum(albumId, { clearTitle: true });
```

In the edit info, `edited` means the user changed that field: `editValue` is set, or for
lists `AddValues`/`RemoveValues` are non-empty. `hasEditLayer` only says the album has an
edit layer, which albums nobody touched can have too.

Get the durable `albumId` (distinct from the session oid) with `roon.albumIdOf(album)`.
`examples/edit-album.ts`, `examples/album-edit-info.ts`.

:::caution
Edits change real metadata. They're reversible (set → read back → restore), but test on
something disposable first.
:::

## Merge, identify and set the primary version

These are the structural edits the desktop client makes through `Library::Edit`. Each one
follows the shape seen in official-client captures and was replayed against a live Core
(Roon 2.73 build 1696). They change how the library is grouped, so take a backup first.

```ts
// merge tracks into a new album (pass an existing AlbumId as the second argument to move them there)
await roon.mergeTracks([
  { trackId: firstTrackId, trackNumber: 1, mediaNumber: 1 },
  { trackId: secondTrackId, trackNumber: 2, mediaNumber: 1 },
]);

// identify an album: fetch a release's editions, pair the files with one, then apply it
const files = await roon.matchFilesForAlbum(albumOid);          // session oid of the album
const editions = await roon.getMatchingEditions(releaseId, files.map((f) => f.tags));
const edition = editions[0];                                    // choose by confidence
const { pairs, complete } = pairFilesWithEdition(files, edition.releaseTracks);
if (edition.editionId === null || !complete) throw new Error('not every file pairs with this edition');
await roon.identifyAlbum(albumId, edition.editionId,
  pairs.map((p) => ({ trackId: p.trackId, metadataTrackId: p.metadataTrackId! })));

// make one copy of a release the primary version; the others point at it
await roon.setPrimaryVersion(primaryAlbumId, [otherAlbumId]);
```

- `releaseId` is a candidate's `AlbumLite.AlbumId` from `Metadata::UserSearch`; the chosen
  edition's id is what gets applied as `MetadataAlbumId`.
- `edition.releaseTracks` is every track of the edition, not a per-file mapping.
  `pairFilesWithEdition` (exported from `roon-internal-api`) pairs files by disc and track
  number and confirms each pair by title or length.
- Without a target, `mergeTracks` sends a temporary album id (counter × 256 + 30), as the
  desktop client does, and the Core creates the album.
- Roon re-attaches an old track's edits to a new file with identical audio, so re-imported
  files can land in an album from an earlier merge. Move them with another `mergeTracks`.
- Merges into disc numbers above 1 have not been run against a live Core yet.

:::danger[clearTrackEdits]
`roon.clearTrackEdits(trackIds)` sends `ClearMetadataEdits`: it removes the user's edits on
those tracks (such as track and disc numbers) and cannot be undone except from a backup.
It does not undo a merge; album membership stays where the merge put it.
:::

## Search

```ts
const objects = await roon.search('Miles Davis');  // albums/tracks/performers/works
const withSections = await roon.search('Jazz', 50, true); // also playlists and genres
```

UnifiedSearch follows the Core's returned memberships, including cached results on
repeated queries. The optional third argument retains playlist and genre results;
existing callers keep the four entity families shown above. These reads were checked
against Roon 2.73 build 1696. Broader streaming-catalog behavior still needs validation.

### Album queries

`queryAlbums` runs `Library::VirtualAlbumQuery` with any `AlbumQueryCriteria` members. It
collects every match's durable `AlbumId` through the query object's `SelectAll` +
`GetSelected`, fetches the first `resolveLimit` albums (default 40) with `getAlbumById`, and
disposes the server-side query. `searchAlbums(term, limit)` is a text-filter shortcut on top
of it.

```ts
import { BinaryWriter, PropertyType } from 'roon-internal-api';

const { count, ids, albums } = await roon.queryAlbums([
  { name: 'TextFilter', propType: PropertyType.String, value: new BinaryWriter().string('Kind of Blue').toBuffer() },
], { resolveLimit: 10 });
const firstTen = await roon.searchAlbums('Kind of Blue', 10);
```

Query pages arrive through `Page` events, so reading `$items` after `RetainPage` (what
`searchAlbums` used to do) stays empty. Checked on Roon 2.73 build 1696 with a favorites
query (`RequireIsFavorite`), which returned the same 170 albums as the desktop client.
`examples/poc-search.ts` remains an experimental research path; historical findings are
preserved in [the journey](/journey/#where-it-stands).

## The full generated API

Every method in the extracted catalog is generated as a typed wrapper. `makeApi(client)`
binds the singleton services; entity classes take an explicit object id.

```ts
import { makeApi } from 'roon-internal-api';

const api = makeApi(roon /* RoonClient's underlying RemotingClient */);
await api.library.favoriteOrBan(/* … */);
```

Arguments are built from each parameter's kind (sooid / primitive / enum / ref / struct /
list / callback). The generator is `tools/gen_client.ts`; output is `src/generated/api.ts`.

:::caution[Generated ≠ tested]
This is the big asterisk on the whole project. ~1550 methods are generated and type-check,
but only the handful above have been run against a real Core. The encoding for those is
checked against captures; everything else is correct-by-construction at best and **completely
untested** at worst. Validate before relying on any of it —
[here's how](/contributing/#validating-a-method).
:::
