// E2E against the actual worker artifact (server/dist/checards-server.js):
// full two-human game + hidden-info leak checks, same assertions as the native test.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ChecardsServer = require('../dist/checards-server.js');
const M = await ChecardsServer();
const cwrap = M.cwrap;
const cs_new = cwrap('cs_new', 'number', ['number']);
const cs_free = cwrap('cs_free', null, ['number']);
const cs_place = cwrap('cs_place', 'number', ['number', 'number', 'number', 'number']);
const cs_draft = cwrap('cs_draft', 'number', ['number', 'number', 'number']);
const cs_act = cwrap('cs_act', 'number', ['number', 'number', 'number']);
const cs_resign = cwrap('cs_resign', 'number', ['number', 'number']);
const cs_state = (h, s) => JSON.parse(cwrap('cs_state', 'string', ['number', 'number'])(h, s));
const cs_state_spec = h => JSON.parse(cwrap('cs_state_spec', 'string', ['number'])(h));
const cs_log = (h, s) => JSON.parse(cwrap('cs_log', 'string', ['number', 'number'])(h, s));

let failures = 0;
const fail = m => { console.log('FAIL:', m); failures++; };

function leakState(j, viewer, what) {
  for (const cell of j.board) for (const c of cell) {
    if (c.name === undefined) continue;
    if (viewer === -1 && !c.revealed) fail(`${what} names hidden card to spectator: ${JSON.stringify(c)}`);
    if (viewer >= 0 && c.owner === 1 - viewer && !c.revealed) fail(`${what} names opponent card: ${JSON.stringify(c)}`);
  }
}
function leakLog(log, viewer, what) {
  for (const ev of log) {
    if (ev.ev === 'act' && ev.mover !== viewer) {
      if ((ev.a.card || '') !== '') fail(`${what} log names mover card: ${JSON.stringify(ev).slice(0, 120)}`);
      if ((ev.spawned || '') !== '') fail(`${what} log names spawned card: ${JSON.stringify(ev).slice(0, 120)}`);
    }
  }
}
const rng = (() => { let s = 12345; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff); })();

const h1 = cs_new(20260925);
if (!h1) fail('cs_new returned 0');
// C1 regression: concurrent second game must stay isolated
const h2 = cs_new(999);
// setup
for (let guard = 0; guard < 200; guard++) {
  let any = false;
  for (const s of [0, 1]) {
    const st = cs_state(h1, s);
    if (st.phase === 'setup_place') {
      let placed = false;
      for (let x = 0; x < 7 && !placed; x++) for (let y = 0; y < 7 && !placed; y++) placed = cs_place(h1, s, x, y) === 1;
      if (!placed) fail('setup place failed'); any = true;
    } else if (st.phase === 'setup_draft') { if (cs_draft(h1, s, 0) !== 1) fail('draft failed'); any = true; }
  }
  if (cs_state(h1, 0).gamePhase === 'play') break;
  if (!any && guard >= 199) fail('setup stalled');
}
if (cs_state(h1, 0).gamePhase !== 'play') fail('never reached play');
// play to completion
let moves = 0;
for (let guard = 0; guard < 4000; guard++) {
  const st0 = cs_state(h1, 0), st1 = cs_state(h1, 1), spec = cs_state_spec(h1);
  if (st0.result !== 0) break;
  leakState(st0, 0, 'state(red)'); leakState(st1, 1, 'state(black)'); leakState(spec, -1, 'state(spec)');
  const mover = st0.mover;
  const sm = mover === 0 ? st0 : st1;
  const idx = sm.legal.length ? rng() % sm.legal.length : 0;
  if (cs_act(h1, mover, idx) !== 1) fail('legal act rejected');
  moves++;
  if (moves % 25 === 0) { leakLog(cs_log(h1, 0), 0, 'log(red)'); leakLog(cs_log(h1, 1), 1, 'log(black)'); leakLog(cs_log(h1, -1), -1, 'log(spec)'); }
}
leakLog(cs_log(h1, 0), 0, 'final log(red)'); leakLog(cs_log(h1, 1), 1, 'final log(black)'); leakLog(cs_log(h1, -1), -1, 'final log(spec)');
console.log(`game over: result=${cs_state(h1, 0).result} moves=${moves}`);
if (cs_state(h1, 0).result === 0) fail('game did not terminate');
if (moves <= 5) fail('trivial game');
// resign: Black resigns -> Red wins (result 1); rejected after over
{
  const hr = cs_new(55);
  if (cs_resign(hr, 1) !== 1) fail('resign rejected in live game');
  const st = cs_state(hr, 0);
  if (st.gamePhase !== 'over' || st.result !== 1) fail(`resign -> expected over/1, got ${st.gamePhase}/${st.result}`);
  if (cs_state_spec(hr).result !== 1) fail('spectator misses resign result');
  if (cs_resign(hr, 0) !== 0) fail('resign after over not rejected');
  cs_free(hr);
}

console.log(failures ? `${failures} FAILURES` : 'WORKER-ARTIFACT E2E PASS');
process.exit(failures ? 1 : 0);
