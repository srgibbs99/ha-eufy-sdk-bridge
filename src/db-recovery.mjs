// Recovery for a station P2P session that has stopped answering database reads. The SDK keeps a station's
// session open until something closes it, and a session can go silent without closing: every recordings list
// then times out ("sent no complete history_record_info") on the same dead session until the bridge restarts,
// while pushes keep arriving on their own channel. So after a run of those timeouts, close the station's session
// and let the next read open a fresh one. Only the station's own control session is closed: a live viewer has
// its own client and session (streams.mjs), and pushes and lock events do not ride it.
//
// Every call here runs under warmup.mjs's DB lock (listRecords holds it while it reports), so a reconnect never
// lands in the middle of another read or a recording download on the same session.

// Failed lists in a row, and the least time from the first to the last, before the session is closed. A list
// already asks each page three times, so three failed lists is nine unanswered asks. 0 disables recovery.
const RECONNECT_AFTER = Number(process.env.BRIDGE_DB_RECONNECT_AFTER ?? 3);
const RECONNECT_SPAN_MS = Number(process.env.BRIDGE_DB_RECONNECT_SPAN_MS ?? 60_000);
// Wait before each further reconnect while lists keep failing, the last value repeating. Reconnects only happen
// when a list has just failed, so the rate of lists bounds them too.
const RECONNECT_BACKOFF_MS = (process.env.BRIDGE_DB_RECONNECT_BACKOFF_MS || "600000,1800000,3600000")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0);

/** The error a database read gives when the station's reply never arrived whole. */
export const isReadTimeout = (e) => /sent no complete/.test(String(e?.message ?? e));

export function createDbRecovery(ctx) {
  const { eufy } = ctx;
  const { streaming } = ctx.state;
  const now = ctx.now ?? Date.now;
  const reconnectAfter = ctx.dbReconnectAfter ?? RECONNECT_AFTER;
  const spanMs = ctx.dbReconnectSpanMs ?? RECONNECT_SPAN_MS;
  const backoffMs = ctx.dbReconnectBackoffMs ?? RECONNECT_BACKOFF_MS;
  // station -> { failures, firstFailureAt, lastFailureAt, lastError, lastOkAt, reconnects, attempts, nextAt, recovering }
  const stations = new Map();

  const stationOf = (sn) => eufy.deviceState?.(sn)?.stationSn ?? sn;
  const sessionOf = (station) => eufy.getP2pSessions?.().get(station);
  const entry = (station) => {
    let s = stations.get(station);
    if (!s) stations.set(station, (s = { failures: 0, reconnects: 0, attempts: 0, nextAt: 0, recovering: false }));
    return s;
  };

  /** Whether any camera on `station` is being watched right now. */
  const watched = (station) => [...streaming].some((sn) => stationOf(sn) === station);

  /** How the station's heartbeat stands, for the log: the SDK's own evidence of a dead path. */
  function pathNote(session) {
    if (!session) return "no session";
    const silent = session.pathSilentMs;
    if (silent === undefined) return "path not yet answered";
    return `path silent ${silent} ms${session.pathAnswering === false ? ", not answering" : ""}`;
  }

  /** A list on `sn` succeeded: the station answers, so any run of failures is over. */
  function noteListSuccess(sn) {
    const station = stationOf(sn);
    const s = entry(station);
    if (s.failures) console.log(`[bridge] ${station} database reads answer again after ${s.failures} failed list(s)`);
    Object.assign(s, { failures: 0, firstFailureAt: undefined, attempts: 0, nextAt: 0, lastOkAt: now() });
  }

  /**
   * A list on `sn` failed with `error`. Counts a read timeout towards a reconnect, and reconnects when the run is
   * long enough (or the SDK says the path has stopped answering) and the backoff allows. Other errors, and any
   * failure while a camera on the station is being watched, are recorded but not counted.
   */
  async function noteListFailure(sn, error) {
    const station = stationOf(sn);
    const s = entry(station);
    const message = String(error?.message ?? error);
    s.lastError = message;
    if (!reconnectAfter || !isReadTimeout(error)) return;
    const session = sessionOf(station);
    if (watched(station)) {
      console.log(`[bridge] ${station} list failed during live view (${pathNote(session)}) — not counted`);
      return;
    }
    const at = now();
    s.failures += 1;
    s.firstFailureAt ??= at;
    s.lastFailureAt = at;
    const dead = session?.pathAnswering === false;
    const due = s.failures >= reconnectAfter && at - s.firstFailureAt >= spanMs;
    console.log(`[bridge] ${station} list failed (${s.failures} in a row; ${pathNote(session)}): ${message}`);
    if (!due && !dead) return;
    if (at < s.nextAt) return;
    await reconnect(sn, station, s);
  }

  /** Close the station's session, then read one page on a fresh one to see whether that helped. */
  async function reconnect(sn, station, s) {
    s.attempts += 1;
    s.reconnects += 1;
    s.nextAt = now() + (backoffMs[Math.min(s.attempts - 1, backoffMs.length - 1)] ?? 0);
    s.recovering = true;
    console.error(
      `[bridge] ${station}: ${s.failures} list(s) in a row got no answer — closing its P2P session and reconnecting ` +
        `(reconnect ${s.attempts} of this run)`,
    );
    try {
      await sessionOf(station)?.close?.();
      await eufy.getStationRecords(sn, { limit: 1 });
      console.log(`[bridge] ${station}: reconnected, and the station answers database reads again`);
      noteListSuccess(sn);
    } catch (e) {
      s.lastError = String(e?.message ?? e);
      const wait = Math.max(0, Math.round((s.nextAt - now()) / 1000));
      console.error(
        `[bridge] ${station}: still no answer after reconnecting (${s.lastError}) — next reconnect in ${wait}s at the earliest`,
      );
    } finally {
      s.recovering = false;
    }
  }

  /** Per station, how its database reads stand, for /healthz. Empty until a station has been listed. */
  function databaseReadHealth() {
    const at = now();
    const secs = (t) => (t === undefined ? undefined : Math.round((at - t) / 1000));
    const out = {};
    for (const [station, s] of stations) {
      out[station] = {
        state: s.recovering ? "recovering" : s.failures ? "failing" : "ok",
        failures: s.failures,
        failingSec: secs(s.firstFailureAt),
        lastOkSec: secs(s.lastOkAt),
        lastError: s.failures ? s.lastError : undefined,
        reconnects: s.reconnects,
        nextReconnectSec: s.failures && s.nextAt > at ? Math.ceil((s.nextAt - at) / 1000) : undefined,
        pathSilentMs: sessionOf(station)?.pathSilentMs,
      };
    }
    return out;
  }

  return { noteListSuccess, noteListFailure, databaseReadHealth };
}
