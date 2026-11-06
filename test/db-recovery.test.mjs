// A station session that stops answering database reads is closed after a run of list timeouts, so the next
// read opens a fresh one. Drives db-recovery.mjs with warmup.mjs's real DB lock against a fake SDK and session.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWarmup } from "../src/warmup.mjs";
import { createDbRecovery, isReadTimeout } from "../src/db-recovery.mjs";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createState } from "../src/state.mjs";
import { loadConfig } from "../src/config.mjs";

const TIMEOUT = "readDatabase: CAM1 sent no complete history_record_info";
const ROWS = [{ record_id: 1, device_sn: "CAM1", start_time: "2026-10-01 09:00:00", storage_path: "/v/v_1.data" }];

/** A fake station session. `answers` decides each list: true answers, false times out, an Error throws it. */
function setup({ answers = () => false } = {}) {
  let clock = 1_000_000;
  const sessions = [];
  const open = () => {
    const s = new EventEmitter();
    s.isConnected = true;
    s.pathSilentMs = 2_000;
    s.pathAnswering = true;
    s.closed = false;
    s.close = async () => {
      s.closed = true;
      current = undefined;
    };
    sessions.push(s);
    return s;
  };
  let current = open();
  const lists = [];
  const log = [];
  const state = createState();
  state.flags.ready = true;
  const ctx = {
    ...loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" }),
    state,
    now: () => clock,
    eventImageDir: fs.mkdtempSync(path.join(os.tmpdir(), "db-recovery-")),
    eventLog: () => {},
    broadcast: () => {},
    authStatus: () => ({ state: "ok" }),
    eufy: {
      getStationRecords: async (sn, opts) => {
        current ??= open(); // the SDK opens a fresh session on the next read
        lists.push(opts);
        const a = answers(lists.length, current);
        if (a instanceof Error) throw a;
        if (!a) throw new Error(TIMEOUT);
        return ROWS;
      },
      getP2pSessions: () => new Map(current ? [["CAM1", current]] : []),
      deviceState: (sn) => ({ sn, stationSn: sn }),
      getDevices: async () => [],
      getDevice: async () => ({ camera: () => ({}) }),
    },
  };
  Object.assign(ctx, createWarmup(ctx), createDbRecovery(ctx));
  const list = () => ctx.listRecords("CAM1").catch((e) => e);
  const advance = (ms) => (clock += ms);
  return { ctx, list, advance, sessions, lists, log, state };
}

/** Silence the recovery's console lines for a test. */
function quiet() {
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
}

test("three list timeouts a minute apart close the session, and a fresh one is read at once", async () => {
  quiet();
  const { ctx, list, advance, sessions, lists } = setup({ answers: (n) => n >= 4 });
  await list();
  advance(30_000);
  await list();
  advance(30_000);
  await list();
  assert.equal(sessions[0].closed, true);
  assert.equal(sessions.length, 2);
  assert.deepEqual(lists.at(-1), { limit: 1 });
  const health = ctx.databaseReadHealth().CAM1;
  assert.equal(health.state, "ok");
  assert.equal(health.failures, 0);
  assert.equal(health.reconnects, 1);
});

test("a quick run of timeouts waits for the span before reconnecting", async () => {
  quiet();
  const { list, advance, sessions } = setup();
  for (let i = 0; i < 3; i++) await list();
  assert.equal(sessions[0].closed, false);
  advance(60_000);
  await list();
  assert.equal(sessions[0].closed, true);
});

test("errors other than a read timeout are not counted", async () => {
  quiet();
  const { ctx, list, advance, sessions } = setup({ answers: () => new Error("getStationRecords: no P2P session") });
  for (let i = 0; i < 5; i++) {
    await list();
    advance(30_000);
  }
  assert.equal(sessions[0].closed, false);
  assert.equal(ctx.databaseReadHealth().CAM1.failures, 0);
});

