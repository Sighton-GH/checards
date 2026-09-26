// Live test against `wrangler dev` on localhost:8787:
// room create (public) -> lobby listing -> two players + spectator over WS ->
// setup for both sides -> first move -> perspective and presence assertions.
const BASE = 'http://localhost:8787';
let failures = 0;
const fail = m => { console.log('FAIL:', m); failures++; };
const ok = m => console.log('ok:', m);

const res = await fetch(BASE + '/api/rooms', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ visibility: 'public', side: 'red' }),
});
const created = await res.json();
if (!created.room || !created.token) { fail('create room: ' + JSON.stringify(created)); process.exit(1); }
ok(`room ${created.room} created, creator side ${created.side}`);

const lobby = await (await fetch(BASE + '/api/rooms')).json();
if (!lobby.rooms?.some(r => r.code === created.room)) fail('room missing from lobby'); else ok('room listed in lobby');

function connect(qs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8787/ws/rooms/${created.room}?${qs}`);
    const msgs = [];
    const waiters = [];
    ws.onmessage = ev => { const m = JSON.parse(ev.data); msgs.push(m); for (const w of waiters.splice(0)) w(m); };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      ws, msgs,
      next: () => new Promise(r => waiters.push(r)),
      send: o => ws.send(JSON.stringify(o)),
      async state() {
        for (;;) {
          const m = msgs.findLast(m => m.t === 'state');
          if (m) return m.view;
          await new Promise(r => setTimeout(r, 100));
        }
      },
    });
  });
}

const p1 = await connect(`token=${created.token}`);
await new Promise(r => setTimeout(r, 300));
const w1 = p1.msgs.find(m => m.t === 'welcome');
if (w1?.role !== created.side) fail('p1 welcome role: ' + JSON.stringify(w1)); else ok('p1 welcomed as ' + w1.role);

const p2 = await connect('');
await new Promise(r => setTimeout(r, 300));
const w2 = p2.msgs.find(m => m.t === 'welcome');
if (!w2 || w2.role === created.side || !w2.token) fail('p2 welcome: ' + JSON.stringify(w2)); else ok('p2 welcomed as ' + w2.role);

const spec = await connect('');
await new Promise(r => setTimeout(r, 300));
const ws3 = spec.msgs.find(m => m.t === 'welcome');
if (ws3?.role !== 'spec') fail('spectator welcome: ' + JSON.stringify(ws3)); else ok('spectator welcomed');

// setup for both sides (aces then 5 draft+place)
for (const [name, p] of [['p1', p1], ['p2', p2]]) {
  for (let step = 0; step < 20; step++) {
    const st = await p.state();
    if (st.gamePhase !== 'setup' || st.phase === 'done') break;
    if (st.phase === 'setup_place') {
      outer: for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) {
        p.send({ t: 'place', x, y });
        await new Promise(r => setTimeout(r, 60));
        const st2 = await p.state();
        if (st2 !== st) break outer;
      }
    } else if (st.phase === 'setup_draft') { p.send({ t: 'draft', idx: 0 }); await new Promise(r => setTimeout(r, 60)); }
  }
  const st = await p.state();
  if (st.gamePhase === 'setup' && st.phase !== 'done') fail(`${name} setup incomplete: ${st.phase}`); else ok(`${name} setup done`);
}
const s0 = await p1.state();
if (s0.gamePhase !== 'play') fail('not in play after setup: ' + s0.gamePhase); else ok('game in play phase');

// red moves first: legal list must be nonempty only for red
const red = w1.role === 'red' ? p1 : p2;
const black = w1.role === 'red' ? p2 : p1;
let rs = await red.state(), bs = await black.state();
if (!rs.legal.length) fail('red has no legal moves at T1');
if (bs.legal.length) fail('black sees legal moves out of turn');
// hidden-info: black's state must not name red's unrevealed cards
for (const cell of bs.board) for (const c of cell) if (c.name && c.owner === 0 && !c.revealed) fail('black sees hidden red card ' + c.name);
const sp = await spec.state();
for (const cell of sp.board) for (const c of cell) if (c.name && !c.revealed) fail('spectator sees hidden card ' + c.name);
ok('perspective filtering holds on live ws');

const mark = red.msgs.length;
red.send({ t: 'act', idx: 0 });
await new Promise(r => setTimeout(r, 500));
const err = red.msgs.slice(mark).find(m => m.t === 'error');
if (err) fail('act rejected: ' + JSON.stringify(err));
const after = await red.state();
const changed = after.movesRemaining !== rs.movesRemaining || after.mover !== rs.mover || after.turn !== rs.turn;
if (err || !changed) fail(`act had no effect (mover ${rs.mover}->${after.mover}, moves ${rs.movesRemaining}->${after.movesRemaining})`);
else ok(`red acted; mover ${rs.mover}->${after.mover}, movesRemaining ${rs.movesRemaining}->${after.movesRemaining}`);

// presence
const pres = p1.msgs.findLast(m => m.t === 'presence');
if (!pres || pres.spectators < 1) fail('presence: ' + JSON.stringify(pres)); else ok(`presence: ${JSON.stringify(pres)}`);

// C1 regression: a second room in the same isolate must not disturb the first
const createdB = await (await fetch(BASE + '/api/rooms', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ visibility: 'private', side: 'black' }),
})).json();
if (!createdB.room || createdB.room === created.room) fail('room B create');
const b1 = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://localhost:8787/ws/rooms/${createdB.room}?token=${createdB.token}`);
  const msgs = [];
  ws.onmessage = ev => msgs.push(JSON.parse(ev.data));
  ws.onerror = reject;
  ws.onopen = () => resolve({ ws, msgs, send: o => ws.send(JSON.stringify(o)),
    async state() { for (;;) { const m = msgs.findLast(m => m.t === 'state'); if (m) return m.view; await new Promise(r => setTimeout(r, 100)); } } });
});
// drive room B several setup steps
for (let i = 0; i < 4; i++) {
  const st = await b1.state();
  if (st.phase === 'setup_place') {
    outer: for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) {
      b1.send({ t: 'place', x, y }); await new Promise(r => setTimeout(r, 50));
      const s2 = await b1.state(); if (s2 !== st) break outer;
    }
  } else if (st.phase === 'setup_draft') { b1.send({ t: 'draft', idx: 0 }); await new Promise(r => setTimeout(r, 50)); }
}
// room A must be exactly where we left it: play phase, black to move (red spawned)
const aNow = await red.state();
const aSpecNow = await spec.state();
if (aNow.gamePhase !== 'play' || aNow.mover !== 1 || aNow.turn !== 1) {
  fail(`C1: room A corrupted by room B activity (phase=${aNow.gamePhase} mover=${aNow.mover} turn=${aNow.turn})`);
} else ok('C1: room A untouched by room B (play, black to move, turn 1)');
if (aSpecNow.gamePhase !== 'play' || aSpecNow.mover !== 1) fail('C1: room A spectator view corrupted');
// and A can still act: black moves
const bm = await black.state();
if (bm.legal.length) {
  black.send({ t: 'act', idx: 0 });
  await new Promise(r => setTimeout(r, 400));
  const afterB = await black.state();
  if (afterB.mover === bm.mover && afterB.movesRemaining === bm.movesRemaining) fail('C1: room A black act ignored');
  else ok('C1: room A continues after cross-room traffic');
}
b1.ws.close();

