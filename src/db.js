import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "queue.db"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS queues (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    admin_token   TEXT NOT NULL,
    now_serving   INTEGER NOT NULL DEFAULT 0,
    last_number   INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'open',
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id          TEXT PRIMARY KEY,
    queue_id    TEXT NOT NULL,
    number      INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'waiting', -- waiting | serving | done | skipped
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (queue_id) REFERENCES queues(id)
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_queue ON tickets(queue_id, number);
`);

// Short, human-friendly, URL-safe IDs (no ambiguous chars), using built-in crypto.
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function makeId(len) {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
const shortId = () => makeId(6);
const tokenId = () => makeId(16);
const ticketId = () => makeId(10);

export function createQueue(name) {
  const id = shortId();
  const adminToken = tokenId();
  db.prepare(
    `INSERT INTO queues (id, name, admin_token, created_at) VALUES (?, ?, ?, ?)`
  ).run(id, name || "Queue", adminToken, Date.now());
  return { id, adminToken };
}

export function getQueue(id) {
  return db.prepare(`SELECT * FROM queues WHERE id = ?`).get(id);
}

export function queueExists(id) {
  return !!getQueue(id);
}

// Assign the next ticket number to a new customer.
export function joinQueue(queueId) {
  const q = getQueue(queueId);
  if (!q) return null;
  if (q.status !== "open") return { closed: true };

  db.exec("BEGIN");
  try {
    const number = q.last_number + 1;
    db.prepare(`UPDATE queues SET last_number = ? WHERE id = ?`).run(
      number,
      queueId
    );
    const id = ticketId();
    db.prepare(
      `INSERT INTO tickets (id, queue_id, number, created_at) VALUES (?, ?, ?, ?)`
    ).run(id, queueId, number, Date.now());
    db.exec("COMMIT");
    return { id, number };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getTicket(ticketId) {
  return db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(ticketId);
}

// Advance the queue: mark current serving done, serve the next waiting ticket.
export function callNext(queueId) {
  const q = getQueue(queueId);
  if (!q) return null;

  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE tickets SET status = 'done' WHERE queue_id = ? AND status = 'serving'`
    ).run(queueId);

    const next = db
      .prepare(
        `SELECT * FROM tickets WHERE queue_id = ? AND status = 'waiting'
         ORDER BY number ASC LIMIT 1`
      )
      .get(queueId);

    if (!next) {
      db.exec("COMMIT");
      return { empty: true };
    }

    db.prepare(`UPDATE tickets SET status = 'serving' WHERE id = ?`).run(
      next.id
    );
    db.prepare(`UPDATE queues SET now_serving = ? WHERE id = ?`).run(
      next.number,
      queueId
    );
    db.exec("COMMIT");
    return { number: next.number };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function setQueueStatus(queueId, status) {
  db.prepare(`UPDATE queues SET status = ? WHERE id = ?`).run(status, queueId);
}

// Full public state of a queue (safe to broadcast; no admin token).
export function getQueueState(queueId) {
  const q = getQueue(queueId);
  if (!q) return null;

  const waiting = db
    .prepare(
      `SELECT number FROM tickets WHERE queue_id = ? AND status = 'waiting'
       ORDER BY number ASC`
    )
    .all(queueId)
    .map((r) => r.number);

  const waitingCount = waiting.length;

  return {
    id: q.id,
    name: q.name,
    status: q.status,
    nowServing: q.now_serving,
    lastNumber: q.last_number,
    waitingCount,
    waiting,
  };
}

// Position info for a single ticket (people ahead, etc.).
export function getTicketState(ticketId) {
  const t = getTicket(ticketId);
  if (!t) return null;
  const q = getQueue(t.queue_id);

  const ahead = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM tickets
       WHERE queue_id = ? AND status = 'waiting' AND number < ?`
      )
      .get(t.queue_id, t.number).c
  );

  return {
    ticketId: t.id,
    queueId: t.queue_id,
    queueName: q?.name,
    number: t.number,
    status: t.status,
    nowServing: q?.now_serving ?? 0,
    peopleAhead: t.status === "waiting" ? ahead : 0,
  };
}

export default db;