test("a timeout while a camera on the station is being watched is not counted", async () => {
  quiet();
  const { ctx, list, advance, sessions, state } = setup();
  state.streaming.add("CAM1");
  for (let i = 0; i < 4; i++) {
    await list();
    advance(30_000);
  }
  assert.equal(sessions[0].closed, false);
  assert.equal(ctx.databaseReadHealth().CAM1.failures, 0);
});

test("a path the SDK reports silent is reconnected on the first timeout", async () => {
  quiet();
  const { list, sessions } = setup({ answers: (n) => n >= 2 });
  sessions[0].pathAnswering = false;
  await list();
  assert.equal(sessions[0].closed, true);
});

test("a reconnect that does not help backs off 10, then 30 minutes", async () => {
  quiet();
  const { ctx, list, advance, sessions } = setup();
  const failRun = async () => {
    for (let i = 0; i < 3; i++) {
      await list();
      advance(30_000);
    }
  };
  await failRun();
  assert.equal(sessions.length, 2); // reconnected once; the check read on the new session failed too
  assert.equal(ctx.databaseReadHealth().CAM1.state, "failing");
  assert.ok(ctx.databaseReadHealth().CAM1.nextReconnectSec > 0);

  advance(5 * 60_000);
  await list();
  assert.equal(sessions.length, 2); // inside the 10-minute wait
  advance(5 * 60_000);
  await list();
  assert.equal(sessions.length, 3);
  advance(20 * 60_000);
  await list();
  assert.equal(sessions.length, 3); // inside the 30-minute wait
  advance(10 * 60_000);
  await list();
  assert.equal(sessions.length, 4);
});

test("a list that answers ends the run and resets the backoff", async () => {
  quiet();
  let ok = false;
  const { ctx, list, advance, sessions } = setup({ answers: () => ok });
  for (let i = 0; i < 3; i++) {
    await list();
    advance(30_000);
  }
  ok = true;
  await list();
  assert.equal(ctx.databaseReadHealth().CAM1.state, "ok");
  ok = false;
  for (let i = 0; i < 3; i++) {
    await list();
    advance(30_000);
  }
  assert.equal(sessions.length, 3); // reconnected again at once, no 10-minute wait carried over
});

test("a reconnect waits for a download running on the session", async () => {
  quiet();
  const { ctx, list, advance, sessions } = setup({ answers: (n) => n === 1 || n >= 5 });
  await list(); // answers, so the download's row is known
  await list();
  advance(30_000);
  await list();
  advance(30_000);
  let finish;
  ctx.eufy.getDevice = async () => ({
    camera: () => ({
      downloadRecording: () =>
        new Promise((resolve) => {
          finish = () => resolve({ video: Buffer.from("V"), frames: 1, missingFrames: 0, durationMs: 1 });
        }),
    }),
  });
  const download = ctx.recordDownload("CAM1", 1);
  const third = list();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(typeof finish, "function");
  assert.equal(sessions[0].closed, false);
  finish();
  await download;
  await third;
  assert.equal(sessions[0].closed, true);
});

test("/healthz reports each station's database reads, and stays ok", async () => {
  quiet();
  const { ctx, list, advance } = setup();
  await list();
  advance(15_000);
  const handler = createHttpHandler(ctx);
  let body;
  await handler(
    { url: "/healthz", headers: { host: "localhost" }, on() {} },
    { writeHead() {}, end: (s) => (body = s) },
  );
  const out = JSON.parse(body);
  assert.equal(out.ok, true);
  assert.equal(out.databaseReads.CAM1.state, "failing");
  assert.equal(out.databaseReads.CAM1.failures, 1);
  assert.equal(out.databaseReads.CAM1.failingSec, 15);
  assert.equal(out.databaseReads.CAM1.pathSilentMs, 2_000);
  assert.match(out.databaseReads.CAM1.lastError, /sent no complete/);
});

test("only the 'sent no complete' error is a read timeout", () => {
  assert.equal(isReadTimeout(new Error(TIMEOUT)), true);
  assert.equal(isReadTimeout(new Error("the station sent nothing within 20000 ms")), false);
  assert.equal(isReadTimeout(new Error("the station's reply carries no 10-digit download code")), false);
});
