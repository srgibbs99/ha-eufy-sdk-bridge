// /records/<sn> lists the recordings a device keeps on its own storage (the SDK's getStationRecords), and
// /record-thumbnail/<sn>/<record_id> serves one listed recording's cover, fetched over the device's P2P
// session by the path its row names. Drives the real handler and warmup against a fake SDK and session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createWarmup } from "../src/warmup.mjs";
import { createClips } from "../src/clip.mjs";
import { createState } from "../src/state.mjs";
import { loadConfig } from "../src/config.mjs";

const ROWS = [
  {
    record_id: 12,
    device_sn: "CAM1",
    start_time: "2026-10-01 09:00:05",
    storage_path: "/mnt/data/video/v_12.data",
    thumb_path: "/mnt/data/video/v_12.jpg",
  },
  {
    record_id: 11,
    device_sn: "CAM1",
    start_time: "2026-10-01 08:00:00",
    storage_path: "/mnt/data/video/v_11.data",
    thumb_path: "/mnt/data/video/v_11.jpg",
  },
];

function setup({ rows = ROWS, records, download, noDownload = false } = {}) {
  const session = new EventEmitter();
  session.isConnected = true;
  session.images = [];
  session.requestImage = (file) => {
    session.images.push(file);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(file)]);
    setTimeout(() => session.emit("image", { file, data: jpeg }), 0);
  };
  const calls = [];
  const downloads = [];
  const cam = noDownload
    ? {}
    : {
        downloadRecording: async (opts) => {
          downloads.push(opts);
          if (download) return download(opts);
          return {
            video: Buffer.from("V"),
            audio: Buffer.from("A"),
            frames: 2,
            missingFrames: 0,
            durationMs: 67,
            fps: 15,
          };
        },
      };
  const state = createState();
  state.flags.ready = true;
  const ctx = {
    ...loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" }),
    state,
    eventImageDir: fs.mkdtempSync(path.join(os.tmpdir(), "records-")),
    eventLog: () => {},
    broadcast: () => {},
    eufy: {
      getStationRecords:
        records ??
        (async (sn, opts) => {
          calls.push({ sn, opts });
          return rows;
        }),
      getP2pSessions: () => new Map([["CAM1", session]]),
      getDevices: async () => [{ sn: "CAM1", raw: { member: { admin_user_id: "ADMIN-0000" } } }],
      deviceState: (sn) => ({ sn, stationSn: sn }),
      getDevice: async () => ({ camera: () => cam }),
    },
    muxClip: async (clip, out) => fs.promises.writeFile(out, Buffer.concat([Buffer.from("MP4:"), clip.video])),
  };
  Object.assign(ctx, createWarmup(ctx), createClips(ctx));
  return { handler: createHttpHandler(ctx), calls, session, downloads };
}

async function get(handler, url) {
  const out = {};
  const res = {
    writeHead(code, headers) {
      out.code = code;
      out.headers = headers;
    },
    end(body) {
      out.body = body;
    },
  };
  await handler({ url, headers: { host: "localhost" }, on() {} }, res);
  if (out.headers?.["content-type"] === "application/json") out.json = JSON.parse(out.body);
  return out;
}

test("lists the device's recordings with a cover URL each", async () => {
  const { handler, calls } = setup();
  const r = await get(handler, "/records/CAM1");
  assert.equal(r.code, 200);
  assert.equal(r.json.count, 2);
  assert.deepEqual(
    r.json.records.map((x) => [x.record_id, x.thumbnail]),
    [
      [12, "/record-thumbnail/CAM1/12"],
      [11, "/record-thumbnail/CAM1/11"],
    ],
  );
  assert.equal(r.json.records[0].storage_path, "/mnt/data/video/v_12.data");
  assert.deepEqual(calls, [{ sn: "CAM1", opts: { startDate: undefined, endDate: undefined, limit: undefined } }]);
});

test("passes the day range and limit through", async () => {
  const { handler, calls } = setup();
  await get(handler, "/records/CAM1?start=20260925&end=20261001&limit=20");
  assert.deepEqual(calls[0].opts, { startDate: "20260925", endDate: "20261001", limit: 20 });
});

test("refuses a malformed day or limit without asking the device", async () => {
  const { handler, calls } = setup();
  assert.equal((await get(handler, "/records/CAM1?start=2026-10-01")).code, 400);
  assert.equal((await get(handler, "/records/CAM1?limit=0")).code, 400);
  assert.equal(calls.length, 0);
});

test("a failed read is a 502 carrying the reason", async () => {
  const { handler } = setup({
    records: async () => {
      throw new Error("readDatabase: CAM1 sent no complete history_record_info");
    },
  });
  const r = await get(handler, "/records/CAM1");
  assert.equal(r.code, 502);
  assert.match(r.json.error, /sent no complete/);
});

test("serves a listed recording's cover, fetched by the path its row names", async () => {
  const { handler, session } = setup();
  await get(handler, "/records/CAM1");
  const r = await get(handler, "/record-thumbnail/CAM1/11");
  assert.equal(r.code, 200);
  assert.equal(r.headers["content-type"], "image/jpeg");
  assert.deepEqual(session.images, ["/mnt/data/video/v_11.jpg"]);
});

test("a cover asked before any listing lists first", async () => {
  const { handler, calls, session } = setup();
  const r = await get(handler, "/record-thumbnail/CAM1/12");
  assert.equal(r.code, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(session.images, ["/mnt/data/video/v_12.jpg"]);
});

test("an id the device does not list is a 404, and nothing is requested from it", async () => {
  const { handler, session } = setup();
  const r = await get(handler, "/record-thumbnail/CAM1/99");
  assert.equal(r.code, 404);
  assert.deepEqual(session.images, []);
});

test("serves a listed recording as an mp4, downloaded by the name its storage_path gives", async () => {
  const { handler, downloads } = setup();
  const r = await get(handler, "/record-clip/CAM1/11");
  assert.equal(r.code, 200);
  assert.equal(r.headers["content-type"], "video/mp4");
  assert.deepEqual(r.body, Buffer.from("MP4:V"));
  assert.deepEqual(downloads, [{ recording: "v_11", cipherId: 0 }]);
});

test("a recording id the device does not list is a 404, and nothing is downloaded", async () => {
  const { handler, downloads } = setup();
  const r = await get(handler, "/record-clip/CAM1/99");
  assert.equal(r.code, 404);
  assert.deepEqual(downloads, []);
});

test("a failed download is a 502 carrying the SDK's reason", async () => {
  const { handler } = setup({
    download: async () => {
      throw Object.assign(new Error("the station sent nothing within 20000 ms"), { reason: "no-data" });
    },
  });
  const r = await get(handler, "/record-clip/CAM1/12");
  assert.equal(r.code, 502);
  assert.equal(r.json.reason, "no-data");
});

test("a device without stored recordings is a 404", async () => {
  const { handler } = setup({ noDownload: true });
  const r = await get(handler, "/record-clip/CAM1/12");
  assert.equal(r.code, 404);
});
