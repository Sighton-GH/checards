// Search bot entry point: wires the TypeScript turn planner (smartEngine.ts)
// to the WASM engine through its AI-seat API (cg_ai_state / cg_ai_act /
// cg_ai_setup). Bundled by web/build.sh into web/dist/bot.js, which sets
// window.ChecardsBot.
//
// The bot only ever reads the AI seat's own view: its own cards, revealed
// cards, and the public move log (opponent card names in that log are hidden
// by the engine).

import { chooseGrandmasterAction, globalBeliefTracker, SmartEngineState } from './smartEngine';

interface EngineModule {
  _cg_ai_state(): number;
  _cg_ai_act(idx: number): number;
  _cg_log(): number;
  UTF8ToString(ptr: number): string;
  ccall(name: string, ret: string, argTypes: string[], args: unknown[]): unknown;
}

// Opening formations. Rows: b = back, s = second, f = front (relative to the
// AI's own side). Cards: A1/A2 Aces, K1/K2 Kings, Q Queen, J Joker,
// X the seventh starter (a Jack in the "decoy" formations, else the 2nd Queen).
type Slot = [card: string, x: number, row: 'b' | 's' | 'f'];
const FORMATIONS: Slot[][] = [
  [['A1', 1, 'b'], ['A2', 4, 'b'], ['X', 5, 'b'], ['K1', 2, 's'], ['Q', 2, 'f'], ['K2', 4, 's'], ['J', 3, 's']],
  [['X', 1, 'b'], ['A2', 5, 'b'], ['A1', 2, 's'], ['K1', 1, 's'], ['K2', 4, 's'], ['Q', 3, 's'], ['J', 4, 'f']],
  [['X', 1, 'b'], ['A1', 2, 'b'], ['A2', 5, 'b'], ['K1', 2, 's'], ['K2', 4, 's'], ['Q', 5, 's'], ['J', 3, 's']],
  [['A1', 1, 'b'], ['A2', 5, 'b'], ['X', 0, 'b'], ['K1', 2, 's'], ['Q', 3, 's'], ['K2', 5, 's'], ['J', 4, 's']],
  [['A1', 1, 'b'], ['X', 4, 'b'], ['A2', 5, 's'], ['K1', 1, 's'], ['J', 2, 's'], ['K2', 4, 's'], ['Q', 3, 'f']],
  [['A1', 1, 'b'], ['A2', 4, 'b'], ['X', 6, 'b'], ['K1', 1, 's'], ['J', 2, 's'], ['K2', 4, 's'], ['Q', 3, 's']],
  [['A1', 1, 'b'], ['A2', 5, 'b'], ['X', 6, 'b'], ['J', 1, 's'], ['K1', 2, 's'], ['K2', 4, 's'], ['Q', 4, 'f']],
  [['X', 1, 'b'], ['A1', 2, 'b'], ['A2', 5, 'b'], ['K1', 2, 's'], ['Q', 3, 's'], ['K2', 4, 's'], ['J', 4, 'f']],
  [['X', 1, 'b'], ['A1', 3, 'b'], ['A2', 5, 'b'], ['K1', 2, 's'], ['Q', 2, 'f'], ['K2', 4, 's'], ['J', 4, 'f']],
  [['A1', 3, 'b'], ['A2', 5, 'b'], ['X', 0, 'b'], ['K1', 1, 's'], ['J', 2, 's'], ['K2', 4, 's'], ['Q', 5, 's']],
  [['X', 1, 'b'], ['A1', 2, 's'], ['A2', 5, 'b'], ['K1', 2, 'f'], ['Q', 3, 's'], ['J', 4, 's'], ['K2', 5, 's']],
  [['A1', 1, 'b'], ['A2', 4, 'b'], ['X', 5, 'b'], ['J', 1, 's'], ['K1', 2, 's'], ['Q', 3, 's'], ['K2', 4, 's']],
];
const JACK_DECOY = new Set([2, 4, 7, 9, 11]);

