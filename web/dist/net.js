/** Checards multiplayer transport. No game rules or DOM rendering live here.
 * Server: POST/GET /api/rooms, WS /ws/rooms/:code. Views are authoritative and
 * perspective-filtered by the server; never infer hidden information locally.
 */
const DEFAULT_SERVER = 'https://checards.sighton.ca';
const ROOM_RE = /^[A-Z0-9]{6}$/;
const handlers = new Map();
let activeSession = null;

function emit(type, value) {
  for (const fn of handlers.get(type) || []) {
    try { fn(value); } catch (error) { queueMicrotask(() => { throw error; }); }
  }
}
export function on(type, fn) {
  if (typeof fn !== 'function') throw new TypeError('listener must be a function');
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  if (type === 'state' && activeSession?.view) fn(activeSession.view);
  if (type === 'presence' && activeSession?.presence) fn(activeSession.presence);
  if (type === 'welcome' && activeSession?.role) fn({ t: 'welcome', room: activeSession.room, role: activeSession.role, token: activeSession.token, visibility: activeSession.visibility });
  return () => handlers.get(type)?.delete(fn);
}
export function off(type, fn) { handlers.get(type)?.delete(fn); }

function baseUrl() {
  const configured = globalThis.CHECARDS_SERVER_URL;
  if (configured) return new URL(configured).origin;
  const host = globalThis.location?.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return `http://${host}:8787`;
  return DEFAULT_SERVER;
}
function codeOf(input) {
  const code = String(input || '').trim().toUpperCase();
  if (!ROOM_RE.test(code)) throw new Error('Enter a six-character room code.');
  return code;
}
async function request(path, options) {
  const response = await fetch(baseUrl() + path, options);
  let data;
  try { data = await response.json(); } catch { throw new Error(`Server returned ${response.status}.`); }
  if (!response.ok) throw new Error(data.error || `Server returned ${response.status}.`);
  return data;
}
export function listRooms() { return request('/api/rooms'); }
export function roomInfo(code) { return request(`/api/rooms/${codeOf(code)}`); }

