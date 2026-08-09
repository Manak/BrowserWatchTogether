/**
 * The only storage the signalling relay needs.
 *
 * Deliberately four methods and no transactions, because the message layout
 * above it is designed never to need one: every key is owned by exactly one
 * writer (see `messageKey`), so two peers announcing at the same instant write
 * to different keys instead of racing over the same one. A read-modify-write on
 * a shared list would drop one of them, and a dropped announcement is a peer
 * that never gets found — the exact failure we have just been chasing.
 */
export interface SignalStore {
  put(key: string, value: string): Promise<void>
  /** Keys beginning with `prefix`, in any order. */
  list(prefix: string): Promise<string[]>
  get(key: string): Promise<string | null>
  delete(key: string): Promise<void>
}

/**
 * For local development and tests. Useless on a real deployment, where each
 * function invocation is a different process with a different heap — hence the
 * Blobs-backed one in the Netlify function.
 */
export class MemoryStore implements SignalStore {
  private readonly entries = new Map<string, string>()

  put(key: string, value: string): Promise<void> {
    this.entries.set(key, value)
    return Promise.resolve()
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.entries.keys()].filter((k) => k.startsWith(prefix)))
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.entries.get(key) ?? null)
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key)
    return Promise.resolve()
  }

  /** Test seam. */
  get size(): number {
    return this.entries.size
  }
}
