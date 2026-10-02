/**
 * RoonClient — high-level facade over the ported remoting stack.
 *
 * Consolidates connection + remoting + object graph + service lookup so a PoC is
 * a few lines. The generic `call()` plus the typed helpers (favorite, play,
 * pause, standby, query-by-title) all run against the live core and are proven
 * end-to-end (favorite UI-confirmed, playback audio-confirmed).
 *
 *   const roon = new RoonClient({ host: 'YOUR_CORE_IP', serverBrokerId });
 *   await roon.connect();
 *   const album = roon.findByTitle('AlbumLite', 'Clube Da Esquina');
 *   await roon.favoriteAlbum(roon.albumIdOf(album!)!, true);
 *   await roon.playAlbumOnZone('HiFi', album!.oid);
 */
import { RoonConnection } from './connection';
import { RemotingClient, CallResult } from './remoting';
import { ObjectGraph, RoonObject, isRef, PropertyType, decodeRefList } from './objects';
import { formatMethodSignature, CatalogParam } from '../catalog/signature';
import { Arg, buildArgs, decodeStringTupleList, encodeStringDictList } from './serializer';
import { structArg } from './structs';
import { BinaryWriter } from './writer';
import { BinaryReader } from './reader';
import { readFlexLong } from './flex';

/** A field for a populated by-value struct argument. */
export interface StructField {
  name: string;
  propType: PropertyType;
  value: Buffer;
}

export interface RoonClientOptions {
  host: string;
  port?: number;
  serverBrokerId: Buffer;
  /** profile Sooid (value bytes). Defaults to the Profile object the Core
   * pushes into the graph on connect — pass this only to pin a specific
   * profile on a multi-profile Core. */
  profileSooid?: Buffer;
  /** ms to wait for the object graph to settle after getService. */
  settleMs?: number;
}

// The root service guid (stable). getService(root) populates the object graph.
const ROOT_SERVICE_GUID = Buffer.from('bcd36e8478a3e111b2725b4a6188709b', 'hex');

export class RoonClient {
  readonly conn: RoonConnection;
  readonly remoting: RemotingClient;
  readonly graph = new ObjectGraph();
  private readonly explicitProfile?: Buffer;
  private cachedProfile?: Buffer;
  private settleMs: number;

  constructor(opts: RoonClientOptions) {
    this.conn = new RoonConnection({ host: opts.host, port: opts.port, serverBrokerId: opts.serverBrokerId });
    this.remoting = new RemotingClient(this.conn);
    this.remoting.onPush = (f) => this.graph.ingest(f);
    // Whenever the socket dies (peer disconnect, error, close), fail in-flight
    // requests immediately rather than waiting out their timeouts.
    this.conn.onclosed = () => this.remoting.failPending('broker connection closed');
    this.explicitProfile = opts.profileSooid;
    this.settleMs = opts.settleMs ?? 2000;
  }

  /**
   * The profile Sooid used by the library calls: the explicit option when
   * given, else read from the Profile object in the graph (available after
   * connect()). The old hardcoded default was one specific Core's profile id —
   * on every other Core the server matched nothing against it, which is a big
   * part of why search returned no results.
   */
  profile(): Buffer {
    if (this.explicitProfile) return this.explicitProfile;
    if (this.cachedProfile) return this.cachedProfile;
    for (const o of this.graph.objects.values()) {
      if (!o.typeName.endsWith('.Profile')) continue;
      for (const [k, v] of Object.entries(o.fields)) {
        if (k.endsWith('::ProfileId') && Buffer.isBuffer(v)) {
          this.cachedProfile = v;
          return v;
        }
      }
    }
    throw new Error('no Profile object in the graph yet — connect() first, or pass profileSooid');
  }

  /** Connect, establish the remoting session, and load the object graph. */
  async connect(): Promise<void> {
    await this.conn.connect();
    await this.remoting.getService(ROOT_SERVICE_GUID);
    await new Promise((r) => setTimeout(r, this.settleMs));
  }

  close(): void {
    // failPending fires synchronously here (and again, as a no-op, from the
    // socket 'close' event) so callers see rejections before close() returns.
    this.remoting.failPending('client closed');
    this.conn.close();
  }

  // --- object lookup ---

  serviceOid(name: string): bigint {
    const o = this.graph.findByType(name)[0];
    if (!o) throw new Error(`service object "${name}" not found`);
    return o.oid;
  }

  private strField(o: RoonObject, suffix: string): string | undefined {
    for (const [k, v] of Object.entries(o.fields)) if (k.endsWith(suffix) && typeof v === 'string') return v;
    return undefined;
  }

  /** Find a loaded object of a type by its Title/Name (case-insensitive). */
  findByTitle(typeName: string, title: string): RoonObject | undefined {
    return this.graph.findByType(typeName).find((o) => {
      const t = this.strField(o, '::Title') ?? this.strField(o, '::Name');
      return t?.toLowerCase() === title.toLowerCase();
    });
  }

  /** Resolve a zone object id by the name of one of its endpoints. */
  zoneByName(name: string): bigint | undefined {
    for (const e of this.graph.findByType('Endpoint')) {
      if (this.strField(e, '::Name')?.toLowerCase().includes(name.toLowerCase())) {
        for (const [k, v] of Object.entries(e.fields)) if (k.endsWith('::Zone') && isRef(v)) return (v as any).$ref;
      }
    }
    return undefined;
  }

  /** Resolve an endpoint object id by name. */
  endpointByName(name: string): bigint | undefined {
    const e = this.graph
      .findByType('Endpoint')
      .find((x) => this.strField(x, '::Name')?.toLowerCase().includes(name.toLowerCase()));
    return e?.oid;
  }

  // --- generic call ---

  /** Call a method by service + name + params + pre-built args; returns the result. */
  call(service: string, method: string, params: CatalogParam[], args: Buffer, objectId?: bigint): Promise<CallResult> {
    const sig = formatMethodSignature(service, method, params);
    return this.remoting.callMethod(objectId ?? this.serviceOid(service), sig, args);
  }

  /** Build a sparse value using the shared full schema and stable field indexes. */
  structArg(typeName: string, fields: StructField[]): Buffer {
    return structArg(this.remoting, typeName, fields);
  }

  /** ms to wait for UnifiedSearch result objects to stream into the graph. */
  private searchSettleMs = 2000;

