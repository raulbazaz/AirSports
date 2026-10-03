// Milestone 1 check: room creation, joining, relay, and reconnects.
// Run with: npm run test:m1
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "../shared/protocol.js";
import { RoomManager } from "../server/rooms.js";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const httpServer = createServer();
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer);
const rooms = new RoomManager(io);
io.on("connection", (s) => rooms.attach(s));

await new Promise<void>((r) => httpServer.listen(0, r));
const url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;

const clients: Client[] = [];
function client(): Promise<Client> {
  const c: Client = connect(url, { transports: ["websocket"], forceNew: true });
  clients.push(c);
  return new Promise((r) => c.on("connect", () => r(c)));
}
function next<E extends keyof ServerToClientEvents>(c: Client, event: E) {
  return new Promise<Parameters<ServerToClientEvents[E]>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 2000);
    c.once(event, ((...args: Parameters<ServerToClientEvents[E]>) => {
      clearTimeout(timer);
      resolve(args);
    }) as any);
  });
}

let passed = 0;
async function step(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const host = await client();
let code = "";
let hostToken = "";
let tokenA = "";
const phoneA = await client();
const phoneB = await client();

await step("host creates a room with a 4-letter code", async () => {
  const res = await host.emitWithAck("host:create");
  assert.match(res.code, /^[A-Z]{4}$/);
  ({ code, hostToken } = res);
});

await step("phone A joins as player 1 and host is notified", async () => {
  const joined = next(host, "player:joined");
  const res = await phoneA.emitWithAck("controller:join", { code });
  assert.ok(res.ok);
  assert.equal(res.slot, 1);
  tokenA = res.playerToken;
  assert.deepEqual((await joined)[0], { slot: 1, reconnected: false });
});

await step("second phone is rejected with ROOM_FULL (code is case-insensitive)", async () => {
  const res = await phoneB.emitWithAck("controller:join", { code: code.toLowerCase() });
  assert.deepEqual(res, { ok: false, error: "ROOM_FULL" });
});

await step("unknown code is rejected with ROOM_NOT_FOUND", async () => {
  const c = await client();
  const res = await c.emitWithAck("controller:join", { code: "ZZZZ" === code ? "YYYY" : "ZZZZ" });
  assert.deepEqual(res, { ok: false, error: "ROOM_NOT_FOUND" });
});

await step("swing from phone A is relayed to host tagged as slot 1", async () => {
  const got = next(host, "player:input");
  const swing = { type: "swing", power: 0.8, side: "forehand", tilt: 12, t: 123 } as const;
  phoneA.emit("controller:input", swing);
  assert.deepEqual((await got)[0], { slot: 1, input: swing });
});

await step("host message reaches the player's phone only", async () => {
  let bGot = false;
  phoneB.once("host:message", () => (bGot = true));
  const got = next(phoneA, "host:message");
  host.emit("host:send", { slot: 1, msg: { type: "vibrate", ms: 40 } });
  assert.deepEqual((await got)[0], { type: "vibrate", ms: 40 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bGot, false);
});

let phoneA2: Client;
await step("phone A drops; slot is held and reclaimed with its token", async () => {
  const left = next(host, "player:left");
  phoneA.disconnect();
  assert.deepEqual((await left)[0], { slot: 1 });

  const stranger = await client();
  assert.deepEqual(await stranger.emitWithAck("controller:join", { code }), { ok: false, error: "ROOM_FULL" });

  phoneA2 = await client();
  const joined = next(host, "player:joined");
  const res = await phoneA2.emitWithAck("controller:join", { code, playerToken: tokenA });
  assert.ok(res.ok);
  assert.equal(res.slot, 1);
  assert.deepEqual((await joined)[0], { slot: 1, reconnected: true });
});

await step("host drops and rejoins; phone sees status changes", async () => {
  const down = next(phoneA2, "host:status");
  host.disconnect();
  assert.deepEqual((await down)[0], { connected: false });

  const host2 = await client();
  const up = next(phoneA2, "host:status");
  const bad = await host2.emitWithAck("host:rejoin", { code, hostToken: "nope" });
  assert.deepEqual(bad, { ok: false, error: "BAD_TOKEN" });
  const res = await host2.emitWithAck("host:rejoin", { code, hostToken });
  assert.ok(res.ok);
  assert.deepEqual(res.players, [1]);
  assert.deepEqual((await up)[0], { connected: true });
});

console.log(`\nMilestone 1: ${passed} checks passed`);
for (const c of clients) c.disconnect();
io.close();
process.exit(0);