// Returns a cg_ai_setup spec ("rank,suit,x,y;...") for `faction` (0 Red, 1 Black).
export function setupSpec(faction: number, rand: () => number = Math.random): string {
  const variant = Math.floor(rand() * FORMATIONS.length);
  const mirror = rand() < 0.5;
  const swapSuits = rand() < 0.5;
  // Red suits: Diamonds 1, Hearts 2. Black suits: Clubs 0, Spades 3.
  const [sa, sb] = faction === 0 ? [1, 2] : [0, 3];
  const s1 = swapSuits ? sb : sa;
  const s2 = swapSuits ? sa : sb;
  const cards: Record<string, [number, number]> = {
    A1: [1, s1], A2: [1, s2], J: [0, 4], K1: [13, s1], K2: [13, s2], Q: [12, s1],
    X: JACK_DECOY.has(variant) ? [11, s2] : [12, s2],
  };
  const rowY = { b: faction === 0 ? 0 : 6, s: faction === 0 ? 1 : 5, f: faction === 0 ? 2 : 4 };
  return FORMATIONS[variant]
    .map(([card, x, row]) => {
      const [rank, suit] = cards[card];
      return `${rank},${suit},${mirror ? 6 - x : x},${rowY[row]}`;
    })
    .join(';');
}

// The public move log from the AI seat's perspective: setup squares (not card
// identities), moves, and combat results. Also collects each side's dead cards.
function publicLog(M: EngineModule, aiFaction: number) {
  const dead: [string[], string[]] = [[], []];
  const log: NonNullable<SmartEngineState['publicLog']> = [];
  let raw: any[] = [];
  try {
    raw = JSON.parse(M.UTF8ToString(M._cg_log()));
  } catch {
    return { log, dead };
  }
  for (const ev of raw) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.ev === 'setup_done' && Array.isArray(ev.board)) {
      const squares = ev.board
        .filter((e: any) => e && e.c && typeof e.x === 'number' && typeof e.y === 'number')
        .map((e: any) => ({ x: e.x, y: e.y, owner: e.c.owner & 1 }));
      log.push({ ev: 'setup_done', squares });
    } else if (ev.ev === 'act' && ev.a) {
      const combat = Array.isArray(ev.combat) ? ev.combat : [];
      for (const c of combat) {
        if (c.attackerDied && Array.isArray(c.att)) dead[c.attacker].push(...c.att);
        if (c.defenderDied && Array.isArray(c.def)) dead[1 - c.attacker].push(...c.def);
      }
      log.push({
        ev: 'act',
        mover: ev.mover,
        spawn: Boolean(ev.a.spawn),
        from: Array.isArray(ev.a.from) ? [ev.a.from[0], ev.a.from[1]] : undefined,
        to: Array.isArray(ev.a.to) ? [ev.a.to[0], ev.a.to[1]] : [0, 0],
        card: ev.mover === aiFaction ? ev.a.card || '' : '',
        combat,
      });
    } else if (ev.ev === 'pass') {
      const combat = Array.isArray(ev.combat) ? ev.combat : [];
      for (const c of combat) {
        if (c.attackerDied && Array.isArray(c.att)) dead[c.attacker].push(...c.att);
        if (c.defenderDied && Array.isArray(c.def)) dead[1 - c.attacker].push(...c.def);
      }
      log.push({ ev: 'pass', mover: ev.mover, combat });
    }
  }
  return { log, dead };
}

// Call right after cg_new: resets the planner and places the bot's opening
// formation. Returns false if the engine rejected the setup (the engine then
// keeps its own neural-net setup).
export function newGame(M: EngineModule, aiFaction: number): boolean {
  globalBeliefTracker.reset();
  return M.ccall('cg_ai_setup', 'number', ['string'], [setupSpec(aiFaction)]) === 1;
}

// Plays one AI action. Returns false when the bot has no decision, so the
// caller can fall back to the engine's own cg_ai_step.
export function step(M: EngineModule): boolean {
  const state = JSON.parse(M.UTF8ToString(M._cg_ai_state())) as SmartEngineState;
  if (state.phase !== 'play' || state.mover !== state.human) return false;
  if (!state.legal || state.legal.length === 0) return M._cg_ai_act(0) === 1;
  const { log, dead } = publicLog(M, state.mover);
  state.publicLog = log;
  state.dead = dead;
  const decision = chooseGrandmasterAction(state);
  if (!decision || decision.actionIndex < 0 || decision.actionIndex >= state.legal.length) return false;
  return M._cg_ai_act(decision.actionIndex) === 1;
}
