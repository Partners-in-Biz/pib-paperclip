/**
 * Reply feed: the person's own live-events socket, filtered to "an agent comment landed on the
 * chat I am watching" (plan PAR-14808, T3). It only signals; the caller reads the comment itself.
 */

export const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;

interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export interface ReplyFeedOptions {
  companyId: string;
  /** Test seam; defaults to the browser WebSocket. */
  createSocket?: (url: string) => SocketLike;
  /** Test seam; defaults to `window.location`. */
  location?: { protocol: string; host: string };
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class ReplyFeed {
  private socket: SocketLike | null = null;
  private watched: string | null = null;
  private listeners: Array<(issueId: string) => void> = [];
  private retry = 0;
  private timer: unknown = null;
  private stopped = false;
  /** True while the socket is open. */
  connected = false;
  onConnectedChange: ((connected: boolean) => void) | null = null;

  constructor(private readonly opts: ReplyFeedOptions) {}

  /** Watch one chat issue (replaces the previous one) and make sure the socket is up. */
  watch(issueId: string | null): void {
    this.watched = issueId;
    this.stopped = false;
    if (issueId && !this.socket && this.timer === null) this.open();
  }

  /** Called once per agent comment on the watched issue. Returns an unsubscribe. */
  onComment(cb: (issueId: string) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter(listener => listener !== cb);
    };
  }

  close(): void {
    this.stopped = true;
    this.watched = null;
    if (this.timer !== null) (this.opts.clearTimer ?? clearTimeout as (h: unknown) => void)(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    this.setConnected(false);
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  }

  private url(): string {
    const location = this.opts.location ?? window.location;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${location.host}/api/companies/${encodeURIComponent(this.opts.companyId)}/events/ws`;
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    this.onConnectedChange?.(value);
  }

  private open(): void {
    const socket = (this.opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike))(this.url());
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      this.setConnected(true);
    };
    socket.onmessage = event => this.handle(event.data);
    socket.onerror = () => {};
    socket.onclose = () => {
      this.socket = null;
      this.setConnected(false);
      if (this.stopped || !this.watched) return;
      const delay = RECONNECT_BACKOFF_MS[Math.min(this.retry, RECONNECT_BACKOFF_MS.length - 1)]!;
      this.retry += 1;
      this.timer = (this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
        this.timer = null;
        if (!this.stopped && this.watched) this.open();
      }, delay);
    };
  }

  private handle(data: unknown): void {
    if (typeof data !== "string" || !this.watched) return;
    let message: { type?: unknown; payload?: { action?: unknown; entityType?: unknown; entityId?: unknown } };
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    const payload = message.payload;
    if (message.type !== "activity.logged" || !payload) return;
    if (payload.action !== "issue.comment_added" || payload.entityType !== "issue" || payload.entityId !== this.watched) return;
    for (const listener of [...this.listeners]) listener(this.watched);
  }
}