  /**
   * Library::UnifiedSearch — library and streaming-catalog results.
   * Resolve only the callback's result graph. TopSearchResults keep the Core's
   * ranking, followed by highlighted albums and category lists in a stable
   * order. Version lists preserve their order; repeated OIDs appear once.
   * Opt in to playlist and genre hits with includePlaylistsAndGenres. Their
   * lists follow ranked hits/highlights and precede broad categories so large
   * performer lists do not consume the entire result limit first.
   */
  async search(terms: string, maxCount = 50, includePlaylistsAndGenres = false): Promise<RoonObject[]> {
    const params = this.structArg('Sooloos.Broker.Api.SearchParameters', [
      {
        name: 'System.Sooid Sooloos.Broker.Api.SearchParameters::ProfileId',
        propType: PropertyType.Sooid,
        value: new BinaryWriter().sooid(this.profile()).toBuffer(),
      },
      {
        name: 'string Sooloos.Broker.Api.SearchParameters::Terms',
        propType: PropertyType.String,
        value: new BinaryWriter().string(terms).toBuffer(),
      },
      {
        name: 'int Sooloos.Broker.Api.SearchParameters::MaxCount',
        propType: PropertyType.Int,
        value: new BinaryWriter().integer(maxCount).toBuffer(),
      },
      {
        name: 'int Sooloos.Broker.Api.SearchParameters::MaxTopResultCount',
        propType: PropertyType.Int,
        value: new BinaryWriter().integer(20).toBuffer(),
      },
    ]);
    const res = await this.call(
      'Library',
      'UnifiedSearch',
      [
        { type: 'SearchParameters', name: 'p' },
        { type: 'ResultCallback<UnifiedSearchResults>', name: 'cb' },
      ],
      params,
      this.serviceOid('Library')
    );
    if (!res.success) throw new Error(`UnifiedSearch failed: ${res.status}`);
    const result = this.graph.decodeReturnValue(Uint8Array.from(res.payload));
    const [, end] = readFlexLong(res.payload, 0);
    if (!isRef(result) || end !== res.payload.length || res.payload.length > 10) {
      throw new Error('UnifiedSearch returned an invalid result reference');
    }
    const deadline = Date.now() + this.searchSettleMs;
    for (;;) {
      const objects = this.searchResultObjects(result.$ref, includePlaylistsAndGenres);
      if (objects !== undefined) return objects.slice(0, Math.max(0, maxCount));
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('UnifiedSearch result graph is incomplete');
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)));
    }
  }

  /** undefined means a referenced membership object has not arrived yet. */
  private searchResultObjects(rootId: bigint, includePlaylistsAndGenres: boolean): RoonObject[] | undefined {
    const root = this.graph.getObject(rootId);
    if (!root) return undefined;
    if (!root.typeName.endsWith('.UnifiedSearchResults')) {
      throw new Error('UnifiedSearch returned an unexpected result type');
    }
    const rootMembers = ['TopSearchResults', 'TopAlbum', 'TopLibraryAlbum',
      'Performers', 'Composers', 'Albums', 'Tracks', 'Works'];
    // Full entities implement their Lite interfaces and can already occupy a
    // returned OID in the shared graph. They remain terminal search hits.
    const leaves = new Set(['AlbumLite', 'TrackLite', 'PerformerLite', 'WorkLite',
      'Album', 'Track', 'Performer', 'Work']);
    if (includePlaylistsAndGenres) {
      rootMembers.splice(3, 0, 'Playlists', 'Genres');
      for (const type of ['Playlist', 'BrowserGenre', 'GenreLite']) leaves.add(type);
    }
    const seen = new Set<bigint>();
    const out: RoonObject[] = [];
    let complete = true;
    const member = (fields: Record<string, unknown>, name: string): unknown =>
      Object.entries(fields).find(([key]) => key.endsWith(`::${name}`))?.[1];
    const visit = (value: unknown): void => {
      if (value === null || value === undefined) return;
      let type: string;
      let fields: Record<string, unknown>;
      if (isRef(value)) {
        if (seen.has(value.$ref)) return;
        seen.add(value.$ref);
        const object = this.graph.getObject(value.$ref);
        if (!object) { complete = false; return; }
        type = object.typeName;
        fields = object.fields;
        if (leaves.has(type.slice(type.lastIndexOf('.') + 1))) {
          out.push(object);
          return; // An album's metadata references are not search membership.
        }
      } else if (typeof value === 'object' && '$type' in value) {
        fields = value as Record<string, unknown>;
        type = String(fields.$type);
      } else {
        complete = false;
        return;
      }
      if (/(^|\.)DataList</.test(type)) {
        const items = fields.$items;
        if (!Array.isArray(items) || !Number.isInteger(fields.$count) ||
            (fields.$count as number) < 0 || items.length !== fields.$count) {
          complete = false;
          return;
        }
        for (const item of items) visit(item);
      } else if (type.endsWith('.AlbumLiteVersions') || type.endsWith('.TrackLiteVersions')) {
        const items = member(fields, type.endsWith('.AlbumLiteVersions') ? 'Albums' : 'Tracks');
        if (items === undefined) complete = false;
        else visit(items);
      } else if (type.endsWith('.TopSearchResult')) {
        for (const name of ['Artist', 'Album', 'Track', 'Work',
          'LibraryArtist', 'LibraryAlbum', 'LibraryTrack', 'LibraryWork']) visit(member(fields, name));
        if (includePlaylistsAndGenres) {
          for (const name of ['Playlist', 'Genre']) visit(member(fields, name));
        }
      } else {
        complete = false; // A known membership edge must resolve to a supported type.
      }
    };
    // A PUSHSTUB carries only identity; await the populated result object.
    if (!Object.keys(root.fields).some((key) => rootMembers.some((name) => key.endsWith(`::${name}`)))) {
      return undefined;
    }
    for (const name of rootMembers) visit(member(root.fields, name));
    return complete ? out : undefined;
  }

  /** Best-effort display title for a result object. */
  titleOf(o: RoonObject): string {
    return this.strField(o, '::Title') ?? this.strField(o, '::Name') ?? '?';
  }

  /** Wait until a referenced object has fields in the graph. Non-references give undefined; on timeout, whatever the graph holds. */
  async waitObject(ref: unknown, ms = 3000): Promise<RoonObject | undefined> {
    if (!isRef(ref)) return undefined;
    const end = Date.now() + ms;
    for (;;) {
      const o = this.graph.getObject(ref.$ref);
      if ((o && Object.keys(o.fields).length) || Date.now() > end) return o;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Decode the result of a method that returns IList<T>; throws when the call failed. */
  listResult(res: CallResult): unknown[] {
    if (!res.success) throw new Error(`call failed: ${res.status}`);
    return this.graph.decodeListReturnValue(Uint8Array.from(res.payload));
  }

  /** Fetch an album by its durable AlbumId via Library::GetAlbum(long, GetAlbumMode); mode defaults to Basic (1). */
  async getAlbumById(albumId: bigint, mode = 1): Promise<RoonObject | undefined> {
    const res = await this.remoting.callMethod(
      this.serviceOid('Library'),
      'Sooloos.Broker.Api.Library::GetAlbum(long, Sooloos.Broker.Api.GetAlbumMode, Base.ResultCallback<Sooloos.Broker.Api.Album>)',
      buildArgs([Arg.long(albumId), Arg.enum_(mode)]),
    );
    if (!res.success) return undefined;
    return this.waitObject(this.graph.decodeReturnValue(Uint8Array.from(res.payload)));
  }

  /**
   * Query albums with Library::VirtualAlbumQuery. Pages arrive through Page events, so reading
   * `$items` after RetainPage stays empty. Instead, SelectAll + GetSelected on the query object
   * return every match at once (links that carry the durable AlbumId); the first `resolveLimit`
   * albums are fetched with getAlbumById, and the server-side query is disposed afterwards.
   * `criteria` are AlbumQueryCriteria members (short names work); UiLanguage defaults to en.
   * `resolveLimit` defaults to 40 so an empty criteria list does not fetch the whole library;
   * pass Infinity to resolve every match.
   * Verified live on Roon 2.73 build 1696.
   */
  async queryAlbums(criteria: StructField[], opts: { resolveLimit?: number; pageSize?: number } = {}): Promise<{
    count: number; ids: (bigint | null)[]; albums: RoonObject[]; missing: number; queryFields: Record<string, unknown>;
  }> {
    const crit = this.structArg('Sooloos.Broker.Api.AlbumQueryCriteria', [
      ...(criteria.some((f) => f.name === 'UiLanguage') ? [] : [
        { name: 'UiLanguage', propType: PropertyType.String, value: new BinaryWriter().string('en').toBuffer() }]),
      ...criteria,
    ]);
    const params = this.structArg('Sooloos.Broker.Api.VirtualQueryParameters', [
      { name: 'PageSize', propType: PropertyType.Int, value: new BinaryWriter().integer(opts.pageSize ?? 500).toBuffer() },
    ]);
    const res = await this.call('Library', 'VirtualAlbumQuery', [
      { type: 'Sooid', name: 'profileid' },
      { type: 'AlbumQueryCriteria', name: 'criteria' },
      { type: 'VirtualQueryParameters', name: 'queryparams' },
      { type: 'ResultCallback<VirtualAlbumLiteQuery>', name: 'cb' },
    ], Buffer.concat([buildArgs([Arg.sooid(this.profile())]), crit, params]), this.serviceOid('Library'));
    if (!res.success) throw new Error(`VirtualAlbumQuery failed: ${res.status}`);
    const q = this.graph.decodeReturnValue(Uint8Array.from(res.payload));
    if (!isRef(q)) throw new Error('VirtualAlbumQuery returned no query object');
    const qid = q.$ref;
    const sig = (m: string) => `Sooloos.Broker.Api.VirtualAlbumLiteQuery::${m}`;
    try {
      await this.waitObject(q);
      const sel = await this.remoting.callMethod(qid, sig('SelectAll(Base.ResultCallback)'), Buffer.alloc(0));
      if (!sel.success) throw new Error(`SelectAll failed: ${sel.status}`);
      const items = this.listResult(await this.remoting.callMethod(qid,
        sig('GetSelected(Base.ResultCallback<System.Collections.Generic.IList<Sooloos.Broker.Api.AlbumBase>>)'), Buffer.alloc(0)));
      const ids = items.map((it) => {
        const id = isRef(it) ? undefined : member(it as Record<string, unknown>, '::AlbumId');
        return id === undefined || id === null ? null : BigInt(String(id));
      });
      const albums: RoonObject[] = [];
      let missing = 0;
      for (const [i, it] of items.slice(0, opts.resolveLimit ?? 40).entries()) {
        const o = isRef(it) ? await this.waitObject(it, 1000) : ids[i] !== null ? await this.getAlbumById(ids[i]!) : undefined;
        if (o && Object.keys(o.fields).length) albums.push(o); else missing++;
      }
      return { count: items.length, ids, albums, missing, queryFields: { ...(this.graph.getObject(qid)?.fields ?? {}) } };
    } finally {
      this.remoting.callMethodNoReply(qid, sig('Dispose()'), Buffer.alloc(0));
    }
  }

  /** Albums matching a text filter (AlbumQueryCriteria.TextFilter), resolving at most `limit`. Built on queryAlbums. */
  async searchAlbums(term: string, limit = 40): Promise<RoonObject[]> {
    const r = await this.queryAlbums(
      [{ name: 'TextFilter', propType: PropertyType.String, value: new BinaryWriter().string(term).toBuffer() }],
      { resolveLimit: limit },
    );
    return r.albums;
  }

  // --- typed convenience methods (proven live) ---

  /** Serialize one AlbumBase as an inline AlbumLink value struct {AlbumId, Broker}. */
  private albumLink(albumId: bigint): Buffer {
    return this.structArg('Sooloos.Broker.Api.AlbumLink', [
      {
        name: 'long Sooloos.Broker.Api.AlbumLink::AlbumId',
        propType: PropertyType.Long,
        value: new BinaryWriter().long(albumId).toBuffer(),
      },
      {
        name: 'Sooloos.Broker.Api.Broker Sooloos.Broker.Api.AlbumLink::Broker',
        propType: PropertyType.Object,
        value: new BinaryWriter().long(this.serviceOid('Broker')).toBuffer(),
      },
    ]);
  }

  /**
   * Favorite/unfavorite an album (FavoriteBanState: None=0, Favorite=1, Ban=2).
   *
   * Takes the STABLE album id (albumIdOf), not a session oid. Uses the
   * IEnumerable<AlbumBase> overload the official client uses; each element is
   * an inline AlbumLink value struct {AlbumId, Broker}, and the collection is
   * length-prefixed (Arg.collection). Both facts came from a byte-for-byte
   * capture diff against the official client — the previous single-AlbumBase
   * call with a bare object ref was silently ignored, and encoding the
   * collection as a naive count+refs list stalls the Core.
   */
  favoriteAlbum(albumId: bigint, favorite: boolean): Promise<CallResult> {
    return this.call(
      'Library',
      'FavoriteOrBan',
      [
        { type: 'Sooid', name: 'profileid' },
        { type: 'IEnumerable<AlbumBase>', name: 'albums' },
        { type: 'FavoriteBanState', name: 'state' },
        { type: 'ResultCallback', name: 'cb' },
      ],
      buildArgs([
        Arg.sooid(this.profile()),
        Arg.collection([this.albumLink(albumId)]),
        Arg.enum_(favorite ? 1 : 0),
      ]),
      this.serviceOid('Library')
    );
  }

  /** Play an album on a zone (default PlayParameters). */
  async playAlbum(zoneOid: bigint, albumOid: bigint): Promise<CallResult> {
    const args = Buffer.concat([
      buildArgs([Arg.ref(zoneOid), Arg.sooid(this.profile())]),
      this.structArg('Sooloos.Broker.Api.PlayParameters', []),
      buildArgs([Arg.ref(albumOid), Arg.bool(false), Arg.bool(false)]),
    ]);
    return this.call(
      'Transport',
      'PlayAlbum',
      [
        { type: 'Zone', name: 'zone' },
        { type: 'Sooid', name: 'profileid' },
        { type: 'PlayParameters', name: 'parameters' },
        { type: 'AlbumBase', name: 'album' },
        { type: 'bool', name: 'favoritesonly' },
        { type: 'bool', name: 'includehidden' },
        { type: 'ResultCallback<PlayFeedback>', name: 'cb' },
      ],
      args,
      this.serviceOid('Transport')
    );
  }

  /** Play a single track on a zone (default PlayParameters). */
  async playTrack(zoneOid: bigint, trackOid: bigint): Promise<CallResult> {
    const args = Buffer.concat([
      buildArgs([Arg.ref(zoneOid), Arg.sooid(this.profile())]),
      this.structArg('Sooloos.Broker.Api.PlayParameters', []),
      buildArgs([Arg.ref(trackOid)]),
    ]);
    return this.call(
      'Transport',
      'PlayTrack',
      [
        { type: 'Zone', name: 'zone' },
        { type: 'Sooid', name: 'profileid' },
        { type: 'PlayParameters', name: 'parameters' },
        { type: 'TrackBase', name: 'track' },
        { type: 'ResultCallback<PlayFeedback>', name: 'cb' },
      ],
      args,
      this.serviceOid('Transport')
    );
  }

  /** Convenience: find an album by title and play it on a named zone. */
  async playAlbumOnZone(zoneName: string, albumTitle: string): Promise<CallResult> {
    const zone = this.zoneByName(zoneName);
    const album = this.findByTitle('AlbumLite', albumTitle) ?? this.findByTitle('Album', albumTitle);
    if (!zone) throw new Error(`zone "${zoneName}" not found`);
    if (!album) throw new Error(`album "${albumTitle}" not loaded`);
    return this.playAlbum(zone, album.oid);
  }

  /** Fire-and-forget zone transport control (Pause/Play/Stop/Next/Previous/...). */
  zoneControl(zoneOid: bigint, method: 'Pause' | 'Play' | 'PlayPause' | 'Stop' | 'Next' | 'Previous'): void {
    this.remoting.callMethodNoReply(zoneOid, formatMethodSignature('Zone', method, []), Buffer.alloc(0));
  }

  /** Power a device off (standby) — fire-and-forget on the endpoint. */
  standby(endpointOid: bigint): void {
    this.remoting.callMethodNoReply(endpointOid, formatMethodSignature('Endpoint', 'Standby', []), Buffer.alloc(0));
  }

  /** Power a device on (convenience switch) — expects a response. */
  powerOn(endpointOid: bigint): Promise<CallResult> {
    return this.remoting.callMethod(
      endpointOid,
      formatMethodSignature('Endpoint', 'ConvenienceSwitch', [{ type: 'ResultCallback', name: 'cb' }]),
      Buffer.alloc(0)
    );
  }

  // --- metadata editing: read side (Phase E) ---

  /**
   * Read an album's editable metadata via Library::GetAlbumEditInfo. The result
   * is returned by-value (an inline AlbumEditInfo struct of Edit*Info<T> wrappers,
   * NOT pushed into the graph), so we decode it from the response payload. Each
   * field exposes its effective `Value`/`Values` plus whether the user has a local
   * edit layer. Proven live (read-only, safe). See docs Phase E.
   */
  async getAlbumEditInfo(albumOid: bigint): Promise<AlbumEditInfo> {
    const res = await this.call(
      'Library',
      'GetAlbumEditInfo',
      [
        { type: 'AlbumBase', name: 'album' },
        { type: 'ResultCallback<AlbumEditInfo>', name: 'cb' },
      ],
      buildArgs([Arg.ref(albumOid)]),
      this.serviceOid('Library')
    );
    if (!res.success) throw new Error(`GetAlbumEditInfo failed: ${res.status}`);
    const decoded = this.graph.decodeReturnValue(Uint8Array.from(res.payload));
    return parseAlbumEditInfo(decoded as Record<string, unknown>);
  }

  // --- metadata editing: write side (Phase E) ---

  /**
   * Edit an album's metadata via Library::Edit. **Proven live & reversible** for
   * title, rating, genres and labels (set then call again with the prior values to
   * restore). `albumId` is the AlbumLite::AlbumId long (see albumIdOf), NOT the oid.
   *
   * Encoding (validated against the live core): a LibraryEdit by-value struct whose
   * Albums is an IList<AlbumEdit> (LengthPrefixed: int(len)+flexInt(count)+items);
   * each AlbumEdit member uses a nested Edit*<T> wrapper (EditRequiredRef<string>
   * for Title, EditOptionalVal<int> for Rating, EditList<string> for Genres/Labels).
   *
   * NOTE: boolean flags (IsPick/IsUserHidden/IsCompilation/…) are intentionally not
   * supported — the core does not respond to EditOptionalVal<bool> edits (the apply
   * hangs server-side; the encoding is correct). Genres/labels must be values Roon
   * recognises; unknown strings return Success but are silently dropped.
   */
  editAlbum(albumId: bigint, edits: AlbumEdits): Promise<CallResult> {
    const fields: StructField[] = [];
    if (edits.title !== undefined && edits.clearTitle) throw new Error('editAlbum: title and clearTitle are exclusive');
    if (edits.title !== undefined || edits.clearTitle) {
      const w = this.structArg(EDIT_REQUIRED_REF_STR, [edits.clearTitle
        ? { name: `bool ${EDIT_REQUIRED_REF_STR}::ClearEdits`, propType: PropertyType.Bool, value: new BinaryWriter().boolean(true).toBuffer() }
        : { name: `string ${EDIT_REQUIRED_REF_STR}::EditValue`, propType: PropertyType.String, value: new BinaryWriter().string(edits.title!).toBuffer() },
      ]);
      fields.push({ name: `${EDIT_REQUIRED_REF_STR} ${ALBUM_EDIT}::Title`, propType: PropertyType.Object, value: w });
    }
    if (edits.rating !== undefined) {
      const w = this.structArg(EDIT_OPTIONAL_VAL_INT, [
        { name: `int? ${EDIT_OPTIONAL_VAL_INT}::EditValue`, propType: PropertyType.NullableInt, value: new BinaryWriter().boolean(true).integer(edits.rating).toBuffer() },
      ]);
      fields.push({ name: `${EDIT_OPTIONAL_VAL_INT} ${ALBUM_EDIT}::Rating`, propType: PropertyType.Object, value: w });
    }
    if (edits.addGenres || edits.removeGenres) {
      fields.push({ name: `${EDIT_LIST_STR} ${ALBUM_EDIT}::Genres`, propType: PropertyType.Object, value: this.editListStr(edits.addGenres ?? [], edits.removeGenres ?? []) });
    }
    if (edits.addLabels || edits.removeLabels) {
      fields.push({ name: `${EDIT_LIST_STR} ${ALBUM_EDIT}::Labels`, propType: PropertyType.Object, value: this.editListStr(edits.addLabels ?? [], edits.removeLabels ?? []) });
    }
    if (!fields.length) throw new Error('editAlbum: no edits supplied');
    return this.editAlbumStruct(albumId, fields);
  }

  /** Convenience: set just an album's rating (see editAlbum). */
  editAlbumRating(albumId: bigint, rating: number): Promise<CallResult> {
    return this.editAlbum(albumId, { rating });
  }

  /** AlbumLite::AlbumId (the long id Library::Edit keys on). */
  albumIdOf(album: RoonObject): bigint | undefined {
    for (const [k, v] of Object.entries(album.fields)) {
      if (k.endsWith('::AlbumId')) return typeof v === 'bigint' ? v : BigInt(String(v));
    }
    return undefined;
  }

  /** Build an EditList<string> wrapper value (AddValues/RemoveValues). */
  private editListStr(add: string[], remove: string[]): Buffer {
    const list = (xs: string[]) => {
      const w = new BinaryWriter().flexInt(xs.length);
      for (const x of xs) w.string(x);
      const b = w.toBuffer();
      return new BinaryWriter().integer(b.length).bytes(b).toBuffer();
    };
    return this.structArg(EDIT_LIST_STR, [
      { name: `System.Collections.Generic.IList<string> ${EDIT_LIST_STR}::AddValues`, propType: PropertyType.LengthPrefixed, value: list(add) },
      { name: `System.Collections.Generic.IList<string> ${EDIT_LIST_STR}::RemoveValues`, propType: PropertyType.LengthPrefixed, value: list(remove) },
    ]);
  }

  /** Build + send a single-album Library::Edit from pre-serialized AlbumEdit member fields. */
  private editAlbumStruct(albumId: bigint, fields: StructField[]): Promise<CallResult> {
    return this.sendLibraryEdit([this.albumEditStruct(albumId, fields)], []);
  }

  /** One AlbumEdit: the AlbumId (AlbumLite::AlbumId) plus the Edit* members to change. */
  private albumEditStruct(albumId: bigint, fields: StructField[]): Buffer {
    return this.structArg(ALBUM_EDIT, [
      { name: `long ${ALBUM_EDIT}::AlbumId`, propType: PropertyType.Long, value: new BinaryWriter().long(albumId).toBuffer() },
      ...fields,
    ]);
  }

  /** One TrackEdit: the TrackId plus the Edit* members to change. */
  private trackEditStruct(trackId: bigint, fields: StructField[]): Buffer {
    return this.structArg(TRACK_EDIT, [
      { name: `long ${TRACK_EDIT}::TrackId`, propType: PropertyType.Long, value: new BinaryWriter().long(trackId).toBuffer() },
      ...fields,
    ]);
  }

  /**
   * Send one Library::Edit. LibraryEdit::Albums and ::Tracks are IList members whose wire form is
   * LengthPrefixed: integer(len) + flexInt(count) + inline structs (confirmed against official-client captures).
   */
  private sendLibraryEdit(albums: Buffer[], tracks: Buffer[]): Promise<CallResult> {
    const list = (items: Buffer[]) => {
      const blob = new BinaryWriter().flexInt(items.length).bytes(Buffer.concat(items)).toBuffer();
      return new BinaryWriter().integer(blob.length).bytes(blob).toBuffer();
    };
    const fields: StructField[] = [];
    if (albums.length) fields.push({ name: `System.Collections.Generic.IList<${ALBUM_EDIT}> ${LIBRARY_EDIT}::Albums`, propType: PropertyType.LengthPrefixed, value: list(albums) });
    if (tracks.length) fields.push({ name: `System.Collections.Generic.IList<${TRACK_EDIT}> ${LIBRARY_EDIT}::Tracks`, propType: PropertyType.LengthPrefixed, value: list(tracks) });
    if (!fields.length) throw new Error('sendLibraryEdit: nothing to edit');
    return this.call(
      'Library', 'Edit',
      [{ type: 'LibraryEdit', name: 'edit' }, { type: 'ResultCallback', name: 'cb' }],
      this.structArg(LIBRARY_EDIT, fields), this.serviceOid('Library'),
    );
  }

  /**
   * Per-track file tags for Metadata::GetMatchingEditions, in track order: the file's own tags
   * (TrackExportInfo.FileTags) plus the keys the official client derives: TRACKNUMBERFROMFILENAME,
   * LENGTH, LENGTHMS, MEDIANUMBER and ORIGINALPATH. Throws when a track does not resolve instead
   * of passing placeholder values on to identifyAlbum.
   */
  async matchFilesForAlbum(albumOid: bigint): Promise<{ trackId: bigint; trackNumber: number; mediaNumber: number; tags: [string, string][] }[]> {
    const infos = this.listResult(await this.remoting.callMethod(this.serviceOid('Library'),
      'Sooloos.Broker.Api.Library::GetTrackExportInfoForAlbums(System.Collections.Generic.IEnumerable<Sooloos.Broker.Api.AlbumBase>, Base.ResultCallback<System.Collections.Generic.IList<Sooloos.Broker.Api.TrackExportInfo>>)',
      buildArgs([Arg.collection([buildArgs([Arg.ref(albumOid)])])]))) as Record<string, unknown>[];
    const out = [];
    for (const [i, info] of infos.entries()) {
      const tl = await this.waitObject(member(info, '::Track'), 2000);
      const trackId = tl && member(tl.fields, '::TrackId');
      if (!tl || trackId === undefined || trackId === null) {
        throw new Error(`matchFilesForAlbum: track ${i + 1} of ${infos.length} did not resolve`);
      }
      const raw = member(info, '::FileTags');
      const tags = raw instanceof Uint8Array ? decodeStringTupleList(raw) : [];
      const path = String(member(info, '::FilePath') ?? '');
      const seconds = Number(member(tl.fields, '::LengthSeconds') || 0);
      const trackNumber = Number(member(tl.fields, '::TrackNumber') || 0);
      const mediaNumber = Number(member(tl.fields, '::MediaNumber') || 1);
      const fromName = /^(\d+)/.exec(path.split('/').pop() ?? '')?.[1];
      const extra: [string, string][] = [
        ...(fromName ? [['TRACKNUMBERFROMFILENAME', String(Number(fromName))] as [string, string]] : []),
        ['LENGTH', String(seconds)], ['LENGTHMS', String(seconds * 1000)], ['MEDIANUMBER', String(mediaNumber)], ['ORIGINALPATH', path],
      ];
      // FileTags can repeat a key (e.g. two COMPOSER tags). An IDictionary cannot, and the Core answers
      // UnexpectedError, so repeated values are joined with "; ".
      const merged = new Map<string, string>();
      for (const [k, v] of tags) merged.set(k, merged.has(k) ? `${merged.get(k)}; ${v}` : v);
      for (const [k, v] of extra) if (!merged.has(k)) merged.set(k, v);
      out.push({ trackId: BigInt(String(trackId)), trackNumber, mediaNumber, tags: [...merged.entries()] });
    }
    return out;
  }

  /**
   * Metadata::GetMatchingEditions: ask which editions of a release fit these files (`metadataAlbumId` is
   * a candidate's AlbumLite.AlbumId from Metadata::UserSearch). Returns each edition's id, confidence,
   * title and tracks. MatchingEdition.Tracks lists every track of the edition in release order; it is
   * not a per-file mapping (three files came back with 46- and 60-track editions). Pair files with
   * release tracks yourself, e.g. with pairFilesWithEdition.
   */
  async getMatchingEditions(metadataAlbumId: bigint, files: [string, string][][]): Promise<{
    editionId: bigint | null; confidence: number | undefined; releaseTitle: string | undefined;
    releaseTracks: ReleaseTrack[]; raw: Record<string, unknown>;
  }[]> {
    const res = await this.remoting.callMethod(this.serviceOid('Metadata'),
      'Sooloos.Broker.Api.Metadata::GetMatchingEditions(long, System.Collections.Generic.IEnumerable<System.Collections.Generic.IDictionary<string, string>>, Base.ResultCallback<System.Collections.Generic.IList<Sooloos.Broker.Api.MatchingEdition>>)',
      Buffer.concat([buildArgs([Arg.long(metadataAlbumId)]), encodeStringDictList(files)]));
    const out = [];
    for (const e of this.listResult(res) as Record<string, unknown>[]) {
      const releaseTracks: ReleaseTrack[] = [];
      for (const r of decodeRefList(member(e, '::Tracks'))) {
        const t = await this.waitObject(r, 2000);
        const id = t && member(t.fields, '::TrackId');
        if (!t || id === undefined || id === null) throw new Error(`getMatchingEditions: release track ${r.$ref} did not resolve`);
        const title = member(t.fields, '::Title');
        const seconds = member(t.fields, '::LengthSeconds');
        releaseTracks.push({
          trackId: BigInt(String(id)), title: typeof title === 'string' ? title : null,
          disc: Number(member(t.fields, '::MediaNumber') ?? 1) || 1, no: Number(member(t.fields, '::TrackNumber') ?? 0),
          seconds: seconds === undefined || seconds === null ? null : Number(seconds),
        });
      }
      const editionId = member(e, '::AlbumEditionId');
      const confidence = member(e, '::Confidence');
      const releaseTitle = member(e, '::ReleaseTitle');
      out.push({
        editionId: editionId === undefined || editionId === null ? null : BigInt(String(editionId)),
        confidence: typeof confidence === 'number' ? confidence : undefined,
        releaseTitle: typeof releaseTitle === 'string' ? releaseTitle : undefined,
        releaseTracks, raw: e,
      });
    }
    return out;
  }

  /** An Edit* wrapper member: `type` is the closed wrapper type (e.g. EditOptionalVal<long>), `members` the fields to set. */
  private editWrapper(owner: string, member: string, type: string, members: StructField[]): StructField {
    return { name: `${type} ${owner}::${member}`, propType: PropertyType.Object, value: this.structArg(type, members) };
  }

  /** AlbumLite reference via Library::GetAlbumLite(long). DuplicateOf takes an AlbumLite, not the Album that GetAlbum returns. */
  async getAlbumLiteRef(albumId: bigint): Promise<bigint> {
    const res = await this.remoting.callMethod(
      this.serviceOid('Library'),
      'Sooloos.Broker.Api.Library::GetAlbumLite(long, Base.ResultCallback<Sooloos.Broker.Api.AlbumLite>)',
      buildArgs([Arg.long(albumId)]),
    );
    const v = res.success ? this.graph.decodeReturnValue(Uint8Array.from(res.payload)) : undefined;
    if (!isRef(v)) throw new Error(`GetAlbumLite(${albumId}) failed: ${res.status}`);
    return v.$ref;
  }

  /**
   * Make one copy of a release the primary version (the Library::Edit shape seen in official-client
   * captures). The primary's DuplicateOf is cleared (ClearBaseValue + ClearEdits) and every other
   * album's DuplicateOf points at the primary's AlbumLite.
   */
  async setPrimaryVersion(primaryAlbumId: bigint, otherAlbumIds: bigint[]): Promise<CallResult> {
    const primaryLite = await this.getAlbumLiteRef(primaryAlbumId);
    const T = EDIT_OPTIONAL_REF_ALBUMLITE;
    const clear = this.editWrapper(ALBUM_EDIT, 'DuplicateOf', T, [
      { name: `bool? ${T}::ClearBaseValue`, propType: PropertyType.NullableBool, value: new BinaryWriter().optionalBoolean(true).toBuffer() },
      { name: `bool ${T}::ClearEdits`, propType: PropertyType.Bool, value: new BinaryWriter().boolean(true).toBuffer() },
    ]);
    const pointTo = this.editWrapper(ALBUM_EDIT, 'DuplicateOf', T, [
      { name: `Sooloos.Broker.Api.AlbumLite ${T}::EditValue`, propType: PropertyType.Object, value: new BinaryWriter().long(primaryLite).toBuffer() },
    ]);
    return this.sendLibraryEdit([
      this.albumEditStruct(primaryAlbumId, [clear]),
      ...otherAlbumIds.map((id) => this.albumEditStruct(id, [pointTo])),
    ], []);
  }

  private tempAlbumCounter = 0;

  /**
   * Merge tracks into one album (the Library::Edit shape seen in an official-client capture): every
   * TrackEdit.AlbumId gets the same value and TrackNumber/MediaNumber are set to the given values.
   * Without `targetAlbumId` a temporary id (counter * 256 + 30, e.g. 1822 in the capture) asks the
   * Core to create a new album, as the official client does; an existing AlbumId moves the tracks there.
   */
  mergeTracks(tracks: { trackId: bigint; trackNumber: number; mediaNumber: number }[], targetAlbumId?: bigint): Promise<CallResult> {
    const target = targetAlbumId ?? ((BigInt(++this.tempAlbumCounter) << 8n) | 30n);
    const L = EDIT_REQUIRED_VAL_LONG;
    const I = EDIT_REQUIRED_VAL_INT;
    const intVal = (v: number) => new BinaryWriter().boolean(true).integer(v).toBuffer();
    return this.sendLibraryEdit([], tracks.map((t) => this.trackEditStruct(t.trackId, [
      this.editWrapper(TRACK_EDIT, 'AlbumId', L, [{ name: `long? ${L}::EditValue`, propType: PropertyType.NullableLong, value: new BinaryWriter().boolean(true).long(target).toBuffer() }]),
      this.editWrapper(TRACK_EDIT, 'TrackNumber', I, [{ name: `int? ${I}::EditValue`, propType: PropertyType.NullableInt, value: intVal(t.trackNumber) }]),
      this.editWrapper(TRACK_EDIT, 'MediaNumber', I, [{ name: `int? ${I}::EditValue`, propType: PropertyType.NullableInt, value: intVal(t.mediaNumber) }]),
    ])));
  }

  /**
   * Apply an identification (the Library::Edit shape seen in official-client captures):
   * AlbumEdit.MetadataAlbumId is set to the chosen edition and each TrackEdit.MetadataTrackId to the
   * release track it was paired with (see getMatchingEditions and pairFilesWithEdition).
   */
  identifyAlbum(albumId: bigint, metadataAlbumId: bigint, tracks: { trackId: bigint; metadataTrackId: bigint }[]): Promise<CallResult> {
    const V = EDIT_OPTIONAL_VAL_LONG;
    const longVal = (v: bigint) => new BinaryWriter().boolean(true).long(v).toBuffer();
    const album = this.albumEditStruct(albumId, [this.editWrapper(ALBUM_EDIT, 'MetadataAlbumId', V, [
      { name: `bool? ${V}::ClearBaseValue`, propType: PropertyType.NullableBool, value: new BinaryWriter().optionalBoolean(false).toBuffer() },
      { name: `long? ${V}::EditValue`, propType: PropertyType.NullableLong, value: longVal(metadataAlbumId) },
    ])]);
    return this.sendLibraryEdit([album], tracks.map((t) => this.trackEditStruct(t.trackId, [
      this.editWrapper(TRACK_EDIT, 'MetadataTrackId', V, [{ name: `long? ${V}::EditValue`, propType: PropertyType.NullableLong, value: longVal(t.metadataTrackId) }]),
    ])));
  }

  /**
   * Clear user edits on tracks (TrackEdit.ClearMetadataEdits) so they fall back to file tags and Roon
   * metadata. Not reversible except from a backup. Album membership set by a merge is not reverted.
   */
  clearTrackEdits(trackIds: bigint[]): Promise<CallResult> {
    return this.sendLibraryEdit([], trackIds.map((id) => this.trackEditStruct(id, [
      { name: `bool ${TRACK_EDIT}::ClearMetadataEdits`, propType: PropertyType.Bool, value: new BinaryWriter().boolean(true).toBuffer() },
    ])));
  }
}

/** One track of a release edition, as returned by RoonClient.getMatchingEditions. */
export interface ReleaseTrack { trackId: bigint; title: string | null; disc: number; no: number; seconds: number | null }

const normTitle = (s: string | null | undefined) => (s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');

/**
 * Pair an album's files (from matchFilesForAlbum) with an edition's release tracks: same disc and track
 * number, confirmed by an equal title (after normalization) or a length within 2 seconds. Each release
 * track pairs at most once. `complete` is true only when every file found its track.
 */
export function pairFilesWithEdition(
  files: { trackId: bigint; trackNumber: number; mediaNumber: number; tags: [string, string][] }[],
  releaseTracks: ReleaseTrack[],
): { pairs: { trackId: bigint; metadataTrackId: bigint | null; reason: string | null }[]; complete: boolean } {
  const used = new Set<bigint>();
  const pairs = files.map((f) => {
    const tags = Object.fromEntries(f.tags);
    const seconds = tags.LENGTH === undefined ? null : Number(tags.LENGTH);
    const r = releaseTracks.find((x) => x.disc === (f.mediaNumber || 1) && x.no === f.trackNumber);
    if (!r) return { trackId: f.trackId, metadataTrackId: null, reason: 'no release track at this position' };
    const titleOk = normTitle(tags.TITLE) !== '' && normTitle(tags.TITLE) === normTitle(r.title);
    const lengthOk = seconds !== null && r.seconds !== null && Math.abs(seconds - r.seconds) <= 2;
    if (used.has(r.trackId)) return { trackId: f.trackId, metadataTrackId: null, reason: 'release track already paired' };
    if (!titleOk && !lengthOk) return { trackId: f.trackId, metadataTrackId: null, reason: 'title and length differ' };
    used.add(r.trackId);
    return { trackId: f.trackId, metadataTrackId: r.trackId, reason: null };
  });
  return { pairs, complete: pairs.length > 0 && pairs.every((p) => p.metadataTrackId !== null) };
}

/** Reversible album metadata edits (see RoonClient.editAlbum). */
export interface AlbumEdits {
  title?: string;
  /** Send Title.ClearEdits to drop the user's title edit and restore the original. Exclusive with `title`. */
  clearTitle?: boolean;
  rating?: number;
  addGenres?: string[];
  removeGenres?: string[];
  addLabels?: string[];
  removeLabels?: string[];
}

// Library::Edit by-value struct type names (members are addressed by full name,
// which the server matches against its PropertyDescriptor.Name).
const ALBUM_EDIT = 'Sooloos.Broker.Api.AlbumEdit';
const EDIT_OPTIONAL_VAL_INT = 'Sooloos.Broker.Api.EditOptionalVal<int>';
const EDIT_REQUIRED_REF_STR = 'Sooloos.Broker.Api.EditRequiredRef<string>';
const EDIT_LIST_STR = 'Sooloos.Broker.Api.EditList<string>';
const LIBRARY_EDIT = 'Sooloos.Broker.Api.LibraryEdit';
const TRACK_EDIT = 'Sooloos.Broker.Api.TrackEdit';
const EDIT_OPTIONAL_VAL_LONG = 'Sooloos.Broker.Api.EditOptionalVal<long>';
const EDIT_REQUIRED_VAL_LONG = 'Sooloos.Broker.Api.EditRequiredVal<long>';
const EDIT_REQUIRED_VAL_INT = 'Sooloos.Broker.Api.EditRequiredVal<int>';
const EDIT_OPTIONAL_REF_ALBUMLITE = 'Sooloos.Broker.Api.EditOptionalRef<Sooloos.Broker.Api.AlbumLite>';

// --- AlbumEditInfo decoding (by-value return) ---

/** One editable field: the effective value + whether the user edited it. */
export interface EditField<T> {
  value: T | undefined;
  /** the metadata (publisher) value, before any local/user edit. */
  metadataValue?: T;
  /** the user's edit (EditValue); undefined when the field was never edited. */
  editValue?: T;
  /** true when the user has a local edit overriding metadata: EditValue is set (lists: AddValues/RemoveValues non-empty). */
  edited: boolean;
  /** the album has an edit layer (HasEditLayer); this alone does not mean the field was edited. */
  hasEditLayer: boolean;
}

export interface AlbumEditInfo {
  title: EditField<string>;
  version: EditField<string>;
  performedBy: EditField<string>;
  genres: EditField<string[]>;
  labels: EditField<string[]>;
  rating: EditField<number>;
  type: EditField<number>;
  isCompilation: EditField<boolean>;
  isLive: EditField<boolean>;
  isPick: EditField<boolean>;
  containsExplicitContent: EditField<boolean>;
  isUserHidden: EditField<boolean>;
  country: EditField<string>;
  catalogNumber: EditField<string>;
  productCode: EditField<string>;
  /** the full decoded struct, for fields not surfaced above. */
  raw: Record<string, unknown>;
}

/** Read a member of a decoded struct by its `::suffix` (keys are fully-qualified). */
function member(obj: Record<string, unknown> | undefined, suffix: string): unknown {
  if (!obj) return undefined;
  for (const [k, v] of Object.entries(obj)) if (k.endsWith(suffix)) return v;
  return undefined;
}

/** A LengthPrefixed IList<string> decodes to a Buffer of flexInt(count)+string*. */
function decodeStringList(v: unknown): string[] | undefined {
  if (!Buffer.isBuffer(v)) return Array.isArray(v) ? (v as string[]) : undefined;
  const r = new BinaryReader(Uint8Array.from(v));
  const out: string[] = [];
  const count = r.flexInt();
  for (let i = 0; i < count && r.remaining > 0; i++) out.push(r.string() ?? '');
  return out;
}

/** Extract one Edit*Info<T> wrapper field from the AlbumEditInfo struct. */
function editField<T>(info: Record<string, unknown>, fieldSuffix: string, list = false): EditField<T> {
  const wrapper = member(info, `::${fieldSuffix}`) as Record<string, unknown> | undefined;
  const rawValue = member(wrapper, list ? '::Values' : '::Value');
  const rawMeta = member(wrapper, list ? '::MetadataValues' : '::MetadataValue');
  const value = (list ? decodeStringList(rawValue) : rawValue) as T | undefined;
  const metadataValue = (list ? decodeStringList(rawMeta) : rawMeta) as T | undefined;
  const hasEditLayer = member(wrapper, '::HasEditLayer') === true;
  if (list) {
    // EditListInfo has no EditValue; user changes live in AddValues/RemoveValues.
    const changed = [member(wrapper, '::AddValues'), member(wrapper, '::RemoveValues')]
      .some((v) => (decodeStringList(v)?.length ?? 0) > 0);
    return { value, metadataValue, edited: changed, hasEditLayer };
  }
  const rawEdit = member(wrapper, '::EditValue');
  const editValue = (rawEdit === null ? undefined : rawEdit) as T | undefined;
  return { value, metadataValue, editValue, edited: editValue !== undefined, hasEditLayer };
}

export function parseAlbumEditInfo(decoded: Record<string, unknown>): AlbumEditInfo {
  return {
    title: editField<string>(decoded, 'Title'),
    version: editField<string>(decoded, 'Version'),
    performedBy: editField<string>(decoded, 'PerformedBy'),
    genres: editField<string[]>(decoded, 'Genres', true),
    labels: editField<string[]>(decoded, 'Labels', true),
    rating: editField<number>(decoded, 'Rating'),
    type: editField<number>(decoded, 'Type'),
    isCompilation: editField<boolean>(decoded, 'IsCompilation'),
    isLive: editField<boolean>(decoded, 'IsLive'),
    isPick: editField<boolean>(decoded, 'IsPick'),
    containsExplicitContent: editField<boolean>(decoded, 'ContainsExplicitContent'),
    isUserHidden: editField<boolean>(decoded, 'IsUserHidden'),
    country: editField<string>(decoded, 'Country'),
    catalogNumber: editField<string>(decoded, 'CatalogNumber'),
    productCode: editField<string>(decoded, 'ProductCode'),
    raw: decoded,
  };
}
