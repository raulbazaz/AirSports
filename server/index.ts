import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import express from "express";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "../shared/protocol.js";
import { RoomManager } from "./rooms.js";

const PORT = Number(process.env.PORT ?? 3000);
const PROD = process.env.NODE_ENV === "production";
/** Public HTTPS origin phones should use (e.g. a tunnel URL). Falls back to the page's own origin. */
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/$/, "") ?? null;

const rootDir = resolve(import.meta.dirname, "..");
const app = express();
const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  // Small payloads, latency matters more than bandwidth.
  perMessageDeflate: false,
  // Let Vite's HMR websocket share this HTTP server in dev.
  destroyUpgrade: PROD,
});

const rooms = new RoomManager(io);
io.on("connection", (socket) => rooms.attach(socket));

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.roomCount });
});

app.get("/api/config", (_req, res) => {
  res.json({ publicUrl: PUBLIC_URL });
});

const pages: Record<string, string> = {
  "/": "game/index.html",
  "/controller": "controller/index.html",
};

if (PROD) {
  const distDir = resolve(rootDir, "dist/client");
  app.use(express.static(distDir, { index: false }));
  for (const [route, file] of Object.entries(pages)) {
    app.get(route, (_req, res) => res.sendFile(resolve(distDir, file)));
  }
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    configFile: resolve(rootDir, "vite.config.ts"),
    server: { middlewareMode: true, ws: { server: httpServer } },
    appType: "custom",
  });
  app.use(vite.middlewares);
  for (const [route, file] of Object.entries(pages)) {
    app.get(route, async (req, res, next) => {
      try {
        const html = await readFile(resolve(rootDir, "client", file), "utf8");
        res.type("html").send(await vite.transformIndexHtml(req.originalUrl, html));
      } catch (err) {
        next(err);
      }
    });
  }
}

httpServer.listen(PORT, () => {
  console.log(`AirSports running at http://localhost:${PORT}`);
  if (PUBLIC_URL) console.log(`Phones will connect via ${PUBLIC_URL}`);
});
