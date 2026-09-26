// Checards multiplayer server: Worker entry + GameRoom / Lobby Durable Objects.
// The authoritative game state lives in the compiled rules engine
// (../../dist/checards-server.js, built by server/build.sh). Clients only ever
// receive their own perspective (or the neutral spectator view).
import ChecardsServer from '../../dist/checards-server.js';
import engineWasm from '../../dist/checards-server.wasm';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

let enginePromise = null;
function getEngine() {
  if (!enginePromise) {
    // Module workers have WorkerGlobalScope but no self.location; the
    // emscripten glue reads self.location.href for script resolution (unused
    // with SINGLE_FILE), so give it a harmless value.
    if (typeof self !== 'undefined' && !self.location) self.location = { href: 'https://checards.worker/' };
    // workerd also exposes process.versions.node (nodejs_compat), which makes
    // the emscripten glue mispick its Node branch (require/__dirname). Hide
    // process for the duration of module init so it takes the worker branch.
    const proc = globalThis.process;
    try {
      if (proc && proc.versions && proc.versions.node) globalThis.process = undefined;
      // Cloudflare Workers forbid runtime wasm compilation from bytes; the
      // wasm ships as a CompiledWasm module binding instead, and we hand the
      // glue a pre-compiled WebAssembly.Module via instantiateWasm.
      enginePromise = ChecardsServer({
        instantiateWasm(imports, cb) {
          WebAssembly.instantiate(engineWasm, imports)
            .then(inst => cb(inst.instance ?? inst))
            .catch(err => { throw err; });
          return {};
        },
      });
    } finally {
      globalThis.process = proc;
    }
  }
  return enginePromise;
}
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function roomCode() {
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      // M2: per-IP room-creation quota, enforced by the Lobby DO
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rl = await env.LOBBY.get(env.LOBBY.idFromName('lobby'))
        .fetch('https://lobby/ratelimit', { method: 'POST', body: JSON.stringify({ ip }) });
      if (rl.status === 429) return json({ error: 'rate limit: too many rooms created, try again later' }, 429);
      const body = await request.json().catch(() => ({}));
      const visibility = body.visibility === 'public' ? 'public' : 'private';
      const side = ['red', 'black', 'random'].includes(body.side) ? body.side : 'random';
      const code = roomCode();
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      const res = await stub.fetch('https://room/init', {
        method: 'POST',
        body: JSON.stringify({ code, visibility, creatorSide: side }),
      });
      const init = await res.json();
      if (visibility === 'public') {
        await env.LOBBY.get(env.LOBBY.idFromName('lobby'))
          .fetch('https://lobby/register', { method: 'POST', body: JSON.stringify({ code }) });
      }
      return json({ room: code, visibility, ...init });
    }

    if (url.pathname === '/api/rooms' && request.method === 'GET') {
      const res = await env.LOBBY.get(env.LOBBY.idFromName('lobby')).fetch('https://lobby/list');
      return json(await res.json());
    }

    const m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})$/);
    if (m && request.method === 'GET') {
      const stub = env.ROOM.get(env.ROOM.idFromName(m[1]));
      const res = await stub.fetch('https://room/info');
      if (res.status === 404) return json({ error: 'no such room' }, 404);
      return json(await res.json());
    }

    const w = url.pathname.match(/^\/ws\/rooms\/([A-Z0-9]{6})$/);
    if (w) {
      const stub = env.ROOM.get(env.ROOM.idFromName(w[1]));
      return stub.fetch(new Request('https://room/ws' + url.search, request));
    }

    // The frontend and API share one production Worker. Keep unknown API and
    // WebSocket routes JSON/404 instead of serving the SPA HTML to API clients.
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/'))
      return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> { role: 'red'|'black'|'spec', token }
    this.meta = null;          // { code, visibility, tokens: {red, black}, createdAt }
  }

  async loadMeta() {
    if (!this.meta) this.meta = await this.state.storage.get('meta');
    return this.meta;
  }

  // Engine state is event-sourced: the seed plus every accepted setup/play
  // action fully determine the game (draw piles are shuffled from the seed).
  // On a cold start after hibernation we rebuild by replaying the action log,
  // so a room survives Durable Object eviction at any point mid-game.
  // One opaque engine handle PER ROOM (audit C1): the module is shared across
  // the isolate, but every game lives behind its own cs_new handle, so rooms
  // can never see or corrupt each other's state.
  async engine() {
    if (this.M) return this.M;
    const M = await getEngine();
    // Residual, accepted: if this DO is evicted while the isolate's cached
    // wasm module survives, the old handle stays allocated in the shared
    // heap (self-bounding; reclaimed on isolate recycle). See DEPLOY.md.
    this.replay = (await this.state.storage.get('replay')) || { seed: (Date.now() & 0x7fffffff) >>> 0, actions: [] };
    const h = M.ccall('cs_new', 'number', ['number'], [this.replay.seed]);
    this.M = M;
    this.handle = h;
    try {
      for (let i = 0; i < this.replay.actions.length; i++) {
        if (!this.applyRaw(this.replay.actions[i]))
          throw new Error(`replay diverged at action ${i} - refusing to serve a corrupt room`);
      }
    } catch (e) {
      // N2: never serve a corrupt room on the warm path - free the handle
      // and drop M/handle so the next request re-initializes cleanly.
      try { M.ccall('cs_free', 'void', ['number'], [h]); } catch {}
      this.M = null;
      this.handle = 0;
      throw e;
    }
    return this.M;
  }

  applyRaw(a) {
    const M = this.M, h = this.handle;
    if (a.t === 'place') return M.ccall('cs_place', 'number', ['number', 'number', 'number', 'number'], [h, a.side, a.x, a.y]);
    if (a.t === 'draft') return M.ccall('cs_draft', 'number', ['number', 'number', 'number'], [h, a.side, a.idx]);
    if (a.t === 'resign') return M.ccall('cs_resign', 'number', ['number', 'number'], [h, a.side]);
    return M.ccall('cs_act', 'number', ['number', 'number', 'number'], [h, a.side, a.idx]);
  }

  async record(a) {
    this.replay.actions.push(a);
    await this.state.storage.put('replay', this.replay);
  }

  stateFor(M, role) {
    if (role === 'spec') return JSON.parse(M.ccall('cs_state_spec', 'string', ['number'], [this.handle]));
    return JSON.parse(M.ccall('cs_state', 'string', ['number', 'number'], [this.handle, role === 'red' ? 0 : 1]));
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.sessions.keys()) {
      try { ws.send(s); } catch { this.sessions.delete(ws); }
    }
  }

  broadcastState(M) {
    for (const [ws, sess] of this.sessions) {
      try {
        ws.send(JSON.stringify({ t: 'state', view: this.stateFor(M, sess.role) }));
      } catch { this.sessions.delete(ws); }
    }
    this.broadcastPresence();
  }

  broadcastPresence() {
    let red = false, black = false, spec = 0;
    for (const sess of this.sessions.values()) {
      if (sess.role === 'red') red = true;
      else if (sess.role === 'black') black = true;
      else spec++;
    }
    this.broadcast({ t: 'presence', redOnline: red, blackOnline: black, spectators: spec });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      const { code, visibility, creatorSide } = await request.json();
      const side = creatorSide === 'random' ? (Math.random() < 0.5 ? 'red' : 'black') : creatorSide;
      const token = crypto.randomUUID();
      this.meta = {
        code, visibility, createdAt: Date.now(),
        tokens: { [side]: token },          // other side's token is minted on join
        creatorSide: side,
      };
      await this.state.storage.put('meta', this.meta);
      await this.engine(); // start a fresh game
      return json({ side, token });
    }

    if (url.pathname === '/info') {
      const meta = await this.loadMeta();
      if (!meta) return json({ error: 'no such room' }, 404);
      const M = await this.engine();
      const st = this.stateFor(M, 'spec');
      return json({
        code: meta.code, visibility: meta.visibility,
        redTaken: !!meta.tokens.red, blackTaken: !!meta.tokens.black,
        phase: st.gamePhase, turn: st.turn, result: st.result,
      });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const meta = await this.loadMeta();
      if (!meta) return new Response('no such room', { status: 404 });
      const M = await this.engine();

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      const token = url.searchParams.get('token') || '';
      // Explicit spectator flag: spectating never consumes a player seat.
      const watch = url.searchParams.get('spectate') === '1' || url.searchParams.get('side') === 'spec';
      let role = 'spec';
      if (token && meta.tokens.red === token) role = 'red';
      else if (token && meta.tokens.black === token) role = 'black';
      else if (!watch) {
        // unclaimed seat? first come first served for the open side
        const want = url.searchParams.get('side');
        if (!meta.tokens.red && want !== 'black') { role = 'red'; meta.tokens.red = crypto.randomUUID(); }
        else if (!meta.tokens.black) { role = 'black'; meta.tokens.black = crypto.randomUUID(); }
        if (role !== 'spec') await this.state.storage.put('meta', meta);
      }
      const sess = { role, token: role === 'spec' ? '' : meta.tokens[role] };
      this.sessions.set(server, sess);
      server.send(JSON.stringify({ t: 'welcome', role, room: meta.code, token: sess.token || undefined, visibility: meta.visibility }));
      server.send(JSON.stringify({ t: 'state', view: this.stateFor(M, role) }));
      this.broadcastPresence();

      server.addEventListener('message', async ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        try { await this.onMessage(server, sess, msg); }
        catch (e) { server.send(JSON.stringify({ t: 'error', msg: String(e && e.message || e) })); }
      });
      server.addEventListener('close', () => { this.sessions.delete(server); this.broadcastPresence(); });
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  async onMessage(ws, sess, msg) {
    const M = await this.engine();
    const send = o => ws.send(JSON.stringify(o));
    if (msg.t === 'ping') { send({ t: 'pong' }); return; }
    if (sess.role === 'spec') { send({ t: 'error', msg: 'spectators cannot act' }); return; }
    const side = sess.role === 'red' ? 0 : 1;
    let action = null;
    if (msg.t === 'place') action = { t: 'place', side, x: msg.x | 0, y: msg.y | 0 };
    else if (msg.t === 'draft') action = { t: 'draft', side, idx: msg.idx | 0 };
    else if (msg.t === 'act') action = { t: 'act', side, idx: msg.idx | 0 };
    else if (msg.t === 'resign') action = { t: 'resign', side };
    else { send({ t: 'error', msg: 'unknown message type' }); return; }
    if (!this.applyRaw(action)) { send({ t: 'error', msg: 'illegal or out-of-turn action' }); return; }
    await this.record(action);
    this.broadcastState(M);
    const st = this.stateFor(M, 'spec');
    if (st.gamePhase === 'over' && this.meta.visibility === 'public') {
      await this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby'))
        .fetch('https://lobby/unregister', { method: 'POST', body: JSON.stringify({ code: this.meta.code }) });
    }
  }
}

