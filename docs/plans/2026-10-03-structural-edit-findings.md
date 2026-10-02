# Structural library edits — capture and live findings (2026-10-03)

Merge, identify and set-primary-version work through `Library::Edit`, extending the
[2026-06-12 metadata findings](2026-06-12-metadata-edit-findings.md) from album fields to
album grouping. Setup: one Core on Roon 2.73 build 1696. The desktop client was captured
with Windows `pktmon` while a user performed each operation once. The capture missed the
connection start, so method ids were matched to catalog signatures by decoding their
arguments (85 of the 311 calls resolved this way). Every live write was preceded by a
backup and read back afterwards. The captures are not committed because they contain
library data.

## Encoding (from captures)

```
LibraryEdit {
  Albums: IList<AlbumEdit>   LengthPrefixed(24)   // already known
  Tracks: IList<TrackEdit>   LengthPrefixed(24)   // new: non-empty in merge and identify edits
}
TrackEdit { TrackId: long, <field>: Edit*<T> ..., ClearMetadataEdits: bool }
```

`Performers` only ever appeared as an empty list, so its framing is left as the catalog
reports it.

| operation | member | wrapper | values sent |
|---|---|---|---|
| merge | `TrackEdit.AlbumId` | `EditRequiredVal<long>` | `EditValue` = temporary id or an existing AlbumId |
| | `TrackEdit.TrackNumber`, `MediaNumber` | `EditRequiredVal<int>` | `EditValue` |
| identify | `AlbumEdit.MetadataAlbumId` | `EditOptionalVal<long>` | `ClearBaseValue` = false, `EditValue` = edition id |
| | `TrackEdit.MetadataTrackId` | `EditOptionalVal<long>` | `EditValue` = release TrackId |
| set primary | `AlbumEdit.DuplicateOf` on the primary | `EditOptionalRef<AlbumLite>` | `ClearBaseValue` = true, `ClearEdits` = true |
| | `AlbumEdit.DuplicateOf` on the others | `EditOptionalRef<AlbumLite>` | `EditValue` = the primary's AlbumLite reference |
| clear track edits | `TrackEdit.ClearMetadataEdits` | — | true |

- Library ids look like `counter * 256 + typeCode`, so the low byte is the type: 47 for
  albums, 50 for tracks. For a merge into a new album the desktop client sends a temporary
  album id with type code 30 (1822 = 7 * 256 + 30 in the capture); the Core creates the album.
- `DuplicateOf` takes an `AlbumLite` (from `Library::GetAlbumLite(long)`), not the `Album`
  object that `GetAlbum` returns.
- Identify flow: `Metadata::UserSearch` gives candidate releases (`AlbumLite.AlbumId`);
  `Metadata::GetMatchingEditions(long, IEnumerable<IDictionary<string,string>>)` takes one
  tag dictionary per file and returns editions with `Confidence`, `AlbumEditionId`,
  `ReleaseTitle` and `Tracks`. `Tracks` is every track of that edition in release order, not a
  per-file mapping: three files came back with 46- and 60-track editions, so the client pairs
  files with tracks itself (`pairFilesWithEdition` does it by disc and track number). The chosen
  edition's id becomes `MetadataAlbumId`. Each dictionary holds the file's tags plus
  `TRACKNUMBERFROMFILENAME`, `LENGTH`, `LENGTHMS`, `MEDIANUMBER` and `ORIGINALPATH`. A
  repeated key (two `COMPOSER` tags) makes the Core answer `UnexpectedError`.

## Results (live)

| operation | result |
|---|---|
| set primary | switched a release back to the local copy; `DuplicateOf` read back as sent |
| merge into a new album | two 3-track albums became one 6-track album numbered 1–6 |
| merge into an existing album | 6 split-off tracks joined a 57-track album: 63 tracks numbered 1–63 |
| identify | 4 editions returned for a 63-track album; the chosen edition's 63 tracks paired with the 63 files by position, as Roon's own identification did; the title and every `MetadataTrackId` applied |
| clear track edits | stale track-number edits removed; album membership unchanged |

## Core behavior that affects these operations

- **Identical audio inherits old edits.** A re-imported file with the same audio as a
  previously edited track was attached to that track's old album and edits, even after the
  old files were deleted. Another merge moves it.
- **`ClearMetadataEdits` does not regroup.** Clearing track edits does not undo album
  membership set by a merge; only another merge moves tracks.

## Open

- `LibraryEdit::Performers` (seen only empty), `::Works`, `::Performances` and `::Genres`:
  framing unconfirmed.
- Merges into disc numbers above 1 have not been run live.
