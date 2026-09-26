# Deploying Checards on one Cloudflare Worker

One-time setup, ~10 minutes. Everything runs under your own Cloudflare account;
no credentials need to be shared.

## 0. Prereqs
- Node.js 20+ and npm
- A Cloudflare account with the `sighton.ca` zone on it (you already have this -
  `*.sighton.ca` is served through Cloudflare)

## 1. Get the code
```sh
git clone https://github.com/Sighton-GH/checards
cd checards/server/worker
```
The engine module (`server/dist/checards-server.js`) and the playable
frontend (`web/dist/`) are committed, so no C++ or frontend build is needed.
The Worker serves both `/api/rooms` + room WebSockets and the static page and
engine from the same origin. To rebuild the server engine after changes, install
emsdk and run `server/build.sh` from the repo root.

## 2. Install and log in
```sh
npm install
npx wrangler login        # opens a browser; approve the Cloudflare OAuth grant
```

## 3. Deploy
```sh
npx wrangler deploy
```
This creates **one** `checards` Worker, both Durable Object classes
(`GameRoom`, `Lobby`) via the v1 migration, and its static asset bundle from
`web/dist/`. The `[assets]` path in `wrangler.toml` is relative to
`server/worker/`; do not import `web/` as a separate Workers & Pages project.
For a Git-connected Workers & Pages production deployment, set the root
directory to `server/worker`, leave build command empty, and use
`npx wrangler deploy` as the deploy command. The Worker name is
`checards`. Do not point the output directory at `web/`.

## 4. Put the unified Worker on checards.sighton.ca
The single `checards` Worker serves both the page and API. Attach
`checards.sighton.ca` to this Worker. Then either uncomment the `routes`
line in `wrangler.toml`
and `npx wrangler deploy` again, or in the dashboard: Workers & Pages →
checards → Settings → Domains & Routes → Add → Custom Domain →
`checards.sighton.ca` (on a zone you own).

## 5. Smoke-test it
```sh
# built frontend (index.html includes ./engine.js) and browser engine
curl -I https://checards.sighton.ca/
curl -I https://checards.sighton.ca/engine.js

# create a private room (also prints your side + player token)
curl -X POST https://checards.sighton.ca/api/rooms \
  -H 'Content-Type: application/json' -d '{"visibility":"private","side":"red"}'

# lobby (public rooms only)
curl https://checards.sighton.ca/api/rooms
```
Open https://checards.sighton.ca/ and confirm a game starts rather than
stalling on "Loading engine…". Then connect a WebSocket to
`wss://checards.sighton.ca/ws/rooms/<CODE>?token=<TOKEN>` - you should get a
`welcome` message followed by a `state` message.

## Notes
- Local dev: `npm run dev` (wrangler dev, serves on localhost:8787 with local
  Durable Objects).
- Rooms are event-sourced: a game survives server restarts/hibernation.
- Engine/protocol conformance tests: `node server/test/e2e.mjs` from the repo
  root (uses the committed wasm module, no worker needed).

### Accepted risk: player tokens in the WebSocket query string

Players authenticate to a room socket as `wss://<host>/ws/rooms/<code>?token=<uuid>`.
Query strings can land in access logs and browser history. We accept this for
now: tokens are unguessable UUIDs, they grant only one seat in one room (no
account, no cross-room power), and a room's tokens die with the room. If we
ever add accounts or persistent identity, move the token to a subprotocol or
header during the WS handshake.

### Accepted residual: engine handles across DO eviction

`getEngine()` caches one wasm instance per isolate, and `cs_new` handles live
in that shared heap. A Durable Object evicted while its isolate survives
cannot free its old handle (the handle value dies with the DO), so each cold
start leaks one Game's heap. Impact is self-bounding (tens of KB per
eviction, reclaimed when the isolate recycles). The clean fix - persisting
the handle id in DO storage and freeing on re-init - is deliberately not
taken yet.