export class Lobby {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const url = new URL(request.url);
    let rooms = (await this.state.storage.get('rooms')) || {};
    if (url.pathname === '/register' && request.method === 'POST') {
      const { code } = await request.json();
      rooms[code] = { code, registeredAt: Date.now() };
      await this.state.storage.put('rooms', rooms);
      return json({ ok: true });
    }
    if (url.pathname === '/unregister' && request.method === 'POST') {
      const { code } = await request.json();
      delete rooms[code];
      await this.state.storage.put('rooms', rooms);
      return json({ ok: true });
    }
    if (url.pathname === '/ratelimit' && request.method === 'POST') {
      const { ip } = await request.json();
      const quotas = (await this.state.storage.get('quotas')) || {};
      const now = Date.now(), windowMs = 3600 * 1000, cap = 20;
      const hits = (quotas[ip] || []).filter(t => now - t < windowMs);
      if (hits.length >= cap) return json({ ok: false }, 429);
      hits.push(now);
      quotas[ip] = hits;
      // prune idle keys so the map cannot grow one entry per IP forever
      for (const k of Object.keys(quotas)) {
        quotas[k] = quotas[k].filter(t => now - t < windowMs);
        if (!quotas[k].length) delete quotas[k];
      }
      await this.state.storage.put('quotas', quotas);
      return json({ ok: true });
    }
    if (url.pathname === '/list') {
      const fresh = Object.values(rooms).filter(r => Date.now() - r.registeredAt < 3 * 3600 * 1000);
      if (fresh.length !== Object.keys(rooms).length) {
        rooms = Object.fromEntries(fresh.map(r => [r.code, r]));
        await this.state.storage.put('rooms', rooms);
      }
      return json({ rooms: fresh.sort((a, b) => b.registeredAt - a.registeredAt).slice(0, 50) });
    }
    return new Response('not found', { status: 404 });
  }
}
