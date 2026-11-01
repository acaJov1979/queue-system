import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createQueue,
  getQueue,
  joinQueue,
  callNext,
  setQueueStatus,
  getQueueState,
  getTicketState,
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const PORT = process.env.PORT || 3000;

/* ----------------------------- tiny helpers ------------------------------ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

async function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  rel = decodeURIComponent(rel.split("?")[0]);
  // Prevent path traversal.
  const filePath = path.normalize(path.join(publicDir, rel));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

/* ------------------------- minimal WebSocket hub -------------------------- */
// Room-based broadcast keyed by queue id. Implements just enough of RFC 6455
// to accept connections and send server->client text frames.
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** @type {Map<string, Set<import('node:net').Socket>>} */
const rooms = new Map();

function wsAccept(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function wsFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsSend(socket, obj) {
  if (socket.writable) socket.write(wsFrame(JSON.stringify(obj)));
}

function subscribe(queueId, socket) {
  if (!rooms.has(queueId)) rooms.set(queueId, new Set());
  rooms.get(queueId).add(socket);
  const cleanup = () => rooms.get(queueId)?.delete(socket);
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

function broadcast(queueId) {
  const room = rooms.get(queueId);
  if (!room || room.size === 0) return;
  const state = getQueueState(queueId);
  if (!state) return;
  for (const socket of room) wsSend(socket, { type: "state", state });
}

/* --------------------------------- server -------------------------------- */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const method = req.method;

  // ---- API routes ----
  if (p.startsWith("/api/")) {
    // POST /api/queues
    if (p === "/api/queues" && method === "POST") {
      const body = await readBody(req);
      const name = (body.name || "Queue").toString().slice(0, 80);
      const { id, adminToken } = createQueue(name);
      const base = baseUrl(req);
      return sendJson(res, 200, {
        id,
        adminToken,
        joinUrl: `${base}/join.html?queue=${id}`,
        staffUrl: `${base}/staff.html?queue=${id}&token=${adminToken}`,
      });
    }

    const queueMatch = p.match(/^\/api\/queues\/([^/]+)(\/[^/]+)?$/);
    if (queueMatch) {
      const queueId = queueMatch[1];
      const sub = queueMatch[2];

      // GET /api/queues/:id
      if (!sub && method === "GET") {
        const state = getQueueState(queueId);
        if (!state) return sendJson(res, 404, { error: "Queue not found" });
        return sendJson(res, 200, state);
      }

      // POST /api/queues/:id/join
      if (sub === "/join" && method === "POST") {
        const result = joinQueue(queueId);
        if (result === null) return sendJson(res, 404, { error: "Queue not found" });
        if (result.closed) return sendJson(res, 409, { error: "Queue is closed" });
        broadcast(queueId);
        return sendJson(res, 200, { ticketId: result.id, number: result.number });
      }

      // POST /api/queues/:id/next  (admin)
      if (sub === "/next" && method === "POST") {
        const q = getQueue(queueId);
        if (!q) return sendJson(res, 404, { error: "Queue not found" });
        const token = req.headers["x-admin-token"] || url.searchParams.get("token");
        if (token !== q.admin_token)
          return sendJson(res, 403, { error: "Invalid admin token" });
        const result = callNext(queueId);
        broadcast(queueId);
        return sendJson(res, 200, result.empty ? { empty: true } : { nowServing: result.number });
      }

      // POST /api/queues/:id/status  (admin)
      if (sub === "/status" && method === "POST") {
        const q = getQueue(queueId);
        if (!q) return sendJson(res, 404, { error: "Queue not found" });
        const token = req.headers["x-admin-token"] || url.searchParams.get("token");
        if (token !== q.admin_token)
          return sendJson(res, 403, { error: "Invalid admin token" });
        const body = await readBody(req);
        const status = body.status === "closed" ? "closed" : "open";
        setQueueStatus(queueId, status);
        broadcast(queueId);
        return sendJson(res, 200, { status });
      }
    }

    // GET /api/tickets/:ticketId
    const ticketMatch = p.match(/^\/api\/tickets\/([^/]+)$/);
    if (ticketMatch && method === "GET") {
      const state = getTicketState(ticketMatch[1]);
      if (!state) return sendJson(res, 404, { error: "Ticket not found" });
      return sendJson(res, 200, state);
    }

    return sendJson(res, 404, { error: "Not found" });
  }

  // ---- static files ----
  return serveStatic(req, res, p);
});

// ---- WebSocket upgrade ----
server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const queueId = url.searchParams.get("queue");
  const key = req.headers["sec-websocket-key"];
  if (!queueId || !getQueue(queueId) || !key) {
    socket.destroy();
    return;
  }
  const accept = wsAccept(key);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  // Drain incoming frames (pings/closes) without parsing; we only push updates.
  socket.on("data", () => {});
  subscribe(queueId, socket);
  wsSend(socket, { type: "state", state: getQueueState(queueId) });
});

server.listen(PORT, () => {
  console.log(`Queue app running on http://localhost:${PORT}`);
});