// spectate flag: watching a room with open seats must not consume a seat
{
  const c = await (await fetch(BASE + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility: 'private', side: 'red' }) })).json();
  const w = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8787/ws/rooms/${c.room}?spectate=1`);
    ws.onerror = reject;
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.t === 'welcome') resolve({ ws, m }); };
  });
  if (w.m.role !== 'spec') fail(`spectate=1 got role ${w.m.role} on open room`); else ok('spectate=1 stays spectator on open room');
  const info = await (await fetch(BASE + '/api/rooms/' + c.room)).json();
  // room was created by a red player, so red is legitimately claimed; black must stay open
  if (!info.redTaken || info.blackTaken) fail(`spectate=1 seat state wrong: ${JSON.stringify(info)}`); else ok('spectate=1 leaves the open seat untouched');
  w.ws.close();
}

// resign flow: black resigns -> red wins; double resign errors; public room leaves lobby
black.send({ t: 'resign' });
await new Promise(r => setTimeout(r, 700));
const overSt = await red.state();
if (overSt.gamePhase !== 'over' || overSt.result !== 1) {
  fail(`resign: expected over/result=1, got ${overSt.gamePhase}/${overSt.result}`);
} else ok('resign: game over, Red wins');
const specOver = await spec.state();
if (specOver.gamePhase !== 'over' || specOver.result !== 1) fail('resign: spectator view not updated'); else ok('resign: spectator sees result');
const errBefore = black.msgs.filter(m => m.t === 'error').length;
black.send({ t: 'resign' });
await new Promise(r => setTimeout(r, 400));
if (black.msgs.filter(m => m.t === 'error').length <= errBefore) fail('double resign produced no error'); else ok('double resign rejected');
await new Promise(r => setTimeout(r, 500));
const lobbyAfter = await (await fetch(BASE + '/api/rooms')).json();
if (lobbyAfter.rooms?.some(r => r.code === created.room)) fail('finished room still in lobby'); else ok('finished room unregistered from lobby');

console.log(failures ? `${failures} FAILURES` : 'LIVE WORKER TEST PASS');
process.exit(failures ? 1 : 0);
