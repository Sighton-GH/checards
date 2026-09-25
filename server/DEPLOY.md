# Deploying the Checards multiplayer server (Cloudflare Workers)

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
The engine module (`server/dist/checards-server.js`) is committed, so no C++
build is needed. (To rebuild it after engine changes: install emsdk and run
`server/build.sh` from the repo root.)

## 2. Install and log in
```sh
npm install
npx wrangler login        # opens a browser; approve the Cloudflare OAuth grant
```

## 3. Deploy
```sh
npx wrangler deploy
```
This creates the `checards-server` Worker and both Durable Object classes
(`GameRoom`, `Lobby`) via the v1 migration in `wrangler.toml`.

## 4. Put it on checards.sighton.ca
Either uncomment the `routes` line in `wrangler.toml` and `npx wrangler deploy`
again, or in the dashboard: Workers & Pages → checards-server → Settings →
Domains & Routes → Add → Custom Domain → `checards.sighton.ca` (free, instant on
a zone you own).

## 5. Smoke-test it
```sh
# create a private room (also prints your side + player token)
curl -X POST https://checards.sighton.ca/api/rooms \
  -H 'Content-Type: application/json' -d '{"visibility":"private","side":"red"}'

# lobby (public rooms only)
curl https://checards.sighton.ca/api/rooms
```
Then connect a WebSocket to `wss://checards.sighton.ca/ws/rooms/<CODE>?token=<TOKEN>`
- you should get a `welcome` message followed by a `state` message.

## Notes
- Local dev: `npm run dev` (wrangler dev, serves on localhost:8787 with local
  Durable Objects).
- Rooms are event-sourced: a game survives server restarts/hibernation.
- Engine/protocol conformance tests: `node server/test/e2e.mjs` from the repo
  root (uses the committed wasm module, no worker needed).
