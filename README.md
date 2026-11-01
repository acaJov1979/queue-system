# 🎟️ Queue System

A free, on-demand "take a number" queuing system — like the ticket machine at a
deli or bakery. A staff member starts a queue whenever one is needed, customers
scan a QR code with their phone to get a number, and everyone can track the
queue live online. No app install required.

## Features

- **Start a queue on demand** — open one for a counter whenever you need it.
- **QR code to join** — customers scan with their phone camera (no app needed).
- **Live tracking** — real-time position updates over WebSockets ("3 people ahead").
- **Staff dashboard** — see who's waiting, call the next person, open/close the queue.
- **Zero cost** — single Node process + SQLite file. Runs locally or on free hosting tiers.

## Tech stack

- Node.js (ES modules) — **zero runtime dependencies**, built-ins only
- HTTP server + a tiny hand-rolled router (`node:http`)
- Live updates via a minimal WebSocket server (`node:http` upgrade + `node:crypto`)
- SQLite via Node's built-in `node:sqlite` — a single file, no database server, nothing to compile
- QR code rendered in the browser from a small vendored script (`public/qrcode.js`)
- Plain HTML/CSS/JS front end (works everywhere, easy to wrap in an app later)

## Getting started

Requires **Node.js 22.5+** (for the built-in `node:sqlite` module).

```bash
cd queue-app
npm start
```

Then open http://localhost:3000

> There are no npm dependencies to install — `npm start` just runs the server
> with Node's built-in modules. (`npm install` is a harmless no-op.)
>
> `node:sqlite` is currently an experimental feature; Node prints a one-line
> experimental warning on startup, which is expected.

## How to use

1. **Staff:** open the home page, type a queue name, click **Start queue**.
   You'll get a private staff dashboard link — keep it safe, it controls the queue.
2. On the dashboard, **print or display the QR code** at your counter.
3. **Customers:** scan the QR code → tap **Get my number** → they're taken to a
   live tracking page showing their number and position.
4. **Staff:** click **Call next** to advance the queue. Everyone's tracking page
   updates instantly.

## Pages

| Page           | URL                                         | Who       |
|----------------|---------------------------------------------|-----------|
| Start a queue  | `/`                                         | Staff     |
| Staff dashboard| `/staff.html?queue=<id>&token=<adminToken>` | Staff     |
| Join           | `/join.html?queue=<id>` (QR target)         | Customer  |
| Live tracking  | `/track.html?ticket=<id>&queue=<id>`        | Customer  |

## API

| Method | Path                       | Auth        | Purpose                     |
|--------|----------------------------|-------------|-----------------------------|
| POST   | `/api/queues`              | —           | Create a queue              |
| GET    | `/api/queues/:id`          | —           | Public queue state          |
| POST   | `/api/queues/:id/join`     | —           | Get a number                |
| GET    | `/api/tickets/:ticketId`   | —           | Ticket position             |
| POST   | `/api/queues/:id/next`     | admin token | Call the next person        |
| POST   | `/api/queues/:id/status`   | admin token | Open/close the queue        |

Admin token is passed as `?token=<adminToken>` or the `x-admin-token` header.

## Deploying for free

The app honors `x-forwarded-proto` / `x-forwarded-host`, so QR links stay correct
behind a reverse proxy. It listens on `process.env.PORT`. It works out of the box
on free tiers like Render, Railway, or Fly.io. For persistent SQLite data, mount
a small volume at `queue-app/data`.

## Roadmap ideas

- SMS / push notification when it's your turn
- Multiple counters per queue
- Average wait-time estimates
- Wrap the web pages into a mobile app (Capacitor / PWA)
```

## Data

SQLite database is stored at `queue-app/data/queue.db` and is git-ignored.
