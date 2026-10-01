export interface FavoriteView {
  favorite: boolean | undefined;
  pending: boolean;
  target?: boolean;
}

interface FavoriteEntry {
  favorite: boolean | undefined;
  target?: boolean;
}

/** Keeps optimistic interaction state separate from confirmed Core state. */
export class FavoriteState {
  private readonly entries = new Map<string, FavoriteEntry>();

  seed(oid: string, favorite: boolean | undefined): void {
    const current = this.entries.get(oid);
    if (!current || current.target === undefined) this.entries.set(oid, { favorite });
  }

  begin(oid: string): boolean | null {
    const entry = this.entries.get(oid);
    if (!entry || entry.favorite === undefined || entry.target !== undefined) return null;
    entry.target = !entry.favorite;
    return entry.target;
  }

  settle(oid: string, success: boolean): void {
    const entry = this.entries.get(oid);
    if (!entry || entry.target === undefined) return;
    if (success) entry.favorite = entry.target;
    delete entry.target;
  }

  view(oid: string): FavoriteView {
    const entry = this.entries.get(oid);
    if (!entry) return { favorite: undefined, pending: false };
    return entry.target === undefined
      ? { favorite: entry.favorite, pending: false }
      : { favorite: entry.favorite, pending: true, target: entry.target };
  }
}
