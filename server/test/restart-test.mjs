// Phase 1 (args: create): make a room, run both setups, make one act, print room/tokens/state.
// Phase 2 (args: rejoin <room> <redToken> <blackToken>): reconnect after a worker restart
// and verify the engine rebuilt from the replay log (same phase/turn, game continues).
const BASE = 'http://localhost:8787';
const [mode, room0, tokR, tokB] = process.argv.slice(2);

function connect(room, qs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8787/ws/rooms/${room}?${qs}`);
    const msgs = [];
    ws.onmessage = ev => msgs.push(JSON.parse(ev.data));
    ws.onerror = reject;
    ws.onopen = () => resolve({ ws, msgs, send: o => ws.send(JSON.stringify(o)),
      async state() { for (;;) { const m = msgs.findLast(m => m.t === 'state'); if (m) return m.view; await new Promise(r => setTimeout(r, 100)); } } });
  });
}
async function doSetup(p) {
  for (let step = 0; step < 20; step++) {
    const st = await p.state();
    if (st.gamePhase !== 'setup' || st.phase === 'done') break;
    if (st.phase === 'setup_place') {
      outer: for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) {
        p.send({ t: 'place', x, y }); await new Promise(r => setTimeout(r, 50));
        const s2 = await p.state(); if (s2 !== st) break outer;
      }
    } else if (st.phase === 'setup_draft') { p.send({ t: 'draft', idx: 0 }); await new Promise(r => setTimeout(r, 50)); }
  }
}

if (mode === 'create') {
  const created = await (await fetch(BASE + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility: 'private', side: 'red' }) })).json();
  const red = await connect(created.room, `token=${created.token}`);
  const black = await connect(created.room, '');
  await new Promise(r => setTimeout(r, 300));
  const btok = black.msgs.find(m => m.t === 'welcome').token;
  await doSetup(red); await doSetup(black);
  let st = await red.state();
  if (st.gamePhase !== 'play') { console.log('SETUP FAILED', st.gamePhase); process.exit(1); }
  red.send({ t: 'act', idx: 0 });
  await new Promise(r => setTimeout(r, 400));
  st = await red.state();
  console.log(JSON.stringify({ room: created.room, redToken: created.token, blackToken: btok, turn: st.turn, mover: st.mover, phase: st.gamePhase }));
  process.exit(0); // close websockets explicitly so the script terminates
} else {
  const red = await connect(room0, `token=${tokR}`);
  const black = await connect(room0, `token=${tokB}`);
  await new Promise(r => setTimeout(r, 400));
  const st = await red.state();
  console.log('after restart: phase', st.gamePhase, '| turn', st.turn, '| mover', st.mover, '| red legal:', st.legal.length);
  const bs = await black.state();
  console.log('black view: mover', bs.mover, '| black legal:', bs.legal.length);
  // game must continue: whoever is mover can act
  const moverP = st.mover === 0 ? red : black;
  const ms = st.mover === 0 ? st : bs;
  if (ms.legal.length) { moverP.send({ t: 'act', idx: 0 }); await new Promise(r => setTimeout(r, 400)); }
  const cont = await red.state();
  const progressed = cont.mover !== st.mover || cont.movesRemaining !== st.movesRemaining || cont.turn !== st.turn;
  console.log(progressed ? 'REPLAY/RESTART PASS' : 'REPLAY/RESTART FAIL: game state did not continue');
  process.exit(progressed ? 0 : 1);
}
