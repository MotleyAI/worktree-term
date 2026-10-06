/** A request awaiting its reply. */
export interface Pending<T> {
  req: number;
  reply: Promise<T>;
}

interface Entry<T> {
  host: number | null;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/** Requests in flight, numbered from 1, each tied to a host (null for the hub). */
export class PendingRequests<T> {
  private readonly entries = new Map<number, Entry<T>>();
  private next = 1;

  add(host: number | null): Pending<T> {
    const req = this.next++;
    const reply = new Promise<T>((resolve, reject) => {
      this.entries.set(req, { host, resolve, reject });
    });
    return { req, reply };
  }

  /** Delivers `value` to request `req`; false when no such request is pending. */
  resolve(req: number, value: T): boolean {
    const entry = this.entries.get(req);
    if (entry === undefined) return false;
    this.entries.delete(req);
    entry.resolve(value);
    return true;
  }

  /** Fails the requests to `host`. */
  failHost(host: number, message: string): void {
    for (const [req, entry] of this.entries) {
      if (entry.host !== host) continue;
      this.entries.delete(req);
      entry.reject(new Error(message));
    }
  }

  failAll(message: string): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.reject(new Error(message));
  }
}
