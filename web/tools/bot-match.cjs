// Head-to-head harness: the search bot (web/dist/bot.js) plays the human seat
// through a shim, the engine's own net plays the AI seat. Alternates colours.
// Run from the repo root after web/build.sh:
//   node web/tools/bot-match.cjs [games=10] [sims=250] [seed=1000] [model=/models/champion-it32.bin]
const path = require('path');
const vm = require('vm');
const fs = require('fs');
const [games = 10, sims = 250, seed0 = 1000] = process.argv.slice(2, 5).map(Number);
const model = process.argv[5] || '/models/champion-it32.bin';
const CE = require(path.join(__dirname, '..', 'dist', 'engine.js'));
// bot.js is an IIFE that defines ChecardsBot; evaluate it in this context.
const ctx = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'dist', 'bot.js'), 'utf8') + ';this.ChecardsBot=ChecardsBot', ctx);
const bot = ctx.ChecardsBot;
const NM = { 0: 'Jkr', 1: 'A', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K' }, SC = 'CDHS*';
(async () => {
  const M = await CE();
  const st = () => JSON.parse(M.UTF8ToString(M._cg_state()));
  // The bot only knows the AI-seat API; point it at the human seat instead.
  const shim = { _cg_ai_state: () => M._cg_state(), _cg_ai_act: i => M._cg_human_act(i), _cg_log: () => M._cg_log(),
    UTF8ToString: p => M.UTF8ToString(p), ccall: () => 0 };
  let w = 0, l = 0, d = 0, fallbacks = 0, ms = 0, moves = 0;
  for (let g = 0; g < games; g++) {
    const seed = seed0 + g, humanRed = g % 2 == 0 ? 1 : 0, hf = humanRed ? 0 : 1;
    M.ccall('cg_new', 'number', ['string', 'number', 'number', 'number'], [model, humanRed, sims, seed]);
    bot.newGame(shim, hf); // resets the planner; the shim's ccall ignores cg_ai_setup
    const spec = bot.setupSpec(hf).split(';').map(e => { const [r, s, x, y] = e.split(',').map(Number); return { name: r == 0 ? 'Jkr*' : NM[r] + SC[s], x, y }; });
    for (;;) {
      const s = st();
      if (s.phase == 'setup_place') { const t = spec.find(e => e.name == s.pending); if (!t || !M._cg_place(t.x, t.y)) throw Error('place ' + s.pending); continue; }
      if (s.phase == 'setup_draft') { const i = s.pool.findIndex(p => spec.some(e => e.name == p)); if (i < 0) throw Error('draft ' + s.pool); M._cg_draft(i); continue; }
      if (s.phase == 'over') { const r = s.result; if (r == (hf == 0 ? 1 : 2)) w++; else if (r == (hf == 0 ? 2 : 1)) l++; else d++; break; }
      if (s.mover == s.human) { const t0 = Date.now(); const ok = bot.step(shim); ms += Date.now() - t0; moves++; if (!ok) { fallbacks++; M._cg_human_act(0); } }
      else M._cg_ai_step();
    }
    console.log(`game ${g} seed ${seed} bot=${hf ? 'black' : 'red'}: W${w} L${l} D${d}`);
  }
  console.log(JSON.stringify({ wins: w, losses: l, draws: d, fallbacks, avgMsPerBotMove: Math.round(ms / Math.max(1, moves)) }));
})().catch(e => { console.error(e); process.exit(1); });