function socketUrl(room, token, role) {
  const url = new URL(`/ws/rooms/${codeOf(room)}`, baseUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (token) url.searchParams.set('token', token);
  // On the original server, an unclaimed seat is assigned to any anonymous
  // socket. An explicit spectator flag is needed server-side for open rooms.
  if (role === 'spec') url.searchParams.set('spectate', '1');
  return url.href;
}

export class RoomSession {
  constructor({ room, token, role, visibility } = {}) {
    this.room = codeOf(room);
    this.token = token || null;
    this.role = role || null;
    this.visibility = visibility || null;
    this.view = null;
    this.presence = null;
    this.status = 'idle';
    this.socket = null;
    this.retries = 0;
    this.closed = false;
    this.timer = null;
    this.pending = null;
  }
  on(type, fn) {
    // Local session listeners do not receive events from other rooms.
    if (!this.listeners) this.listeners = new Map();
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }
  _emit(type, payload) {
    for (const fn of this.listeners?.get(type) || []) {
      try { fn(payload); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
    if (activeSession === this) emit(type, payload);
  }
  async connect() {
    if (this.closed) throw new Error('Session closed.');
    if (this.pending) return this.pending;
    this.pending = this._open().finally(() => { this.pending = null; });
    return this.pending;
  }
  _open() {
    return new Promise((resolve, reject) => {
      let welcomed = false, settled = false;
      const ws = new WebSocket(socketUrl(this.room, this.token, this.role));
      this.socket = ws;
      this.status = this.retries ? 'reconnecting' : 'connecting';
      this._emit('connection', this.status);
      const fail = error => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      ws.onmessage = event => {
        if (ws !== this.socket || this.closed) return;
        let msg;
        try { msg = JSON.parse(event.data); } catch { this._emit('error', 'Invalid server message.'); return; }
        if (msg.t === 'welcome') {
          // On reconnect, a lost seat must not silently turn into spectating or
          // switch sides. Surface that failure instead of pretending play works.
          if (this.role && msg.role !== this.role) {
            this._emit('error', 'Your seat could not be restored.');
            this.close();
            fail(new Error('Your seat could not be restored.'));
            return;
          }
          welcomed = true;
          this.role = msg.role;
          this.token = msg.token || null;
          this.visibility = msg.visibility;
          this.room = msg.room;
          this.retries = 0;
          this.status = 'connected';
          this._emit('welcome', msg);
          this._emit('connection', this.status);
          // A fresh state always follows welcome, and is the resync snapshot.
          if (!settled) { settled = true; resolve(this); }
        } else if (msg.t === 'state') {
          this.view = msg.view;
          this._emit('state', msg.view);
        } else if (msg.t === 'presence') {
          this.presence = msg;
          this._emit('presence', msg);
        } else if (msg.t === 'error') this._emit('error', msg.msg);
        else if (msg.t === 'pong') this._emit('pong', msg);
      };
      ws.onerror = () => {
        if (!welcomed) fail(new Error('Could not connect to the room.'));
      };
      ws.onclose = () => {
        if (ws !== this.socket) return;
        this.socket = null;
        if (!welcomed) fail(new Error('Could not connect to the room.'));
        if (this.closed) return;
        this.status = 'disconnected';
        this._emit('connection', this.status);
        // No action queue: a move whose acknowledgement was lost must be
        // resolved by the fresh server state, never replayed automatically.
        this.retries++;
        const delay = Math.min(15000, 500 * (2 ** Math.min(5, this.retries - 1)));
        this.timer = setTimeout(() => { this.timer = null; this.connect().catch(error => this._emit('error', error.message)); }, delay);
      };
    });
  }
  send(action) {
    if (!action || !['place', 'draft', 'act', 'resign', 'ping'].includes(action.t)) throw new Error('Unknown action.');
    if (this.role === 'spec' && action.t !== 'ping') throw new Error('Spectators cannot act.');
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Room is disconnected. Wait for resync.');
    let msg;
    if (action.t === 'place') {
      if (![action.x, action.y].every(n => Number.isInteger(n) && n >= 0 && n < 7)) throw new Error('Invalid square.');
      msg = { t: 'place', x: action.x, y: action.y };
    } else if (action.t === 'draft' || action.t === 'act') {
      if (!Number.isInteger(action.idx) || action.idx < 0) throw new Error('Invalid action index.');
      msg = { t: action.t, idx: action.idx };
    } else msg = { t: action.t };
    this.socket.send(JSON.stringify(msg));
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
    this.status = 'closed';
    if (activeSession === this) { activeSession = null; emit('connection', 'closed'); }
    this._emit('connection', 'closed');
  }
}

export async function selectRoom({ room, token, role, visibility } = {}) {
  const session = new RoomSession({ room, token, role, visibility });
  // Selection changes global listeners before opening, so the initial welcome
  // and state reach the UI. Failed selection leaves no broken active session.
  const previous = activeSession;
  activeSession = session;
  try { await session.connect(); }
  catch (error) { session.close(); activeSession = previous; throw error; }
  previous?.close();
  const detail = { room: session.room, role: session.role, token: session.token, session };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('checards:room-selected', { detail }));
  return { ...detail, side: session.role, visibility: session.visibility };
}
export async function createRoom({ visibility = 'private', side = 'random' } = {}) {
  if (!['private', 'public'].includes(visibility) || !['red', 'black', 'random'].includes(side)) throw new Error('Invalid room options.');
  const created = await request('/api/rooms', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visibility, side }),
  });
  return selectRoom({ room: created.room, token: created.token, role: created.side, visibility: created.visibility });
}
export function joinRoom(code) { return selectRoom({ room: codeOf(code) }); }
export function spectate(code) { return selectRoom({ room: codeOf(code), role: 'spec' }); }
export function send(action) {
  if (!activeSession) throw new Error('No room selected.');
  activeSession.send(action);
}
export function disconnect() { activeSession?.close(); }
export function currentSession() { return activeSession; }

const facade = { on, off, send, disconnect, currentSession, createRoom, joinRoom, listRooms, roomInfo, spectate, selectRoom, RoomSession };
Object.defineProperties(facade, {
  role: { get: () => activeSession?.role }, room: { get: () => activeSession?.room },
  token: { get: () => activeSession?.token }, session: { get: () => activeSession },
  view: { get: () => activeSession?.view }, presence: { get: () => activeSession?.presence },
});
if (typeof window !== 'undefined') window.ChecardsNet = facade;
export default facade;
