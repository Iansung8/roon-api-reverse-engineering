export interface SearchRequest {
  id: number;
  q: string;
}

export type SearchInput = { clear: true } | { clear: false; request: SearchRequest };

/** Correlates debounced browser input with asynchronous Core responses. */
export class SearchState {
  private nextId = 1;
  private current: SearchRequest | null = null;

  input(raw: string): SearchInput {
    const q = raw.trim();
    if (q.length < 2) {
      this.current = null;
      return { clear: true };
    }
    const request = { id: this.nextId++, q };
    this.current = request;
    return { clear: false, request };
  }

  accept(id: number, q: string): boolean {
    return this.current?.id === id && this.current.q === q;
  }
}
