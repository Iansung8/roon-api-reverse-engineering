/**
 * Maps browser requests to the RoonClient. Phase 3: search + library.
 * Phase 4 adds transport/volume/favorite/play/standby.
 */
import { RoonClient, generated } from '../../roon-internal-api/src/index';
import { RoonObject } from '../../roon-internal-api/src/proto/objects';

function title(o: RoonObject): string | undefined {
  for (const [k, v] of Object.entries(o.fields)) if ((k.endsWith('::Title') || k.endsWith('::Name')) && typeof v === 'string') return v;
  return undefined;
}
// Roon links display names as `[[id|Name]]`; strip to plain text.
function cleanLinks(s: string): string {
  return s.replace(/\[\[\d+\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1');
}
function artistOf(o: RoonObject): string | undefined {
  for (const suf of ['::LocalizedPerformedBy', '::PerformedBy', '::Subtitle']) {
    for (const [k, v] of Object.entries(o.fields)) if (k.endsWith(suf) && typeof v === 'string' && v) return cleanLinks(v);
  }
  return undefined;
}

export interface AlbumRow { oid: string; title: string; artist?: string; favorite?: boolean }
export interface TrackRow { oid: string; title: string }
export interface ArtistRow { oid: string; name: string }
export interface NamedRow { oid: string; name: string }
export interface SearchResult {
  albums: AlbumRow[]; artists: NamedRow[]; playlists: NamedRow[]; genres: NamedRow[];
  tracks: TrackRow[]; works: NamedRow[];
}

function favoriteOf(o: RoonObject): boolean | undefined {
  for (const [k, v] of Object.entries(o.fields)) {
    if (k.endsWith('::IsFavorite') && typeof v === 'boolean') return v;
  }
  return undefined;
}

/** Map the current SDK UnifiedSearch result objects into the web response. */
export async function search(roon: RoonClient, q: string): Promise<SearchResult> {
  const term = q.trim();
  const empty: SearchResult = { albums: [], artists: [], playlists: [], genres: [], tracks: [], works: [] };
  if (term.length < 2) return empty;

  const objects = await roon.search(term, 50, true);
  const seen = new Set<string>();
  const albums: AlbumRow[] = [];
  const artists: NamedRow[] = [];
  const playlists: NamedRow[] = [];
  const genres: NamedRow[] = [];
  const tracks: TrackRow[] = [];
  const works: NamedRow[] = [];
  for (const o of objects) {
    const key = o.oid.toString();
    if (seen.has(key)) continue;
    const name = title(o);
    if (!name) continue;
    seen.add(key);
    if (o.typeName.endsWith('AlbumLite') || o.typeName.endsWith('.Album'))
      albums.push({ oid: key, title: cleanLinks(name), artist: artistOf(o), favorite: favoriteOf(o) });
    else if (o.typeName.endsWith('TrackLite') || o.typeName.endsWith('.Track'))
      tracks.push({ oid: key, title: cleanLinks(name) });
    else if (o.typeName.endsWith('PerformerLite') || o.typeName.endsWith('.Performer'))
      artists.push({ oid: key, name: cleanLinks(name) });
    else if (o.typeName.endsWith('WorkLite') || o.typeName.endsWith('.Work'))
      works.push({ oid: key, name: cleanLinks(name) });
    else if (o.typeName.endsWith('.Playlist'))
      playlists.push({ oid: key, name: cleanLinks(name) });
    else if (o.typeName.endsWith('GenreLite') || o.typeName.endsWith('BrowserGenre'))
      genres.push({ oid: key, name: cleanLinks(name) });
  }

  return {
    albums,
    artists,
    playlists,
    genres,
    tracks,
    works,
  };
}

export function library(roon: RoonClient): { albums: AlbumRow[]; artists: ArtistRow[] } {
  const seen = new Set<string>();
  const albums: AlbumRow[] = [];
  for (const o of [...roon.graph.findByType('AlbumLite'), ...roon.graph.findByType('Album')]) {
    const t = title(o);
    const key = o.oid.toString();
    if (t && !seen.has(key)) {
      seen.add(key);
      albums.push({ oid: key, title: t, artist: artistOf(o), favorite: favoriteOf(o) });
    }
  }
  const aseen = new Set<string>();
  const artists: ArtistRow[] = [];
  for (const o of roon.graph.findByType('PerformerLite')) {
    const n = title(o);
    const key = o.oid.toString();
    if (n && !aseen.has(key)) {
      aseen.add(key);
      artists.push({ oid: key, name: n });
    }
  }
  return { albums, artists };
}

// --- controls (Phase 4) ---

const TRANSPORT = new Set(['Pause', 'Play', 'PlayPause', 'Next', 'Previous', 'Stop']);

/** Zone transport: Pause/Play/PlayPause/Next/Previous/Stop (fire-and-forget). */
export function transport(roon: RoonClient, zoneOid: string, action: string): { ok: boolean } {
  if (!TRANSPORT.has(action)) throw new Error(`unsupported transport action: ${action}`);
  roon.zoneControl(BigInt(zoneOid), action as any);
  return { ok: true };
}

/** Endpoint volume (Endpoint::SetVolumeDouble). */
export async function setVolume(roon: RoonClient, endpointOid: string, value: number): Promise<{ ok: boolean; status: string }> {
  const ep = new generated.EndpointApi(roon, BigInt(endpointOid));
  const r = await ep.setVolumeDouble(value);
  return { ok: r.success, status: r.status };
}

/** Favorite/unfavorite an album (reversible). FavoriteBanState: None=0, Favorite=1. */
export async function favorite(roon: RoonClient, oid: string, on: boolean): Promise<{ ok: boolean; status: string }> {
  // favoriteAlbum keys on the stable AlbumId, not the session oid the UI holds.
  const album = roon.graph.getObject(BigInt(oid));
  const albumId = album ? roon.albumIdOf(album) : undefined;
  if (albumId === undefined) throw new Error(`album ${oid} not loaded or missing AlbumId`);
  const r = await roon.favoriteAlbum(albumId, on);
  return { ok: r.success, status: r.status };
}

/** Play an album or track on a zone (CONFIRM-gated at the caller; produces audio). */
export async function play(roon: RoonClient, zoneOid: string, kind: 'album' | 'track', oid: string): Promise<{ ok: boolean; status: string }> {
  const r = kind === 'track' ? await roon.playTrack(BigInt(zoneOid), BigInt(oid)) : await roon.playAlbum(BigInt(zoneOid), BigInt(oid));
  return { ok: r.success, status: r.status };
}

/** Standby (power off) / ConvenienceSwitch (power on) an endpoint (CONFIRM-gated). */
export async function power(roon: RoonClient, endpointOid: string, on: boolean): Promise<{ ok: boolean; status?: string }> {
  if (on) {
    const r = await roon.powerOn(BigInt(endpointOid));
    return { ok: r.success, status: r.status };
  }
  roon.standby(BigInt(endpointOid));
  return { ok: true };
}
