const KiB = 1024;
const MiB = 1024 * KiB;

/** Version of the daemon link (client ↔ daemon), whose two ends can run different releases. */
export const DAEMON_PROTOCOL_VERSION = 6;
/** Version of the browser link (browser ↔ hub); the hub serves the page, so a bump needs no daemon restart. */
export const BROWSER_PROTOCOL_VERSION = 8;

/** Largest stream frame payload. */
export const MAX_FRAME = 16 * MiB;
/** Largest input frame payload after the terminal id. */
export const MAX_INPUT = 64 * KiB;
/** Unacked output bytes per connection and terminal above which the PTY pauses. */
export const FLOW_HIGH = 512 * KiB;
/** Unacked output bytes below which a paused PTY resumes. */
export const FLOW_LOW = 128 * KiB;
/** Clients ack at least every this many consumed output bytes. */
export const ACK_EVERY = 64 * KiB;
/** A connection keeping a PTY paused longer than this is detached. */
export const LAG_EVICT_MS = 2000;
