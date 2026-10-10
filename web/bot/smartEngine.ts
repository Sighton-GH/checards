// smartEngine.ts — Superhuman Grandmaster Checards Engine
// Full 3-Move Macro+Micro Turn Combinatorial Search, Exact 2-Turn Minimax Threat Analyzer,
// Persistent Bayesian Setup/Phalanx/Joker Belief Tracker, and Bitboard Tactical Solver.

import {
  advanceStockfishSearchGeneration,
  clearTranspositionTable,
  runStockfishPVSOnPostTurnBoard,
  lastStockfishTelemetry,
} from './stockfishEngine';
import {
  evaluateOpeningBookRules,
  evaluateEndgameBookRules,
  lastBookTelemetry,
} from './openingAndEndgameBooks';

export { lastBookTelemetry };

export const engineBookConfig = {
  enableOpeningBook: true,
  enableEndgameBook: true,
};

export interface CardState {
  name?: string; // e.g. "AH", "Jkr*", "10S", or undefined/empty for face-down
  owner: number; // 0 = Red, 1 = Black
  revealed?: boolean | number;
  rank?: number; // 0 = Joker, 1 = Ace, 9..13
  suit?: number;
}

export interface LegalAction {
  from?: [number, number] | { x: number; y: number };
  to: [number, number] | { x: number; y: number };
  ord?: number;
  cardIdx?: number;
  cardRank?: number;
  spawn?: boolean | number;
  name?: string;
  card?: string;
}

export interface CombatEventRecord {
  at: [number, number];
  attacker: number;
  attackerDied: number;
  defenderDied: number;
  att: string[];
  def: string[];
}

export interface PublicLogEvent {
  ev: 'setup_done' | 'act' | 'pass';
  squares?: Array<{ x: number; y: number; owner: number }>;
  mover?: number;
  spawn?: boolean;
  from?: [number, number];
  to?: [number, number];
  card?: string;
  combat?: CombatEventRecord[];
}

export interface SmartEngineState {
  phase: string;
  human: number;
  mover: number;
  movesRemaining: number;
  turn: number;
  draw: [number, number];
  drawPileRanks?: [number[], number[]];
  board: CardState[][]; // 49 tiles, indexed x * 7 + y
  legal: LegalAction[];
  result: number;
  inactivity?: number;
  events?: CombatEventRecord[];
  dead?: [string[], string[]];
  publicLog?: PublicLogEvent[];
}

export interface CombatEvaluation {
  occurred: boolean;
  attackerDies: boolean;
  defenderDies: boolean;
  attackerLostAces: number;
  defenderLostAces: number;
}

// ---------------------------------------------------------------------------
// 1. Bitboard Representation (64-Bit Words for 49 Squares)
// ---------------------------------------------------------------------------

export class ChecardsBitboard {
  public occupied: [bigint, bigint] = [0n, 0n];
  public aces: [bigint, bigint] = [0n, 0n];
  public revealed: [bigint, bigint] = [0n, 0n];
  public heights: [[bigint, bigint, bigint, bigint], [bigint, bigint, bigint, bigint]] = [
    [0n, 0n, 0n, 0n],
    [0n, 0n, 0n, 0n],
  ];

  public static tileToBit(x: number, y: number): bigint {
    return 1n << BigInt(x * 7 + y);
  }

  public static fromState(state: SmartEngineState): ChecardsBitboard {
    const bb = new ChecardsBitboard();
    for (let x = 0; x < 7; x++) {
      for (let y = 0; y < 7; y++) {
        const idx = x * 7 + y;
        const tile = state.board[idx] || [];
        const bit = 1n << BigInt(idx);

        for (let p = 0; p < 2; p++) {
          const cardsOfPlayer = tile.filter((c) => c.owner === p);
          if (cardsOfPlayer.length > 0) {
            bb.occupied[p] |= bit;
            const h = Math.min(3, cardsOfPlayer.length - 1);
            bb.heights[p][h] |= bit;
          }
          for (const c of cardsOfPlayer) {
            if (c.name?.startsWith('A') || c.rank === 1) bb.aces[p] |= bit;
            if (c.revealed) bb.revealed[p] |= bit;
          }
        }
      }
    }
    return bb;
  }

  public static shiftNorth(bb: bigint): bigint {
    return (bb << 1n) & 0x1fbdf7de7bc000n;
  }

  public static shiftSouth(bb: bigint): bigint {
    return (bb >> 1n) & 0x7defbeff000000n;
  }
}

// ---------------------------------------------------------------------------
// 2. Card Parsing & Exact Checards Combat Resolution
// ---------------------------------------------------------------------------

export function parseCardRank(name?: string, explicitRank?: number): number {
  if (typeof explicitRank === 'number') return explicitRank;
  if (!name) return -1;
  if (name.startsWith('Jkr')) return 0;
  if (name.startsWith('A')) return 1;
  if (name.startsWith('K')) return 13;
  if (name.startsWith('Q')) return 12;
  if (name.startsWith('J')) return 11;
  if (name.startsWith('10')) return 10;
  if (name.startsWith('9')) return 9;
  return -1;
}

export function rankPoints(rank: number): number {
  if (rank === 0 || rank === 1) return 1;
  if (rank >= 9 && rank <= 13) return rank;
  return 11; // Default expected value for unknown non-Ace card
}

export function resolveCombat(
  attackerCards: CardState[],
  defenderCards: CardState[]
): CombatEvaluation {
  if (attackerCards.length === 0 || defenderCards.length === 0) {
    return {
      occurred: false,
      attackerDies: false,
      defenderDies: false,
      attackerLostAces: 0,
      defenderLostAces: 0,
    };
  }

  let attAces = 0;
  let defAces = 0;
  let defJokers = 0;
  let attTotal = 0;
  let defTotal = 0;

  for (let i = 0; i < attackerCards.length; i++) {
    const r = parseCardRank(attackerCards[i].name, attackerCards[i].rank);
    if (r === 1) attAces++;
    attTotal += rankPoints(r);
  }

  for (let i = 0; i < defenderCards.length; i++) {
    const r = parseCardRank(defenderCards[i].name, defenderCards[i].rank);
    if (r === 1) defAces++;
    else if (r === 0) defJokers++;
    defTotal += rankPoints(r);
  }

  // Rule 1: Two attacking Aces overwhelm defending Joker -> defender dies, attacker lives
  if (attAces >= 2 && defJokers >= 1) {
    return {
      occurred: true,
      attackerDies: false,
      defenderDies: true,
      attackerLostAces: 0,
      defenderLostAces: defAces,
    };
  }

  // Rule 2: One attacking Ace trades with defending Joker -> both die
  if (attAces === 1 && defJokers >= 1) {
    return {
      occurred: true,
      attackerDies: true,
      defenderDies: true,
      attackerLostAces: 1,
      defenderLostAces: defAces,
    };
  }

  // Rule 3: Attacking Ace against any non-Joker -> automatic attacker victory
  if (attAces >= 1 && defJokers === 0) {
    return {
      occurred: true,
      attackerDies: false,
      defenderDies: true,
      attackerLostAces: 0,
      defenderLostAces: defAces,
    };
  }

  // Rule 4: Defending Joker beats any attack without an Ace -> attacker dies, defender lives
  if (attAces === 0 && defJokers >= 1) {
    return {
      occurred: true,
      attackerDies: true,
      defenderDies: false,
      attackerLostAces: 0,
      defenderLostAces: 0,
    };
  }

  // Rule 5: Total point sum comparison (ties destroy both stacks)
  if (attTotal > defTotal) {
    return {
      occurred: true,
      attackerDies: false,
      defenderDies: true,
      attackerLostAces: 0,
      defenderLostAces: defAces,
    };
  } else if (defTotal > attTotal) {
    return {
      occurred: true,
      attackerDies: true,
      defenderDies: false,
      attackerLostAces: attAces,
      defenderLostAces: 0,
    };
  } else {
    return {
      occurred: true,
      attackerDies: true,
      defenderDies: true,
      attackerLostAces: attAces,
      defenderLostAces: defAces,
    };
  }
}

// ---------------------------------------------------------------------------
// 3. Persistent Bayesian Opponent Belief, Phalanx & Joker Trap Tracker
// ---------------------------------------------------------------------------

export interface FactionBelief {
  unseenAces: number;
  unseenJoker: boolean;
  unseenHighCards: { [rank: string]: number };
  maxUnseenCourt: number;
  secondMaxUnseenCourt: number;
  expectedUnseenCourt: number;
  expectedSetupCourt?: number;
  expectedReserveCourt?: number;
  drawPileRemaining: number;
  setupRemainingHidden: number;
  jokerDrawPileProb: number;
  suspectedJokerTiles: [number, number][];
  suspectedAceTiles: [number, number][];
  discreditedAceTiles: [number, number][];
  tileAceProb: Float32Array; // 49 squares: probability tile holds an unrevealed Ace
  tileJokerProb: Float32Array; // 49 squares: probability tile holds an unrevealed Joker
}

interface PlannedMicroMove {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  rank: number;
}

class PersistentBeliefTracker {
  private lastTurn: number = -1;
  private deadCards: [string[], string[]] = [[], []];
  private seenCombatSignatures = new Set<string>();
  private canBeAceCount: [Int32Array, Int32Array] = [new Int32Array(49), new Int32Array(49)];
  private setupMass: [Float32Array, Float32Array] = [new Float32Array(49), new Float32Array(49)];
  private stationaryBackRowTurns: [Int32Array, Int32Array] = [new Int32Array(49), new Int32Array(49)];
  private jokerSuspectScore: [Float32Array, Float32Array] = [new Float32Array(49), new Float32Array(49)];
  private aceBodyguardScore: [Float32Array, Float32Array] = [new Float32Array(49), new Float32Array(49)];
  private aceVanguardDiscount: [Float32Array, Float32Array] = [new Float32Array(49), new Float32Array(49)];
  private missedKillAceDiscount: [Float32Array, Float32Array] = [new Float32Array(49), new Float32Array(49)];
  private prevCounts: [Int32Array, Int32Array] = [new Int32Array(49), new Int32Array(49)];
  private prevDraw: [number, number] = [6, 6];
  private processedLogLen: number = 0;
  public recentBoardHashes: number[] = [];
  public startOfTurnMyHash: number = 0;
  public plannedTurnQueue: PlannedMicroMove[] = [];
  public plannedTurnNumber: number = -1;
  public plannedTurnFaction: number = -1;
  public prevStepTurn: number = -1;
  public prevStepFaction: number = -1;
  public prevStepFromIdx: number = -1;
  public prevStepToIdx: number = -1;

  public reset() {
    this.lastTurn = -1;
    this.deadCards = [[], []];
    this.seenCombatSignatures.clear();
    this.canBeAceCount = [new Int32Array(49), new Int32Array(49)];
    this.setupMass = [new Float32Array(49), new Float32Array(49)];
    this.stationaryBackRowTurns = [new Int32Array(49), new Int32Array(49)];
    this.jokerSuspectScore = [new Float32Array(49), new Float32Array(49)];
    this.aceBodyguardScore = [new Float32Array(49), new Float32Array(49)];
    this.aceVanguardDiscount = [new Float32Array(49), new Float32Array(49)];
    this.missedKillAceDiscount = [new Float32Array(49), new Float32Array(49)];
    this.prevCounts = [new Int32Array(49), new Int32Array(49)];
    this.prevDraw = [6, 6];
    this.processedLogLen = 0;
    this.recentBoardHashes = [];
    clearTranspositionTable();
    this.startOfTurnMyHash = 0;
    this.plannedTurnQueue = [];
    this.plannedTurnNumber = -1;
    this.plannedTurnFaction = -1;
    this.prevStepTurn = -1;
    this.prevStepFaction = -1;
    this.prevStepFromIdx = -1;
    this.prevStepToIdx = -1;
  }

  private initSetupBeliefs(state: SmartEngineState) {
    for (let p = 0; p < 2; p++) {
      for (let i = 0; i < 49; i++) {
        const x = (i / 7) | 0;
        const y = i % 7;
        const depth = p === 0 ? y : 6 - y;
        const cnt = (state.board[i] || []).filter((c) => c.owner === p).length;
        this.prevCounts[p][i] = cnt;
        if (cnt > 0) {
          // All 7 initial setup cards on depth <= 2 can potentially be an Ace
          this.canBeAceCount[p][i] = depth <= 2 ? cnt : 0;
          this.setupMass[p][i] = depth <= 2 ? cnt : 0;
          if (depth === 0) {
            this.stationaryBackRowTurns[p][i] = 1;
          }
          // Front setup row (depth === 2), especially center columns (x = 2, 3, 4 like (3,4)),
          // is the classic human Joker shield square!
          if (depth === 2) {
            this.jokerSuspectScore[p][i] = x === 3 ? 6.0 : x >= 2 && x <= 4 ? 3.5 : 2.0;
          } else if (depth === 1 && x === 3) {
            this.jokerSuspectScore[p][i] = 3.0;
          }
        }
      }
    }
    this.prevDraw = [state.draw[0], state.draw[1]];
  }

  private applyPublicLogEvents(log: PublicLogEvent[], state: SmartEngineState) {
    // Deterministically replay the full publicLog using an isolated `logCounts` board array
    // so UI `evaluatePosition` calls (which lack `publicLog`) can NEVER corrupt card lineage!
    this.canBeAceCount = [new Int32Array(49), new Int32Array(49)];
    this.setupMass = [new Float32Array(49), new Float32Array(49)];
    this.stationaryBackRowTurns = [new Int32Array(49), new Int32Array(49)];
    this.jokerSuspectScore = [new Float32Array(49), new Float32Array(49)];
    this.aceBodyguardScore = [new Float32Array(49), new Float32Array(49)];
    this.aceVanguardDiscount = [new Float32Array(49), new Float32Array(49)];
    this.missedKillAceDiscount = [new Float32Array(49), new Float32Array(49)];
    const logCounts = [new Int32Array(49), new Int32Array(49)];
    const maxStackReached = [new Int32Array(49), new Int32Array(49)];
    interface SplitSiblingLink {
      peerSq: number;
      transferredMass: number;
      hadJokerSuspect: boolean;
    }
    const splitSiblings: [SplitSiblingLink[][], SplitSiblingLink[][]] = [
      Array.from({ length: 49 }, () => []),
      Array.from({ length: 49 }, () => []),
    ];
    let turnsElapsed = 0;
    let lastMover = -1;
    const attackedSquaresLastTurn: [Set<number>, Set<number>] = [new Set(), new Set()];

    for (let idxLog = 0; idxLog < log.length; idxLog++) {
      const ev = log[idxLog];
      if (ev.ev === 'setup_done' && Array.isArray(ev.squares)) {
        for (const s of ev.squares) {
          const idx = s.x * 7 + s.y;
          const p = s.owner & 1;
          const depth = p === 0 ? s.y : 6 - s.y;
          logCounts[p][idx]++;
          if (logCounts[p][idx] > maxStackReached[p][idx]) {
            maxStackReached[p][idx] = logCounts[p][idx];
          }
          this.canBeAceCount[p][idx]++;
          this.setupMass[p][idx] += 1.0;
          if (depth === 0) this.stationaryBackRowTurns[p][idx] = 1;
          if (depth === 2) {
            this.jokerSuspectScore[p][idx] = s.x === 3 ? 6.0 : s.x >= 2 && s.x <= 4 ? 3.5 : 2.0;
          } else if (depth === 1 && s.x === 3) {
            this.jokerSuspectScore[p][idx] = 3.0;
          }
        }
      } else if (ev.ev === 'act' && typeof ev.mover === 'number') {
        const p = ev.mover & 1;
        if (lastMover !== -1 && lastMover !== p) {
          // A full turn of `lastMover` just completed: increment `stationaryBackRowTurns` for any back-row setup card of `lastMover` that stayed on depth === 0!
          const backY = lastMover === 0 ? 0 : 6;
          for (let bx = 0; bx < 7; bx++) {
            const bIdx = bx * 7 + backY;
            if (logCounts[lastMover][bIdx] > 0 && this.stationaryBackRowTurns[lastMover][bIdx] > 0) {
              this.stationaryBackRowTurns[lastMover][bIdx] = Math.min(
                12,
                this.stationaryBackRowTurns[lastMover][bIdx] + 1
              );
            }
          }
          attackedSquaresLastTurn[p].clear();
        }
        lastMover = p;
        if (ev.spawn && ev.to) {
          const toIdx = ev.to[0] * 7 + ev.to[1];
          // Spawned cards from the draw pile can NEVER be Aces (Aces are placed first in setup!)
          logCounts[p][toIdx]++;
          turnsElapsed++;
        } else if (ev.from && ev.to) {
          const fromIdx = ev.from[0] * 7 + ev.from[1];
          const toIdx = ev.to[0] * 7 + ev.to[1];
          const fromDepth = p === 0 ? ev.from[1] : 6 - ev.from[1];
          const toDepth = p === 0 ? ev.to[1] : 6 - ev.to[1];
          if (logCounts[p][fromIdx] <= 0 && fromDepth <= 2) {
            logCounts[p][fromIdx] = 1;
            this.canBeAceCount[p][fromIdx] = 1;
            this.setupMass[p][fromIdx] = 1.0;
          }
          const fromCnt = Math.max(1, logCounts[p][fromIdx]);
          const toCntBefore = logCounts[p][toIdx];
          const fromMass = this.setupMass[p][fromIdx];

          let movedMass = fromMass / fromCnt;
          let isBackRowAnchorPeel = false;
          if (fromCnt >= 2 && fromMass > 0) {
            if (fromDepth === 0 && toDepth > 0) {
              // Phase 2 Behavioral Tell #4A (Peel-Off Anchor Tell):
              // When a player peels 1 card forward from a 2-card back-row stack while leaving 1 card anchored on depth 0,
              // the card left anchored on the back row is almost always the Ace and the advancing card is the guard/decoy!
              movedMass = Math.min(fromMass, fromMass * 0.28);
              this.aceBodyguardScore[p][fromIdx] = Math.min(6.0, this.aceBodyguardScore[p][fromIdx] + 1.6);
              isBackRowAnchorPeel = true;
            } else if (toDepth === 0 && fromDepth >= 1) {
              // Phase 2 Behavioral Tell #4C (Retreating Ace Peel Tell):
              // When a player peels 1 card BACKWARDS from a 2+ card stack at depth >= 1 onto the home row (`toDepth === 0`,
              // e.g. retreating AC from [KS, AC] at (2,5)->(2,6) or AS from [KC, AS] at (4,5)->(3,6)),
              // the retreating card is overwhelmingly the ACE seeking back-row safety, while the card left behind
              // at `fromIdx` ((2,5) or (4,5)) is the King/Queen court bodyguard!
              movedMass = Math.min(fromMass, Math.max(0.75, fromMass * 0.75));
              this.stationaryBackRowTurns[p][toIdx] = Math.max(
                this.stationaryBackRowTurns[p][toIdx],
                this.stationaryBackRowTurns[p][fromIdx] + 2
              );
              this.stationaryBackRowTurns[p][fromIdx] = 0;
              this.aceBodyguardScore[p][toIdx] = Math.max(
                this.aceBodyguardScore[p][toIdx],
                this.aceBodyguardScore[p][fromIdx] + 1.5
              );
              this.aceBodyguardScore[p][fromIdx] *= 0.15;
            } else if (toDepth === 0 && toCntBefore === 0) {
              // Phase 2 Behavioral Tell #4B (Lateral Back-Row Evading Ace Tell):
              // Peeling 1 card laterally onto an empty back-row square carries the evading Ace mass!
              movedMass = Math.min(fromMass, fromMass * 0.72);
              this.stationaryBackRowTurns[p][toIdx] = Math.max(
                this.stationaryBackRowTurns[p][toIdx],
                this.stationaryBackRowTurns[p][fromIdx]
              );
              this.stationaryBackRowTurns[p][fromIdx] = Math.round(
                this.stationaryBackRowTurns[p][fromIdx] * 0.25
              );
              this.aceBodyguardScore[p][toIdx] = Math.max(
                this.aceBodyguardScore[p][toIdx],
                this.aceBodyguardScore[p][fromIdx] * 0.85
              );
              this.aceBodyguardScore[p][fromIdx] *= 0.25;
            }
          }

          this.setupMass[p][fromIdx] = Math.max(0, fromMass - movedMass);
          this.setupMass[p][toIdx] += movedMass;

          // Phase 1 Split-Sibling Lineage Graph Update:
          if (fromCnt === 1) {
            const movedLinks = splitSiblings[p][fromIdx];
            if (movedLinks.length > 0) {
              for (let l = 0; l < movedLinks.length; l++) {
                const peerSq = movedLinks[l].peerSq;
                const peerLinks = splitSiblings[p][peerSq];
                for (let pl = 0; pl < peerLinks.length; pl++) {
                  if (peerLinks[pl].peerSq === fromIdx) {
                    peerLinks[pl].peerSq = toIdx;
                  }
                }
                if (peerSq !== toIdx) {
                  splitSiblings[p][toIdx].push(movedLinks[l]);
                }
              }
              splitSiblings[p][fromIdx] = [];
            }
          } else if (fromCnt >= 2 && fromIdx !== toIdx) {
            const hadJokerSuspect = this.jokerSuspectScore[p][fromIdx] >= 3.0;
            splitSiblings[p][fromIdx].push({
              peerSq: toIdx,
              transferredMass: movedMass,
              hadJokerSuspect,
            });
            splitSiblings[p][toIdx].push({
              peerSq: fromIdx,
              transferredMass: Math.max(0, fromMass - movedMass),
              hadJokerSuspect,
            });
          }

          // Phase 2 Behavioral Tell #1 (Bodyguard Tell):
          // When a player routes a card onto an unrevealed back-row (`toDepth === 0`) setup piece to form a 2+ card stack,
          // or retreats a back-row setup piece (`fromDepth === 0 && movedMass >= 0.45`) onto `toDepth === 1`,
          // human players are very frequently armoring their Ace!
          if (
            toCntBefore >= 1 &&
            this.canBeAceCount[p][toIdx] > 0 &&
            (toDepth === 0 || (toDepth === 1 && fromDepth === 0 && movedMass >= 0.45))
          ) {
            this.aceBodyguardScore[p][toIdx] = Math.min(6.0, this.aceBodyguardScore[p][toIdx] + 2.2);
          }

          // Phase 2 Behavioral Tell #2 (Early Vanguard Probe Discount):
          // A lone card rushing to `toDepth >= 3` onto an empty square in the first 3 turns is rarely a naked Ace!
          if (fromCnt === 1 && toCntBefore === 0 && toDepth >= 3 && idxLog <= 14) {
            this.aceVanguardDiscount[p][toIdx] = 0.52;
          }

          if (this.canBeAceCount[p][fromIdx] > 0) {
            this.canBeAceCount[p][toIdx] = Math.min(
              toCntBefore + 1,
              this.canBeAceCount[p][toIdx] + 1
            );
            if (fromCnt - 1 < this.canBeAceCount[p][fromIdx]) {
              this.canBeAceCount[p][fromIdx] = Math.max(0, fromCnt - 1);
            }
          }
          if (this.jokerSuspectScore[p][fromIdx] > 0) {
            this.jokerSuspectScore[p][toIdx] = Math.max(
              this.jokerSuspectScore[p][toIdx],
              this.jokerSuspectScore[p][fromIdx] * 0.9
            );
          }
          // Preserve back-row stationary history & bodyguard score when a card or stack moves!
          if (fromCnt === 1) {
            this.stationaryBackRowTurns[p][toIdx] =
              toDepth === 0
                ? Math.max(
                    this.stationaryBackRowTurns[p][toIdx],
                    this.stationaryBackRowTurns[p][fromIdx]
                  )
                : Math.max(
                    this.stationaryBackRowTurns[p][toIdx],
                    Math.round(this.stationaryBackRowTurns[p][fromIdx] * 0.75)
                  );
            this.stationaryBackRowTurns[p][fromIdx] = 0;
            this.aceBodyguardScore[p][toIdx] =
              toDepth <= 1
                ? Math.max(
                    this.aceBodyguardScore[p][toIdx],
                    this.aceBodyguardScore[p][fromIdx] * (toDepth === 0 ? 1.0 : 0.6)
                  )
                : 0;
            this.aceBodyguardScore[p][fromIdx] = 0;
          } else if (!isBackRowAnchorPeel && toCntBefore >= 1 && movedMass > 0 && toDepth === 0) {
            this.stationaryBackRowTurns[p][toIdx] = Math.max(
              this.stationaryBackRowTurns[p][toIdx],
              this.stationaryBackRowTurns[p][fromIdx]
            );
            this.aceBodyguardScore[p][toIdx] = Math.max(
              this.aceBodyguardScore[p][toIdx],
              this.aceBodyguardScore[p][fromIdx] * 0.85
            );
          }
          logCounts[p][fromIdx] = Math.max(0, logCounts[p][fromIdx] - 1);
          logCounts[p][toIdx]++;
          if (logCounts[p][toIdx] > maxStackReached[p][toIdx]) {
            maxStackReached[p][toIdx] = logCounts[p][toIdx];
          }
          if (logCounts[p][toIdx] >= 3 && toDepth >= 2) {
            this.jokerSuspectScore[p][toIdx] = Math.max(this.jokerSuspectScore[p][toIdx], 7.0);
            // A 3+ card battering ram marching forward to depth >= 2 is a court/Joker phalanx, rarely a back-row Ace guard!
            this.aceBodyguardScore[p][toIdx] *= 0.35;
          } else if (
            logCounts[p][toIdx] === 2 &&
            toDepth >= 2 &&
            ev.to[0] >= 2 &&
            ev.to[0] <= 4
          ) {
            this.jokerSuspectScore[p][toIdx] = Math.max(this.jokerSuspectScore[p][toIdx], 4.2);
          } else if (logCounts[p][toIdx] === 1 && toDepth >= 4) {
            this.jokerSuspectScore[p][toIdx] = Math.max(this.jokerSuspectScore[p][toIdx], 6.2);
          }
        }

        if (Array.isArray(ev.combat)) {
          for (const c of ev.combat) {
            if (!c.at) continue;
            const atIdx = c.at[0] * 7 + c.at[1];
            const att = c.attacker & 1;
            const def = 1 - att;
            attackedSquaresLastTurn[att].add(atIdx);

            const backpropSideReveal = (side: number, revNames?: string[]) => {
              if (!Array.isArray(revNames) || revNames.length === 0) return;
              const links = splitSiblings[side][atIdx];
              if (!links || links.length === 0) return;
              let revHasAce = false;
              let revHasJoker = false;
              for (let rIdx = 0; rIdx < revNames.length; rIdx++) {
                const rk = parseCardRank(revNames[rIdx]);
                if (rk === 1) revHasAce = true;
                else if (rk === 0) revHasJoker = true;
              }
              for (let l = 0; l < links.length; l++) {
                const link = links[l];
                const peerSq = link.peerSq;
                if (peerSq === atIdx || logCounts[side][peerSq] <= 0) continue;
                if (!revHasAce) {
                  this.setupMass[side][peerSq] = Math.min(
                    logCounts[side][peerSq],
                    this.setupMass[side][peerSq] + Math.max(0.35, link.transferredMass)
                  );
                  this.canBeAceCount[side][peerSq] = Math.min(
                    logCounts[side][peerSq],
                    Math.max(1, this.canBeAceCount[side][peerSq] + 1)
                  );
                  const peerY = peerSq % 7;
                  const peerDepth = side === 0 ? peerY : 6 - peerY;
                  if (peerDepth <= 1) {
                    this.aceBodyguardScore[side][peerSq] = Math.min(
                      6.0,
                      this.aceBodyguardScore[side][peerSq] + 1.65
                    );
                  }
                } else if (logCounts[side][peerSq] === 1) {
                  this.aceBodyguardScore[side][peerSq] *= 0.25;
                }
                if (!revHasJoker && link.hadJokerSuspect) {
                  this.jokerSuspectScore[side][peerSq] = Math.min(
                    12.0,
                    Math.max(8.6, this.jokerSuspectScore[side][peerSq] + 3.8)
                  );
                }
              }
              splitSiblings[side][atIdx] = [];
            };

            backpropSideReveal(att, c.att);
            backpropSideReveal(def, c.def);

            if (c.attackerDied) {
              logCounts[att][atIdx] = 0;
              maxStackReached[att][atIdx] = 0;
              this.canBeAceCount[att][atIdx] = 0;
              this.setupMass[att][atIdx] = 0;
              this.stationaryBackRowTurns[att][atIdx] = 0;
              this.jokerSuspectScore[att][atIdx] = 0;
              this.aceBodyguardScore[att][atIdx] = 0;
              this.aceVanguardDiscount[att][atIdx] = 0;
              splitSiblings[att][atIdx] = [];
            }
            if (c.defenderDied) {
              logCounts[def][atIdx] = 0;
              maxStackReached[def][atIdx] = 0;
              this.canBeAceCount[def][atIdx] = 0;
              this.setupMass[def][atIdx] = 0;
              this.stationaryBackRowTurns[def][atIdx] = 0;
              this.jokerSuspectScore[def][atIdx] = 0;
              this.aceBodyguardScore[def][atIdx] = 0;
              this.aceVanguardDiscount[def][atIdx] = 0;
              splitSiblings[def][atIdx] = [];
            }
          }
        }
      }
    }

    this.processedLogLen = log.length;

    // Reconcile counts and stationary turns with the live board state
    for (let p = 0; p < 2; p++) {
      for (let i = 0; i < 49; i++) {
        const cards = (state.board[i] || []).filter((c) => c.owner === p);
        const cnt = cards.length;
        this.prevCounts[p][i] = cnt;
        if (cnt === 0) {
          this.canBeAceCount[p][i] = 0;
          this.setupMass[p][i] = 0;
          this.stationaryBackRowTurns[p][i] = 0;
          this.jokerSuspectScore[p][i] = 0;
          this.aceBodyguardScore[p][i] = 0;
          this.aceVanguardDiscount[p][i] = 0;
        } else {
          const y = i % 7;
          const depth = p === 0 ? y : 6 - y;
          if (depth === 0 && this.stationaryBackRowTurns[p][i] > 0) {
            this.stationaryBackRowTurns[p][i] = Math.max(
              this.stationaryBackRowTurns[p][i],
              Math.min(12, Math.floor(state.turn / 2) + 1)
            );
          }
          if (cnt >= 3 && depth >= 2) {
            this.jokerSuspectScore[p][i] = Math.max(this.jokerSuspectScore[p][i], 7.0);
          } else if (cnt === 1 && depth >= 3 && maxStackReached[p][i] >= 2) {
            // End-of-Turn Phalanx Remnant Deduction:
            // Square `i` at `depth >= 3` previously held a 2+ card stack and peeled off its court attacker(s),
            // leaving 1 unrevealed remnant card behind at turn end — almost certainly the Joker!
            this.jokerSuspectScore[p][i] = Math.max(this.jokerSuspectScore[p][i], 7.8);
          }
        }
      }
    }

    // Phase 1 Counterfactual "Missed-Kill" Negative Inference (Law-3 Elimination):
    if (typeof state.mover === 'number' && state.turn >= 2) {
      const myF = state.mover & 1;
      const opP = 1 - myF;
      const highValueLaw3Targets: number[] = [];
      for (let sq = 0; sq < 49; sq++) {
        const myCards = (state.board[sq] || []).filter((c) => c.owner === myF);
        if (myCards.length === 0) continue;
        const hasMyJoker = myCards.some((c) => parseCardRank(c.name, c.rank) === 0);
        if (hasMyJoker) continue;
        const hasRevMyAce = myCards.some((c) => Boolean(c.revealed) && parseCardRank(c.name, c.rank) === 1);
        let myKnownPts = 0;
        for (let k = 0; k < myCards.length; k++) {
          myKnownPts += rankPoints(parseCardRank(myCards[k].name, myCards[k].rank));
        }
        if (hasRevMyAce || (myCards.length >= 2 && myKnownPts >= 22)) {
          highValueLaw3Targets.push(sq);
        }
      }
      if (highValueLaw3Targets.length > 0 && lastMover === opP) {
        for (let uSq = 0; uSq < 49; uSq++) {
          const opCards = (state.board[uSq] || []).filter((c) => c.owner === opP);
          if (opCards.length !== 1 || opCards[0].revealed) continue;
          const uy = uSq % 7;
          const opDepth = opP === 0 ? uy : 6 - uy;
          if (opDepth < 2) continue;
          const ux = (uSq / 7) | 0;
          for (let t = 0; t < highValueLaw3Targets.length; t++) {
            const tSq = highValueLaw3Targets[t];
            if (attackedSquaresLastTurn[opP].has(tSq)) continue;
            const tx = (tSq / 7) | 0;
            const ty = tSq % 7;
            const d = Math.max(Math.abs(ux - tx), Math.abs(uy - ty));
            if (d === 1) {
              this.missedKillAceDiscount[opP][uSq] = 0.25;
              break;
            }
          }
        }
      }
    }

    this.prevDraw = [state.draw[0], state.draw[1]];
    this.lastTurn = state.turn;
  }

  public observeState(state: SmartEngineState) {
    if (!state || !state.board || state.board.length < 49) return;

    // Detect a new game reliably even if restarted during Turn 1
    if (
      this.lastTurn === -1 ||
      state.turn < this.lastTurn ||
      (state.turn === 1 && this.lastTurn > 1) ||
      (state.publicLog && Array.isArray(state.publicLog) && state.publicLog.length < this.processedLogLen)
    ) {
      this.reset();
      this.lastTurn = state.turn;
      this.initSetupBeliefs(state);
      if (state.publicLog && Array.isArray(state.publicLog) && state.publicLog.length > 0) {
        this.applyPublicLogEvents(state.publicLog, state);
      }
      return;
    }

    // Sync dead cards directly if state.dead is provided from _cg_log()
    if (state.dead && Array.isArray(state.dead) && state.dead.length === 2) {
      this.deadCards = [
        Array.isArray(state.dead[0]) ? [...state.dead[0]] : [],
        Array.isArray(state.dead[1]) ? [...state.dead[1]] : [],
      ];
    } else if (state.events && Array.isArray(state.events)) {
      for (const ev of state.events) {
        const sig = `${state.turn}-${ev.at?.[0]},${ev.at?.[1]}-${ev.attacker}-${(ev.att || []).join(',')}-${(ev.def || []).join(',')}`;
        if (!this.seenCombatSignatures.has(sig)) {
          this.seenCombatSignatures.add(sig);
          const attOwner = ev.attacker;
          const defOwner = 1 - attOwner;
          if (ev.attackerDied && Array.isArray(ev.att)) {
            this.deadCards[attOwner].push(...ev.att);
          }
          if (ev.defenderDied && Array.isArray(ev.def)) {
            this.deadCards[defOwner].push(...ev.def);
          }
        }
      }
    }

    // Prefer exact step-by-step publicLog lineage tracking when available!
    if (state.publicLog && Array.isArray(state.publicLog) && state.publicLog.length > 0) {
      this.applyPublicLogEvents(state.publicLog, state);
      return;
    }

    // If we already have exact publicLog tracking active for this game, never let a UI snapshot
    // (which lacks state.publicLog and masks AI cards as "??") overwrite our exact lineage tables!
    if (this.processedLogLen > 0) {
      return;
    }

    for (let p = 0; p < 2; p++) {
      const curCounts = new Int32Array(49);
      for (let i = 0; i < 49; i++) {
        curCounts[i] = (state.board[i] || []).filter((c) => c.owner === p).length;
      }

      const drawDropped = state.draw[p] < this.prevDraw[p];
      if (drawDropped) {
        // A spawn turn: spawned cards cannot be Aces (Aces are placed first in setup!)
        for (let i = 0; i < 49; i++) {
          this.prevCounts[p][i] = curCounts[i];
        }
      } else {
        const lostSquares: number[] = [];
        const gainedSquares: number[] = [];
        for (let i = 0; i < 49; i++) {
          if (curCounts[i] < this.prevCounts[p][i]) {
            for (let k = 0; k < this.prevCounts[p][i] - curCounts[i]; k++) lostSquares.push(i);
          } else if (curCounts[i] > this.prevCounts[p][i]) {
            for (let k = 0; k < curCounts[i] - this.prevCounts[p][i]; k++) gainedSquares.push(i);
          }
        }

        // Match lostSquares to gainedSquares in ascending order of Chebyshev distance (<= 3 steps)
        if (lostSquares.length > 0 && gainedSquares.length > 0) {
          const pairs: Array<{ m: number; g: number; d: number }> = [];
          for (let m = 0; m < lostSquares.length; m++) {
            const fromIdx = lostSquares[m];
            const fx = (fromIdx / 7) | 0;
            const fy = fromIdx % 7;
            for (let g = 0; g < gainedSquares.length; g++) {
              const toIdx = gainedSquares[g];
              const tx = (toIdx / 7) | 0;
              const ty = toIdx % 7;
              const d = Math.max(Math.abs(fx - tx), Math.abs(fy - ty));
              if (d <= 3) {
                pairs.push({ m, g, d });
              }
            }
          }
          pairs.sort((a, b) => a.d - b.d);
          const usedLost = new Uint8Array(lostSquares.length);
          const usedGained = new Uint8Array(gainedSquares.length);
          for (let k = 0; k < pairs.length; k++) {
            const { m, g } = pairs[k];
            if (usedLost[m] || usedGained[g]) continue;
            usedLost[m] = 1;
            usedGained[g] = 1;
            const fromIdx = lostSquares[m];
            const toIdx = gainedSquares[g];
            if (this.canBeAceCount[p][fromIdx] > 0) {
              this.canBeAceCount[p][fromIdx]--;
              this.canBeAceCount[p][toIdx]++;
              const movedMass = this.setupMass[p][fromIdx] / Math.max(1, this.prevCounts[p][fromIdx]);
              this.setupMass[p][fromIdx] = Math.max(0, this.setupMass[p][fromIdx] - movedMass);
              this.setupMass[p][toIdx] += movedMass;
            }
            if (this.jokerSuspectScore[p][fromIdx] > 0) {
              this.jokerSuspectScore[p][toIdx] = Math.max(
                this.jokerSuspectScore[p][toIdx],
                this.jokerSuspectScore[p][fromIdx] * 0.9
              );
            }
            this.stationaryBackRowTurns[p][fromIdx] = 0;
          }
        }

        // Phalanx Remnant Deduction:
        // If a square had >= 2 cards (especially a 3-card phalanx) and peeled off cards into combat
        // that were revealed as non-Jokers, the remaining unrevealed card on that square is very likely the Joker!
        for (let i = 0; i < 49; i++) {
          if (this.prevCounts[p][i] >= 2 && curCounts[i] === 1 && this.jokerSuspectScore[p][i] >= 3.0) {
            this.jokerSuspectScore[p][i] = Math.min(12.0, this.jokerSuspectScore[p][i] + 4.5);
          }
        }

        for (let i = 0; i < 49; i++) {
          if (curCounts[i] === 0) {
            this.canBeAceCount[p][i] = 0;
            this.setupMass[p][i] = 0;
            this.stationaryBackRowTurns[p][i] = 0;
            this.jokerSuspectScore[p][i] = 0;
          } else {
            this.canBeAceCount[p][i] = Math.min(this.canBeAceCount[p][i], curCounts[i]);
            if (curCounts[i] === this.prevCounts[p][i] && state.turn > this.lastTurn) {
              this.stationaryBackRowTurns[p][i]++;
            }
            // Any 3-card stack formed in midgame is a prime Joker-escorted phalanx suspect!
            const y = i % 7;
            const depth = p === 0 ? y : 6 - y;
            if (curCounts[i] >= 3 && depth >= 2) {
              this.jokerSuspectScore[p][i] = Math.max(this.jokerSuspectScore[p][i], 7.0);
            }
          }
          this.prevCounts[p][i] = curCounts[i];
        }
      }
    }

    this.prevDraw = [state.draw[0], state.draw[1]];
    this.lastTurn = state.turn;
  }

  public getDeadCards(faction: number): string[] {
    return this.deadCards[faction] || [];
  }

  public canSquareHoldSetupAce(faction: number, sqIdx: number): boolean {
    return this.canBeAceCount[faction][sqIdx] > 0 || this.setupMass[faction][sqIdx] > 0.02;
  }

  public getSetupMass(faction: number, sqIdx: number): number {
    return this.setupMass[faction][sqIdx];
  }

  public getStationaryTurns(faction: number, sqIdx: number): number {
    return this.stationaryBackRowTurns[faction][sqIdx];
  }

  public getJokerSuspectScore(faction: number, sqIdx: number): number {
    return this.jokerSuspectScore[faction][sqIdx];
  }

  public getAceBodyguardScore(faction: number, sqIdx: number): number {
    return this.aceBodyguardScore[faction][sqIdx];
  }

  public getAceVanguardDiscount(faction: number, sqIdx: number): number {
    return this.aceVanguardDiscount[faction][sqIdx];
  }

  public getMissedKillAceDiscount(faction: number, sqIdx: number): number {
    const d = this.missedKillAceDiscount[faction][sqIdx];
    return d > 0 ? d : 1.0;
  }
}

export const globalBeliefTracker = new PersistentBeliefTracker();

export function computeBelief(
  board: CardState[][],
  drawPiles: [number, number],
  faction: number
): FactionBelief {
  const fullDeck: Record<string, number> = {
    A: 2,
    Jkr: 1,
    K: 2,
    Q: 2,
    J: 2,
    '10': 2,
    '9': 2,
  };

  const subtractCardName = (name?: string, rank?: number) => {
    const r = parseCardRank(name, rank);
    if (r === 1) fullDeck.A = Math.max(0, fullDeck.A - 1);
    else if (r === 0) fullDeck.Jkr = Math.max(0, fullDeck.Jkr - 1);
    else if (r === 13) fullDeck.K = Math.max(0, fullDeck.K - 1);
    else if (r === 12) fullDeck.Q = Math.max(0, fullDeck.Q - 1);
    else if (r === 11) fullDeck.J = Math.max(0, fullDeck.J - 1);
    else if (r === 10) fullDeck['10'] = Math.max(0, fullDeck['10'] - 1);
    else if (r === 9) fullDeck['9'] = Math.max(0, fullDeck['9'] - 1);
  };

  for (const deadName of globalBeliefTracker.getDeadCards(faction)) {
    subtractCardName(deadName);
  }

  let visibleHiddenCardsOnBoard = 0;
  const suspectedJokerTiles: [number, number][] = [];
  const suspectedAceTiles: [number, number][] = [];
  const discreditedAceTiles: [number, number][] = [];
  const tileAceProb = new Float32Array(49);
  const tileJokerProb = new Float32Array(49);

  const rawAceWeights = new Float32Array(49);
  const rawJokerWeights = new Float32Array(49);
  let totalAceWeight = 0;
  let totalJokerWeight = 0;

  for (let x = 0; x < 7; x++) {
    for (let y = 0; y < 7; y++) {
      const idx = x * 7 + y;
      const tile = board[idx] || [];
      const cards = tile.filter((c) => c.owner === faction);
      if (cards.length === 0) continue;

      const depth = faction === 0 ? y : 6 - y;
      let unrevealedOnTile = 0;

      for (const card of cards) {
        const r = parseCardRank(card.name, card.rank);
        if (card.revealed || r !== -1) {
          subtractCardName(card.name, card.rank);
          if (r === 1) {
            tileAceProb[idx] = 1.0;
            suspectedAceTiles.push([x, y]);
          }
          if (r === 0) {
            tileJokerProb[idx] = 1.0;
            suspectedJokerTiles.push([x, y]);
          }
        } else {
          visibleHiddenCardsOnBoard++;
          unrevealedOnTile++;
        }
      }

      if (unrevealedOnTile > 0) {
        const canBeAce = globalBeliefTracker.canSquareHoldSetupAce(faction, idx);
        const setupMass = Math.max(canBeAce ? 0.5 : 0, globalBeliefTracker.getSetupMass(faction, idx));
        const statTurns = globalBeliefTracker.getStationaryTurns(faction, idx);
        const trackedJokerSuspect = globalBeliefTracker.getJokerSuspectScore(faction, idx);
        const bodyguardBonus = globalBeliefTracker.getAceBodyguardScore(faction, idx);
        const vanguardDisc = globalBeliefTracker.getAceVanguardDiscount(faction, idx);
        const missedKillDisc = globalBeliefTracker.getMissedKillAceDiscount(faction, idx);
        const discMult = (vanguardDisc > 0 && statTurns <= 1 ? vanguardDisc : 1.0) * missedKillDisc;

        if (!canBeAce || tileAceProb[idx] === 1.0) {
          // Spawned cards from the draw pile can NEVER be Aces under Checards rules,
          // and a square that ALREADY has a revealed Ace does not hold the opponent's 2nd unrevealed Ace!
          if (!canBeAce) discreditedAceTiles.push([x, y]);
          rawAceWeights[idx] = 0.0;
        } else if (tileJokerProb[idx] === 1.0) {
          // An unrevealed setup-origin card stacked with a revealed enemy Joker:
          // A 2-card [Jkr*, ??] stack in the midfield (depth >= 2) is almost always a [Jkr*, King/Queen] court phalanx,
          // whereas a 3-card [Jkr*, ??, ??] stack with high setupMass (>= 1.5) or back-row stack is much more likely to hold an Ace!
          if (cards.length >= 3 && setupMass >= 1.45) {
            rawAceWeights[idx] = 7.5 * Math.max(0.65, setupMass);
            suspectedAceTiles.push([x, y]);
          } else if (depth <= 1) {
            rawAceWeights[idx] = 3.2 * Math.max(0.5, setupMass);
            suspectedAceTiles.push([x, y]);
          } else {
            rawAceWeights[idx] = 0.85 * Math.max(0.4, setupMass);
          }
        } else if (depth === 0) {
          // If the opponent stacked a 2nd/3rd card onto a back-row setup square, they are almost certainly armoring an Ace!
          const armorMult = (cards.length >= 2 ? 1.85 : 1.0) + bodyguardBonus * 0.45;
          rawAceWeights[idx] = (5.8 + Math.min(8, statTurns) * 1.45) * armorMult * Math.max(0.65, setupMass);
          suspectedAceTiles.push([x, y]);
        } else if (depth === 1) {
          const armorMult = (cards.length >= 2 ? 1.55 : 1.0) + bodyguardBonus * 0.35;
          rawAceWeights[idx] = (2.0 + Math.min(8, statTurns) * 0.95) * armorMult * Math.max(0.5, setupMass);
        } else if (depth === 2) {
          const armorMult = (cards.length >= 2 ? 1.35 : 1.0) + bodyguardBonus * 0.3;
          rawAceWeights[idx] =
            (0.75 + Math.min(8, statTurns) * 0.85 + bodyguardBonus * 0.6) *
            armorMult *
            Math.max(0.4, setupMass) *
            discMult;
        } else {
          // Distinguish an early Turn 1-3 vanguard probe (statTurns === 0, rarely an Ace) from a midgame/endgame
          // Law-3 Hunter Ace (`statTurns >= 2`, sat on the back row for several turns before marching out to assassinate our stacks/Ace)!
          const isHunterAceStalker = cards.length === 1 && statTurns >= 2;
          const deepInfiltratorDisc =
            cards.length === 1
              ? isHunterAceStalker
                ? 1.15
                : depth >= 4
                ? 0.18
                : 0.45
              : 1.0;
          rawAceWeights[idx] =
            (0.95 + Math.min(8, statTurns) * 1.25 + bodyguardBonus * 0.6) *
            Math.max(0.45, setupMass) *
            discMult *
            deepInfiltratorDisc;
          if (isHunterAceStalker) {
            suspectedAceTiles.push([x, y]);
          }
        }
        totalAceWeight += rawAceWeights[idx];

        // Phase 2 Behavioral Tell #3 (Joker-Bait Proximity vs Anti-Joker 2-Ace Stalker Tell):
        // Check if this unrevealed enemy tile is adjacent (d=1) or within d=2 of our >=2-card stacks or our revealed Joker!
        let nearOurMultiStack = false;
        let adjacentToOurMultiStack = false;
        let nearOurRevealedJoker = false;
        if (depth >= 2) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= 7) continue;
            for (let dy = -2; dy <= 2; dy++) {
              const ny = y + dy;
              if (ny < 0 || ny >= 7) continue;
              const cheb = Math.max(Math.abs(dx), Math.abs(dy));
              if (cheb === 0) continue;
              const nt = board[nx * 7 + ny] || [];
              let myCnt = 0;
              let myHasRevJoker = false;
              for (let k = 0; k < nt.length; k++) {
                if (nt[k].owner !== faction) {
                  myCnt++;
                  if (parseCardRank(nt[k].name, nt[k].rank) === 0 && nt[k].revealed) {
                    myHasRevJoker = true;
                  }
                }
              }
              if (cards.length === 1 && myCnt >= 2) {
                nearOurMultiStack = true;
                if (cheb === 1) adjacentToOurMultiStack = true;
              }
              if (myHasRevJoker && cheb <= 2) {
                nearOurRevealedJoker = true;
              }
            }
          }
        }

        // A lone unrevealed enemy card parked at d=1 of our >=2-card non-Joker stack on Turns 1-4 (statTurns <= 1) is usually Joker bait or a low scout;
        // whereas a back-row setup card (`statTurns >= 2`) stalking within d<=2 of our >=2-card stack or Ace is a prime Law-3 Hunter Ace!
        if (
          cards.length === 1 &&
          adjacentToOurMultiStack &&
          !nearOurRevealedJoker &&
          statTurns <= 1 &&
          rawAceWeights[idx] > 0
        ) {
          totalAceWeight -= rawAceWeights[idx];
          rawAceWeights[idx] *= 0.42;
          totalAceWeight += rawAceWeights[idx];
        } else if (
          cards.length === 1 &&
          nearOurMultiStack &&
          statTurns >= 2 &&
          rawAceWeights[idx] > 0
        ) {
          totalAceWeight -= rawAceWeights[idx];
          rawAceWeights[idx] *= 1.65;
          totalAceWeight += rawAceWeights[idx];
        } else if (nearOurRevealedJoker && rawAceWeights[idx] > 0) {
          totalAceWeight -= rawAceWeights[idx];
          rawAceWeights[idx] *= cards.length >= 2 && setupMass >= 0.95 ? 2.35 : 1.45;
          totalAceWeight += rawAceWeights[idx];
        }

        let jw = trackedJokerSuspect;
        if (cards.length >= 3 && depth >= 2) {
          jw = Math.max(jw, 6.0);
          suspectedJokerTiles.push([x, y]);
        } else if (depth >= 2 && cards.length === 2) {
          jw = Math.max(jw, 3.2);
          suspectedJokerTiles.push([x, y]);
        } else if (depth >= 2 && cards.length === 1) {
          jw = Math.max(
            jw,
            depth >= 4
              ? 6.8
              : x === 3 && depth === 3
              ? 6.6
              : adjacentToOurMultiStack
              ? 6.2
              : nearOurMultiStack
              ? 4.8
              : x >= 2 && x <= 4
              ? 3.8
              : 1.8
          );
          if (jw >= 3.5) suspectedJokerTiles.push([x, y]);
        } else {
          jw = Math.max(jw, 0.5);
        }
        rawJokerWeights[idx] = jw;
        totalJokerWeight += jw;
      }
    }
  }

  // Compute exact unseen court rank statistics from remaining unseenHighCards
  const unseenCourtList: number[] = [];
  for (let k = 0; k < fullDeck.K; k++) unseenCourtList.push(13);
  for (let k = 0; k < fullDeck.Q; k++) unseenCourtList.push(12);
  for (let k = 0; k < fullDeck.J; k++) unseenCourtList.push(11);
  for (let k = 0; k < fullDeck['10']; k++) unseenCourtList.push(10);
  for (let k = 0; k < fullDeck['9']; k++) unseenCourtList.push(9);

  const maxUnseenCourt = unseenCourtList[0] ?? 9;
  const secondMaxUnseenCourt = unseenCourtList[1] ?? maxUnseenCourt;
  const expectedUnseenCourt =
    unseenCourtList.length > 0
      ? unseenCourtList.reduce((acc, v) => acc + v, 0) / unseenCourtList.length
      : 10.5;

  const drawRemaining = drawPiles[faction] ?? 0;
  // Phase 1 Dual-Pool Cohort Accounting:
  // Setup-origin board cards are drafted from the highest unseen court ranks (Kings & Queens),
  // whereas cards remaining in the draw pile or freshly spawned from reserves come from the lower ranks (J, 10, 9).
  const setupCourtPoolLen = Math.max(1, unseenCourtList.length - drawRemaining);
  const setupCourtSlice = unseenCourtList.slice(0, setupCourtPoolLen);
  const expectedSetupCourt =
    setupCourtSlice.length > 0
      ? setupCourtSlice.reduce((acc, v) => acc + v, 0) / setupCourtSlice.length
      : expectedUnseenCourt;
  const reserveCourtSlice =
    drawRemaining > 0
      ? unseenCourtList.slice(Math.max(0, unseenCourtList.length - drawRemaining))
      : unseenCourtList;
  const expectedReserveCourt =
    reserveCourtSlice.length > 0
      ? reserveCourtSlice.reduce((acc, v) => acc + v, 0) / reserveCourtSlice.length
      : expectedUnseenCourt;

  const totalHiddenSlots = visibleHiddenCardsOnBoard + drawRemaining;
  const jokerDrawPileProb =
    fullDeck.Jkr > 0 && totalHiddenSlots > 0 ? (drawRemaining * 0.45) / totalHiddenSlots : 0;

  if (fullDeck.A > 0 && totalAceWeight > 0) {
    for (let i = 0; i < 49; i++) {
      if (rawAceWeights[i] > 0 && tileAceProb[i] === 0) {
        const baseP = (rawAceWeights[i] / totalAceWeight) * fullDeck.A;
        tileAceProb[i] = Math.min(0.95, baseP);
      }
    }
  }

  if (fullDeck.Jkr > 0 && totalJokerWeight > 0) {
    const boardJokerMass = 1.0 - jokerDrawPileProb * 0.5;
    for (let i = 0; i < 49; i++) {
      if (rawJokerWeights[i] > 0 && tileJokerProb[i] === 0) {
        const p = (rawJokerWeights[i] / totalJokerWeight) * boardJokerMass;
        // Only apply a probability floor when persistent phalanx remnant deduction flagged this tile (`trackedJokerSuspect >= 8.5`);
        // never give an unnormalized 0.45 floor to generic depth>=4 or adjacent court infiltrators!
        const trackedSuspect = globalBeliefTracker.getJokerSuspectScore(faction, i);
        const boost = trackedSuspect >= 8.5 ? 0.58 : 0;
        tileJokerProb[i] = Math.min(0.92, Math.max(p, boost));
      }
    }
  }

  return {
    unseenAces: fullDeck.A,
    unseenJoker: fullDeck.Jkr > 0,
    unseenHighCards: {
      K: fullDeck.K,
      Q: fullDeck.Q,
      J: fullDeck.J,
      '10': fullDeck['10'],
      '9': fullDeck['9'],
    },
    maxUnseenCourt,
    secondMaxUnseenCourt,
    expectedUnseenCourt,
    expectedSetupCourt,
    expectedReserveCourt,
    drawPileRemaining: drawRemaining,
    setupRemainingHidden: visibleHiddenCardsOnBoard,
    jokerDrawPileProb,
    suspectedJokerTiles,
    suspectedAceTiles,
    discreditedAceTiles,
    tileAceProb,
    tileJokerProb,
  };
}

// ---------------------------------------------------------------------------
// 4. Dynamic Positional Readiness Index (DPRI)
// ---------------------------------------------------------------------------

export type StrategyPhase = 'fortification' | 'formation_advance' | 'endgame_liquidation';

export interface DPRIAnalysis {
  dpri: number;
  phase: StrategyPhase;
  myAces: number;
  oppAces: number;
  coveredAces: number;
  lead: number;
  recommendation: string;
}

export function computeDPRI(state: SmartEngineState, myFaction: number): DPRIAnalysis {
  if (!state || (state.phase !== 'play' && state.phase !== 'over')) {
    return {
      dpri: 0,
      phase: 'fortification',
      myAces: 2,
      oppAces: 2,
      coveredAces: 0,
      lead: 0,
      recommendation:
        'Place both Aces separated on your back row, Joker in the center front row, and court cards on row 2',
    };
  }
  const opFaction = 1 - myFaction;
  const opBelief = computeBelief(state.board, state.draw, opFaction);

  let myAces = 0;
  let oppAces = opBelief.unseenAces;
  let myCards = state.draw[myFaction] ?? 0;
  let oppCards = state.draw[opFaction] ?? 0;
  let coveredAces = 0;
  let territoryAdvantage = 0;

  for (let i = 0; i < 49; i++) {
    const tile = state.board[i] || [];
    const y = i % 7;

    const myOnTile = tile.filter((c) => c.owner === myFaction);
    const opOnTile = tile.filter((c) => c.owner === opFaction);

    myCards += myOnTile.length;
    oppCards += opOnTile.length;

    for (const c of myOnTile) {
      const r = parseCardRank(c.name, c.rank);
      if (r === 1) {
        myAces++;
        if (myOnTile.length >= 2) coveredAces++;
      }
      const depth = myFaction === 0 ? y : 6 - y;
      if (depth >= 3) territoryAdvantage++;
    }

    for (const c of opOnTile) {
      const r = parseCardRank(c.name, c.rank);
      if (r === 1) oppAces++;
    }
  }

  const aceDelta = myAces - oppAces;
  const cardDelta = myCards - oppCards;

  const dpri =
    0.4 * aceDelta +
    0.25 * (cardDelta / 2) +
    0.2 * (coveredAces / 2) +
    0.15 * (territoryAdvantage / 4);

  let phase: StrategyPhase = 'fortification';
  let recommendation = 'Deploy draw pile and armor both Aces on separate back-row squares';

  if (dpri >= 1.1 || oppAces <= 1 || (myCards <= 5 && oppCards <= 5)) {
    phase = 'endgame_liquidation';
    recommendation = 'Hunt remaining enemy Ace with 2-card strike stack or 3-step assassin';
  } else if (dpri >= 0.45 || state.turn >= 10 || state.draw[myFaction] === 0) {
    phase = 'formation_advance';
    recommendation = 'Advance 2-card court stacks (20+ pts) and Joker-shielded phalanx';
  }

  return {
    dpri: parseFloat(dpri.toFixed(2)),
    phase,
    myAces,
    oppAces,
    coveredAces,
    lead: cardDelta,
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// 5. Superhuman Grandmaster 3-Move Turn Planner & Minimax Threat Engine
// ---------------------------------------------------------------------------

interface SimCard {
  owner: number;
  name: string;
  rank: number; // 0=Jkr, 1=Ace, 9..13, -1=unknown
  revealed: boolean;
  locked: boolean;
}

function cloneSimBoard(board: SimCard[][]): SimCard[][] {
  const out = new Array<SimCard[]>(49);
  for (let i = 0; i < 49; i++) {
    const t = board[i];
    const len = t ? t.length : 0;
    if (len === 0) {
      out[i] = [];
    } else {
      const copy = new Array<SimCard>(len);
      for (let j = 0; j < len; j++) {
        const c = t[j];
        copy[j] = {
          owner: c.owner,
          name: c.name,
          rank: c.rank,
          revealed: c.revealed,
          locked: c.locked,
        };
      }
      out[i] = copy;
    }
  }
  return out;
}

function createInitialSimBoard(state: SmartEngineState): SimCard[][] {
  const out = new Array<SimCard[]>(49);
  for (let i = 0; i < 49; i++) {
    const t = state.board[i] || [];
    let hasEnemy = false;
    for (let j = 0; j < t.length; j++) {
      if (t[j].owner !== state.mover) {
        hasEnemy = true;
        break;
      }
    }
    out[i] = t.map((c) => ({
      owner: c.owner,
      name: c.name || '',
      rank: parseCardRank(c.name, c.rank),
      revealed: Boolean(c.revealed),
      locked: c.owner === state.mover && hasEnemy,
    }));
  }
  return out;
}

function applyLegalActionToSim(
  board: SimCard[][],
  action: LegalAction,
  mover: number,
  nextSpawnRank: number = 11
): SimCard[][] {
  const next = cloneSimBoard(board);
  const toX = Array.isArray(action.to) ? action.to[0] : action.to.x;
  const toY = Array.isArray(action.to) ? action.to[1] : action.to.y;
  const toIdx = toX * 7 + toY;

  if (action.spawn) {
    next[toIdx].push({
      owner: mover,
      name: nextSpawnRank === 13 ? 'K?' : nextSpawnRank === 12 ? 'Q?' : nextSpawnRank === 11 ? 'J?' : `${nextSpawnRank}?`,
      rank: nextSpawnRank,
      revealed: false,
      locked: true,
    });
    return next;
  }

  const fromX = action.from ? (Array.isArray(action.from) ? action.from[0] : action.from.x) : 0;
  const fromY = action.from ? (Array.isArray(action.from) ? action.from[1] : action.from.y) : 0;
  const fromIdx = fromX * 7 + fromY;
  const src = next[fromIdx];

  const cardName = action.card || action.name || '';
  let removeIdx = -1;

  if (typeof action.ord === 'number') {
    let moverOrd = 0;
    for (let i = 0; i < src.length; i++) {
      if (src[i].owner === mover) {
        if (moverOrd === action.ord) {
          removeIdx = i;
          break;
        }
        moverOrd++;
      }
    }
  }
  if (removeIdx === -1 && cardName) {
    for (let i = 0; i < src.length; i++) {
      if (src[i].owner === mover && src[i].name === cardName && !src[i].locked) {
        removeIdx = i;
        break;
      }
    }
  }
  if (removeIdx === -1) {
    for (let i = 0; i < src.length; i++) {
      if (src[i].owner === mover && !src[i].locked) {
        removeIdx = i;
        break;
      }
    }
  }

  if (removeIdx !== -1) {
    const [moved] = src.splice(removeIdx, 1);
    const dst = next[toIdx];
    for (let i = 0; i < dst.length; i++) {
      if (dst[i].owner !== mover) {
        moved.locked = true;
        break;
      }
    }
    dst.push(moved);
  }

  return next;
}

interface SimMicroMove {
  fromIdx: number;
  toIdx: number;
  cardPosInTile: number;
  rank: number;
}

function generateSimMicroMoves(board: SimCard[][], mover: number): SimMicroMove[] {
  const moves: SimMicroMove[] = [];
  for (let x = 0; x < 7; x++) {
    for (let y = 0; y < 7; y++) {
      const fromIdx = x * 7 + y;
      const tile = board[fromIdx];
      const tLen = tile.length;
      if (tLen === 0) continue;

      let hasEnemyOnFrom = false;
      for (let i = 0; i < tLen; i++) {
        if (tile[i].owner !== mover) {
          hasEnemyOnFrom = true;
          break;
        }
      }
      if (hasEnemyOnFrom) continue;

      let seenRanksMask = 0;
      for (let i = 0; i < tLen; i++) {
        const c = tile[i];
        if (c.owner !== mover || c.locked) continue;
        const rBit = 1 << (c.rank + 2);
        if (seenRanksMask & rBit) continue;
        seenRanksMask |= rBit;

        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= 7) continue;
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const ny = y + dy;
            if (ny < 0 || ny >= 7) continue;
            const toIdx = nx * 7 + ny;
            const dst = board[toIdx];
            let myCountOnDst = 0;
            let dstHasMyAce = false;
            let dstHasEnemy = false;
            for (let k = 0; k < dst.length; k++) {
              if (dst[k].owner === mover) {
                myCountOnDst++;
                if (dst[k].rank === 1) dstHasMyAce = true;
              } else {
                dstHasEnemy = true;
              }
            }
            // Never stack a friendly Ace onto another friendly Ace unless attacking an enemy!
            if (c.rank === 1 && dstHasMyAce && !dstHasEnemy) continue;
            if (myCountOnDst < 4) {
              moves.push({ fromIdx, toIdx, cardPosInTile: i, rank: c.rank });
            }
          }
        }
      }
    }
  }
  return moves;
}

function applySimMicroMove(board: SimCard[][], mv: SimMicroMove, mover: number): SimCard[][] {
  const next = board.slice();
  const src = board[mv.fromIdx];
  if (mv.cardPosInTile >= 0 && mv.cardPosInTile < src.length) {
    const newSrc = src.slice();
    const [origMoved] = newSrc.splice(mv.cardPosInTile, 1);
    next[mv.fromIdx] = newSrc;

    const dst = board[mv.toIdx];
    let locked = origMoved.locked;
    for (let i = 0; i < dst.length; i++) {
      if (dst[i].owner !== mover) {
        locked = true;
        break;
      }
    }
    const newDst = dst.slice();
    newDst.push({
      owner: origMoved.owner,
      name: origMoved.name,
      rank: origMoved.rank,
      revealed: origMoved.revealed,
      locked,
    });
    next[mv.toIdx] = newDst;
  }
  return next;
}

function revealAndUnlockSimCards(cards: SimCard[]): SimCard[] {
  const out = new Array<SimCard>(cards.length);
  for (let j = 0; j < cards.length; j++) {
    const c = cards[j];
    out[j] = {
      owner: c.owner,
      name: c.name,
      rank: c.rank,
      revealed: true,
      locked: false,
    };
  }
  return out;
}

// Phase 1: Zero-Allocation 53-Bit Order-Independent Zobrist Multiset Board Hash!
// Replaces string concatenation & insertion sorting in the 3-step beam search (~10x faster!).
const ZOBRIST_SIM_LO = new Uint32Array(49 * 32);
const ZOBRIST_SIM_HI = new Uint32Array(49 * 32);
(() => {
  let s0 = 0x6a09e667 >>> 0;
  let s1 = 0xbb67ae85 >>> 0;
  const nextRand32 = (): number => {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= (x << 23) >>> 0;
    s1 = (x ^ y ^ (x >>> 17) ^ (y >>> 26)) >>> 0;
    return (s1 + y) >>> 0;
  };
  for (let i = 0; i < 49 * 32; i++) {
    ZOBRIST_SIM_LO[i] = nextRand32();
    ZOBRIST_SIM_HI[i] = nextRand32();
  }
})();

// Canonical order-independent multiset board hash so stack permutations never mask identical positions!
function hashSimBoard(board: SimCard[][]): number {
  let bLo = 0;
  let bHi = 0;
  for (let i = 0; i < 49; i++) {
    const t = board[i];
    const len = t.length;
    if (len === 0) continue;
    let sLo = 0;
    let sHi = 0;
    const base = i << 5;
    for (let j = 0; j < len; j++) {
      const c = t[j];
      const key = base | ((c.owner & 1) << 4) | ((c.rank + 2) & 0x0f);
      sLo = (sLo + ZOBRIST_SIM_LO[key]) | 0;
      sHi = (sHi + ZOBRIST_SIM_HI[key]) | 0;
    }
    sLo = Math.imul(sLo ^ (sLo >>> 16), 0x85ebca6b);
    sHi = Math.imul(sHi ^ (sHi >>> 15), 0xc2b2ae35);
    bLo ^= sLo;
    bHi ^= sHi;
  }
  return (bHi & 0x1fffff) * 4294967296 + (bLo >>> 0);
}

// Canonical order-independent hash of ONLY myFaction's cards to forbid 3-step triangle rotations in place!
function hashMyBoard(board: SimCard[][], myFaction: number): number {
  let bLo = 0;
  let bHi = 0;
  for (let i = 0; i < 49; i++) {
    const t = board[i];
    const len = t.length;
    if (len === 0) continue;
    let sLo = 0;
    let sHi = 0;
    let cnt = 0;
    const base = i << 5;
    for (let j = 0; j < len; j++) {
      const c = t[j];
      if (c.owner === myFaction) {
        cnt++;
        const key = base | ((myFaction & 1) << 4) | ((c.rank + 2) & 0x0f);
        sLo = (sLo + ZOBRIST_SIM_LO[key]) | 0;
        sHi = (sHi + ZOBRIST_SIM_HI[key]) | 0;
      }
    }
    if (cnt === 0) continue;
    sLo = Math.imul(sLo ^ (sLo >>> 16), 0x85ebca6b);
    sHi = Math.imul(sHi ^ (sHi >>> 15), 0xc2b2ae35);
    bLo ^= sLo;
    bHi ^= sHi;
  }
  return (bHi & 0x1fffff) * 4294967296 + (bLo >>> 0);
}

// Canonical order-independent hash of ONLY myFaction's non-Ace cards so sliding a back-row Ace
// can NEVER be used to disguise a 2-turn oscillation of offensive court/Joker stacks!
function hashMyNonAceBoard(board: SimCard[][], myFaction: number): number {
  let bLo = 0;
  let bHi = 0;
  for (let i = 0; i < 49; i++) {
    const t = board[i];
    const len = t.length;
    if (len === 0) continue;
    let sLo = 0;
    let sHi = 0;
    let cnt = 0;
    const base = i << 5;
    for (let j = 0; j < len; j++) {
      const c = t[j];
      if (c.owner === myFaction && c.rank !== 1) {
        cnt++;
        const key = base | ((myFaction & 1) << 4) | ((c.rank + 2) & 0x0f);
        sLo = (sLo + ZOBRIST_SIM_LO[key]) | 0;
        sHi = (sHi + ZOBRIST_SIM_HI[key]) | 0;
      }
    }
    if (cnt === 0) continue;
    sLo = Math.imul(sLo ^ (sLo >>> 16), 0x85ebca6b);
    sHi = Math.imul(sHi ^ (sHi >>> 15), 0xc2b2ae35);
    bLo ^= sLo;
    bHi ^= sHi;
  }
  return (bHi & 0x1fffff) * 4294967296 + (bLo >>> 0);
}
const bfsQueue = new Int32Array(64);

const SQ_NEIGHBORS_8: Int32Array[] = Array.from({ length: 49 }, (_, sq) => {
  const cx = (sq / 7) | 0;
  const cy = sq % 7;
  const arr: number[] = [];
  for (let dx = -1; dx <= 1; dx++) {
    const nx = cx + dx;
    if (nx < 0 || nx >= 7) continue;
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const ny = cy + dy;
      if (ny < 0 || ny >= 7) continue;
      arr.push(nx * 7 + ny);
    }
  }
  return new Int32Array(arr);
});

const SQ_RING_1_2: Int32Array[] = Array.from({ length: 49 }, (_, sq) => {
  const cx = (sq / 7) | 0;
  const cy = sq % 7;
  const arr: number[] = [];
  for (let t = 0; t < 49; t++) {
    if (t === sq) continue;
    const d = Math.max(Math.abs(((t / 7) | 0) - cx), Math.abs((t % 7) - cy));
    if (d <= 2) arr.push(t);
  }
  return new Int32Array(arr);
});

const PRECOMPUTED_CHEB_DIST: Int8Array[] = Array.from({ length: 49 }, (_, sq) => {
  const cx = (sq / 7) | 0;
  const cy = sq % 7;
  const out = new Int8Array(49);
  for (let t = 0; t < 49; t++) {
    if (t === sq) {
      out[t] = 0;
      continue;
    }
    const d = Math.max(Math.abs(((t / 7) | 0) - cx), Math.abs((t % 7) - cy));
    out[t] = d <= 3 ? d : 99;
  }
  return out;
});

function computeStepDistancesFast(
  board: SimCard[][],
  attackerFaction: number,
  fromIdx: number,
  outDist: Int8Array
): void {
  const r12 = SQ_RING_1_2[fromIdx];
  let needBfs = false;
  for (let k = 0; k < r12.length; k++) {
    const t = board[r12[k]];
    const len = t.length;
    if (len === 0) continue;
    let fCnt = 0;
    for (let i = 0; i < len; i++) {
      if (t[i].owner !== attackerFaction) {
        needBfs = true;
        break;
      }
      fCnt++;
    }
    if (needBfs || fCnt >= 4) {
      needBfs = true;
      break;
    }
  }
  if (!needBfs) {
    outDist.set(PRECOMPUTED_CHEB_DIST[fromIdx]);
    for (let tIdx = 0; tIdx < 49; tIdx++) {
      if (outDist[tIdx] === 3 && board[tIdx].length >= 4) {
        let fCnt = 0;
        const tile = board[tIdx];
        for (let i = 0; i < tile.length; i++) {
          if (tile[i].owner === attackerFaction) fCnt++;
        }
        if (fCnt >= 4) outDist[tIdx] = 99;
      }
    }
    return;
  }

  outDist.fill(99);
  outDist[fromIdx] = 0;
  bfsQueue[0] = fromIdx;
  let head = 0;
  let tail = 1;

  while (head < tail) {
    const cur = bfsQueue[head++];
    const d = outDist[cur];
    if (d >= 3) continue;

    if (cur !== fromIdx) {
      const curTile = board[cur];
      let hasDef = false;
      for (let i = 0; i < curTile.length; i++) {
        if (curTile[i].owner !== attackerFaction) {
          hasDef = true;
          break;
        }
      }
      if (hasDef) continue;
    }

    const nbrs = SQ_NEIGHBORS_8[cur];
    for (let k = 0; k < nbrs.length; k++) {
      const nIdx = nbrs[k];
      if (outDist[nIdx] <= d + 1) continue;

      const nTile = board[nIdx];
      if (nTile.length >= 4) {
        let friendlyCount = 0;
        for (let i = 0; i < nTile.length; i++) {
          if (nTile[i].owner === attackerFaction) friendlyCount++;
        }
        if (friendlyCount >= 4) continue;
      }

      outDist[nIdx] = d + 1;
      bfsQueue[tail++] = nIdx;
    }
  }
}

const OP_DIST_MAP_POOL: Int8Array[] = Array.from({ length: 32 }, () => new Int8Array(49));
const MY_DIST_MAP_POOL: Int8Array[] = Array.from({ length: 32 }, () => new Int8Array(49));

// Evaluate end-of-turn board state after resolving all combats and checking opponent's 3-move response!
function evaluateTurnEndState(
  preCombatBoard: SimCard[][],
  myFaction: number,
  opBelief: FactionBelief,
  myDrawAfter: number,
  turnNumber: number,
  wasSpawn: boolean,
  isIntermediateStep: boolean = false
): number {
  const opFaction = 1 - myFaction;
  const postBoard = preCombatBoard.slice();

  let combatScore = 0;
  let killedEnemyAces = 0;
  let killedUnrevealedEnemyAces = 0;
  let killedEnemyJokers = 0;
  let lostMyAces = 0;
  let winningCombatsCount = 0;
  const rule1KillSq = new Uint8Array(49);
  const capturedLowBaitOnSq = new Uint8Array(49);

  let totalMyAcesBefore = 0;
  const myAceSquaresBefore: number[] = [];
  for (let i = 0; i < 49; i++) {
    const t = postBoard[i];
    for (let j = 0; j < t.length; j++) {
      if (t[j].owner === myFaction && t[j].rank === 1) {
        totalMyAcesBefore++;
        myAceSquaresBefore.push(i);
      }
    }
  }

  // Information-Theoretic Value of Information (VoI) for Revealing Enemy Cards on Square `sq`:
  // Calibrated so low-card (`9`/`10`) scout probes and winning captures earn clean information rewards
  // without EVER bribing a King, Queen, or 2-card stack into a losing or suicidal trade!
  const computeEnemyRevealInformationValue = (
    sq: number,
    numUnrev: number,
    pAce: number,
    pJoker: number,
    pCourt: number,
    myAttackerCards: SimCard[],
    attTotalPts: number,
    totalWinProb: number
  ): number => {
    if (numUnrev <= 0) return 0;

    const isLowCardScoutProbe =
      myAttackerCards.length === 1 &&
      myAttackerCards[0].rank !== 0 &&
      myAttackerCards[0].rank !== 1 &&
      attTotalPts <= 10;

    // Never award a large information bonus to sacrificing a high court card (J, Q, K) or multi-card stack in a low-win-prob attack!
    if (!isLowCardScoutProbe && totalWinProb < 0.62) {
      return Math.round(numUnrev * 350 * totalWinProb);
    }

    // 1. Shannon Entropy & Base Hidden-Identity Discovery Value
    let entropy = 0;
    if (pAce > 0.001) entropy -= pAce * Math.log2(pAce);
    if (pJoker > 0.001) entropy -= pJoker * Math.log2(pJoker);
    if (pCourt > 0.001) entropy -= pCourt * Math.log2(pCourt);
    const baseDiscovery = numUnrev * 650 + Math.round(entropy * 550);

    // 2. Global Bayesian Elimination Cascade (Pinpointing Remaining Hidden Setup Aces & Joker)
    let cascadeBonus = 0;
    const isSetupCandidate =
      pAce >= 0.15 || globalBeliefTracker.canSquareHoldSetupAce(opFaction, sq);
    if (opBelief.unseenAces > 0 && isSetupCandidate) {
      const remSetupAfter = Math.max(1, opBelief.setupRemainingHidden - 1);
      const concentrationGain = Math.min(1.0, opBelief.unseenAces / remSetupAfter);
      cascadeBonus += Math.round(concentrationGain * 950);
      if (remSetupAfter <= opBelief.unseenAces) {
        cascadeBonus += 1600;
      }
    }
    if (opBelief.unseenJoker && pJoker >= 0.15) {
      cascadeBonus += Math.round(pJoker * 2200);
    }

    // 3. 2nd-Wave Avenger & Pincer Follow-Up Strike Enablement
    const sx = (sq / 7) | 0;
    const sy = sq % 7;
    let hasFollowUpStackWithin2 = false;
    for (let oSq = 0; oSq < 49; oSq++) {
      if (oSq === sq) continue;
      const oTile = postBoard[oSq];
      if (oTile.length === 0) continue;
      let myCntOnOther = 0;
      let myAceOnOther = false;
      for (let k = 0; k < oTile.length; k++) {
        if (oTile[k].owner === myFaction) {
          myCntOnOther++;
          if (oTile[k].rank === 1) myAceOnOther = true;
        }
      }
      if (myCntOnOther === 0) continue;
      const ox = (oSq / 7) | 0;
      const oy = oSq % 7;
      const d = Math.max(Math.abs(sx - ox), Math.abs(sy - oy));
      if (d <= 2 && (myCntOnOther >= 2 || myAceOnOther)) {
        hasFollowUpStackWithin2 = true;
        break;
      }
    }

    const followUpBonus = hasFollowUpStackWithin2 ? (isLowCardScoutProbe ? 2200 : 850) : 0;

    // 4. Home-Perimeter Stalker Unmasking Bonus (only for low-card probes or high-prob wins)
    let perimeterUnmaskBonus = 0;
    if (isLowCardScoutProbe || totalWinProb >= 0.72) {
      for (let a = 0; a < myAceSquaresBefore.length; a++) {
        const aSq = myAceSquaresBefore[a];
        const ax = (aSq / 7) | 0;
        const ay = aSq % 7;
        const dToAce = Math.max(Math.abs(sx - ax), Math.abs(sy - ay));
        if (dToAce <= 3) {
          perimeterUnmaskBonus = Math.max(perimeterUnmaskBonus, 1800);
        }
      }
    }

    const rawVoI = baseDiscovery + cascadeBonus + followUpBonus + perimeterUnmaskBonus;
    return isLowCardScoutProbe ? Math.min(4800, rawVoI) : Math.min(2400, rawVoI);
  };

  const maxUnseenCourt =
    opBelief.unseenHighCards.K > 0
      ? 13
      : opBelief.unseenHighCards.Q > 0
      ? 12
      : opBelief.unseenHighCards.J > 0
      ? 11
      : opBelief.unseenHighCards['10'] > 0
      ? 10
      : 9;

  // 1. Resolve all combats at end of turn (`myFaction` is ATTACKER, `opFaction` is DEFENDER)
  for (let i = 0; i < 49; i++) {
    const tile = postBoard[i];
    if (tile.length < 2) continue;

    const myCards: SimCard[] = [];
    const opCards: SimCard[] = [];
    for (let j = 0; j < tile.length; j++) {
      if (tile[j].owner === myFaction) myCards.push(tile[j]);
      else opCards.push(tile[j]);
    }
    if (myCards.length === 0 || opCards.length === 0) continue;

    let attAces = 0;
    let attJokers = 0;
    let attTotal = 0;
    let attTotalWithoutJoker = 0;
    for (let j = 0; j < myCards.length; j++) {
      const r = myCards[j].rank;
      if (r === 1) attAces++;
      else if (r === 0) attJokers++;
      const pts = rankPoints(r);
      attTotal += pts;
      if (r !== 0) attTotalWithoutJoker += pts;
    }

    let allOpRevealed = true;
    let revealedOpJokers = 0;
    let revealedOpAces = 0;
    for (let j = 0; j < opCards.length; j++) {
      const c = opCards[j];
      if (!c.revealed && c.rank === -1) allOpRevealed = false;
      if (c.rank === 0) revealedOpJokers++;
      else if (c.rank === 1) revealedOpAces++;
    }

    const tileJokerProb = revealedOpJokers > 0 ? 1.0 : opBelief.tileJokerProb[i];
    const tileAceProb = revealedOpAces > 0 ? 1.0 : opBelief.tileAceProb[i];

    let defWorstCaseTotal = 0;
    for (let j = 0; j < opCards.length; j++) {
      const c = opCards[j];
      if (c.rank !== -1) {
        defWorstCaseTotal += rankPoints(c.rank);
      } else {
        defWorstCaseTotal += maxUnseenCourt;
      }
    }

    // On an intermediate step (Move 1 or Move 2 of 3):
    // If our attackers on tile `i` ALREADY win the combat, score it fully so beam search prioritizes winning captures!
    // Only defer if the attack is still a partial stack waiting for a 2nd/3rd attacker in the same turn.
    if (isIntermediateStep) {
      const alreadyWinsRevealed =
        allOpRevealed &&
        resolveCombat(myCards, opCards).defenderDies &&
        !resolveCombat(myCards, opCards).attackerDies;
      const maxArmoredAceTotal = 1 + (opCards.length >= 2 ? maxUnseenCourt : 0);
      const alreadyWinsUnrevealed =
        !allOpRevealed &&
        revealedOpJokers === 0 &&
        (attAces >= 2 ||
          (attAces === 1 && tileJokerProb < 0.12) ||
          (attTotal > defWorstCaseTotal && tileJokerProb < 0.3) ||
          (tileAceProb >= 0.45 && attTotal > maxArmoredAceTotal && tileJokerProb < 0.25));
      if (!alreadyWinsRevealed && !alreadyWinsUnrevealed) {
        combatScore += 2200;
        continue;
      }
    }

    // Never bundle our Joker with a single Ace in an attack (reveals both to 1-Ace counter-trade!),
    // EXCEPT when executing the Rule-1 Invincible 2-Ace + Joker Strike ([AC, AS, Jkr*]) against an enemy Joker!
    if (attAces === 1 && attJokers >= 1) {
      combatScore -= 95000;
    } else if (attAces >= 2 && attJokers >= 1 && revealedOpJokers === 0 && tileJokerProb < 0.22) {
      combatScore -= 65000;
    }

    // Strict Royal Ace Discipline:
    // 1. If our non-Ace attacking card(s) on square `i` ALREADY beat the enemy defender(s) without needing our Ace
    //    (e.g. [KH(13), AH(1)] attacking a 12-pt QS where KH(13) alone wins 13 > 12!), NEVER drag our Ace into the combat
    //    and permanently reveal our Ace (`👁️`) for zero combat benefit!
    const attTotalWithoutAce = attTotal - attAces;
    if (
      attAces >= 1 &&
      myCards.length > attAces &&
      revealedOpJokers === 0 &&
      tileJokerProb < 0.15 &&
      attTotalWithoutAce > defWorstCaseTotal
    ) {
      combatScore -= 75000;
    }

    // 2. Using our Ace to attack a non-Ace enemy piece reveals our Ace (`👁️`) on square `i`!
    // Distinguish suicidal exposure (where enemy backup within d<=3 can recapture our 1-pt Ace) from
    // winning Law-3 Ace liquidations of 2+ card enemy stacks or active threats to our Aces!
    const combatDepth = myFaction === 0 ? i % 7 : 6 - (i % 7);
    const revealsHiddenMyAce = myCards.some((c) => c.owner === myFaction && c.rank === 1 && !c.revealed);
    if (attAces === 1 && revealedOpAces === 0 && tileAceProb < 0.58) {
      const ix0 = (i / 7) | 0;
      const iy0 = i % 7;
      let hasEnemyBackupWithin3 = false;
      let isThreatToMyAce = false;
      for (let oSq = 0; oSq < 49; oSq++) {
        if (oSq === i) continue;
        const ox = (oSq / 7) | 0;
        const oy = oSq % 7;
        if (Math.max(Math.abs(ix0 - ox), Math.abs(iy0 - oy)) <= 3) {
          if (postBoard[oSq].some((c) => c.owner === opFaction)) {
            hasEnemyBackupWithin3 = true;
          }
        }
      }
      for (let a = 0; a < myAceSquaresBefore.length; a++) {
        const aSq = myAceSquaresBefore[a];
        const ax = (aSq / 7) | 0;
        const ay = aSq % 7;
        if (Math.max(Math.abs(ix0 - ax), Math.abs(iy0 - ay)) <= 3) {
          isThreatToMyAce = true;
          break;
        }
      }
      if (myCards.length === 1) {
        if (totalMyAcesBefore <= 1) {
          combatScore -= 165000;
        } else if (hasEnemyBackupWithin3) {
          combatScore -= opBelief.unseenJoker ? 85000 : 52000;
        } else if (opCards.length === 1 && !isThreatToMyAce && tileAceProb < 0.35) {
          combatScore -= opBelief.unseenJoker ? 48000 : 32000;
        } else if (revealsHiddenMyAce && tileJokerProb < 0.22) {
          // Law-3 execution of an isolated 2+ card enemy stack or active threat with zero enemy backup in range!
          combatScore -= 7500;
        }
      } else if (opCards.length === 1 && combatDepth >= 2 && tileAceProb < 0.35) {
        combatScore -= totalMyAcesBefore <= 1 ? 85000 : 38000;
      } else if (opCards.length >= 2 && tileJokerProb < 0.22) {
        // [Ace + Guard] liquidating a 2+ card enemy stack under Law 3 while keeping our Ace armored!
        combatScore -= totalMyAcesBefore <= 1 ? 52000 : revealsHiddenMyAce ? 11500 : 4500;
      } else if (revealsHiddenMyAce && revealedOpJokers === 0 && tileJokerProb < 0.25) {
        combatScore -= totalMyAcesBefore <= 1 ? 68000 : 32000;
      }
    }

    if (allOpRevealed) {
      const res = resolveCombat(myCards, opCards);
      if (res.defenderDies && !res.attackerDies) {
        winningCombatsCount++;
        killedEnemyAces += res.defenderLostAces;
        if (revealedOpJokers > 0) {
          killedEnemyJokers += revealedOpJokers;
          if (attAces >= 2) {
            rule1KillSq[i] = 1;
            combatScore += 28000 + (attJokers >= 1 ? 12000 : 0);
          }
        }
        let opRankSum = 0;
        for (let j = 0; j < opCards.length; j++) {
          opRankSum += opCards[j].rank === 0 ? 9500 : rankPoints(opCards[j].rank) * 160;
        }
        combatScore += res.defenderLostAces * 165000 + opCards.length * 4600 + opRankSum;
        // Post-Capture Joker Lock Bonus: our stack (with Joker) won the battle,
        // so the captured square is now shielded by our Defending Joker against all non-Ace counter-attacks!
        if (attJokers >= 1 && attAces === 0 && attTotal > defWorstCaseTotal) {
          combatScore += 9500;
        }
        if (opCards.length === 1 && res.defenderLostAces === 0 && revealedOpJokers === 0) {
          capturedLowBaitOnSq[i] = 1;
        }
        postBoard[i] = revealAndUnlockSimCards(myCards);
      } else if (res.defenderDies && res.attackerDies) {
        killedEnemyAces += res.defenderLostAces;
        lostMyAces += res.attackerLostAces;

        if (attJokers >= 1 && attAces === 0 && res.defenderLostAces >= 1) {
          combatScore += 92000;
        } else if (res.attackerLostAces > 0) {
          if (totalMyAcesBefore - lostMyAces <= 0) {
            combatScore -= 750000;
          } else if (res.defenderLostAces >= 1) {
            // When 1 attacking Ace trades into [Enemy Ace + Enemy Joker] under Law 2 (`revealedOpJokers > 0`),
            // it kills BOTH the enemy Ace AND the enemy Joker in a 2-for-1 royal execution!
            combatScore += revealedOpJokers > 0 ? 135000 : 45000;
          } else {
            // STRICT SUICIDE VETO: Never voluntarily trade 1 of our Aces into a revealed non-Ace enemy stack!
            combatScore -= 550000;
          }
        } else {
          let opVal = 0;
          for (let j = 0; j < opCards.length; j++) {
            opVal += opCards[j].rank === 0 ? 9000 : rankPoints(opCards[j].rank) * 140;
          }
          let myVal = 0;
          for (let j = 0; j < myCards.length; j++) {
            myVal += myCards[j].rank === 0 ? 14000 : rankPoints(myCards[j].rank) * 165;
          }
          // Phase 4 Asymmetric Tie-Breaker Physics:
          // Check if the destroyed enemy stack was an escort/bodyguard within d<=2 of an enemy Ace!
          let wasEnemyAceGuard = false;
          const ix = (i / 7) | 0;
          const iy = i % 7;
          for (let dx = -2; dx <= 2 && !wasEnemyAceGuard; dx++) {
            const nx = ix + dx;
            if (nx < 0 || nx >= 7) continue;
            for (let dy = -2; dy <= 2 && !wasEnemyAceGuard; dy++) {
              if (dx === 0 && dy === 0) continue;
              const ny = iy + dy;
              if (ny < 0 || ny >= 7) continue;
              const nIdx = nx * 7 + ny;
              if (opBelief.tileAceProb[nIdx] >= 0.45) {
                wasEnemyAceGuard = true;
              }
            }
          }
          const guardLiquidationBonus = wasEnemyAceGuard ? 7500 : 0;
          const simplificationBonus = totalMyAcesBefore >= 2 && opBelief.unseenAces <= 1 ? 5200 : 0;
          combatScore +=
            res.defenderLostAces * 155000 +
            opVal -
            myVal -
            800 +
            guardLiquidationBonus +
            simplificationBonus;
        }
        postBoard[i] = [];
      } else {
        lostMyAces += res.attackerLostAces;
        let myRankSum = 0;
        for (let j = 0; j < myCards.length; j++) {
          myRankSum += myCards[j].rank === 0 ? 14000 : rankPoints(myCards[j].rank) * 190;
        }
        combatScore -= res.attackerLostAces * 550000 + myCards.length * 5200 + myRankSum;
        postBoard[i] = opCards;
      }
    } else {
      // Exact Bayesian Multi-Hypothesis Combat Evaluation against Unrevealed Defender(s)!
      if (attAces >= 2) {
        rule1KillSq[i] = 1;
        if (tileJokerProb >= 0.25) killedEnemyJokers++;
        if (revealedOpAces > 0) {
          killedEnemyAces += revealedOpAces;
        } else if (opBelief.unseenAces > 0 && tileAceProb >= 0.65) {
          killedEnemyAces += 1;
          killedUnrevealedEnemyAces += 1;
        }
        combatScore +=
          (revealedOpAces > 0 ? revealedOpAces * 165000 : tileAceProb * 88000) +
          tileJokerProb * 32000 +
          (attJokers >= 1 && tileJokerProb >= 0.25 ? 12000 : 0) +
          opCards.length * 4400;
        postBoard[i] = revealAndUnlockSimCards(myCards);
      } else if (attAces === 1) {
        if (revealedOpJokers === 0 && (!opBelief.unseenJoker || tileJokerProb <= 0.03)) {
          if (revealedOpAces > 0) {
            killedEnemyAces += revealedOpAces;
          } else if (opBelief.unseenAces > 0 && tileAceProb >= 0.65) {
            killedEnemyAces += 1;
            killedUnrevealedEnemyAces += 1;
          }
          combatScore +=
            (revealedOpAces > 0 ? revealedOpAces * 165000 : tileAceProb * 90000) +
            opCards.length * 4800 +
            (opCards.length >= 2 ? 3200 : 0);
          postBoard[i] = revealAndUnlockSimCards(myCards);
        } else if (
          totalMyAcesBefore >= 2 &&
          revealedOpJokers >= 1 &&
          opCards.length >= 2 &&
          (revealedOpAces >= 1 || (opCards.length >= 3 && tileAceProb >= 0.68))
        ) {
          // Rule 2 Liquidation Strike against a CONFIRMED enemy [Revealed Joker + Revealed Ace] (or 3-card [AS, AC, Jkr*]) stack!
          // Never sacrifice 1 of our Aces into a 2-card [Revealed Joker + Unrevealed Card] stack (which is almost always [Jkr*, King/Queen])!
          lostMyAces += 1;
          if (revealedOpAces > 0) {
            killedEnemyAces += revealedOpAces;
          } else {
            killedEnemyAces += 1;
            killedUnrevealedEnemyAces += 1;
          }
          combatScore += 42000 + (revealedOpAces > 0 ? revealedOpAces * 95000 : tileAceProb * 65000);
          postBoard[i] = [];
        } else if (revealedOpJokers >= 1) {
          // Rule 2: 1 attacking Ace against a square with a Revealed Defending Joker (without a confirmed enemy Ace)
          // sacrifices our priceless Ace to kill a Joker + Court card — STRICT VETO!
          lostMyAces += 1;
          combatScore -= totalMyAcesBefore <= 1 ? 750000 : 245000;
          postBoard[i] = [];
        } else {
          // Weigh Ace capture vs Joker Rule 2 trade risk
          const isGameWinningLastAceStrike =
            revealedOpAces > 0 && opBelief.unseenAces === 0 && tileJokerProb < 0.22;
          if (
            (!isGameWinningLastAceStrike && totalMyAcesBefore <= 1) ||
            (tileJokerProb >= 0.14 && tileAceProb < 0.55)
          ) {
            combatScore -= 160000;
            postBoard[i] = [];
          } else {
            if (revealedOpAces > 0 && tileJokerProb < 0.25) {
              killedEnemyAces += revealedOpAces;
            }
            combatScore +=
              (revealedOpAces > 0 ? revealedOpAces * 155000 : tileAceProb * 88000) +
              (1 - tileJokerProb) * (opCards.length * 4200) -
              tileJokerProb * 95000;
            postBoard[i] = revealAndUnlockSimCards(myCards);
          }
        }
      } else if (attJokers >= 1 && myCards.length === 1) {
        // Lone attacking Joker (1 pt): ONLY snipe a 1-card very high-probability enemy Ace (or last enemy Ace)!
        const y = i % 7;
        const opDepth = opFaction === 0 ? y : 6 - y;
        if (
          opCards.length === 1 &&
          opDepth <= 1 &&
          (tileAceProb >= 0.78 || (tileAceProb >= 0.65 && opBelief.unseenAces === 1)) &&
          opBelief.unseenAces >= 1
        ) {
          combatScore += tileAceProb * 82000 - (1 - tileAceProb) * 28000;
          postBoard[i] = [];
        } else {
          combatScore -= 65000;
          postBoard[i] = opCards;
        }
      } else {
        // Attacking with non-Ace card(s) (possibly including a Joker escort where myCards.length >= 2)
        // Note: A single court card (11..13 pts) CAN beat or tie a 2-card enemy stack if one of the 2 enemy cards
        // is an Ace (1 pt, so [Ace + 9/10/J/Q] = 10..13 pts)!
        const canSingleCardSnipeArmoredAce =
          opCards.length === 2 &&
          ((revealedOpAces >= 1 && attTotal >= 11) ||
            (opBelief.unseenAces > 0 && opBelief.tileAceProb[i] >= 0.45 && attTotal >= 12));
        if (revealedOpJokers >= 1) {
          combatScore -= 120000;
          postBoard[i] = opCards;
        } else if (
          opCards.length >= 2 &&
          myCards.length === 1 &&
          attJokers === 0 &&
          !canSingleCardSnipeArmoredAce
        ) {
          // STRICT BLUNDER VETO: Never attack a 2+ card non-Ace enemy stack with a single non-Ace card (e.g. lone King vs 2-card court stack)!
          // Even 9+9=18 beats K=13, so a 1-card non-Ace attack into a 2-card non-Ace enemy stack is guaranteed suicide!
          combatScore -= 45000;
          postBoard[i] = opCards;
        } else if (opCards.length >= 3 && myCards.length <= 2 && attAces === 0) {
          // STRICT BLUNDER VETO: Never attack an unrevealed 3+ card enemy stack with <= 2 non-Ace cards (e.g. [KH, QH]=25 vs 3-card [KC, 10C, QC]=35)!
          // Even the lowest 3 court cards (9+9+10=28) beat K+K=26, and if the 3-card stack holds a Joker, Law 4 beats any non-Ace attack!
          combatScore -= 58000;
          postBoard[i] = opCards;
        } else {
          let knownDefPts = 0;
          let numUnrev = 0;
          for (let j = 0; j < opCards.length; j++) {
            if (opCards[j].rank !== -1) knownDefPts += rankPoints(opCards[j].rank);
            else numUnrev++;
          }

          const secondCourt = opBelief.secondMaxUnseenCourt || maxUnseenCourt;
          const avgCourt = opBelief.expectedUnseenCourt || 11.0;

          // Hypothesis 1 (prob = pAce): One of the `numUnrev` unrevealed cards on square `i` is an Ace (1 pt)!
          // (If `revealedOpAces > 0`, the Ace on square `i` is ALREADY revealed and counted in `knownDefPts`,
          //  so the remaining `numUnrev` unrevealed card(s) on square `i` are court guard(s) or Joker, NOT another Ace!)
          const maxDefIfAce =
            knownDefPts +
            1 +
            (numUnrev <= 1
              ? 0
              : numUnrev === 2
              ? maxUnseenCourt
              : maxUnseenCourt + secondCourt + (numUnrev - 3) * 11);
          const avgDefIfAce = knownDefPts + 1 + Math.max(0, numUnrev - 1) * avgCourt;

          let winGivenAce = 0;
          let tieGivenAce = 0;
          if (attTotal > maxDefIfAce) {
            winGivenAce = 1.0;
          } else if (attTotal === maxDefIfAce) {
            winGivenAce = numUnrev >= 2 ? 0.78 : 0.0;
            tieGivenAce = numUnrev >= 2 ? 0.22 : 1.0;
          } else if (attTotal > avgDefIfAce) {
            winGivenAce = 0.55;
            tieGivenAce = 0.15;
          }

          // Hypothesis 2 (prob = pCourt): All `numUnrev` unrevealed cards on square `i` are non-Ace, non-Joker court cards!
          const pJoker = opBelief.unseenJoker ? tileJokerProb : 0;
          const pAce =
            revealedOpAces > 0 || opBelief.unseenAces <= 0
              ? 0
              : Math.min(1.0 - pJoker, opBelief.tileAceProb[i]);
          const pCourt = Math.max(0, 1.0 - pAce - pJoker);

          let winGivenCourt = 0;
          let tieGivenCourt = 0;
          // Setup Draft Selection Bias:
          // While `opBelief.drawPileRemaining > 0`, the opponent's lowest cards (9, 10, J) sit in their draw pile,
          // whereas the cards placed on the board during Setup are overwhelmingly Kings (13) and Queens (12)!
          const hc = opBelief.unseenHighCards;
          let reserveFilter = Math.round((opBelief.drawPileRemaining || 0) * 0.88);
          const filterLow = (cnt: number): number => {
            if (cnt <= 0 || reserveFilter <= 0) return cnt;
            const rem = Math.min(cnt, reserveFilter);
            reserveFilter -= rem;
            return Math.max(cnt * 0.12, cnt - rem);
          };
          const eff9 = filterLow(hc['9']);
          const eff10 = filterLow(hc['10']);
          const effJ = filterLow(hc.J);
          const effQ = hc.Q;
          const effK = hc.K;
          const totC = effK + effQ + effJ + eff10 + eff9;

          if (numUnrev === 1) {
            if (totC > 0) {
              // Vanguard High-Card Bias: when a lone unrevealed enemy piece advances deep into our half (`opDepthForSingle >= 3`),
              // human and GM players overwhelmingly spearhead with Kings (13) and Queens (12) rather than 9s/10s!
              const opDepthForSingle = opFaction === 0 ? i % 7 : 6 - (i % 7);
              const kMult = opDepthForSingle >= 3 ? 2.4 : 1.0;
              const qMult = opDepthForSingle >= 3 ? 1.8 : 1.0;
              const lowMult = opDepthForSingle >= 3 ? 0.55 : 1.0;
              const ranks: Array<[number, number]> = [
                [13, effK * kMult],
                [12, effQ * qMult],
                [11, effJ],
                [10, eff10 * lowMult],
                [9, eff9 * lowMult],
              ];
              let wTotC = 0;
              for (let rIdx = 0; rIdx < ranks.length; rIdx++) wTotC += ranks[rIdx][1];
              for (const [rk, count] of ranks) {
                if (count <= 0 || wTotC <= 0) continue;
                const defTot = knownDefPts + rk;
                if (attTotal > defTot) winGivenCourt += count / wTotC;
                else if (attTotal === defTot) tieGivenCourt += count / wTotC;
              }
            } else {
              winGivenCourt = attTotal > knownDefPts + 12 ? 1.0 : 0.0;
            }
          } else if (numUnrev === 2 && totC > 0.5) {
            // Exact 5x5 Pair Combinatorics over remaining unseen court cards (with spearhead bias for K/Q):
            const opDepthForStack = opFaction === 0 ? i % 7 : 6 - (i % 7);
            const spearMult = opDepthForStack >= 2 ? 1.45 : 1.15;
            const ranks: Array<[number, number]> = [
              [13, effK * spearMult],
              [12, effQ * spearMult],
              [11, effJ],
              [10, eff10 * 0.75],
              [9, eff9 * 0.65],
            ];
            let pairWeightSum = 0;
            let winWeight = 0;
            let tieWeight = 0;
            for (let a = 0; a < ranks.length; a++) {
              const [r1, c1] = ranks[a];
              if (c1 <= 0) continue;
              for (let b = a; b < ranks.length; b++) {
                const [r2, c2] = ranks[b];
                if (c2 <= 0) continue;
                const w = a === b ? c1 * Math.max(0, c1 - 0.85) * 0.5 : c1 * c2;
                if (w <= 0) continue;
                pairWeightSum += w;
                const defTot = knownDefPts + r1 + r2;
                if (attTotal > defTot) winWeight += w;
                else if (attTotal === defTot) tieWeight += w;
              }
            }
            if (pairWeightSum > 0) {
              winGivenCourt = winWeight / pairWeightSum;
              tieGivenCourt = tieWeight / pairWeightSum;
            }
          } else {
            const opDepthForStack = opFaction === 0 ? i % 7 : 6 - (i % 7);
            const stackBiasPerCard = opDepthForStack >= 2 ? 1.15 : 0;
            const maxDefCourt =
              knownDefPts +
              (numUnrev === 2
                ? maxUnseenCourt + secondCourt
                : maxUnseenCourt + secondCourt + (numUnrev - 2) * 11);
            const avgDefCourt = knownDefPts + numUnrev * Math.min(12.6, avgCourt + stackBiasPerCard);
            const minDefCourt = knownDefPts + numUnrev * (opDepthForStack >= 2 ? 10.5 : 9);
            if (attTotal > maxDefCourt) {
              winGivenCourt = 1.0;
            } else if (attTotal === maxDefCourt) {
              winGivenCourt = 0.82;
              tieGivenCourt = 0.18;
            } else if (attTotal >= maxDefCourt - 1) {
              winGivenCourt = 0.58;
              tieGivenCourt = 0.22;
            } else if (attTotal > avgDefCourt) {
              winGivenCourt = 0.35;
              tieGivenCourt = 0.15;
            } else if (attTotal >= minDefCourt) {
              winGivenCourt = 0.12;
              tieGivenCourt = 0.08;
            }
          }

          const totalWinProb = pAce * winGivenAce + pCourt * winGivenCourt;
          const totalTieProb = pAce * tieGivenAce + pCourt * tieGivenCourt;
          const totalLossProb = Math.max(0, 1.0 - totalWinProb - totalTieProb);

          const opDepthOnSq = opFaction === 0 ? i % 7 : 6 - (i % 7);
          // Check if square `i` is genuinely threatening any of our Aces:
          // An enemy card at d <= 2 is an immediate threat; an enemy card at d === 3 is only an emergency threat
          // if our Ace is revealed, or we are down to 1 Ace, or the enemy card has crossed into our territory (`opDepthOnSq >= 4`)!
          const ix = (i / 7) | 0;
          const iy = i % 7;
          let threatensMyAce = false;
          for (let a = 0; a < myAceSquaresBefore.length; a++) {
            const aSq = myAceSquaresBefore[a];
            const ax = (aSq / 7) | 0;
            const ay = aSq % 7;
            const dToAce = Math.max(Math.abs(ix - ax), Math.abs(iy - ay));
            const aceRev = postBoard[aSq].some((c) => c.owner === myFaction && c.rank === 1 && c.revealed);
            if (
              dToAce <= 2 ||
              (dToAce === 3 && (aceRev || totalMyAcesBefore <= 1 || opDepthOnSq >= 4))
            ) {
              threatensMyAce = true;
              break;
            }
          }

          // Never feed a 2+ card non-Ace stack (including our [Joker, Court] stack!) into a lone 1-card suspected Joker (`pJoker >= 0.22`),
          // because under Law 4 a Defending Joker destroys ANY non-Ace attacking stack (even if the attacker also has a Joker!)
          const isHighProbJokerTrap =
            opBelief.unseenJoker &&
            !threatensMyAce &&
            opDepthOnSq <= 3 &&
            attAces === 0 &&
            ((opCards.length === 1 && myCards.length >= 2 && pJoker >= (attJokers > 0 ? 0.20 : 0.36) && pAce < 0.35) ||
              (opCards.length === 2 && myCards.length >= 3 && pJoker >= 0.38 && pAce < 0.3));

          if (
            attJokers > 0 &&
            (!threatensMyAce || opCards.length === 1) &&
            (totalWinProb < 0.58 || (pJoker >= 0.20 && pAce < 0.35))
          ) {
            combatScore -= 68000;
            postBoard[i] = opCards;
          } else if (isHighProbJokerTrap && pAce < 0.45) {
            combatScore -= 38000;
            postBoard[i] = opCards;
          } else {
            const myMaterialAtRisk =
              myCards.length * 6400 + attTotal * 195 + (attJokers > 0 ? 18000 : 0);
            const opExpectedMaterial = opCards.length * 4800 + Math.round(opCards.length * avgCourt * 150);

            // Exact Information-Theoretic Value of Information (VoI) for Revealing `numUnrev` Enemy Cards on Square `i`!
            const infoRevealValue = computeEnemyRevealInformationValue(
              i,
              numUnrev,
              pAce,
              pJoker,
              pCourt,
              myCards,
              attTotal,
              totalWinProb
            );

            let overcommitPenalty = 0;
            if (opCards.length === 1 && opBelief.unseenJoker && attAces === 0) {
              if (myCards.length >= 3) {
                overcommitPenalty = (myCards.length - 2) * 6500;
              }
              // Against a 1-card unrevealed enemy square with plausible Joker probability (`pJoker >= 0.18`),
              // committing 2+ non-Ace cards (especially [Jkr, King] or [King, Queen]) risks losing the entire stack to a Defending Joker under Law 4!
              if (myCards.length >= 2 && pJoker >= 0.18 && pAce < 0.35) {
                overcommitPenalty +=
                  Math.round(pJoker * myMaterialAtRisk * (attJokers > 0 ? 1.35 : 0.85)) +
                  (myCards.length - 1) * 6200;
              }
            }

            // Pre-Emptive Initiative Strike & Home-Defense Interceptor Bonus:
            // Crushing an enemy 2+ card stack OR wiping out an enemy infiltrator deep in our territory (`opDepthOnSq >= 4`) / threatening our Aces!
            // Note: `attJokers > 0` is NOT safe against a suspected enemy Joker (`pJoker >= 0.18`) because Law 4 kills an attacking Joker!
            const safeInterceptorOnSingle =
              opCards.length >= 2 ||
              (myCards.length === 1 && attJokers === 0) ||
              !opBelief.unseenJoker ||
              pJoker < 0.18;
            const preEmptiveStackCrushBonus =
              (opCards.length >= 2 && totalWinProb >= 0.64 ? 9500 : 0) +
              ((threatensMyAce || opDepthOnSq >= 4) &&
              safeInterceptorOnSingle &&
              (totalWinProb >= 0.72 ||
                (opCards.length === 1 && myCards.length === 1 && totalWinProb + totalTieProb >= 0.65))
                ? 11500
                : 0);

            // Back-Row Ace Assassination Bonus:
            // For a lone 1-card court attacker (`myCards.length === 1 && attAces === 0 && attJokers === 0`),
            // require high Ace certainty (`pAce >= 0.58 && totalWinProb >= 0.72`) so the bot NEVER splits a 25-pt [KH, QD] stack
            // to send a lone Queen/King into an enemy King bodyguard at (2,5) or (4,5)!
            const isLoneCourtAttacker = myCards.length === 1 && attAces === 0 && attJokers === 0;
            const backRowHunterBonus =
              opDepthOnSq <= 1 &&
              (isLoneCourtAttacker ? pAce >= 0.58 && totalWinProb >= 0.72 : pAce >= 0.35 && totalWinProb >= 0.62)
                ? 11500
                : 0;

            // Quadratic damping when `pAce < 0.35`, AND strict cap for lone 1-card court attackers when `pAce < 0.62`
            // so generic setup-origin squares never hallucinate a +56,000 Ace bounty that lures lone Kings/Queens into suicide!
            const effectiveAceProb = pAce >= 0.35 ? pAce : pAce * pAce * 1.6;
            const aceBountyScale =
              isLoneCourtAttacker && pAce < 0.62
                ? Math.round(26000 * totalWinProb)
                : totalWinProb >= 0.58
                ? opBelief.unseenAces <= 1
                  ? 185000
                  : 125000
                : 36000;
            const unrevAceKillReward =
              effectiveAceProb * (winGivenAce + tieGivenAce * 0.85) * aceBountyScale;
            const revAceBountyScale = opBelief.unseenAces === 0 ? 220000 : 155000;
            const revAceKillReward =
              revealedOpAces * (totalWinProb + totalTieProb * 0.92) * revAceBountyScale;
            const expectedAceKillReward = revAceKillReward + unrevAceKillReward;
            const expectedCaptureReward =
              totalWinProb * opExpectedMaterial +
              totalTieProb * (opExpectedMaterial - myMaterialAtRisk - 1800);
            const expectedLossPenalty = totalLossProb * myMaterialAtRisk + overcommitPenalty;

            // Post-Capture Joker Lock Bonus when attacking with Court + Joker (e.g. K + Jkr = 14)
            const jokerLockBonus = attJokers > 0 && totalWinProb >= 0.78 ? 8500 : 0;

            combatScore +=
              expectedAceKillReward +
              expectedCaptureReward +
              infoRevealValue +
              jokerLockBonus +
              preEmptiveStackCrushBonus +
              backRowHunterBonus -
              expectedLossPenalty;

            if (
              totalWinProb >= 0.54 &&
              totalWinProb >= totalLossProb + totalTieProb * 0.45
            ) {
              if (totalWinProb >= 0.64) winningCombatsCount++;
              if (revealedOpAces > 0 && totalWinProb + totalTieProb >= 0.72) {
                killedEnemyAces += revealedOpAces;
              } else if (revealedOpAces === 0 && pAce >= 0.75 && winGivenAce + tieGivenAce >= 0.9) {
                killedEnemyAces += 1;
                killedUnrevealedEnemyAces += 1;
              }
              if (opCards.length === 1 && pAce < 0.42 && revealedOpAces === 0) {
                capturedLowBaitOnSq[i] = 1;
              }
              if (totalWinProb < 0.78) {
                // Phase 1 Uncertain Survival Discount: avoid over-crediting downstream positional value on coin-flip attacks
                combatScore -= Math.round((0.8 - totalWinProb) * myMaterialAtRisk * 0.32);
              }
              postBoard[i] = revealAndUnlockSimCards(myCards);
            } else if (
              totalWinProb + totalTieProb >= 0.58 &&
              totalWinProb + totalTieProb > totalLossProb
            ) {
              // Mutual-Destruction / High-Probability Threat Liquidation:
              // If `totalWinProb >= 0.32` (e.g., a 13-pt King attacking an unrevealed card where it wins against Q/J/10/9
              // and ties K), keep `myCards` on `postBoard[i]` (while deducting the tie/loss positional discount) so Section 2
              // ALWAYS evaluates whether our surviving attacker on `i` is immediately recaptured by enemy backup!
              if (revealedOpAces > 0 && totalWinProb + totalTieProb >= 0.72) {
                killedEnemyAces += revealedOpAces;
              }
              if (totalWinProb >= 0.32) {
                if (opCards.length === 1 && pAce < 0.42 && revealedOpAces === 0) {
                  capturedLowBaitOnSq[i] = 1;
                }
                combatScore -= Math.round((1.0 - totalWinProb) * myMaterialAtRisk * 0.45);
                postBoard[i] = revealAndUnlockSimCards(myCards);
              } else {
                postBoard[i] = [];
              }
            } else {
              // When win+tie probability is < 58%, do NOT optimistically assume the enemy stack is destroyed!
              const revealedSurvivors: SimCard[] = [];
              const survCourtRank =
                globalBeliefTracker.getSetupMass(opFaction, i) >= 0.35
                  ? Math.max(12, Math.round(opBelief.expectedSetupCourt || 12))
                  : Math.max(9, Math.min(13, Math.round(avgCourt)));
              for (let j = 0; j < opCards.length; j++) {
                const oc = opCards[j];
                revealedSurvivors.push({
                  owner: oc.owner,
                  name: oc.name,
                  rank: oc.rank !== -1 ? oc.rank : survCourtRank,
                  revealed: true,
                  locked: false,
                });
              }
              postBoard[i] = revealedSurvivors;
            }
          }
        }
      }
    }
  }

  // Phase 4 Multi-Square Simultaneous Split-Kill Fork Bonus:
  // If our 3 micro-moves execute winning combats on 2 or 3 distinct squares in the same turn, reward the fork!
  if (winningCombatsCount >= 2) {
    combatScore += (winningCombatsCount - 1) * 12500;
  }

  const remainingMyAces: number[] = [];
  let remainingOpRevealedAces = 0;
  let remainingOpUnrevealedCards = 0;

  for (let i = 0; i < 49; i++) {
    const t = postBoard[i];
    for (let j = 0; j < t.length; j++) {
      const c = t[j];
      if (c.owner === myFaction && c.rank === 1) {
        remainingMyAces.push(i);
      } else if (c.owner === opFaction) {
        if (c.rank === 1) remainingOpRevealedAces++;
        else if (c.rank === -1) remainingOpUnrevealedCards++;
      }
    }
  }

  if (remainingMyAces.length === 0) {
    return -1000000;
  }

  // Note: `remainingOpRevealedAces` on `postBoard` ALREADY excludes any revealed enemy Aces killed this turn!
  // Only `killedUnrevealedEnemyAces` should be subtracted from `opBelief.unseenAces` so killing 1 revealed Ace
  // when 1 unrevealed Ace is still alive NEVER double-subtracts and hallucinates a false 1,000,000 checkmate!
  const totalOpAcesRemaining =
    remainingOpRevealedAces +
    Math.min(
      remainingOpUnrevealedCards,
      Math.max(0, opBelief.unseenAces - killedUnrevealedEnemyAces)
    );
  if (totalOpAcesRemaining === 0 && killedEnemyAces > 0) {
    return 1000000 + combatScore;
  }

  // -------------------------------------------------------------------------
  // 2. Exact Opponent 3-Move Counter-Turn Threat Analysis (Only at Turn End!)
  // -------------------------------------------------------------------------
  let threatPenalty = 0;
  const condemnedSq = new Uint8Array(49);
  const opMaxReachCards = new Uint8Array(49);
  const opMaxReachPts = new Int32Array(49);
  const opAceReachProb = new Float32Array(49);
  const opTwoTurnCards = new Uint8Array(49);
  const opTwoTurnPts = new Int32Array(49);
  const sqToDistMapIdx = new Int32Array(49).fill(-1);

  if (!isIntermediateStep) {
    const opUnitSq: number[] = [];
    const opUnitRank: number[] = [];
    const opUnitCanJoker: boolean[] = [];
    const opUnitCanAce: boolean[] = [];
    let numOpDistMaps = 0;

    for (let i = 0; i < 49; i++) {
      const t = postBoard[i];
      let hasOp = false;
      for (let j = 0; j < t.length; j++) {
        if (t[j].owner === opFaction) {
          hasOp = true;
          break;
        }
      }
      if (!hasOp) continue;

      const mapIdx = numOpDistMaps++;
      const dMap = OP_DIST_MAP_POOL[mapIdx] || new Int8Array(49);
      computeStepDistancesFast(postBoard, opFaction, i, dMap);
      sqToDistMapIdx[i] = mapIdx;

      const hasRevOpAceOnI = t.some((c) => c.owner === opFaction && c.rank === 1);
      const hasRevOpJkrOnI = t.some((c) => c.owner === opFaction && c.rank === 0);
      for (let j = 0; j < t.length; j++) {
        const c = t[j];
        if (c.owner !== opFaction) continue;
        const isUnrev = c.rank === -1 && !c.revealed;
        opUnitSq.push(i);
        opUnitRank.push(c.rank);
        opUnitCanJoker.push(
          c.rank === 0 || (isUnrev && !hasRevOpJkrOnI && opBelief.tileJokerProb[i] > 0.2)
        );
        opUnitCanAce.push(
          c.rank === 1 ||
            (isUnrev &&
              !hasRevOpAceOnI &&
              opBelief.unseenAces > 0 &&
              (opBelief.tileAceProb[i] >= 0.08 ||
                globalBeliefTracker.canSquareHoldSetupAce(opFaction, i)))
        );
      }
    }

    const numOpUnits = opUnitSq.length;
    // For non-Ace fighting stacks, use expected court value (11) for 2nd/3rd unrevealed attackers so advancing
    // a 25-pt K+Q stack across the midline never hallucinates two simultaneous 13-pt Kings (26 pts) condemning it!
    const expectedUnrevCourt = Math.round(opBelief.expectedUnseenCourt || 11);
    const secondUnrevCourtGlobal = opBelief.secondMaxUnseenCourt || expectedUnrevCourt;

    // Precompute the 49-Tile Enemy 1-Turn (3-Move) & 2-Turn Reinforced (6-Move) Reachability Fields:
    // For every tile `sq`, compute both:
    //  1) Immediate 1-turn (3 micro-moves, sum d <= 3) reachable cards, points, and Ace probability.
    //  2) Turn-After Reinforced 2-turn (6 micro-moves across Turn 1 staging + Turn 2 convergence,
    //     sum d <= 6 with max 4 cards and sum max(0, d - 3) <= 3) reachable cards and points.
    for (let sq = 0; sq < 49; sq++) {
      let c1 = 0;
      let c2 = 0;
      let c3 = 0;
      let c4 = 0;
      let t1_0 = 0;
      let t1_1 = 0;
      let t1_2 = 0;
      let t2_0 = 0;
      let t2_1 = 0;
      let t2_2 = 0;
      let t3_0 = 0;
      let t3_1 = 0;
      let t4_0 = 0;
      let maxPAce = 0;
      let noAceReachProb = 1.0;

      for (let u = 0; u < numOpUnits; u++) {
        const uSq = opUnitSq[u];
        const d = OP_DIST_MAP_POOL[sqToDistMapIdx[uSq]][sq];
        if (d < 1 || d > 4) continue;

        const r = opUnitRank[u];
        const pts =
          r !== -1
            ? rankPoints(r)
            : d === 1 && t1_0 === 0
            ? maxUnseenCourt
            : d <= 2
            ? secondUnrevCourtGlobal
            : expectedUnrevCourt;

        if (d <= 3) {
          if (r === 1) {
            maxPAce = 1.0;
            noAceReachProb = 0.0;
          } else if (opUnitCanAce[u]) {
            const pA = opBelief.tileAceProb[uSq];
            const wA = d === 1 ? pA : d === 2 ? pA * 0.85 : pA * 0.6;
            if (wA > maxPAce) maxPAce = wA;
            noAceReachProb *= 1.0 - Math.min(0.9, wA * 0.65);
          }
        }

        if (d === 1) {
          c1++;
          if (pts >= t1_0) {
            t1_2 = t1_1;
            t1_1 = t1_0;
            t1_0 = pts;
          } else if (pts >= t1_1) {
            t1_2 = t1_1;
            t1_1 = pts;
          } else if (pts > t1_2) {
            t1_2 = pts;
          }
        } else if (d === 2) {
          c2++;
          if (pts >= t2_0) {
            t2_2 = t2_1;
            t2_1 = t2_0;
            t2_0 = pts;
          } else if (pts >= t2_1) {
            t2_2 = t2_1;
            t2_1 = pts;
          } else if (pts > t2_2) {
            t2_2 = pts;
          }
        } else if (d === 3) {
          c3++;
          if (pts >= t3_0) {
            t3_1 = t3_0;
            t3_0 = pts;
          } else if (pts > t3_1) {
            t3_1 = pts;
          }
        } else {
          c4++;
          if (pts > t4_0) t4_0 = pts;
        }
      }

      const maxCards =
        c1 >= 3 ? 3 : c1 >= 2 || (c1 >= 1 && c2 >= 1) ? 2 : c1 + c2 + c3 >= 1 ? 1 : 0;
      const m1 = Math.max(t1_0, t2_0, t3_0);
      const m2 = t1_0 > 0 ? t1_0 + Math.max(t1_1, t2_0) : 0;
      const m3 = t1_0 > 0 && t1_1 > 0 && t1_2 > 0 ? t1_0 + t1_1 + t1_2 : 0;
      const oneTurnPts = Math.max(m1, m2, m3);

      opMaxReachCards[sq] = maxCards;
      opMaxReachPts[sq] = oneTurnPts;
      opAceReachProb[sq] = Math.max(maxPAce, 1.0 - noAceReachProb);

      // Exact 2-Turn (6-Move Staging + Turn-After Reinforcement) Convergence Knapsack:
      // Any k <= 4 cards with sum(d_m) <= 6 and sum(max(0, d_m - 3)) <= 3 can stage on Turn 1 and converge on Turn 2.
      // Sort top cards at d <= 2 (each costs <= 2, so ANY 3 of them cost <= 6!):
      let d12_0 = 0;
      let d12_1 = 0;
      let d12_2 = 0;
      const d12Arr = [t1_0, t1_1, t1_2, t2_0, t2_1, t2_2];
      for (let k = 0; k < 6; k++) {
        const v = d12Arr[k];
        if (v <= 0) continue;
        if (v >= d12_0) {
          d12_2 = d12_1;
          d12_1 = d12_0;
          d12_0 = v;
        } else if (v >= d12_1) {
          d12_2 = d12_1;
          d12_1 = v;
        } else if (v > d12_2) {
          d12_2 = v;
        }
      }
      const two1 = Math.max(oneTurnPts, t4_0);
      const two2 = Math.max(
        d12_0 + d12_1,
        d12_0 > 0 && t3_0 > 0 ? d12_0 + t3_0 : 0,
        t3_0 > 0 && t3_1 > 0 ? t3_0 + t3_1 : 0,
        t1_0 > 0 && t4_0 > 0 ? t1_0 + t4_0 : 0
      );
      const two3 = Math.max(
        d12_0 + d12_1 + d12_2,
        t1_0 > 0 && t1_1 > 0 ? t1_0 + t1_1 + Math.max(t3_0, t4_0) : 0,
        t1_0 > 0 && t2_0 > 0 && t3_0 > 0 ? t1_0 + t2_0 + t3_0 : 0
      );
      const two4 = Math.max(
        t1_0 > 0 && t1_1 > 0 && t1_2 > 0 && Math.max(t2_0, t3_0) > 0
          ? t1_0 + t1_1 + t1_2 + Math.max(t2_0, t3_0)
          : 0,
        t1_0 > 0 && t1_1 > 0 && t2_0 > 0 && t2_1 > 0 ? t1_0 + t1_1 + t2_0 + t2_1 : 0
      );
      opTwoTurnPts[sq] = Math.max(two1, two2, two3, two4);
      opTwoTurnCards[sq] =
        two4 > 0
          ? 4
          : two3 > 0 || c1 + c2 >= 3
          ? 3
          : two2 > 0 || c1 + c2 + c3 >= 2
          ? 2
          : c1 + c2 + c3 + c4 >= 1
          ? 1
          : 0;
    }

    let aceAndJokerThreatPenalty = 0;
    let firstThreatenedMyAceDist = 99;
    const nonAceStackThreats: number[] = [];

    for (let sq = 0; sq < 49; sq++) {
      const t = postBoard[sq];
      let myLen = 0;
      let myAcesOnSq = 0;
      let myJokersOnSq = 0;
      let myRevealedJoker = false;
      let myDefTotal = 0;

      for (let j = 0; j < t.length; j++) {
        const c = t[j];
        if (c.owner === myFaction) {
          myLen++;
          if (c.rank === 1) myAcesOnSq++;
          else if (c.rank === 0) {
            myJokersOnSq++;
            if (c.revealed) myRevealedJoker = true;
          }
          myDefTotal += rankPoints(c.rank);
        }
      }
      if (myLen === 0) continue;

      let top1_0 = 0;
      let top1_1 = 0;
      let top1_2 = 0;
      let top2_0 = 0;
      let top2_1 = 0;
      let top3_0 = 0;
      let allCounterCardsRevealed = true;
      let opHasJokerAtD1 = false;
      const reachAceCands: Array<{ d: number; pAce: number }> = [];

      let canKillOurStack = false;
      let killedByEnemyAce = false;
      let opponentSurvivesCounter = false;
      let canKillWithGuaranteedCard = false;
      let unrevealedAceThreatWeight = 0;
      let unrevealedAceNoHitProb = 1.0;
      let minUnrevAceDist = 99;
      let minKillDist = 99;
      const seenAceCandCountOnSq = new Int32Array(49);
      const seenUnrevAceThreatOrigin = new Uint8Array(49);

      for (let u = 0; u < numOpUnits; u++) {
        const d = OP_DIST_MAP_POOL[sqToDistMapIdx[opUnitSq[u]]][sq];
        if (d < 1 || d > 3) continue;

        const r = opUnitRank[u];
        // When an opponent converges 1 or 2 unrevealed setup/board cards onto our square,
        // the primary attacker can be `maxUnseenCourt` (13) and the secondary attacker `secondMaxUnseenCourt` (12),
        // so a 24-pt [Q, Q] stack is recognized as vulnerable to a 25-pt [K, Q] convergence!
        const secondUnrevCourt = opBelief.secondMaxUnseenCourt || expectedUnrevCourt;
        const uSetupMass = globalBeliefTracker.getSetupMass(opFaction, opUnitSq[u]);
        const isPureReserveSpawn = uSetupMass < 0.25 && myAcesOnSq === 0;
        const reserveMaxPts = Math.min(11, maxUnseenCourt);
        const reserveExpectedPts = Math.min(
          11,
          Math.max(9, Math.round(opBelief.expectedReserveCourt || 10))
        );
        const pts =
          r !== -1
            ? rankPoints(r)
            : myAcesOnSq > 0
            ? maxUnseenCourt
            : isPureReserveSpawn
            ? d === 1 && top1_0 === 0
              ? reserveMaxPts
              : reserveExpectedPts
            : d === 1 && top1_0 === 0
            ? maxUnseenCourt
            : d <= 2
            ? secondUnrevCourt
            : expectedUnrevCourt;

        if (d === 1 && (r === 0 || opUnitCanJoker[u])) {
          opHasJokerAtD1 = true;
        }

        // Count Ace candidates per enemy square: allow up to 2 on a multi-card setup stack with setupMass >= 0.95
        // (such as Black's [QC, AS, AC] stack at (4,4) or [Jkr*, AS, AC] at (3,5)!) and lower threshold when our square
        // holds a Joker (`myJokersOnSq > 0`) so 2-Ace Rule-1 convergence is ALWAYS detected!
        const uSq = opUnitSq[u];
        const uDepth = opFaction === 0 ? uSq % 7 : 6 - (uSq % 7);
        const maxAcesFromUSq =
          uSetupMass >= 1.35 || (myJokersOnSq > 0 && postBoard[uSq].length >= 2 && uSetupMass >= 0.9)
            ? 2
            : 1;
        if (
          r === 1 ||
          (opUnitCanAce[u] &&
            (opBelief.tileAceProb[uSq] >= (myJokersOnSq > 0 ? 0.18 : 0.34) ||
              (uDepth <= 1 && opBelief.tileAceProb[uSq] >= 0.2)) &&
            seenAceCandCountOnSq[uSq] < maxAcesFromUSq)
        ) {
          seenAceCandCountOnSq[uSq]++;
          reachAceCands.push({
            d,
            pAce: r === 1 ? 1.0 : Math.max(opBelief.tileAceProb[uSq], myJokersOnSq > 0 && uSetupMass >= 0.95 ? 0.38 : 0),
          });
        }

        // Rule 2 & Rule 3: A single enemy Ace kills ANY non-Joker stack AND trades with a defending Joker
        // (destroying the entire stack including any friendly Ace on the same square!)
        // However, if our square has a Joker and NO friendly Ace, 1 enemy Ace attacking it dies in a 1-for-1 trade (good for us!).
        if (r === 1) {
          if (myJokersOnSq === 0) {
            canKillOurStack = true;
            killedByEnemyAce = true;
            opponentSurvivesCounter = true;
            canKillWithGuaranteedCard = true;
            if (d < minKillDist) minKillDist = d;
          } else if (myAcesOnSq > 0) {
            canKillOurStack = true;
            killedByEnemyAce = true;
            opponentSurvivesCounter = false;
            canKillWithGuaranteedCard = true;
            if (d < minKillDist) minKillDist = d;
          }
        } else if (opUnitCanAce[u]) {
          // Unrevealed enemy setup card within 3 steps can be a hidden enemy Ace (even if we have a Joker on sq!)
          // Combine independent origin squares via complement probability `1 - prod(1 - w)` so 2-3 setup cards in range
          // accumulate their true joint probability of holding at least 1 enemy Ace!
          const pAce = opBelief.tileAceProb[opUnitSq[u]];
          if (pAce >= 0.16) {
            const distFactor = d === 1 ? 1.0 : d === 2 ? 0.76 : 0.45;
            const w = Math.min(0.92, distFactor * pAce);
            if (!seenUnrevAceThreatOrigin[opUnitSq[u]]) {
              seenUnrevAceThreatOrigin[opUnitSq[u]] = 1;
              unrevealedAceNoHitProb *= 1.0 - w;
              unrevealedAceThreatWeight = Math.max(unrevealedAceThreatWeight, 1.0 - unrevealedAceNoHitProb);
            } else {
              unrevealedAceThreatWeight = Math.max(unrevealedAceThreatWeight, w);
            }
            if (d < minUnrevAceDist) minUnrevAceDist = d;
          }
        }

        if (myJokersOnSq === 0) {
          if (myDefTotal === 1 && (r === 0 || opUnitCanJoker[u])) {
            canKillOurStack = true;
            if (r === 0) canKillWithGuaranteedCard = true;
            if (d < minKillDist) minKillDist = d;
          }
        }

        if (r === -1) allCounterCardsRevealed = false;

        if (d === 1) {
          if (pts >= top1_0) {
            top1_2 = top1_1;
            top1_1 = top1_0;
            top1_0 = pts;
          } else if (pts >= top1_1) {
            top1_2 = top1_1;
            top1_1 = pts;
          } else if (pts > top1_2) {
            top1_2 = pts;
          }
        } else if (d === 2) {
          if (pts >= top2_0) {
            top2_1 = top2_0;
            top2_0 = pts;
          } else if (pts > top2_1) {
            top2_1 = pts;
          }
        } else if (d === 3) {
          if (pts > top3_0) top3_0 = pts;
        }
      }

      // Rule 1: 2 enemy Aces reaching our Joker square in <= 3 combined steps overwhelm the Joker!
      // Only possible if the opponent actually has 2 Aces remaining in the game!
      let twoAceOverwhelmCred = 0;
      if (myJokersOnSq > 0 && totalOpAcesRemaining >= 2 && reachAceCands.length >= 2) {
        reachAceCands.sort((a, b) => a.d - b.d || b.pAce - a.pAce);
        if (reachAceCands[0].d + reachAceCands[1].d <= 3) {
          canKillOurStack = true;
          opponentSurvivesCounter = true;
          twoAceOverwhelmCred = Math.min(
            1.0,
            Math.sqrt(reachAceCands[0].pAce * reachAceCands[1].pAce) * 1.35
          );
          if (remainingOpRevealedAces >= 2) {
            canKillWithGuaranteedCard = true;
            twoAceOverwhelmCred = 1.0;
          }
        }
      }

      // Exact 3-Move Reachable Point Sum against non-Joker stacks (1-card, 2-card, and 3-card attacks!)
      const max1 = Math.max(top1_0, top2_0, top3_0);
      const max2 = top1_0 > 0 ? top1_0 + Math.max(top1_1, top2_0) : 0;
      const max3 = top1_0 > 0 && top1_1 > 0 && top1_2 > 0 ? top1_0 + top1_1 + top1_2 : 0;
      const maxReachableOppPts = Math.max(max1, max2, max3);

      if (myJokersOnSq === 0 && maxReachableOppPts >= myDefTotal) {
        canKillOurStack = true;
        if (top1_0 >= myDefTotal || max2 >= myDefTotal || max3 >= myDefTotal) {
          minKillDist = Math.min(minKillDist, 1);
        } else if (top2_0 >= myDefTotal) {
          minKillDist = Math.min(minKillDist, 2);
        } else {
          minKillDist = Math.min(minKillDist, 3);
        }
        if (maxReachableOppPts > myDefTotal) {
          opponentSurvivesCounter = true;
        }
        // Rank-Independent Card-Count Dominance Theorem:
        // Since every regular card is in [9, 13], 2 regular cards are in [18, 26] (> any 1-card piece <= 13 AND
        // > any 2-card [Ace + Court] stack <= 14!), and 3 regular cards are in [27, 38] (> any 2-card stack <= 26).
        // Conversely, by the 1-Tile Buffer Theorem, if there is >= 1 empty tile between `sq` and all enemy cards,
        // `opMaxReachCards[sq] <= 1` (at most 13 court pts), making any 14+ pt stack 100% immune to court cards!
        const guaranteedByCardCountDominance =
          (myDefTotal <= 17 && opMaxReachCards[sq] >= 2 && !opHasJokerAtD1) ||
          (myLen === 2 && myDefTotal <= 26 && opMaxReachCards[sq] >= 3 && !opHasJokerAtD1);
        if (allCounterCardsRevealed || guaranteedByCardCountDominance) {
          canKillWithGuaranteedCard = true;
        }
      }

      const myStackMaterial = myLen * 6400 + myDefTotal * 195;

      // Exact 3-Micro-Move Turn-After Friendly Avenger & Active Reinforcement Knapsack:
      // Evaluate how much friendly force from other squares (`oSq !== sq`) can converge on `sq`
      // on our Turn-After (`Turn T+2`) to either:
      //   1) Avenge/recapture `sq` if the enemy captures `sq` on `Turn T+1`, OR
      //   2) Actively reinforce `sq` (up to `4 - myLen` cards) against a 2-turn enemy siege (`opTwoTurnPts[sq]`)!
      const sx = (sq / 7) | 0;
      const sy = sq % 7;
      let fTop1_0 = 0;
      let fTop1_1 = 0;
      let fTop1_2 = 0;
      let fTop2_0 = 0;
      let fTop2_1 = 0;
      let fTop3_0 = 0;
      let adjFriendlyAces = 0;
      let fAceDist0 = 99;
      let fAceDist1 = 99;
      let fJokerDist = 99;
      let hasAvengerWithin3 = false;
      for (let oSq = 0; oSq < 49; oSq++) {
        if (oSq === sq) continue;
        const nt = postBoard[oSq];
        if (nt.length === 0) continue;
        const nx = (oSq / 7) | 0;
        const ny = oSq % 7;
        const dToSq = Math.max(Math.abs(sx - nx), Math.abs(sy - ny));
        if (dToSq > 3) continue;
        const oHasMyAce = nt.some((c) => c.owner === myFaction && c.rank === 1);
        const oMyCnt = nt.filter((c) => c.owner === myFaction).length;
        const oAceThreatened =
          oHasMyAce && (opAceReachProb[oSq] >= 0.22 || opMaxReachCards[oSq] >= 1);
        for (let k = 0; k < nt.length; k++) {
          const fc = nt[k];
          if (fc.owner !== myFaction) continue;
          hasAvengerWithin3 = true;
          if (fc.rank === 1) {
            if (dToSq === 1) adjFriendlyAces++;
            if (dToSq <= fAceDist0) {
              fAceDist1 = fAceDist0;
              fAceDist0 = dToSq;
            } else if (dToSq < fAceDist1) {
              fAceDist1 = dToSq;
            }
          } else if (fc.rank === 0) {
            if (dToSq < fJokerDist) fJokerDist = dToSq;
          } else {
            // Do not count the sole bodyguard of a threatened friendly Ace as free to leave its Ace naked!
            if (oAceThreatened && oMyCnt <= 2) continue;
            const pts = rankPoints(fc.rank);
            if (dToSq === 1) {
              if (pts >= fTop1_0) {
                fTop1_2 = fTop1_1;
                fTop1_1 = fTop1_0;
                fTop1_0 = pts;
              } else if (pts >= fTop1_1) {
                fTop1_2 = fTop1_1;
                fTop1_1 = pts;
              } else if (pts > fTop1_2) {
                fTop1_2 = pts;
              }
            } else if (dToSq === 2) {
              if (pts >= fTop2_0) {
                fTop2_1 = fTop2_0;
                fTop2_0 = pts;
              } else if (pts > fTop2_1) {
                fTop2_1 = pts;
              }
            } else if (dToSq === 3) {
              if (pts > fTop3_0) fTop3_0 = pts;
            }
          }
        }
      }
      const avMax1 = Math.max(fTop1_0, fTop2_0, fTop3_0);
      const avMax2 = fTop1_0 > 0 ? fTop1_0 + Math.max(fTop1_1, fTop2_0) : 0;
      const avMax3 = fTop1_0 > 0 && fTop1_1 > 0 && fTop1_2 > 0 ? fTop1_0 + fTop1_1 + fTop1_2 : 0;
      const avMaxReachPts = Math.max(avMax1, avMax2, avMax3);
      const reinforceCap = Math.max(0, 4 - myLen);
      const myReinforcePts =
        reinforceCap === 0
          ? 0
          : reinforceCap === 1
          ? avMax1
          : reinforceCap === 2
          ? Math.max(avMax1, avMax2)
          : avMaxReachPts;

      // Minimum enemy point sum that must land on `sq` to capture our stack of strength `myDefTotal`:
      const enemyCapturesWithMultiStack = max2 >= myDefTotal && max1 < myDefTotal;
      const minEnemyCommitPts =
        max1 >= myDefTotal ? max1 : max2 >= myDefTotal ? max2 : Math.max(myDefTotal, max3);
      const hasSpareAceAvenger =
        !opHasJokerAtD1 && fAceDist0 <= 3 && remainingMyAces.length > myAcesOnSq;
      const hasCrossfireAvenger =
        adjFriendlyAces >= 1 ||
        fAceDist0 + fAceDist1 <= 3 ||
        hasSpareAceAvenger ||
        (!opHasJokerAtD1 && avMaxReachPts >= minEnemyCommitPts && avMaxReachPts >= 12);

      if (canKillOurStack) {
        if (myAcesOnSq > 0) {
          const isLastAce = remainingMyAces.length <= myAcesOnSq;
          const aceIsRevealed = t.some((c) => c.owner === myFaction && c.rank === 1 && c.revealed);
          const aceDepth = myFaction === 0 ? sy : 6 - sy;
          // Armor Survival Credit:
          // Court armor (`KH`, `QH`) ONLY protects an Ace against non-Ace court attackers!
          // Under Rule 3 & Rule 2, an attacking enemy Ace (`killedByEnemyAce`) kills `[AH, KH]` or `[AD, Jkr*]` regardless of court points!
          // Furthermore, when `isLastAce === true`, a tie-trade (`!opponentSurvivesCounter`) STILL kills our last Ace and loses the game on the spot!
          const tieOnlyDiscount =
            !isLastAce && !opponentSurvivesCounter && !killedByEnemyAce && myLen >= 2 ? 0.56 : 1.0;
          const armorDefenseCredit =
            !isLastAce && !killedByEnemyAce && myJokersOnSq === 0 && myLen >= 2
              ? Math.min(20, myDefTotal - 1) * 3600
              : 0;

          let rawAcePen = 0;
          if (minKillDist === 1) {
            condemnedSq[sq] = 1;
            rawAcePen =
              Math.round(
                ((isLastAce ? 650000 : 145000 * myAcesOnSq) +
                  85000 +
                  (opHasJokerAtD1 ? 45000 : 0)) *
                  tieOnlyDiscount
              ) - armorDefenseCredit;
          } else if (minKillDist === 2) {
            condemnedSq[sq] = 1;
            if (aceIsRevealed || canKillWithGuaranteedCard) {
              rawAcePen =
                Math.round(
                  ((isLastAce ? 580000 : 128000 * myAcesOnSq) + 35000) * tieOnlyDiscount
                ) - armorDefenseCredit;
            } else {
              rawAcePen =
                Math.round((isLastAce ? 155000 : 52000 * myAcesOnSq) * tieOnlyDiscount) -
                (hasCrossfireAvenger && !isLastAce ? 12000 : 0) -
                armorDefenseCredit;
            }
          } else {
            // minKillDist === 3 (e.g. enemy card 3 steps away from our Ace)
            if (aceIsRevealed || canKillWithGuaranteedCard) {
              condemnedSq[sq] = 1;
              rawAcePen =
                Math.round((isLastAce ? 540000 : 115000 * myAcesOnSq) * tieOnlyDiscount) -
                armorDefenseCredit;
            } else if (myLen === 1) {
              if (aceDepth >= 1) {
                // NEVER step a naked Ace off the back row (`aceDepth >= 1`, like (0,1) in Game 1!) within d=3 of an enemy piece!
                condemnedSq[sq] = 1;
                rawAcePen = isLastAce ? 320000 : 95000;
              } else {
                // An unrevealed 1-card Ace on our home row (`aceDepth === 0`) when `minKillDist === 3` (midline y=3)
                // is camouflaged among our back-row cards and protected by adjacent avengers — do not panic-split power stacks!
                rawAcePen = isLastAce
                  ? 48000
                  : killedByEnemyAce
                  ? 18000
                  : hasCrossfireAvenger
                  ? 2200
                  : 6500;
              }
            } else {
              // `myLen >= 2` (a 2-card [Ace, Guard] crown on the back row is visible as a 2-card stack to the opponent!):
              rawAcePen =
                Math.round((isLastAce ? 95000 : 38000 * myAcesOnSq) * tieOnlyDiscount) -
                Math.round(armorDefenseCredit * 0.45);
            }
          }

          // Law-3 Unrevealed Enemy Ace Threat Check on `myAcesOnSq > 0`:
          // Because an attacking enemy Ace ignores court armor under Law 3 (`[AH, JH]` or `[AH, KH]` dies to a 1-pt enemy Ace!),
          // ALWAYS fold in `unrevealedAceThreatWeight` even when `canKillOurStack` was triggered by court points!
          if (unrevealedAceThreatWeight > 0 && (minUnrevAceDist <= 3 || aceIsRevealed || myJokersOnSq > 0)) {
            if (
              (minUnrevAceDist <= 2 && unrevealedAceThreatWeight >= 0.22) ||
              (minUnrevAceDist === 3 && (unrevealedAceThreatWeight >= 0.30 || myLen >= 2 || isLastAce))
            ) {
              condemnedSq[sq] = 1;
            }
            const jokerOnAceMult = myJokersOnSq > 0 ? 1.45 : myLen >= 2 ? 1.25 : 1.0;
            const distScale = minUnrevAceDist <= 2 ? 1.0 : aceIsRevealed || myLen >= 2 ? 0.85 : 0.45;
            const law3UnrevAcePen = Math.round(
              (isLastAce ? 195000 : 92000 * myAcesOnSq) *
                unrevealedAceThreatWeight *
                jokerOnAceMult *
                distScale
            );
            if (law3UnrevAcePen > rawAcePen) {
              rawAcePen = law3UnrevAcePen;
            }
          }

          if (rawAcePen > 0) {
            if (isLastAce || firstThreatenedMyAceDist === 99) {
              firstThreatenedMyAceDist = minKillDist;
              aceAndJokerThreatPenalty += Math.max(4000, rawAcePen);
            } else if (firstThreatenedMyAceDist + minKillDist <= 3) {
              // True simultaneous 3-move double-Ace fork (e.g. d=1 + d<=2)!
              aceAndJokerThreatPenalty += Math.max(4000, rawAcePen);
            } else {
              // Since a turn only has 3 micro-moves, two separated Aces with d0 + d1 > 3 CANNOT both be killed in 1 turn!
              aceAndJokerThreatPenalty += Math.round(Math.max(4000, rawAcePen) * 0.25);
            }
          }
        } else if (myJokersOnSq > 0) {
          // Rule-1 2-Ace Overwhelm Threat against our Joker stack (e.g. marching [Jkr*, KD] to (2,4) in front of 2 enemy Aces!):
          if (canKillWithGuaranteedCard || twoAceOverwhelmCred >= 0.34) {
            condemnedSq[sq] = 1;
            const jokerStackVal = myStackMaterial + 18000;
            aceAndJokerThreatPenalty += Math.round(
              jokerStackVal * (canKillWithGuaranteedCard ? 1.0 : Math.max(0.62, twoAceOverwhelmCred))
            );
          } else {
            aceAndJokerThreatPenalty += 2200;
          }
        } else if (opponentSurvivesCounter) {
          // Phase 2 Static Exchange Evaluation (SEE) & Anti-Bait Recapture Protection:
          // 3 enemy cards at d=1 (max3 > myDefTotal) have a minimum possible court sum of 9+9+9=27 > 26,
          // so 3 adjacent enemy cards overwhelm any 2-card non-Joker stack with 100% certainty!
          const overwhelmedByThreeAtD1 =
            top1_0 > 0 && top1_1 > 0 && top1_2 > 0 && top1_0 + top1_1 + top1_2 > myDefTotal;
          const multiCardConvergenceAtD1 = top1_0 > 0 && top1_1 > 0 && top1_0 + top1_1 > myDefTotal;
          if (
            canKillWithGuaranteedCard ||
            myLen === 1 ||
            overwhelmedByThreeAtD1 ||
            multiCardConvergenceAtD1
          ) {
            condemnedSq[sq] = 1;
          }
          let pen =
            canKillWithGuaranteedCard || overwhelmedByThreeAtD1
              ? Math.round(
                  myStackMaterial * (overwhelmedByThreeAtD1 && !canKillWithGuaranteedCard ? 0.92 : 1.0)
                )
              : multiCardConvergenceAtD1
              ? Math.round(myStackMaterial * 0.78)
              : myLen >= 2 && myDefTotal >= 25
              ? Math.round(myStackMaterial * 0.56)
              : myLen >= 2 && myDefTotal === 24
              ? Math.round(myStackMaterial * 0.72)
              : Math.round(myStackMaterial * 0.88);
          if (hasCrossfireAvenger) {
            pen = Math.round(pen * 0.68);
          }
          // Anti-Bait & Anti-Merge Concession Veto:
          // Never sacrifice a 2+ card royal stack (myDefTotal >= 20) or a lone 1-card court piece (`myLen === 1`, e.g. KD -> (2,4))
          // to capture a 1-card enemy bait piece when the opponent can immediately converge 2+ cards (`opMaxReachCards[sq] >= 2`),
          // killing our piece AND merging a 2-card offensive stack on `sq` for free!
          if (capturedLowBaitOnSq[sq] === 1) {
            if (myLen >= 2 && myDefTotal >= 20) {
              pen += 14500;
              condemnedSq[sq] = 1;
            } else if (myLen === 1 && myDefTotal >= 11) {
              pen += opMaxReachCards[sq] >= 2 ? 15500 : 6800;
              condemnedSq[sq] = 1;
            }
          } else if (myLen === 1 && myDefTotal >= 12 && opMaxReachCards[sq] >= 2) {
            // Even on a non-capture move, parking a lone King/Queen inside a 2-card enemy convergence zone (`opMaxReachCards >= 2`)
            // hands the enemy a free capture + stack merge!
            pen += 6400;
            condemnedSq[sq] = 1;
          }
          // Stepping-Stone Into Ace Check Theorem:
          // When our non-Ace piece/stack on `sq` is killed (`condemnedSq[sq] === 1 && opponentSurvivesCounter`),
          // the recapturing enemy piece lands ON `sq` at the end of the opponent's turn!
          // If `sq` is at Chebyshev distance <= 3 from a naked friendly Ace (such as `(2,3)` at d=3 from `AH` at `(2,0)` on Turn 16!),
          // feeding our stack onto `sq` gives the enemy a free tempo-advance ("Stepping Stone") into 1-turn lethal range of our Ace!
          if (condemnedSq[sq] === 1) {
            for (let a = 0; a < remainingMyAces.length; a++) {
              const aSq = remainingMyAces[a];
              if (aSq === sq) continue;
              const ax = (aSq / 7) | 0;
              const ay = aSq % 7;
              const dSqToAce = Math.max(Math.abs(sx - ax), Math.abs(sy - ay));
              const aTile = postBoard[aSq];
              const myCntOnAce = aTile.filter((c) => c.owner === myFaction).length;
              if (
                (myCntOnAce === 1 && dSqToAce <= 3) ||
                (myCntOnAce >= 2 && dSqToAce <= 1 && (opAceReachProb[sq] >= 0.35 || opMaxReachPts[sq] >= 14))
              ) {
                pen += remainingMyAces.length === 1 ? 48000 : 22000;
                break;
              }
            }
          }
          if (myLen >= 2 && myJokersOnSq === 0 && minUnrevAceDist <= 2 && unrevealedAceThreatWeight > 0) {
            const stackIsRevealed = t.every((c) => c.owner !== myFaction || c.revealed);
            const baitMult =
              capturedLowBaitOnSq[sq] === 1
                ? 1.75
                : stackIsRevealed
                ? 1.3
                : hasAvengerWithin3
                ? 0.82
                : 1.0;
            const baseScale = minUnrevAceDist === 1 ? 0.85 : 0.62;
            const unrevAcePen = Math.round(
              myStackMaterial * baseScale * baitMult * unrevealedAceThreatWeight +
                (capturedLowBaitOnSq[sq] === 1 ? 14500 * unrevealedAceThreatWeight : 0)
            );
            if (
              (minUnrevAceDist === 1 && unrevealedAceThreatWeight >= 0.3) ||
              (minUnrevAceDist <= 2 && unrevealedAceThreatWeight >= 0.38 && !hasAvengerWithin3) ||
              (minUnrevAceDist <= 2 && unrevealedAceThreatWeight >= 0.48) ||
              (capturedLowBaitOnSq[sq] === 1 && unrevealedAceThreatWeight >= 0.25)
            ) {
              condemnedSq[sq] = 1;
            }
            if (unrevAcePen > pen) pen = unrevAcePen;
          }
          nonAceStackThreats.push(pen);
        } else {
          // Opponent can only TIE our stack (both sides destroyed in mutual trade)
          const minOppCardsToTie = max1 >= myDefTotal ? 1 : max2 >= myDefTotal ? 2 : 3;
          const oppSacrificeVal = minOppCardsToTie * 4400 + myDefTotal * 140;
          let pen = Math.max(800, myStackMaterial - oppSacrificeVal + 800);
          if (myLen >= 2 && myJokersOnSq === 0 && minUnrevAceDist <= 2 && unrevealedAceThreatWeight > 0) {
            const stackIsRevealed = t.every((c) => c.owner !== myFaction || c.revealed);
            const baitMult =
              capturedLowBaitOnSq[sq] === 1
                ? 1.75
                : stackIsRevealed
                ? 1.3
                : hasAvengerWithin3
                ? 0.82
                : 1.0;
            const baseScale = minUnrevAceDist === 1 ? 0.85 : 0.62;
            const unrevAcePen = Math.round(
              myStackMaterial * baseScale * baitMult * unrevealedAceThreatWeight +
                (capturedLowBaitOnSq[sq] === 1 ? 14500 * unrevealedAceThreatWeight : 0)
            );
            if (
              (minUnrevAceDist === 1 && unrevealedAceThreatWeight >= 0.3) ||
              (minUnrevAceDist <= 2 && unrevealedAceThreatWeight >= 0.38 && !hasAvengerWithin3) ||
              (minUnrevAceDist <= 2 && unrevealedAceThreatWeight >= 0.48) ||
              (capturedLowBaitOnSq[sq] === 1 && unrevealedAceThreatWeight >= 0.25)
            ) {
              condemnedSq[sq] = 1;
            }
            if (unrevAcePen > pen) pen = unrevAcePen;
          }
          nonAceStackThreats.push(pen);
        }
      } else if (unrevealedAceThreatWeight > 0) {
        if (myAcesOnSq > 0) {
          const isLastAce = remainingMyAces.length <= myAcesOnSq;
          const aceIsRevealed = t.some((c) => c.owner === myFaction && c.rank === 1 && c.revealed);
          if (minUnrevAceDist <= 3 || aceIsRevealed || myJokersOnSq > 0) {
            if (
              (minUnrevAceDist <= 2 && unrevealedAceThreatWeight >= 0.22) ||
              (minUnrevAceDist === 3 && unrevealedAceThreatWeight >= 0.32)
            ) {
              condemnedSq[sq] = 1;
            }
            const jokerOnAceMult = myJokersOnSq > 0 ? 1.45 : 1.0;
            const distScale = minUnrevAceDist <= 2 ? 1.0 : aceIsRevealed ? 0.85 : 0.55;
            aceAndJokerThreatPenalty += Math.round(
              (isLastAce ? 195000 : 88000 * myAcesOnSq) *
                unrevealedAceThreatWeight *
                jokerOnAceMult *
                distScale
            );
          }
        } else if (myJokersOnSq > 0 && myLen === 1) {
          // Rule 1: A lone 1-card Defending Joker is killed FOR FREE by a single Attacking Ace!
          // Never park a lone Joker within range of a high-probability unrevealed enemy Ace!
          aceAndJokerThreatPenalty += Math.round(24000 * unrevealedAceThreatWeight);
        } else if (myJokersOnSq > 0 && myLen >= 2 && totalOpAcesRemaining >= 2 && minUnrevAceDist <= 2) {
          // Phase 4 Rule-2 Joker Trade Protection:
          // When opponent has 2 Aces, they can trade 1 Ace into our multi-card Joker stack to wipe out
          // both our Joker and our Court card!
          aceAndJokerThreatPenalty += Math.round(
            (remainingMyAces.length <= 1 ? 14500 : 8500) * unrevealedAceThreatWeight
          );
        } else if (myLen === 1 && myJokersOnSq === 0) {
          // A lone 1-card court piece stepping within 3 steps of an unrevealed enemy Ace is easy prey!
          nonAceStackThreats.push(Math.round(myStackMaterial * 0.85 * unrevealedAceThreatWeight));
        } else if (myLen >= 2 && myJokersOnSq === 0 && minUnrevAceDist <= 2) {
          // Phase 2 Anti-Bait & Assassin-Ace Protection for 2+ card non-Joker stacks (such as revealed [KD, QD] at (6,5)):
          // Under Rule 3, a single enemy Ace within d <= 2 steps can walk onto our non-Joker royal stack and destroy ALL cards for free!
          const stackIsRevealed = t.every((c) => c.owner !== myFaction || c.revealed);
          const baitMult =
            capturedLowBaitOnSq[sq] === 1
              ? 1.75
              : stackIsRevealed
              ? 1.3
              : hasAvengerWithin3
              ? 0.82
              : 1.0;
          const baseScale = minUnrevAceDist === 1 ? 0.88 : 0.65;
          if (
            (minUnrevAceDist === 1 && unrevealedAceThreatWeight >= 0.3) ||
            (minUnrevAceDist <= 2 && unrevealedAceThreatWeight >= 0.38 && !hasAvengerWithin3) ||
            (minUnrevAceDist <= 2 && unrevealedAceThreatWeight >= 0.48) ||
            (capturedLowBaitOnSq[sq] === 1 && unrevealedAceThreatWeight >= 0.25)
          ) {
            condemnedSq[sq] = 1;
          }
          nonAceStackThreats.push(
            Math.round(
              myStackMaterial * baseScale * baitMult * unrevealedAceThreatWeight +
                (capturedLowBaitOnSq[sq] === 1 ? 14500 * unrevealedAceThreatWeight : 0)
            )
          );
        }
      } else if (
        myAcesOnSq > 0 &&
        myJokersOnSq === 0 &&
        ((top2_0 > 0 && top2_1 > 0 && top2_0 + top2_1 >= myDefTotal) ||
          opTwoTurnPts[sq] >= myDefTotal)
      ) {
        // 2-Turn Enemy Siege vs. Friendly Reinforcement Balance on Our Ace:
        // Compare the enemy's 2-turn staged convergence (`opTwoTurnPts[sq]`) against our Ace's current defense
        // PLUS our 1-turn active friendly reinforcement capacity (`myDefTotal + myReinforcePts`)!
        const isLastAce = remainingMyAces.length <= myAcesOnSq;
        const unreinforceableTwoTurnSiege =
          opTwoTurnPts[sq] >= myDefTotal + myReinforcePts && fJokerDist > 2;
        if (unreinforceableTwoTurnSiege) {
          aceAndJokerThreatPenalty += isLastAce ? 46000 : 26000;
        } else {
          aceAndJokerThreatPenalty += isLastAce ? 24000 : 13500;
        }
      } else if (
        myLen >= 2 &&
        myAcesOnSq === 0 &&
        myJokersOnSq === 0 &&
        opTwoTurnPts[sq] > myDefTotal + myReinforcePts &&
        opTwoTurnCards[sq] >= myLen + 1 &&
        fAceDist0 > 3 &&
        fJokerDist > 2
      ) {
        // Isolated 2+ card friendly Citadel facing an overwhelming 2-turn enemy convergence (`opTwoTurnPts > myDefTotal + myReinforcePts`)
        // with no friendly Ace or Joker reinforcement in range!
        nonAceStackThreats.push(Math.round(myStackMaterial * 0.22));
      }
    }

    if (nonAceStackThreats.length > 1) {
      nonAceStackThreats.sort((a, b) => b - a);
    }
    threatPenalty =
      aceAndJokerThreatPenalty +
      (nonAceStackThreats[0] || 0) +
      Math.round((nonAceStackThreats[1] || 0) * 0.85) +
      Math.round((nonAceStackThreats[2] || 0) * 0.65);
  } else {
    // Part 1.2: Intermediate-Step (Move 1 & Move 2) Fast Ace-Safety Awareness!
    // Ensures moves that evacuate, armor, or block threats to our Aces are NEVER pruned at Step 1 or Step 2!
    for (let a = 0; a < remainingMyAces.length; a++) {
      const aSq = remainingMyAces[a];
      const ax = (aSq / 7) | 0;
      const ay = aSq % 7;
      const aTile = postBoard[aSq];
      const aDepth = myFaction === 0 ? ay : 6 - ay;
      let myDefPts = 0;
      let myCntOnAce = 0;
      let myHasJoker = false;
      let aceIsRev = false;
      for (let k = 0; k < aTile.length; k++) {
        if (aTile[k].owner === myFaction) {
          myCntOnAce++;
          if (aTile[k].rank === 0) myHasJoker = true;
          if (aTile[k].rank === 1 && aTile[k].revealed) aceIsRev = true;
          myDefPts += rankPoints(aTile[k].rank);
        }
      }
      const isCamouflagedHomeAce =
        !aceIsRev && aDepth === 0 && myCntOnAce === 1 && remainingMyAces.length >= 2;
      let canEnemyReachAndKillAce = false;
      let d1EnemyPts = 0;
      let d2BestEnemyPts = 0;
      for (let eSq = 0; eSq < 49; eSq++) {
        const eTile = postBoard[eSq];
        if (eTile.length === 0) continue;
        const ex = (eSq / 7) | 0;
        const ey = eSq % 7;
        const dCheb = Math.max(Math.abs(ax - ex), Math.abs(ay - ey));
        if (dCheb < 1 || dCheb > 3) continue;
        // Obstacle-Aware Intermediate-Step Reachability:
        // Enemy cards cannot step through squares occupied by our friendly screening cards without stopping for combat!
        let d = 99;
        if (dCheb === 1) {
          d = 1;
        } else if (dCheb === 2) {
          for (let dx1 = -1; dx1 <= 1 && d > 2; dx1++) {
            const mx1 = ex + dx1;
            if (mx1 < 0 || mx1 >= 7 || Math.abs(mx1 - ax) > 1) continue;
            for (let dy1 = -1; dy1 <= 1; dy1++) {
              if (dx1 === 0 && dy1 === 0) continue;
              const my1 = ey + dy1;
              if (my1 < 0 || my1 >= 7 || Math.abs(my1 - ay) > 1) continue;
              if (!postBoard[mx1 * 7 + my1].some((c) => c.owner === myFaction)) {
                d = 2;
                break;
              }
            }
          }
        } else {
          for (let dx1 = -1; dx1 <= 1 && d > 3; dx1++) {
            const mx1 = ex + dx1;
            if (mx1 < 0 || mx1 >= 7 || Math.abs(mx1 - ax) > 2) continue;
            for (let dy1 = -1; dy1 <= 1 && d > 3; dy1++) {
              if (dx1 === 0 && dy1 === 0) continue;
              const my1 = ey + dy1;
              if (my1 < 0 || my1 >= 7 || Math.abs(my1 - ay) > 2) continue;
              if (postBoard[mx1 * 7 + my1].some((c) => c.owner === myFaction)) continue;
              for (let dx2 = -1; dx2 <= 1; dx2++) {
                const mx2 = mx1 + dx2;
                if (mx2 < 0 || mx2 >= 7 || Math.abs(mx2 - ax) > 1) continue;
                for (let dy2 = -1; dy2 <= 1; dy2++) {
                  if (dx2 === 0 && dy2 === 0) continue;
                  const my2 = my1 + dy2;
                  if (my2 < 0 || my2 >= 7 || Math.abs(my2 - ay) > 1) continue;
                  if (!postBoard[mx2 * 7 + my2].some((c) => c.owner === myFaction)) {
                    d = 3;
                    break;
                  }
                }
              }
            }
          }
        }
        if (d > 3) continue;
        for (let k = 0; k < eTile.length; k++) {
          const ec = eTile[k];
          if (ec.owner !== opFaction) continue;
          const er = ec.rank;
          const ePts = er !== -1 ? rankPoints(er) : maxUnseenCourt;
          if (er === 1 || (er === -1 && opBelief.tileAceProb[eSq] >= 0.35)) {
            canEnemyReachAndKillAce = true;
          } else if (!myHasJoker && (!isCamouflagedHomeAce || d <= 2)) {
            if (ePts >= myDefPts) canEnemyReachAndKillAce = true;
            if (d === 1) d1EnemyPts += ePts;
            else if (d === 2 && ePts > d2BestEnemyPts) d2BestEnemyPts = ePts;
          }
        }
      }
      if (!myHasJoker && d1EnemyPts > 0 && d1EnemyPts + d2BestEnemyPts >= myDefPts) {
        canEnemyReachAndKillAce = true;
      }
      // Do NOT penalize a Hunter Ace on an intermediate step (Step 1 or Step 2) when we have 2 Aces (or are hunting an enemy Ace)
      // and this Ace is at d <= 2 of an enemy 2+ card non-Joker stack or enemy Ace that it is actively marching to assassinate THIS turn!
      // ALSO do not slam a full -240,000 penalty on Step 1 when another friendly piece just stepped to d=1 of the threatening
      // enemy piece to execute it on Step 2 (such as KD (3,1)->(3,2)->(3,3) killing Black's AC at (3,3) on Turn 23!).
      let isActiveAssassinationMarch = false;
      let threatBeingCounterKilled = false;
      if (canEnemyReachAndKillAce) {
        for (let eSq = 0; eSq < 49; eSq++) {
          const eTile = postBoard[eSq];
          if (eTile.length === 0) continue;
          const ex = (eSq / 7) | 0;
          const ey = eSq % 7;
          const d = Math.max(Math.abs(ax - ex), Math.abs(ay - ey));
          if (d >= 1 && d <= 3 && eTile.some((c) => c.owner === opFaction)) {
            const eHasRevJoker = eTile.some((c) => c.owner === opFaction && c.rank === 0);
            const eHasAce =
              eTile.some((c) => c.owner === opFaction && c.rank === 1) ||
              opBelief.tileAceProb[eSq] >= 0.35;
            const eOpCnt = eTile.filter((c) => c.owner === opFaction).length;
            if (
              myDefPts === 1 &&
              d <= 2 &&
              ((remainingMyAces.length >= 2 && eOpCnt >= 2 && !eHasRevJoker) || eHasAce)
            ) {
              isActiveAssassinationMarch = true;
              break;
            }
            // Check if an unlocked friendly card is now adjacent (d=1) to `eSq` and strong enough to kill it on the next micro-move!
            let eDefPts = 0;
            for (let k = 0; k < eTile.length; k++) {
              if (eTile[k].owner === opFaction) {
                eDefPts += eTile[k].rank !== -1 ? rankPoints(eTile[k].rank) : maxUnseenCourt;
              }
            }
            for (let dx = -1; dx <= 1; dx++) {
              const nx = ex + dx;
              if (nx < 0 || nx >= 7) continue;
              for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const ny = ey + dy;
                if (ny < 0 || ny >= 7) continue;
                const mTile = postBoard[nx * 7 + ny];
                for (let k = 0; k < mTile.length; k++) {
                  const mc = mTile[k];
                  if (
                    mc.owner === myFaction &&
                    !mc.locked &&
                    !eHasRevJoker &&
                    (mc.rank === 1 || rankPoints(mc.rank) > eDefPts)
                  ) {
                    threatBeingCounterKilled = true;
                    break;
                  }
                }
              }
            }
          }
        }
      }
      if (canEnemyReachAndKillAce && !isActiveAssassinationMarch) {
        if (threatBeingCounterKilled) {
          threatPenalty += remainingMyAces.length === 1 ? 35000 : 18000;
        } else {
          threatPenalty += remainingMyAces.length === 1 ? 240000 : 85000;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2.5. Exact Next-Turn 3-Move Lethal Strike & Check Reachability (Ply-2/3 Vision)
  // -------------------------------------------------------------------------
  let nextTurnStrikeBonus = 0;
  if (!isIntermediateStep) {
    const mySurvSq: number[] = [];
    const mySurvRank: number[] = [];
    let numMyDistMaps = 0;
    const mySqToMapIdx = new Int32Array(49).fill(-1);

    for (let i = 0; i < 49; i++) {
      if (condemnedSq[i]) continue;
      const t = postBoard[i];
      let hasMine = false;
      for (let j = 0; j < t.length; j++) {
        if (t[j].owner === myFaction) {
          hasMine = true;
          break;
        }
      }
      if (!hasMine) continue;

      const mIdx = numMyDistMaps++;
      const dMap = MY_DIST_MAP_POOL[mIdx] || new Int8Array(49);
      computeStepDistancesFast(postBoard, myFaction, i, dMap);
      mySqToMapIdx[i] = mIdx;

      for (let j = 0; j < t.length; j++) {
        const c = t[j];
        if (c.owner === myFaction) {
          mySurvSq.push(i);
          mySurvRank.push(c.rank);
        }
      }
    }

    const numMySurv = mySurvSq.length;
    const expCourtS25 = Math.round(opBelief.expectedUnseenCourt || 11);
    const secondCourtS25 = Math.min(12, Math.round(opBelief.secondMaxUnseenCourt || expCourtS25));
    for (let eSq = 0; eSq < 49; eSq++) {
      const t = postBoard[eSq];
      let opLen = 0;
      let opKnownPts = 0;
      let opUnrevCnt = 0;
      let opHasJoker = false;
      let opHasAce = false;
      for (let j = 0; j < t.length; j++) {
        const c = t[j];
        if (c.owner === opFaction) {
          opLen++;
          if (c.rank === 0) opHasJoker = true;
          else if (c.rank === 1) opHasAce = true;
          if (c.rank !== -1) opKnownPts += rankPoints(c.rank);
          else opUnrevCnt++;
        }
      }
      if (opLen === 0) continue;

      const pAce = opHasAce ? 1.0 : opBelief.tileAceProb[eSq];
      // Conditioned on `eSq` holding an unrevealed enemy Ace, 1 of the unrevealed cards is the Ace (1 pt)
      // and any 2nd unrevealed card is a court guard (<= maxUnseenCourt, so <= 14 pts total for a 2-card Ace stack!):
      const opDefPtsGivenAce =
        opKnownPts +
        (opUnrevCnt > 0
          ? (opHasAce ? expCourtS25 : 1) +
            (opUnrevCnt >= 2 ? maxUnseenCourt : 0) +
            Math.max(0, opUnrevCnt - 2) * 10
          : 0);
      const opDefPtsGivenNoAce =
        opKnownPts +
        (opUnrevCnt > 0
          ? expCourtS25 +
            (opUnrevCnt >= 2 ? secondCourtS25 : 0) +
            Math.max(0, opUnrevCnt - 2) * 10
          : 0);
      const opDefPts =
        !opHasAce && pAce >= 0.35 && opUnrevCnt > 0
          ? Math.round(pAce * opDefPtsGivenAce + (1 - pAce) * opDefPtsGivenNoAce)
          : opDefPtsGivenNoAce;
      let mTop1_0 = 0;
      let mTop1_1 = 0;
      let mTop1_2 = 0;
      let mTop2_0 = 0;
      let mTop2_1 = 0;
      let mTop2_2 = 0;
      let mTop3_0 = 0;
      let mTop3_1 = 0;
      let mTop4_0 = 0;
      let mReachAces = 0;
      let mTwoTurnAces = 0;
      let mAceD0 = 99;
      let mAceD1 = 99;
      let mReachJoker = 0;

      for (let u = 0; u < numMySurv; u++) {
        const d = MY_DIST_MAP_POOL[mySqToMapIdx[mySurvSq[u]]][eSq];
        if (d < 1 || d > 4) continue;
        const r = mySurvRank[u];
        const pts = rankPoints(r);
        if (r === 1) {
          if (d <= 3 && (d <= 2 || pAce < 0.35)) mReachAces++;
          if (d <= 4) {
            mTwoTurnAces++;
            if (d <= mAceD0) {
              mAceD1 = mAceD0;
              mAceD0 = d;
            } else if (d < mAceD1) {
              mAceD1 = d;
            }
          }
        } else if (r === 0) {
          if (d <= 3) mReachJoker++;
        }

        if (d === 1) {
          if (pts >= mTop1_0) {
            mTop1_2 = mTop1_1;
            mTop1_1 = mTop1_0;
            mTop1_0 = pts;
          } else if (pts >= mTop1_1) {
            mTop1_2 = mTop1_1;
            mTop1_1 = pts;
          } else if (pts > mTop1_2) {
            mTop1_2 = pts;
          }
        } else if (d === 2) {
          if (pts >= mTop2_0) {
            mTop2_2 = mTop2_1;
            mTop2_1 = mTop2_0;
            mTop2_0 = pts;
          } else if (pts >= mTop2_1) {
            mTop2_2 = mTop2_1;
            mTop2_1 = pts;
          } else if (pts > mTop2_2) {
            mTop2_2 = pts;
          }
        } else if (d === 3) {
          if (pts >= mTop3_0) {
            mTop3_1 = mTop3_0;
            mTop3_0 = pts;
          } else if (pts > mTop3_1) {
            mTop3_1 = pts;
          }
        } else if (d === 4) {
          if (pts > mTop4_0) mTop4_0 = pts;
        }
      }

      const mMax1 = Math.max(mTop1_0, mTop2_0, mTop3_0);
      const mMax2 = mTop1_0 > 0 ? mTop1_0 + Math.max(mTop1_1, mTop2_0) : 0;
      const mMax3 = mTop1_0 > 0 && mTop1_1 > 0 && mTop1_2 > 0 ? mTop1_0 + mTop1_1 + mTop1_2 : 0;
      const mReachPts = Math.max(mMax1, mMax2, mMax3);

      // Exact 2-Turn (6-Move Staging + Turn-After Reinforcement) Offensive Convergence on `eSq`:
      let md12_0 = 0;
      let md12_1 = 0;
      let md12_2 = 0;
      const md12Arr = [mTop1_0, mTop1_1, mTop1_2, mTop2_0, mTop2_1, mTop2_2];
      for (let k = 0; k < 6; k++) {
        const v = md12Arr[k];
        if (v <= 0) continue;
        if (v >= md12_0) {
          md12_2 = md12_1;
          md12_1 = md12_0;
          md12_0 = v;
        } else if (v >= md12_1) {
          md12_2 = md12_1;
          md12_1 = v;
        } else if (v > md12_2) {
          md12_2 = v;
        }
      }
      const mTwo2 = Math.max(
        md12_0 + md12_1,
        md12_0 > 0 && mTop3_0 > 0 ? md12_0 + mTop3_0 : 0,
        mTop3_0 > 0 && mTop3_1 > 0 ? mTop3_0 + mTop3_1 : 0,
        mTop1_0 > 0 && mTop4_0 > 0 ? mTop1_0 + mTop4_0 : 0
      );
      const mTwo3 = Math.max(
        md12_0 + md12_1 + md12_2,
        mTop1_0 > 0 && mTop1_1 > 0 ? mTop1_0 + mTop1_1 + Math.max(mTop3_0, mTop4_0) : 0,
        mTop1_0 > 0 && mTop2_0 > 0 && mTop3_0 > 0 ? mTop1_0 + mTop2_0 + mTop3_0 : 0
      );
      const mTwo4 = Math.max(
        mTop1_0 > 0 && mTop1_1 > 0 && mTop1_2 > 0 && Math.max(mTop2_0, mTop3_0) > 0
          ? mTop1_0 + mTop1_1 + mTop1_2 + Math.max(mTop2_0, mTop3_0)
          : 0,
        mTop1_0 > 0 && mTop1_1 > 0 && mTop2_0 > 0 && mTop2_1 > 0
          ? mTop1_0 + mTop1_1 + mTop2_0 + mTop2_1
          : 0
      );
      const mTwoTurnReachPts = Math.max(mReachPts, mTop4_0, mTwo2, mTwo3, mTwo4);

      // Enemy 1-Turn Defensive Reinforcement Capacity onto `eSq` (subject to 4-card stack cap):
      const maxEnemyReinforceCards = Math.min(4 - opLen, opMaxReachCards[eSq]);
      const opReinforcePtsOnESq =
        maxEnemyReinforceCards <= 0
          ? 0
          : Math.min(opMaxReachPts[eSq], maxEnemyReinforceCards * maxUnseenCourt);

      const canKillNextTurn =
        (!opHasJoker && mReachPts > opDefPts) ||
        (!opHasJoker && pAce >= 0.38 && mReachPts > opDefPtsGivenAce) ||
        (!opHasJoker && mReachAces >= 1 && pAce >= 0.55) ||
        (opHasJoker && mReachAces >= 2 && pAce >= 0.55) ||
        (!opHasJoker && opDefPts === 1 && mReachJoker >= 1 && pAce >= 0.55);

      if (canKillNextTurn) {
        const unstoppableEvenIfReinforced =
          (!opHasJoker && mReachPts > opDefPts + opReinforcePtsOnESq) ||
          (!opHasJoker && mReachAces >= 1 && pAce >= 0.55) ||
          (opHasJoker && mReachAces >= 2);
        const wave2OverwhelmsReinforcement =
          !opHasJoker && mTwoTurnReachPts > opDefPts + opReinforcePtsOnESq;
        if (pAce >= 0.35) {
          // Verified 1-turn lethal check on an enemy Ace from our uncondemned surviving stacks!
          nextTurnStrikeBonus += 15500 * pAce;
          if (maxEnemyReinforceCards === 0) {
            nextTurnStrikeBonus += 3200 * pAce;
          }
          if (unstoppableEvenIfReinforced) {
            nextTurnStrikeBonus += 4600 * pAce;
          } else if (wave2OverwhelmsReinforcement) {
            nextTurnStrikeBonus += 2800 * pAce;
          }
          // Extra bonus if we have >= 2 cards at d === 1 so the enemy Ace + guard cannot escape by stepping 1 square!
          if (mTop1_0 > 0 && mTop1_1 > 0 && mTop1_0 + mTop1_1 > opDefPtsGivenAce) {
            nextTurnStrikeBonus += 6500 * pAce;
          }
        } else {
          nextTurnStrikeBonus +=
            opLen * 1400 +
            (maxEnemyReinforceCards === 0 ? 450 : 0) +
            (unstoppableEvenIfReinforced && opLen >= 2 ? 1100 : wave2OverwhelmsReinforcement && opLen >= 2 ? 650 : 0);
        }
      } else {
        // Turn-After Reinforced Siege (2-Turn Horizon):
        // Even when a 2-card power stack (e.g. [K, Q] = 25 pts) or multi-stack convergence at d = 2..3
        // cannot deliver all cards in 1 turn (since 2 cards * 2 steps = 4 > 3 micro-moves),
        // evaluate whether staging + Turn-After Reinforcement (`mTwoTurnReachPts`) cracks `eSq`!
        const canKillInTwoTurns =
          (!opHasJoker && mTwoTurnReachPts > opDefPts) ||
          (!opHasJoker && mTwoTurnAces >= 1 && pAce >= 0.48) ||
          (opHasJoker && mAceD0 + mAceD1 <= 5 && pAce >= 0.35);
        if (canKillInTwoTurns) {
          const beatsEnemyReinforcement =
            (!opHasJoker && mTwoTurnReachPts > opDefPts + Math.round(opReinforcePtsOnESq * 0.65)) ||
            (opHasJoker && mAceD0 + mAceD1 <= 5);
          const safeD2CitadelSiege = mTop2_0 > 0 && mTop2_1 > 0 && mTop2_0 + mTop2_1 > opDefPts;
          if (pAce >= 0.32) {
            nextTurnStrikeBonus += Math.round(
              (6400 +
                (safeD2CitadelSiege ? 3600 : 0) +
                (beatsEnemyReinforcement ? 3200 : 0)) *
                pAce
            );
          } else if (opLen >= 2) {
            nextTurnStrikeBonus +=
              1650 + (safeD2CitadelSiege ? 850 : 0) + (beatsEnemyReinforcement ? 950 : 0);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Strategic Formation, Ace Armor, Stack Synergy & Ace-Hunting Gradient
  // -------------------------------------------------------------------------
  let positionalScore = 0;

  const enemyTargetIdx: number[] = [];
  const enemyTargetWeight: number[] = [];
  const enemyTargetLone: boolean[] = [];
  const enemyTargetCards: number[] = [];
  const enemyTargetDefPts: number[] = [];
  const enemyTargetHasJoker: boolean[] = [];
  const allEnemySquares: number[] = [];
  const expCourtForTarget = Math.round(opBelief.expectedUnseenCourt || 11);
  const secondCourtForTarget = Math.min(12, Math.round(opBelief.secondMaxUnseenCourt || expCourtForTarget));

  for (let i = 0; i < 49; i++) {
    const t = postBoard[i];
    let opLen = 0;
    let opKnownPts = 0;
    let opUnrevCnt = 0;
    let hasRevAce = false;
    let hasRevJoker = false;
    let revOpCourtOnSq = 0;
    for (let j = 0; j < t.length; j++) {
      const c = t[j];
      if (c.owner === opFaction) {
        opLen++;
        if (c.rank === 1) hasRevAce = true;
        else if (c.rank === 0) hasRevJoker = true;
        if (c.rank !== -1) opKnownPts += rankPoints(c.rank);
        else opUnrevCnt++;
        // Board-Wide Information Asymmetry Bonus:
        // Every revealed enemy card on the board eliminates opponent bluff potential and gives our solver exact ranks!
        if (c.revealed || c.rank !== -1) {
          if (c.rank === 1) {
            positionalScore += 4800; // Revealed enemy Ace is a known high-priority bullseye!
          } else if (c.rank === 0) {
            positionalScore += 4200; // Revealed enemy Joker has lost its surprise trap value!
          } else {
            revOpCourtOnSq++;
            positionalScore += 950;
          }
        }
      }
    }
    const rawTileAceProb = hasRevAce ? 1.0 : opBelief.tileAceProb[i];
    let opDefPts = opKnownPts;
    if (opUnrevCnt > 0) {
      if (!hasRevAce && rawTileAceProb >= 0.38) {
        const ptsAce = 1 + (opUnrevCnt >= 2 ? maxUnseenCourt : 0) + Math.max(0, opUnrevCnt - 2) * 10;
        const ptsNoAce =
          expCourtForTarget +
          (opUnrevCnt >= 2 ? secondCourtForTarget : 0) +
          Math.max(0, opUnrevCnt - 2) * 10;
        opDefPts += Math.round(rawTileAceProb * ptsAce + (1 - rawTileAceProb) * ptsNoAce);
      } else {
        opDefPts +=
          expCourtForTarget +
          (opUnrevCnt >= 2 ? secondCourtForTarget : 0) +
          Math.max(0, opUnrevCnt - 2) * 10;
      }
    }
    if (hasRevAce && revOpCourtOnSq > 0) {
      // Knowing the exact armor rank covering a revealed enemy Ace lets our stacks calculate the exact kill threshold!
      positionalScore += revOpCourtOnSq * 550;
    }
    if (opLen === 0) continue;
    allEnemySquares.push(i);
    const ey = i % 7;
    const opDepth = opFaction === 0 ? ey : 6 - ey;

    // Pure target weight based on Ace probability & enemy home-row setup origin:
    // Keep enemy Aces and back-row setup citadels as the primary bullseyes so our deep offensive stacks
    // NEVER turn around to chase a lone reserve decoy in our backfield!
    let pAce = hasRevAce ? 2.15 : opBelief.tileAceProb[i];
    if (opDepth <= 1 && globalBeliefTracker.canSquareHoldSetupAce(opFaction, i)) {
      pAce = Math.max(pAce * 1.32, opLen >= 2 ? 0.68 : 0.56);
    } else if (globalBeliefTracker.canSquareHoldSetupAce(opFaction, i)) {
      pAce = Math.max(pAce, 0.24);
    } else {
      pAce = Math.max(pAce, 0.14);
    }
    enemyTargetIdx.push(i);
    enemyTargetWeight.push(pAce);
    enemyTargetLone.push(opLen === 1);
    enemyTargetCards.push(opLen);
    enemyTargetDefPts.push(opDefPts);
    enemyTargetHasJoker.push(hasRevJoker);
  }

  // Ban on stacking both friendly Aces on the same square, EXCEPT when they just executed a Rule-1 2-Ace Joker kill
  // (`rule1KillSq[a0] === 1`) or are shielded on `a0` by our own friendly Joker (`[AC, AS, Jkr*]`)!
  if (remainingMyAces.length === 2) {
    const a0 = remainingMyAces[0];
    const a1 = remainingMyAces[1];
    if (a0 === a1) {
      const shieldedByFriendlyJoker =
        postBoard[a0].some((c) => c.owner === myFaction && c.rank === 0) && !condemnedSq[a0];
      if ((rule1KillSq[a0] === 1 && !condemnedSq[a0]) || shieldedByFriendlyJoker) {
        positionalScore -= 16000;
      } else {
        positionalScore -= 450000;
      }
    } else {
      const ax0 = (a0 / 7) | 0;
      const ay0 = a0 % 7;
      const ax1 = (a1 / 7) | 0;
      const ay1 = a1 % 7;
      const aceDist = Math.max(Math.abs(ax0 - ax1), Math.abs(ay0 - ay1));
      if (aceDist >= 2) positionalScore += 3200;
    }
  }

  const myNonAceSingleSquares: number[] = [];
  let occupiedBackRowSquares = 0;
  let totalMyBoardCards = 0;
  let myUnrevealedBackAces = 0;
  let myUnrevealedBackNonAceDecoys = 0;
  let myNonAceTwoCardStacks = 0;

  for (let sq = 0; sq < 49; sq++) {
    const t = postBoard[sq];
    if (t.length === 0) continue;
    const sy = sq % 7;
    const sDepth = myFaction === 0 ? sy : 6 - sy;
    let mLen = 0;
    let mHasAce = false;
    let mAllUnrev = true;
    for (let k = 0; k < t.length; k++) {
      if (t[k].owner === myFaction) {
        mLen++;
        if (t[k].rank === 1) mHasAce = true;
        if (t[k].revealed) mAllUnrev = false;
      }
    }
    if (mLen === 1 && mAllUnrev && sDepth <= 1) {
      if (mHasAce) myUnrevealedBackAces++;
      else myUnrevealedBackNonAceDecoys++;
    } else if (mLen >= 2 && !mHasAce) {
      myNonAceTwoCardStacks++;
    }
  }

  // Phase 2 Shell-Game Decoy Entropy Bonus:
  // When our Ace(s) on depth <= 1 are unrevealed (`myUnrevealedBackAces >= 1`) AND we maintain at least 1
  // unrevealed 1-card non-Ace decoy on depth <= 1 (`myUnrevealedBackNonAceDecoys >= 1`), the opponent sees
  // multiple identical face-down 1-card squares on our home rows and cannot tell which square is the Ace!
  if (!isIntermediateStep && myUnrevealedBackAces >= 1 && myUnrevealedBackNonAceDecoys >= 1) {
    positionalScore += Math.min(2, myUnrevealedBackNonAceDecoys) * 2800;
  }

  for (let x = 0; x < 7; x++) {
    for (let y = 0; y < 7; y++) {
      const idx = x * 7 + y;
      const t = postBoard[idx];
      if (t.length === 0) continue;

      let myLen = 0;
      let hasAce = false;
      let hasUnrevealedAce = false;
      let hasJoker = false;
      let hasUnrevealedJoker = false;
      let defTotal = 0;
      let nonAceCount = 0;

      for (let j = 0; j < t.length; j++) {
        const c = t[j];
        if (c.owner === myFaction) {
          myLen++;
          if (c.rank === 1) {
            hasAce = true;
            if (!c.revealed) hasUnrevealedAce = true;
          } else {
            nonAceCount++;
            if (c.rank === 0) {
              hasJoker = true;
              if (!c.revealed) hasUnrevealedJoker = true;
            }
          }
          defTotal += rankPoints(c.rank);
        }
      }
      if (myLen === 0) continue;

      totalMyBoardCards += myLen;
      const depth = myFaction === 0 ? y : 6 - y;
      if (depth === 0) occupiedBackRowSquares++;

      // Condemned stacks (about to be killed on the opponent's turn) do not collect full positional value!
      const survScale = condemnedSq[idx] ? 0.2 : 1.0;

      positionalScore += Math.round((myLen * 2800 + defTotal * 90) * survScale);

      // Preserve hidden identity of our Aces and Joker!
      if (hasUnrevealedAce) positionalScore += 4200;
      if (hasUnrevealedJoker) positionalScore += 3600;

      // Count adjacent friendly non-Ace cards (Chebyshev distance === 1) for guard readiness & phalanx crossfire
      let adjFriendlyNonAceCards = 0;
      let adjFriendlyMaxRank = 0;
      let adjFriendlyJokerOnScreen = false;
      let adjFriendlyJokerDisguised = false;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= 7) continue;
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const ny = y + dy;
          if (ny < 0 || ny >= 7) continue;
          const nt = postBoard[nx * 7 + ny];
          let ntMyLen = 0;
          let ntHasJoker = false;
          let ntJokerRevealed = false;
          for (let k = 0; k < nt.length; k++) {
            if (nt[k].owner === myFaction) {
              ntMyLen++;
              if (nt[k].rank !== 1) {
                adjFriendlyNonAceCards++;
                if (nt[k].rank === 0) {
                  ntHasJoker = true;
                  if (nt[k].revealed) ntJokerRevealed = true;
                }
                const rPts = rankPoints(nt[k].rank);
                if (rPts > adjFriendlyMaxRank) adjFriendlyMaxRank = rPts;
              }
            }
          }
          if (ntHasJoker) {
            adjFriendlyJokerOnScreen = true;
            if (ntMyLen >= 2 || ntJokerRevealed) {
              adjFriendlyJokerDisguised = true;
            }
          }
        }
      }

      if (hasAce) {
        if (depth === 0) positionalScore += 2200;
        else if (depth === 1) positionalScore += hasUnrevealedAce ? 1600 : 600;
        else positionalScore -= (depth - 1) * 4200;

        // Hard Law-2 Suicide Veto:
        // Stacking our Joker on the SAME square as our Ace while the opponent still has >= 1 Ace
        // allows a single enemy Ace to kill BOTH our Joker AND our Ace in 1 blow AND acts as a giant beacon!
        if (hasJoker && totalOpAcesRemaining >= 1 && rule1KillSq[idx] === 0) {
          positionalScore -= remainingMyAces.length === 1 || !hasUnrevealedAce ? 165000 : 95000;
        }

        // Phase 3 Flood-Fill Voronoi Safe Escape Volume for our Ace:
        // Count 1-step and 2-step safe escape squares that are not controlled by an enemy Ace or stronger enemy stack!
        if (!isIntermediateStep) {
          let safeStep1 = 0;
          let safeStep2Voronoi = 0;
          const step1SafeList: number[] = [];
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= 7) continue;
            for (let dy = -1; dy <= 1; dy++) {
              if (dx === 0 && dy === 0) continue;
              const ny = y + dy;
              if (ny < 0 || ny >= 7) continue;
              const escSq = nx * 7 + ny;
              const escTile = postBoard[escSq];
              let myCntEsc = 0;
              let opPtsEsc = 0;
              for (let k = 0; k < escTile.length; k++) {
                if (escTile[k].owner === myFaction) myCntEsc++;
                else opPtsEsc += escTile[k].rank !== -1 ? rankPoints(escTile[k].rank) : maxUnseenCourt;
              }
              if (myCntEsc >= 4 || opPtsEsc > 0) continue;
              // Use the 49-Tile Enemy 3-Move Reachability Field (`opMaxReachPts`, `opMaxReachCards`, `opAceReachProb`)
              // in addition to immediate d=1 adjacency so an escape square inside the enemy's 3-move convergence zone
              // or 3-move Ace strike zone is never misclassified as safe!
              let dangerAtEsc =
                opAceReachProb[escSq] >= 0.35 ||
                opMaxReachPts[escSq] >= defTotal ||
                (myLen === 1 && opMaxReachCards[escSq] >= 1);
              if (!dangerAtEsc) {
                for (let e = 0; e < allEnemySquares.length; e++) {
                  const eSq = allEnemySquares[e];
                  const ex = (eSq / 7) | 0;
                  const ey = eSq % 7;
                  if (Math.max(Math.abs(nx - ex), Math.abs(ny - ey)) <= 1) {
                    const eTile = postBoard[eSq];
                    let eSum = 0;
                    let eHasAce = false;
                    for (let k = 0; k < eTile.length; k++) {
                      const ec = eTile[k];
                      if (ec.owner === opFaction) {
                        if (
                          ec.rank === 1 ||
                          (ec.rank === -1 && opBelief.tileAceProb[eSq] >= 0.35)
                        ) {
                          eHasAce = true;
                        }
                        eSum += ec.rank !== -1 ? rankPoints(ec.rank) : maxUnseenCourt;
                      }
                    }
                    if (eHasAce || eSum >= defTotal) {
                      dangerAtEsc = true;
                      break;
                    }
                  }
                }
              }
              if (!dangerAtEsc) {
                safeStep1++;
                step1SafeList.push(escSq);
              }
            }
          }
          // Expand 1 more step from safeStep1 squares to measure 2-step Voronoi safe escape volume
          const seenVoronoi = new Uint8Array(49);
          seenVoronoi[idx] = 1;
          for (let s = 0; s < step1SafeList.length; s++) {
            seenVoronoi[step1SafeList[s]] = 1;
            safeStep2Voronoi++;
          }
          for (let s = 0; s < step1SafeList.length; s++) {
            const s1Sq = step1SafeList[s];
            const s1x = (s1Sq / 7) | 0;
            const s1y = s1Sq % 7;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = s1x + dx;
              if (nx < 0 || nx >= 7) continue;
              for (let dy = -1; dy <= 1; dy++) {
                const ny = s1y + dy;
                if (ny < 0 || ny >= 7) continue;
                const s2Sq = nx * 7 + ny;
                if (seenVoronoi[s2Sq]) continue;
                const s2Tile = postBoard[s2Sq];
                if (s2Tile.some((c) => c.owner === opFaction)) continue;
                seenVoronoi[s2Sq] = 1;
                safeStep2Voronoi++;
              }
            }
          }
          if (safeStep1 === 0) {
            positionalScore -= remainingMyAces.length === 1 ? 38000 : 18000;
          } else if (safeStep2Voronoi <= 2) {
            positionalScore -= (3 - safeStep2Voronoi) * 7500;
          }
        }

        let minEnemyDistToAce = 99;
        let enemyAceWithin3 = false;
        let shadowScreenBonus = 0;
        for (let e = 0; e < allEnemySquares.length; e++) {
          const eSq = allEnemySquares[e];
          const ex = (eSq / 7) | 0;
          const ey = eSq % 7;
          const dCheb = Math.max(Math.abs(x - ex), Math.abs(y - ey));
          const dBfs =
            !isIntermediateStep && sqToDistMapIdx[eSq] >= 0
              ? OP_DIST_MAP_POOL[sqToDistMapIdx[eSq]][idx]
              : dCheb;
          const dEff = dBfs <= 3 ? dBfs : Math.max(4, dCheb);
          if (dEff < minEnemyDistToAce) minEnemyDistToAce = dEff;

          const eTile = postBoard[eSq];
          let eIsAceThreat = false;
          for (let k = 0; k < eTile.length; k++) {
            if (
              eTile[k].owner === opFaction &&
              (eTile[k].rank === 1 || (eTile[k].rank === -1 && opBelief.tileAceProb[eSq] >= 0.25))
            ) {
              eIsAceThreat = true;
            }
          }
          if (dEff <= 3 && eIsAceThreat) {
            enemyAceWithin3 = true;
          }
          // Geodesic Shadow-Screen Obstruction Theorem (`dBfs > dCheb`):
          // Only reward blocking the shortest Chebyshev corridor if the enemy is at `dCheb <= 2` (or our Ace is revealed / last Ace / eIsAceThreat)
          // AND we did NOT create the block by feeding a condemned 1-card sacrificial piece adjacent to `eSq`!
          if (
            !isIntermediateStep &&
            dCheb <= 3 &&
            dBfs > dCheb &&
            (dCheb <= 2 || !hasUnrevealedAce || remainingMyAces.length === 1 || eIsAceThreat)
          ) {
            let hasCondemnedBlockerAdjToE = false;
            for (let dxB = -1; dxB <= 1 && !hasCondemnedBlockerAdjToE; dxB++) {
              const bx = ex + dxB;
              if (bx < 0 || bx >= 7) continue;
              for (let dyB = -1; dyB <= 1; dyB++) {
                if (dxB === 0 && dyB === 0) continue;
                const by = ey + dyB;
                if (by < 0 || by >= 7) continue;
                if (condemnedSq[bx * 7 + by]) {
                  hasCondemnedBlockerAdjToE = true;
                  break;
                }
              }
            }
            if (!hasCondemnedBlockerAdjToE) {
              if (dBfs > 3) {
                shadowScreenBonus += eIsAceThreat ? 4200 : 1800;
              } else {
                shadowScreenBonus += eIsAceThreat ? 2400 : 1100;
              }
            }
          }
        }
        if (shadowScreenBonus > 0) {
          positionalScore += Math.min(9600, shadowScreenBonus);
        }

        // Phase 2 & 4 Disguised Adjacent Joker Interceptor Zoning:
        // Only reward an adjacent Joker screen when the Joker is disguised inside a 2-card [Court, Jkr*] stack,
        // OR when an enemy is within d <= 3 of our Ace, OR when our Ace/Joker is already revealed!
        // Never park a lone 1-card unrevealed Joker next to an unthreatened unrevealed Ace as a giant flare!
        if (!hasJoker && adjFriendlyJokerOnScreen) {
          if (adjFriendlyJokerDisguised || minEnemyDistToAce <= 3 || !hasUnrevealedAce) {
            positionalScore += 6800;
          }
        }

        const isIntermediateHunterAce =
          isIntermediateStep &&
          myLen === 1 &&
          minEnemyDistToAce <= 2 &&
          (remainingMyAces.length >= 2 || enemyAceWithin3);

        // NEVER strip the court-card armor off an already-revealed friendly Ace (leaving a 1-pt bullseye)!
        if (!hasUnrevealedAce && myLen === 1 && !isIntermediateHunterAce) {
          positionalScore -= 42000;
        }

        // Phase 2 Stealth Ace Concealment & Anti-Beacon Law:
        // When our Ace is UNREVEALED (`hasUnrevealedAce`) and no enemy piece is within d <= 3 (`minEnemyDistToAce > 3`),
        // KEEP our Ace as a 1-card concealed piece (`myLen === 1`) so it looks identical to any reserve/decoy card,
        // and NEVER put a solo 2-card crown on an unthreatened unrevealed Ace (`turnNumber > 10`) that screams "Here is my Ace!"
        if (myLen === 1) {
          if (minEnemyDistToAce <= 2 && !isIntermediateHunterAce) {
            positionalScore -= 24000;
          } else {
            positionalScore +=
              (hasUnrevealedAce ? 4600 : 3200) + (adjFriendlyNonAceCards >= 1 ? 1800 : 0);
          }
          // Guard Convergence Gradient:
          // When our Ace is ALREADY revealed (`!hasUnrevealedAce`) and unarmored (`myLen === 1`),
          // pull our closest friendly court card toward our naked Ace so it converges and armors it!
          if (!hasUnrevealedAce) {
            let minGuardDist = 99;
            let bestGuardRank = 0;
            for (let gSq = 0; gSq < 49; gSq++) {
              if (gSq === idx) continue;
              const gt = postBoard[gSq];
              for (let k = 0; k < gt.length; k++) {
                if (gt[k].owner === myFaction && gt[k].rank >= 9) {
                  const gx = (gSq / 7) | 0;
                  const gy = gSq % 7;
                  const gd = Math.max(Math.abs(x - gx), Math.abs(y - gy));
                  if (gd < minGuardDist || (gd === minGuardDist && gt[k].rank > bestGuardRank)) {
                    minGuardDist = gd;
                    bestGuardRank = gt[k].rank;
                  }
                }
              }
            }
            if (minGuardDist <= 5) {
              positionalScore += (6 - minGuardDist) * 2600 + bestGuardRank * 140;
            }
          }
        } else if (myLen === 2) {
          if (hasJoker) {
            if (totalOpAcesRemaining === 0) {
              positionalScore += 4800;
            }
          } else if (
            minEnemyDistToAce <=
              (hasUnrevealedAce && depth === 0 && remainingMyAces.length >= 2 && !enemyAceWithin3
                ? 2
                : 3) ||
            !hasUnrevealedAce ||
            remainingMyAces.length === 1 ||
            myNonAceTwoCardStacks >= 2
          ) {
            positionalScore += defTotal >= 13 ? 5200 : 3800;
            // 1-Tile Buffer Court-Immunity Bonus:
            // When at least 1 empty tile separates our [Ace + King] (14 pts) from all enemy cards,
            // the 3-move budget caps enemy attacks at `opMaxReachCards[idx] <= 1` card (max 13 court pts < 14),
            // making our 14-pt Ace citadel 100% immune to ALL enemy court cards regardless of how many enemy
            // cards sit at d=2 or d=3!
            if (defTotal >= 14 && opMaxReachCards[idx] <= 1 && opAceReachProb[idx] < 0.25) {
              positionalScore += 3400;
            }
          } else {
            // Anti-Beacon Law: When our Ace is unrevealed (`hasUnrevealedAce`), we still have 2 Aces,
            // no enemy is within d <= 3, and we don't have >= 2 other 2-card stacks to camouflage it,
            // do NOT put a lone 2-card crown on our unrevealed Ace that tells the human where our Ace is!
            positionalScore -= 3200;
          }
        } else if (myLen >= 3) {
          // Penalize hoarding 3+ cards on a home-row Ace (ties up court cards and makes the stack immobile!)
          positionalScore -= (myLen - 1) * 5800;
        }

        // Smooth Enemy Proximity Repulsion: our Ace prefers being farther from enemy pieces!
        // (For an unrevealed 1-card home-row Ace when we have both Aces, only repulse when `minEnemyDistToAce <= 2`
        //  so a midline card at `d = 3` never causes the bot to split its power stacks into sacrificial blockers!)
        const isCamouflagedHomeAce =
          hasUnrevealedAce && depth === 0 && myLen === 1 && remainingMyAces.length >= 2 && !enemyAceWithin3;
        if (
          minEnemyDistToAce <= (isCamouflagedHomeAce ? 2 : 3) &&
          !isIntermediateHunterAce
        ) {
          positionalScore -= (4 - minEnemyDistToAce) * 4800;
        }
      } else {
        if (myLen === 1 && !condemnedSq[idx]) {
          myNonAceSingleSquares.push(idx);
          // On intermediate steps (Move 1 or Move 2 of 3), bridge stack-in-transit value so moving a 2/3-card stack
          // 1 card at a time is never penalized before the partner card arrives on the next micro-move!
          if (isIntermediateStep && adjFriendlyMaxRank >= 10 && defTotal + adjFriendlyMaxRank >= 22) {
            positionalScore += 3400;
          }
        }

        // Phalanx Crossfire Support Bonus in the midfield
        if (depth >= 1 && adjFriendlyNonAceCards > 0 && !condemnedSq[idx]) {
          positionalScore += Math.min(3, adjFriendlyNonAceCards) * 520;
        }

        // Steep Non-Ace 2-Card & Phalanx Stack Scoring (strongly prefers 24-26 pt K+Q / K+J / Q+Q stacks and Joker+Court phalanxes!)
        if (nonAceCount >= 2 && !condemnedSq[idx]) {
          if (defTotal >= 24) {
            positionalScore += 5200 + (defTotal - 24) * 400;
          } else if (defTotal >= 22) {
            positionalScore += 3800 + (defTotal - 22) * 350;
          } else if (defTotal >= 20) {
            positionalScore += 2400 + (defTotal - 20) * 300;
          } else if (defTotal >= 18) {
            positionalScore += 1500;
          }
          // Joker-shielded Phalanx (Joker + King = 14 pts beats any lone card; Joker + 2 court = 22+ pts beats 2-card stacks; both immune to non-Ace counter-attacks!):
          if (hasJoker && myLen <= 3 && defTotal >= 22) {
            positionalScore += 7500;
          } else if (hasJoker && myLen === 2 && defTotal >= 14) {
            positionalScore += 6600;
          } else if (hasJoker && myLen === 2 && defTotal === 13) {
            positionalScore += 5200;
          } else if (hasJoker && myLen <= 3) {
            positionalScore += 2800;
          }
          // Phase 2 Hidden-Joker Camouflage Bonus:
          // When our Joker is UNREVEALED (`hasUnrevealedJoker`) and disguised inside a 2-card non-Ace stack (`myLen === 2`),
          // the human opponent cannot distinguish `[Court, Jkr*]` from a normal 2-card `[K, Q]` stack — setting a lethal Law-4 trap!
          if (hasUnrevealedJoker && myLen === 2) {
            positionalScore += 5400;
          }
          // STRICT 4-CARD STACK BAN: A 4-card stack CANNOT move 1 square in a 3-move turn without splitting and leaving a card behind!
          if (myLen >= 4) {
            positionalScore -= (myLen - 3) * 18000;
          } else if (myLen === 3 && !hasJoker) {
            positionalScore -= 5800;
          }
        }

        // Only 2+ card stacks (or late-endgame units when draw pile is empty) qualify as deep offensive forces on empty squares!
        // Prevents a lone Queen/King from sprinting across the board alone on Turns 2-3 to be eaten by an enemy Ace or stack!
        const isOffensiveForce =
          !condemnedSq[idx] &&
          ((nonAceCount >= 2 && defTotal >= 20) ||
            (hasJoker && myLen >= 2 && defTotal >= 13) ||
            (myDrawAfter === 0 && nonAceCount >= 2 && defTotal >= 18) ||
            (myDrawAfter === 0 && defTotal >= 12 && adjFriendlyNonAceCards >= 1));

        if (isOffensiveForce && enemyTargetIdx.length > 0) {
          let bestTargetBonus = -99999;
          let checksDelivered = 0;
          let forkedEnemyTargets = 0;
          let forkedEnemyCardSum = 0;
          const myCenterDist = Math.max(Math.abs(x - 3), Math.abs(y - 3));

          for (let k = 0; k < enemyTargetIdx.length; k++) {
            const tIdx = enemyTargetIdx[k];
            const tx = (tIdx / 7) | 0;
            const ty = tIdx % 7;
            const chebDist = Math.max(Math.abs(x - tx), Math.abs(y - ty));
            const manhDist = Math.abs(x - tx) + Math.abs(y - ty);
            const targetOpDepth = opFaction === 0 ? ty : 6 - ty;
            // Only apply Home-Defense Interceptor boost to friendly stacks still in our own half (`depth <= 3`)
            // that are within `chebDist <= 3` of an enemy infiltrator (`targetOpDepth >= 4`), so deep offensive
            // spearheads (`depth >= 4`) stay locked onto the opponent's home-row Aces!
            const effTargetWeight =
              targetOpDepth >= 4 && depth <= 3 && chebDist <= 3
                ? Math.max(enemyTargetWeight[k], 0.74)
                : enemyTargetWeight[k];
            const b = (14 - chebDist * 2.4 - manhDist * 0.6) * 450 * (0.45 + effTargetWeight);
            if (b > bestTargetBonus) bestTargetBonus = b;

            const tCards = enemyTargetCards[k];
            const tDefPts = enemyTargetDefPts[k];
            const tHasJoker = enemyTargetHasJoker[k];
            const tAceProb = opBelief.tileAceProb[tIdx];

            // 1. Multi-Target Fork Evacuation Theorem (sum(cards) >= 4 > 3 moves):
            // Moving our stack of `myLen` cards (`<= 3`) by 1 square onto `tIdx` (`chebDist === 1`) costs `myLen` moves.
            // If we can beat `tIdx` and we simultaneously threaten >= 2 enemy targets at `chebDist === 1`,
            // evacuating those targets out of our 3x3 neighborhood costs the opponent `sum(tCards)` moves!
            // When `sum(tCards) >= 4`, the opponent CANNOT evacuate both targets in a 3-move turn!
            if (
              chebDist === 1 &&
              myLen <= 3 &&
              !tHasJoker &&
              defTotal > tDefPts &&
              (hasJoker || tAceProb < 0.45 || myLen >= 2)
            ) {
              forkedEnemyTargets++;
              forkedEnemyCardSum += tCards;
            }

            // 2. 2-Card Stack d=2 Standoff / Zugzwang Theorem ("1-Tile Buffer Tempo"):
            // Two 2-card stacks separated by 1 empty tile (`chebDist === 2`) cannot attack each other with both cards (2+2 = 4 > 3).
            // Holding at `chebDist === 2` while preserving the 1-tile buffer (`opMaxReachCards[idx] <= 1`) puts the enemy
            // 2-card stack in Zugzwang: if they step to d=1 (spending 2 moves), they cannot complete the capture and hand us first-strike!
            if (myLen === 2 && !hasJoker && tCards >= 2) {
              if (chebDist === 2 && opMaxReachCards[idx] <= 1) {
                positionalScore += defTotal <= tDefPts ? 2600 : 1400;
              } else if (
                !isIntermediateStep &&
                chebDist === 1 &&
                defTotal <= tDefPts &&
                adjFriendlyNonAceCards === 0
              ) {
                positionalScore -= 3800;
              }
            }

            // 3. Edge & Corner Escape Compression Theorem (|N_1(T)| in {3, 5, 8} — Inside-Track Shepherding):
            // An edge tile has only 5 neighbors and a corner tile has only 3 neighbors (vs 8 in the interior).
            // Standing at `chebDist <= 2` on the inside track (`myCenterDist <= targetCenterDist`) compresses an enemy Ace against the wall!
            if (tAceProb >= 0.35 && chebDist <= 2) {
              const onXEdge = tx === 0 || tx === 6;
              const onYEdge = ty === 0 || ty === 6;
              if (onXEdge || onYEdge) {
                const targetCenterDist = Math.max(Math.abs(tx - 3), Math.abs(ty - 3));
                if (myCenterDist <= targetCenterDist) {
                  const isCorner = onXEdge && onYEdge;
                  positionalScore += Math.round((isCorner ? 3200 : 1900) * tAceProb);
                }
              }
            }

            // Check & Fork Bonus: A 2-card non-Joker stack delivers a 1-turn check at chebDist === 1 (2 moves total)
            // whenever `defTotal > tDefPts` (note: any 2-card [Ace, Guard] stack has at most 1 + 13 = 14 pts!),
            // whereas a Joker-escorted stack can safely pressure an enemy Ace from chebDist <= 2 (and lethal check at chebDist === 1)!
            if (tAceProb >= 0.3) {
              if (
                chebDist === 1 &&
                ((hasJoker && defTotal >= 13) ||
                  defTotal >= 22 ||
                  (myLen >= 2 && defTotal >= 18 && tCards <= 2 && defTotal > tDefPts))
              ) {
                checksDelivered++;
                positionalScore += 6800 * tAceProb;
              } else if (hasJoker && chebDist === 2 && defTotal >= 13) {
                positionalScore += 2800 * tAceProb;
              }
            }
          }
          if (checksDelivered >= 2) {
            // Double-Check Fork against two enemy Ace candidates simultaneously!
            positionalScore += 5500;
          }
          if (forkedEnemyTargets >= 2) {
            // 4-Move Evacuation Trap: when `forkedEnemyCardSum >= 4`, the opponent only has 3 moves and CANNOT save both stacks!
            if (forkedEnemyCardSum >= 4) {
              positionalScore += 8800;
            } else if (forkedEnemyCardSum === 3) {
              positionalScore += 5400;
            } else {
              positionalScore += 3200;
            }
          }
          const houndMult = totalOpAcesRemaining === 1 ? 1.55 : 1.0;
          positionalScore += Math.round((bestTargetBonus + depth * 380) * houndMult);
        } else if (isIntermediateStep && !condemnedSq[idx]) {
          // Part 1.2: Intermediate-Step Assassination Corridor Bonus so 3-step marches (d=3->2->1) are never penalized mid-turn!
          for (let k = 0; k < enemyTargetIdx.length; k++) {
            if (enemyTargetWeight[k] >= 0.35) {
              const tIdx = enemyTargetIdx[k];
              const tx = (tIdx / 7) | 0;
              const ty = tIdx % 7;
              const chebDist = Math.max(Math.abs(x - tx), Math.abs(y - ty));
              if (chebDist === 1) {
                positionalScore += Math.round(7500 * enemyTargetWeight[k]);
              } else if (chebDist === 2) {
                positionalScore += Math.round(3600 * enemyTargetWeight[k]);
              }
            }
          }
        } else if (!isIntermediateStep && !hasJoker && myLen === 1 && depth >= 3) {
          // Strongly forbid leaving a lone 1-card court piece unsupported across the midline at the END of a turn!
          positionalScore -= adjFriendlyNonAceCards === 0 ? 11500 : 4200;
        } else if (
          !isIntermediateStep &&
          hasJoker &&
          myLen === 1 &&
          (depth >= 2 || opMaxReachCards[idx] >= 1) &&
          totalOpAcesRemaining >= 1
        ) {
          // Never leave a LONE 1-card Joker (`1 pt`) unescorted in the midfield (`depth >= 2`) or inside the enemy's
          // 3-move reachability field (`opMaxReachCards[idx] >= 1`, such as peeling `QH` off `[Jkr*, QH]` on Turn 13!),
          // or the opponent can execute our lone Joker under Rule 1 / Rule 2 without losing a single court card!
          positionalScore -=
            totalOpAcesRemaining >= 2 && (depth >= 3 || opMaxReachCards[idx] >= 2) ? 34000 : 22000;
        } else if (!isIntermediateStep && hasUnrevealedJoker && myLen === 1) {
          // Phase 2 Anti-Telegraph Joker Law:
          // Even on depth <= 1, never leave an unrevealed Joker wandering alone as a 1-card piece when it can be
          // disguised inside a 2-card [Court, Jkr*] stack!
          positionalScore -= 7500;
        }

        if (hasJoker && !condemnedSq[idx]) {
          if ((myLen >= 2 || !hasUnrevealedJoker) && depth >= 2 && depth <= 4 && x >= 2 && x <= 4) {
            positionalScore += 1400;
          }
          for (let k = 0; k < enemyTargetIdx.length; k++) {
            if (enemyTargetLone[k] && enemyTargetWeight[k] >= 0.45) {
              const tIdx = enemyTargetIdx[k];
              const tx = (tIdx / 7) | 0;
              const ty = tIdx % 7;
              const chebDist = Math.max(Math.abs(x - tx), Math.abs(y - ty));
              if (chebDist <= 3) {
                positionalScore += 2600 * enemyTargetWeight[k];
              } else {
                positionalScore += (10 - chebDist) * 280 * enemyTargetWeight[k];
              }
            }
          }
        }
      }
    }
  }

  // Phase 4 Twin-Spearhead Mutual Crossfire & Synchronized Wave Advance Bonus:
  // Reward advancing two 2+ card offensive stacks in mutual support (Chebyshev distance 2..3 apart)
  // so neither stack can be attacked by an enemy Ace or stack without immediate avenger recapture!
  if (!isIntermediateStep) {
    const myOffensiveStacks: Array<{ x: number; y: number; depth: number }> = [];
    for (let sq = 0; sq < 49; sq++) {
      if (condemnedSq[sq]) continue;
      const t = postBoard[sq];
      let cnt = 0;
      let pts = 0;
      let hasAce = false;
      let hasJoker = false;
      for (let k = 0; k < t.length; k++) {
        if (t[k].owner === myFaction) {
          cnt++;
          pts += rankPoints(t[k].rank);
          if (t[k].rank === 1) hasAce = true;
          else if (t[k].rank === 0) hasJoker = true;
        }
      }
      if (!hasAce && cnt >= 2 && (pts >= 20 || (hasJoker && pts >= 13))) {
        const sx = (sq / 7) | 0;
        const sy = sq % 7;
        const sDepth = myFaction === 0 ? sy : 6 - sy;
        myOffensiveStacks.push({ x: sx, y: sy, depth: sDepth });
      }
    }
    if (myOffensiveStacks.length >= 2) {
      for (let a = 0; a < myOffensiveStacks.length; a++) {
        for (let b = a + 1; b < myOffensiveStacks.length; b++) {
          const stA = myOffensiveStacks[a];
          const stB = myOffensiveStacks[b];
          const d = Math.max(Math.abs(stA.x - stB.x), Math.abs(stA.y - stB.y));
          if (d >= 1 && d <= 3) {
            positionalScore += d === 2 ? 3200 : 2200;
            if (stA.depth >= 2 && stB.depth >= 2 && Math.abs(stA.depth - stB.depth) <= 1) {
              // Synchronized two-lane wave advance across the board!
              positionalScore += 2400;
            }
          }
        }
      }
    }
  }

  // Pull single non-Ace cards toward each other so they merge into 2-card offensive stacks!
  if (myNonAceSingleSquares.length >= 2) {
    for (let a = 0; a < myNonAceSingleSquares.length; a++) {
      const sqA = myNonAceSingleSquares[a];
      const ax = (sqA / 7) | 0;
      const ay = sqA % 7;
      let minCheb = 99;
      for (let b = 0; b < myNonAceSingleSquares.length; b++) {
        if (a === b) continue;
        const sqB = myNonAceSingleSquares[b];
        const bx = (sqB / 7) | 0;
        const by = sqB % 7;
        const d = Math.max(Math.abs(ax - bx), Math.abs(ay - by));
        if (d < minCheb) minCheb = d;
      }
      if (minCheb <= 3) {
        positionalScore += (4 - minCheb) * 550;
      }
    }
  }

  // Count how many unmerged 1-card non-Ace singles sit on our back 2 rows (depth <= 1)
  let unmergedBackSingles = 0;
  for (let a = 0; a < myNonAceSingleSquares.length; a++) {
    const sqA = myNonAceSingleSquares[a];
    const ay = sqA % 7;
    const dA = myFaction === 0 ? ay : 6 - ay;
    if (dA <= 1 && postBoard[sqA][0]?.rank !== 0) {
      unmergedBackSingles++;
    }
  }

  // Keep at least 2 back-row spawn squares open while draw pile still has cards!
  if (myDrawAfter > 0 && occupiedBackRowSquares >= 5) {
    positionalScore -= (occupiedBackRowSquares - 4) * 1800;
  }

  // Balanced draw-pile deployment:
  // Only discourage spawning when there were ALREADY >= 2 unmerged 1-card singles on the back rows BEFORE spawning
  // (when `preSpawnUnmergedBackSingles === 1`, that lone single card NEEDS a spawned partner to merge into a 2-card stack!),
  // or when we face a real immediate threat (`threatPenalty >= 22000`).
  if (wasSpawn) {
    const preSpawnUnmergedBackSingles = Math.max(0, unmergedBackSingles - 1);
    if (
      turnNumber <= 2 ||
      preSpawnUnmergedBackSingles >= 2 ||
      threatPenalty >= 22000
    ) {
      positionalScore -= 9500;
    } else {
      const reserveDeficit = Math.max(0, myDrawAfter + 1 - opBelief.drawPileRemaining);
      const lowArmyUrgency = totalMyBoardCards <= 6 ? 4800 : totalMyBoardCards <= 7 ? 2800 : 1400;
      const partnerBonus = preSpawnUnmergedBackSingles === 1 ? 2400 : 0;
      positionalScore += lowArmyUrgency + partnerBonus + reserveDeficit * 2100;

      // Optimal Spawn Square Selection on the Back Row (`y = 0` for Red, `y = 6` for Black):
      // Instead of defaulting to the dead corner `(0,0)`, prefer spawning adjacent (`d = 1..2`) to an unmerged
      // single court card or unarmored Ace, and slightly prefer interior files (`x in 1..5`) over corners!
      const homeY = myFaction === 0 ? 0 : 6;
      for (let sx = 0; sx < 7; sx++) {
        const sIdx = sx * 7 + homeY;
        const sTile = postBoard[sIdx];
        if (sTile.length === 1 && sTile[0].owner === myFaction && sTile[0].locked && sTile[0].rank !== 1) {
          if (sx >= 1 && sx <= 5) positionalScore += 450;
          if (sx >= 2 && sx <= 4) positionalScore += 350;
          for (let oSq = 0; oSq < 49; oSq++) {
            if (oSq === sIdx) continue;
            const oTile = postBoard[oSq];
            if (oTile.length !== 1 || oTile[0].owner !== myFaction) continue;
            const ox = (oSq / 7) | 0;
            const oy = oSq % 7;
            const dToOther = Math.max(Math.abs(sx - ox), Math.abs(homeY - oy));
            if (dToOther <= 2) {
              positionalScore += (3 - dToOther) * 650;
            }
          }
          break;
        }
      }
    }
  }

  // Phase 6 Grandmaster Opening Book & Adaptive Counter-Opening Suite (Turns 1 - 7)
  if (engineBookConfig.enableOpeningBook && turnNumber <= 7) {
    positionalScore += evaluateOpeningBookRules(
      postBoard,
      myFaction,
      opBelief,
      myDrawAfter,
      opBelief.drawPileRemaining,
      turnNumber,
      wasSpawn,
      isIntermediateStep,
      condemnedSq
    );
  }

  // Phase 7 Grandmaster Endgame Tablebase & Siege Solver
  if (engineBookConfig.enableEndgameBook) {
    positionalScore += evaluateEndgameBookRules(
      postBoard,
      myFaction,
      opBelief,
      myDrawAfter,
      opBelief.drawPileRemaining,
      turnNumber,
      remainingMyAces,
      totalOpAcesRemaining,
      isIntermediateStep,
      condemnedSq
    );
  }

  // True Canonical Multiset Anti-Circle & Anti-Oscillation Enforcement!
  if (!isIntermediateStep) {
    const myHash = hashMyBoard(postBoard, myFaction);
    const myNonAceHash = hashMyNonAceBoard(postBoard, myFaction);
    // Never end a 3-move turn with our own cards in the exact same multiset positions they started the turn!
    if (globalBeliefTracker.startOfTurnMyHash && myHash === globalBeliefTracker.startOfTurnMyHash) {
      positionalScore -= 250000;
    } else if (globalBeliefTracker.recentBoardHashes.length > 0) {
      let repHits = 0;
      for (let k = 0; k < globalBeliefTracker.recentBoardHashes.length; k++) {
        const rh = globalBeliefTracker.recentBoardHashes[k];
        if (rh === myHash || rh === myNonAceHash) {
          repHits++;
        }
      }
      if (repHits > 0) {
        positionalScore -= repHits >= 2 ? 220000 : 95000;
      }
    }
  }

  return combatScore - threatPenalty + nextTurnStrikeBonus + positionalScore;
}

const ZERO_UNSEEN_BELIEF: FactionBelief = {
  unseenAces: 0,
  unseenJoker: false,
  unseenHighCards: { K: 0, Q: 0, J: 0, '10': 0, '9': 0 },
  maxUnseenCourt: 9,
  secondMaxUnseenCourt: 9,
  expectedUnseenCourt: 9,
  drawPileRemaining: 0,
  setupRemainingHidden: 0,
  jokerDrawPileProb: 0,
  suspectedJokerTiles: [],
  suspectedAceTiles: [],
  discreditedAceTiles: [],
  tileAceProb: new Float32Array(49),
  tileJokerProb: new Float32Array(49),
};

function findBestOpponentReplyScore(
  endBoardAfterMyMoves: SimCard[][],
  myFaction: number,
  opBelief: FactionBelief,
  myDraw: number,
  opDraw: number,
  nextTurn: number,
  pvsTimeBudgetMs: number = 20,
  myDrawRanks?: number[],
  opDrawRanks?: number[]
): number {
  const opFaction = 1 - myFaction;
  const postMyBoard = cloneSimBoard(endBoardAfterMyMoves);

  let initMyAces = 0;
  let initOpRevealedAces = 0;
  let initOpUnrevCards = 0;
  for (let sq = 0; sq < 49; sq++) {
    const t = endBoardAfterMyMoves[sq];
    for (let k = 0; k < t.length; k++) {
      const c = t[k];
      if (c.owner === myFaction) {
        if (c.rank === 1) initMyAces++;
      } else {
        if (c.rank === 1) initOpRevealedAces++;
        else if (c.rank === -1) initOpUnrevCards++;
      }
    }
  }
  const initOpAces = initOpRevealedAces + Math.min(initOpUnrevCards, opBelief.unseenAces);
  const initAceDiffForOp = initOpAces - initMyAces;

  // Locate our Aces and 2+ card stacks on `endBoardAfterMyMoves` so World 1 (Adversarial Assassin World)
  // can test whether ANY uncontested `canBeAce` enemy piece within striking range is a hidden Ace!
  const myAceSqs: number[] = [];
  const myStackSqs: number[] = [];
  for (let sq = 0; sq < 49; sq++) {
    const t = endBoardAfterMyMoves[sq];
    let myCnt = 0;
    let hasMyAce = false;
    for (let k = 0; k < t.length; k++) {
      if (t[k].owner === myFaction) {
        myCnt++;
        if (t[k].rank === 1) hasMyAce = true;
      }
    }
    if (hasMyAce) myAceSqs.push(sq);
    else if (myCnt >= 2) myStackSqs.push(sq);
  }

  // 1. Collect unrevealed opponent card slots on postMyBoard
  const unrevOpSlots: Array<{
    sq: number;
    idx: number;
    aceProb: number;
    canBeAce: boolean;
    assassinThreatScore: number;
    jokerProb: number;
    priority: number;
    contestedByUs: boolean;
  }> = [];

  for (let i = 0; i < 49; i++) {
    const t = postMyBoard[i];
    if (t.length === 0) continue;
    const x = (i / 7) | 0;
    const y = i % 7;
    const opDepth = opFaction === 0 ? y : 6 - y;
    const hasMyCard = t.some((c) => c.owner === myFaction);
    const hasRevOpAceOnSq = t.some((c) => c.owner === opFaction && c.rank === 1);
    const hasRevOpJkrOnSq = t.some((c) => c.owner === opFaction && c.rank === 0);
    const unrevAceProbOnSq = hasRevOpAceOnSq ? 0 : opBelief.tileAceProb[i];
    const unrevJkrProbOnSq = hasRevOpJkrOnSq ? 0 : opBelief.tileJokerProb[i];
    const canBeAce =
      !hasRevOpAceOnSq &&
      (unrevAceProbOnSq >= 0.05 || globalBeliefTracker.canSquareHoldSetupAce(opFaction, i));

    let assassinThreatScore = unrevAceProbOnSq;
    if (!hasMyCard && unrevAceProbOnSq >= 0.28) {
      for (const aSq of myAceSqs) {
        const ax = (aSq / 7) | 0;
        const ay = aSq % 7;
        const d = Math.max(Math.abs(x - ax), Math.abs(y - ay));
        if (d <= 3) assassinThreatScore += (4 - d) * 0.45;
      }
      for (const sSq of myStackSqs) {
        const sx = (sSq / 7) | 0;
        const sy = sSq % 7;
        const d = Math.max(Math.abs(x - sx), Math.abs(y - sy));
        if (d <= 3) assassinThreatScore += (4 - d) * 0.35;
      }
    }

    const opCardsCountOnTile = t.filter((c) => c.owner === opFaction).length;
    for (let j = 0; j < t.length; j++) {
      const c = t[j];
      if (c.owner === opFaction && c.rank === -1) {
        unrevOpSlots.push({
          sq: i,
          idx: j,
          aceProb: unrevAceProbOnSq,
          canBeAce,
          assassinThreatScore,
          jokerProb: unrevJkrProbOnSq,
          priority: opCardsCountOnTile * 10 + opDepth * 2 - Math.abs(x - 3),
          contestedByUs: hasMyCard,
        });
      }
    }
  }

  // Helper to assign unrevealed cards for Determinized World `worldVariant`:
  // World 0 = MAP Expected World (Aces on highest-prob uncontested setup squares)
  // World 1 = Primary Adversarial Assassin-Ace & Joker-Trap World (Aces on closest uncontested `canBeAce` squares to our Aces/stacks!)
  // World 2 = Complementary Disjoint Flank World (Permutes unseen Aces/Jokers to 2nd-highest candidate squares disjoint from World 1!)
  const w1AssignedAceSqs = new Set<number>();
  let w1AssignedJokerSq = -1;

  const assignDeterminizedWorld = (targetBoard: SimCard[][], worldVariant: number) => {
    if (unrevOpSlots.length === 0) return;
    const assigned = new Uint8Array(unrevOpSlots.length);

    let jokerAssigned = false;
    if (opBelief.unseenJoker) {
      let bestJk = -1;
      let bestJkScore = worldVariant >= 1 ? 0.14 : 0.20;
      for (let k = 0; k < unrevOpSlots.length; k++) {
        const s = unrevOpSlots[k];
        // Never teleport a suspected Joker (`s.jokerProb >= 0.18`) away from a square just because we attack it in World 0!
        if (worldVariant === 0 && s.contestedByUs && s.jokerProb < 0.18) continue;
        if (worldVariant === 2 && s.sq === w1AssignedJokerSq && unrevOpSlots.length >= 2) continue;
        const jkScore =
          worldVariant >= 1
            ? s.jokerProb +
              (s.contestedByUs && s.jokerProb >= 0.28 ? 0.25 : 0) +
              (s.priority >= 15 && s.jokerProb >= 0.22 ? 0.12 : 0)
            : s.jokerProb;
        if (jkScore > bestJkScore) {
          bestJkScore = jkScore;
          bestJk = k;
        }
      }
      if (bestJk >= 0) {
        const slot = unrevOpSlots[bestJk];
        targetBoard[slot.sq][slot.idx].rank = 0;
        assigned[bestJk] = 1;
        jokerAssigned = true;
        if (worldVariant === 1) w1AssignedJokerSq = slot.sq;
      }
    }

    // Assign unseen Aces ONLY to uncontested squares (`!s.contestedByUs`) whenever possible so Turn-1
    // attacks on unrevealed squares never double-count an Ace kill or strip the opponent of counter-attacking Aces!
    let acesToAssign = opBelief.unseenAces;
    if (acesToAssign > 0) {
      const aceOrder = unrevOpSlots
        .map((s, k) => ({
          k,
          score: s.contestedByUs
            ? -10.0 + s.aceProb
            : worldVariant === 2
            ? (w1AssignedAceSqs.has(s.sq) ? -2.0 : 2.0) + s.assassinThreatScore * 0.7 + s.aceProb
            : worldVariant === 1
            ? s.assassinThreatScore
            : s.aceProb,
        }))
        .sort((a, b) => b.score - a.score);

      const assignedAceSqCount = new Int32Array(49);
      for (let sq = 0; sq < 49; sq++) {
        if (targetBoard[sq].some((c) => c.owner === opFaction && c.rank === 1)) {
          assignedAceSqCount[sq] = 1;
        }
      }
      for (let pass = 0; pass < aceOrder.length && acesToAssign > 0; pass++) {
        const slotIdx = aceOrder[pass].k;
        if (assigned[slotIdx]) continue;
        const slot = unrevOpSlots[slotIdx];
        if (slot.aceProb < 0.05 && !slot.contestedByUs) continue;
        const maxAcesOnSlotSq =
          worldVariant >= 1 && globalBeliefTracker.getSetupMass(opFaction, slot.sq) >= 1.35 ? 2 : 1;
        if (assignedAceSqCount[slot.sq] < maxAcesOnSlotSq) {
          // If forced to assign to a contested square because no uncontested squares exist, only do so if aceProb >= 0.85
          if (slot.contestedByUs && slot.aceProb < 0.85) continue;
          targetBoard[slot.sq][slot.idx].rank = 1;
          assigned[slotIdx] = 1;
          assignedAceSqCount[slot.sq]++;
          if (worldVariant === 1) w1AssignedAceSqs.add(slot.sq);
          acesToAssign--;
        }
      }
      if (acesToAssign > 0) {
        for (let pass = 0; pass < aceOrder.length && acesToAssign > 0; pass++) {
          const slotIdx = aceOrder[pass].k;
          if (assigned[slotIdx]) continue;
          const slot = unrevOpSlots[slotIdx];
          if (slot.contestedByUs && slot.aceProb < 0.85) continue;
          if (assignedAceSqCount[slot.sq] < 1) {
            targetBoard[slot.sq][slot.idx].rank = 1;
            assigned[slotIdx] = 1;
            assignedAceSqCount[slot.sq]++;
            acesToAssign--;
          }
        }
      }
    }

    if (opBelief.unseenJoker && !jokerAssigned) {
      let bestJk = -1;
      let bestJkScore = 0.18;
      for (let k = 0; k < unrevOpSlots.length; k++) {
        if (assigned[k]) continue;
        const s = unrevOpSlots[k];
        if (s.jokerProb > bestJkScore) {
          bestJkScore = s.jokerProb;
          bestJk = k;
        }
      }
      if (bestJk >= 0) {
        const slot = unrevOpSlots[bestJk];
        targetBoard[slot.sq][slot.idx].rank = 0;
        assigned[bestJk] = 1;
      }
    }

    const courtPool: number[] = [];
    for (let k = 0; k < opBelief.unseenHighCards.K; k++) courtPool.push(13);
    for (let k = 0; k < opBelief.unseenHighCards.Q; k++) courtPool.push(12);
    for (let k = 0; k < opBelief.unseenHighCards.J; k++) courtPool.push(11);
    for (let k = 0; k < opBelief.unseenHighCards['10']; k++) courtPool.push(10);
    for (let k = 0; k < opBelief.unseenHighCards['9']; k++) courtPool.push(9);
    while (courtPool.length < unrevOpSlots.length) courtPool.push(11);

    const expectedCourtRank = Math.max(9, Math.min(13, Math.round(opBelief.expectedUnseenCourt || 11)));
    const expectedSetupRank = Math.max(
      11,
      Math.min(13, Math.round(opBelief.expectedSetupCourt || opBelief.expectedUnseenCourt || 12))
    );
    const expectedReserveRank = Math.max(
      9,
      Math.min(12, Math.round(opBelief.expectedReserveCourt || opBelief.expectedUnseenCourt || 10))
    );
    const remOrder = unrevOpSlots
      .map((s, k) => ({
        k,
        prio: s.priority,
      }))
      .filter((x) => !assigned[x.k])
      .sort((a, b) => b.prio - a.prio);

    const cardsAssignedOnSq = new Int32Array(49);
    const secondCourtRank = Math.max(9, Math.min(13, opBelief.secondMaxUnseenCourt || expectedCourtRank));
    for (let r = 0; r < remOrder.length; r++) {
      const slot = unrevOpSlots[remOrder[r].k];
      const opCntOnSq = targetBoard[slot.sq].filter((c) => c.owner === opFaction).length;
      const ordOnSq = cardsAssignedOnSq[slot.sq]++;
      const sqSetupMass = globalBeliefTracker.getSetupMass(opFaction, slot.sq);
      const isSetupOrigin = sqSetupMass >= 0.35;
      if (slot.contestedByUs) {
        if (opCntOnSq === 1) {
          targetBoard[slot.sq][slot.idx].rank =
            worldVariant === 0
              ? isSetupOrigin
                ? expectedSetupRank
                : expectedReserveRank
              : isSetupOrigin
              ? courtPool[0] || 13
              : Math.min(12, expectedReserveRank + 1);
        } else if (ordOnSq === 0) {
          // 1st card of a contested 2+ card enemy stack:
          targetBoard[slot.sq][slot.idx].rank =
            worldVariant === 0
              ? isSetupOrigin
                ? expectedSetupRank
                : expectedCourtRank
              : isSetupOrigin
              ? courtPool[0] || 13
              : secondCourtRank;
        } else if (slot.aceProb >= 0.36) {
          // 2nd card of a suspected [Ace + Guard] stack (e.g. back-row 2-card Ace citadel):
          // Model the 2nd card as the low-point Ace escort (1 pt if safe, or 9 pts so we don't falsely zero out opSurvAces!)
          // rather than assigning a second 13-pt King (`13+13=26`) that scares our [K, Q]/[K, J] stack away from attacking!
          targetBoard[slot.sq][slot.idx].rank =
            worldVariant === 0 ? 9 : slot.aceProb >= 0.58 ? 9 : expectedReserveRank;
        } else {
          // 2nd card of a regular 2+ card court stack:
          targetBoard[slot.sq][slot.idx].rank =
            worldVariant === 0
              ? sqSetupMass >= 1.45
                ? expectedCourtRank
                : expectedReserveRank
              : sqSetupMass >= 1.65
              ? secondCourtRank
              : Math.min(11, secondCourtRank);
        }
      } else {
        targetBoard[slot.sq][slot.idx].rank = courtPool[r] || 11;
      }
    }
  };

  const resolveTurn1CombatsOnBoard = (
    targetBoard: SimCard[][]
  ): { mySurvAces: number; opSurvAces: number; myLostNonAcePen: number } => {
    let myA = 0;
    let opA = 0;
    let myLostNonAcePen = 0;
    for (let i = 0; i < 49; i++) {
      const t = targetBoard[i];
      if (t.length === 0) continue;
      const myCards: SimCard[] = [];
      const opCards: SimCard[] = [];
      for (let j = 0; j < t.length; j++) {
        const c = t[j];
        c.locked = false;
        if (c.owner === myFaction) myCards.push(c);
        else opCards.push(c);
      }
      if (myCards.length > 0 && opCards.length > 0) {
        // Only cards on squares where combat actually occurs become revealed!
        for (let j = 0; j < myCards.length; j++) myCards[j].revealed = true;
        for (let j = 0; j < opCards.length; j++) opCards[j].revealed = true;
        const res = resolveCombat(myCards, opCards);
        if (res.defenderDies && !res.attackerDies) {
          targetBoard[i] = myCards;
        } else if (res.defenderDies && res.attackerDies) {
          targetBoard[i] = [];
        } else {
          targetBoard[i] = opCards;
          for (let j = 0; j < myCards.length; j++) {
            if (myCards[j].rank !== 1) {
              myLostNonAcePen +=
                myCards[j].rank === 0 ? 14000 : 4800 + rankPoints(myCards[j].rank) * 160;
            }
          }
        }
      }
      for (let j = 0; j < targetBoard[i].length; j++) {
        const sc = targetBoard[i][j];
        if (sc.rank === 1) {
          if (sc.owner === myFaction) myA++;
          else opA++;
        }
      }
    }
    return { mySurvAces: myA, opSurvAces: opA, myLostNonAcePen };
  };

  assignDeterminizedWorld(postMyBoard, 0);
  const { mySurvAces, opSurvAces, myLostNonAcePen: w0LostPen } =
    resolveTurn1CombatsOnBoard(postMyBoard);

  if (mySurvAces === 0) return 1000000;
  if (opSurvAces === 0 && opBelief.unseenAces === 0) return -1000000;

  // Phase 5 Multi-World Information-Set PVS:
  // ALWAYS evaluate both World 0 (MAP Expected World) AND World 1 (Adversarial Assassin-Ace & Joker-Trap World)
  // whenever any unrevealed opponent cards exist on the board!
  const isEndgamePVS =
    engineBookConfig.enableEndgameBook &&
    (myDraw + opDraw <= 2 || mySurvAces <= 1 || opSurvAces <= 1);
  const pvsDepth = isEndgamePVS ? 8 : 6;

  const useMultiWorld = unrevOpSlots.length >= 1;
  const useThreeWorlds = unrevOpSlots.length >= 2 && opBelief.unseenAces >= 1;
  const world0Budget = useMultiWorld
    ? Math.max(8, (pvsTimeBudgetMs * (useThreeWorlds ? 0.44 : 0.56)) | 0)
    : pvsTimeBudgetMs;
  const pvsRes0 = runStockfishPVSOnPostTurnBoard(
    postMyBoard,
    myFaction,
    myDraw,
    opDraw,
    nextTurn,
    world0Budget,
    pvsDepth,
    myDrawRanks,
    opDrawRanks,
    opBelief.tileAceProb,
    opBelief.tileJokerProb
  );

  // Note: `runStockfishPVSOnPostTurnBoard` ALREADY normalizes `opScore` relative to the post-Turn-1 Ace counts on `targetBoard`.
  // We only add `(initMyAces - worldMySurvAces) * 187000` if our Turn-1 move lost one of our Aces in `resolveTurn1CombatsOnBoard`!
  const normalizePvsOpScore = (
    rawPvsOp: number,
    worldMySurvAces: number,
    lostNonAcePen: number = 0
  ): number => {
    if (Math.abs(rawPvsOp) >= 800000) return rawPvsOp;
    const lostMyAcesOnTurn1 = Math.max(0, initMyAces - worldMySurvAces);
    return rawPvsOp + lostMyAcesOnTurn1 * 187000 + Math.round(lostNonAcePen * 0.65);
  };

  let pvsCombinedOpScore = normalizePvsOpScore(pvsRes0.opScore, mySurvAces, w0LostPen);

  if (useMultiWorld) {
    const world1Board = cloneSimBoard(endBoardAfterMyMoves);
    assignDeterminizedWorld(world1Board, 1);
    const w1Surv = resolveTurn1CombatsOnBoard(world1Board);
    let worstAdvScore = pvsCombinedOpScore;

    if (w1Surv.mySurvAces === 0) {
      worstAdvScore = Math.max(worstAdvScore, 880000);
    } else if (w1Surv.opSurvAces > 0) {
      const remBudget = Math.max(8, pvsTimeBudgetMs - world0Budget);
      const world1Budget = useThreeWorlds ? Math.max(6, (remBudget * 0.58) | 0) : remBudget;
      const pvsRes1 = runStockfishPVSOnPostTurnBoard(
        world1Board,
        myFaction,
        myDraw,
        opDraw,
        nextTurn,
        world1Budget,
        pvsDepth,
        myDrawRanks,
        opDrawRanks,
        opBelief.tileAceProb,
        opBelief.tileJokerProb
      );
      worstAdvScore = Math.max(
        worstAdvScore,
        normalizePvsOpScore(pvsRes1.opScore, w1Surv.mySurvAces, w1Surv.myLostNonAcePen)
      );

      // Phase 2 World 2 (Complementary Disjoint Flank Assassin World):
      // Tests what happens if the opponent's unseen Ace/Joker is on the OTHER candidate square!
      if (useThreeWorlds && worstAdvScore < 800000) {
        const world2Board = cloneSimBoard(endBoardAfterMyMoves);
        assignDeterminizedWorld(world2Board, 2);
        const w2Surv = resolveTurn1CombatsOnBoard(world2Board);
        if (w2Surv.mySurvAces === 0) {
          worstAdvScore = Math.max(worstAdvScore, 880000);
        } else if (w2Surv.opSurvAces > 0) {
          const world2Budget = Math.max(5, remBudget - world1Budget);
          const pvsRes2 = runStockfishPVSOnPostTurnBoard(
            world2Board,
            myFaction,
            myDraw,
            opDraw,
            nextTurn,
            world2Budget,
            pvsDepth,
            myDrawRanks,
            opDrawRanks,
            opBelief.tileAceProb,
            opBelief.tileJokerProb
          );
          worstAdvScore = Math.max(
            worstAdvScore,
            normalizePvsOpScore(pvsRes2.opScore, w2Surv.mySurvAces, w2Surv.myLostNonAcePen)
          );
        }
      }
    }

    const baseScore0 = normalizePvsOpScore(pvsRes0.opScore, mySurvAces, w0LostPen);
    if (worstAdvScore > baseScore0) {
      // Weight the adversarial refutation by the Bayesian credibility of the unrevealed threat square
      // so a 15%-probability hypothesis never triggers a -120,000 false panic when no real check exists!
      let maxThreatCredibility = 0.22;
      for (const aSq of w1AssignedAceSqs) {
        if (opBelief.tileAceProb[aSq] > maxThreatCredibility) {
          maxThreatCredibility = opBelief.tileAceProb[aSq];
        }
      }
      if (w1AssignedJokerSq >= 0 && opBelief.tileJokerProb[w1AssignedJokerSq] > maxThreatCredibility) {
        maxThreatCredibility = opBelief.tileJokerProb[w1AssignedJokerSq];
      }
      const advWeight =
        worstAdvScore >= 800000
          ? Math.min(0.48, Math.max(0.24, maxThreatCredibility * 0.9))
          : Math.min(0.38, Math.max(0.16, maxThreatCredibility * 0.75));
      pvsCombinedOpScore = Math.round((1 - advWeight) * baseScore0 + advWeight * worstAdvScore);
    }
  }

  // Save & isolate anti-circle hashes during opponent's Turn-2 minimax simulation
  const savedStartHash = globalBeliefTracker.startOfTurnMyHash;
  const savedRecent = globalBeliefTracker.recentBoardHashes;
  globalBeliefTracker.startOfTurnMyHash = hashMyBoard(postMyBoard, opFaction);
  globalBeliefTracker.recentBoardHashes = [];

  let maxOpScore = -Infinity;
  let bestOpEndBoard: SimCard[][] = postMyBoard;
  const recordOpReply = (b: SimCard[][], sc: number) => {
    if (sc > maxOpScore) {
      maxOpScore = sc;
      bestOpEndBoard = b;
    }
  };

  // Evaluate opponent spawn reply if opDraw > 0
  if (opDraw > 0) {
    const opHomeY = opFaction === 0 ? 0 : 6;
    for (let x = 0; x < 7; x++) {
      const sq = x * 7 + opHomeY;
      if (postMyBoard[sq].length === 0) {
        const spBoard = cloneSimBoard(postMyBoard);
        spBoard[sq].push({
          owner: opFaction,
          name: 'Q?',
          rank: 11,
          revealed: true,
          locked: false,
        });
        const spSc = evaluateTurnEndState(
          spBoard,
          opFaction,
          ZERO_UNSEEN_BELIEF,
          opDraw - 1,
          nextTurn,
          true,
          false
        );
        recordOpReply(spBoard, spSc);
      }
    }
  }

  // Phase 3 Imperfect-Information Opponent Perception Model:
  // Count how many unrevealed friendly candidate squares we have on our back 2 rows (`depth <= 1`)
  // and whether we have a disguised 2-card `[Court, Unrevealed Joker]` ambush stack in the combat zone!
  let unrevFriendlyBackCandidates = 0;
  let myNonAceTwoCardStacks = 0;
  let disguisedJokerTrapBonusForUs = 0;
  for (let sq = 0; sq < 49; sq++) {
    const t = postMyBoard[sq];
    if (t.length === 0) continue;
    const sx = (sq / 7) | 0;
    const sy = sq % 7;
    const myDepth = myFaction === 0 ? sy : 6 - sy;
    let mLen = 0;
    let mAllUnrev = true;
    let mHasAce = false;
    let mHasUnrevJoker = false;
    for (let k = 0; k < t.length; k++) {
      if (t[k].owner === myFaction) {
        mLen++;
        if (t[k].revealed) mAllUnrev = false;
        if (t[k].rank === 1) mHasAce = true;
        else if (t[k].rank === 0 && !t[k].revealed) mHasUnrevJoker = true;
      }
    }
    if (mLen >= 1 && mAllUnrev && myDepth <= 1) {
      unrevFriendlyBackCandidates++;
    }
    if (mLen >= 2 && !mHasAce) {
      myNonAceTwoCardStacks++;
    }
    // If we have a 2-card disguised [Court, Jkr*] stack (`mLen === 2 && mHasUnrevJoker && !mHasAce`)
    // standing within d <= 2 of an enemy 2+ card non-Ace stack, the human opponent sees `[??, ??]`
    // and faces a lethal Law-4 ambush trap!
    if (mLen === 2 && mHasUnrevJoker && !mHasAce) {
      for (let eSq = 0; eSq < 49; eSq++) {
        const eTile = postMyBoard[eSq];
        const opCnt = eTile.filter((c) => c.owner === opFaction).length;
        if (opCnt >= 2) {
          const ex = (eSq / 7) | 0;
          const ey = eSq % 7;
          if (Math.max(Math.abs(sx - ex), Math.abs(sy - ey)) <= 2) {
            disguisedJokerTrapBonusForUs = 5400;
            break;
          }
        }
      }
    }
  }
  const baseNoCombatOpEval = evaluateTurnEndState(
    postMyBoard,
    opFaction,
    ZERO_UNSEEN_BELIEF,
    opDraw,
    nextTurn,
    false,
    false
  );

  // Exact Opponent 1/2/3-Step Ace-Assassination & 2-Card Ace-Kill Pincer Scanner (<0.15ms):
  // Ensures `findBestOpponentReplyScore` NEVER misses an opponent Ace peeling off a stack (e.g. AC at (4,4)->(5,5)->(6,5))
  // or a 1/2/3-step / 2-card convergent strike onto our Ace due to intermediate beam pruning!
  const opScannerDistBySq = new Map<number, Int8Array>();
  for (let uSq = 0; uSq < 49; uSq++) {
    if (postMyBoard[uSq].some((c) => c.owner === opFaction && !c.locked)) {
      const dm = new Int8Array(49);
      computeStepDistancesFast(postMyBoard, opFaction, uSq, dm);
      opScannerDistBySq.set(uSq, dm);
    }
  }
  if (opScannerDistBySq.size > 0) {
    for (let targetSq = 0; targetSq < 49; targetSq++) {
      const tTile = postMyBoard[targetSq];
      if (!tTile.some((c) => c.owner === myFaction)) continue;
      const targetHasMyAce = tTile.some((c) => c.owner === myFaction && c.rank === 1);
      const targetAceRevealed = tTile.some((c) => c.owner === myFaction && c.rank === 1 && c.revealed);
      const myCntOnTarget = tTile.filter((c) => c.owner === myFaction).length;
      // Phase 3 Imperfect-Information Discount on Long-Range Blind Snipes:
      // If our Ace on `targetSq` is REVEALED (`targetAceRevealed`), the human knows 100% where it is (`blindSnipeCred = 1.0`).
      // If our Ace on `targetSq` is UNREVEALED (`!targetAceRevealed`) and camouflaged among `unrevFriendlyBackCandidates >= 2`
      // face-down squares on our home rows, a 2-step or 3-step blind snipe by the human has to guess which face-down card is the Ace!
      const blindSnipeCred =
        !targetHasMyAce || targetAceRevealed || unrevFriendlyBackCandidates <= 1
          ? 1.0
          : Math.min(
              0.92,
              Math.max(
                0.58,
                1.0 / unrevFriendlyBackCandidates +
                  (myCntOnTarget >= 2 && myNonAceTwoCardStacks === 0 ? 0.25 : 0.08)
              )
            );
      const scaleBlindSnipeScore = (rawSc: number, reachSteps: number): number => {
        if (reachSteps <= 1 || blindSnipeCred >= 0.99 || rawSc <= baseNoCombatOpEval) return rawSc;
        // A 3-step (`reachSteps === 3`) blind snipe from the midline onto an unrevealed 1-card home-row Ace
        // when we have >= 2 Aces and >= 2 unrevealed back-row candidates is a low-probability blind guess!
        const stepCred =
          reachSteps === 3 && !targetAceRevealed && myCntOnTarget === 1 && initMyAces >= 2 && unrevFriendlyBackCandidates >= 2
            ? Math.min(0.22, blindSnipeCred * 0.35)
            : blindSnipeCred;
        return Math.round(baseNoCombatOpEval + (rawSc - baseNoCombatOpEval) * stepCred);
      };

      // 1. Check all 1/2/3-step opponent Ace strikes (`oc.rank === 1`) onto `targetSq` (and any 1/2/3-step strike onto our Ace!)
      for (const [uSq, dm] of opScannerDistBySq.entries()) {
        if (uSq === targetSq) continue;
        const reachSteps = dm[targetSq];
        if (reachSteps >= 1 && reachSteps <= 3) {
          const uTile = postMyBoard[uSq];
          let testedRanksMask = 0;
          for (let slot = 0; slot < uTile.length; slot++) {
            const oc = uTile[slot];
            if (oc.owner !== opFaction || oc.locked) continue;
            if (oc.rank !== 1 && !targetHasMyAce) continue;
            const rBit = 1 << Math.max(0, oc.rank + 1);
            if ((testedRanksMask & rBit) !== 0) continue;
            testedRanksMask |= rBit;

            const strikeBoard = applySimMicroMove(
              postMyBoard,
              { fromIdx: uSq, toIdx: targetSq, cardPosInTile: slot, rank: oc.rank },
              opFaction
            );
            const sc = scaleBlindSnipeScore(
              evaluateTurnEndState(
                strikeBoard,
                opFaction,
                ZERO_UNSEEN_BELIEF,
                opDraw,
                nextTurn,
                false,
                false
              ),
              reachSteps
            );
            recordOpReply(strikeBoard, sc);
            if (
              oc.rank === 1 &&
              reachSteps === 1 &&
              strikeBoard[uSq].some((c) => c.owner === opFaction && !c.locked && c.rank >= 9)
            ) {
              const gSlot = strikeBoard[uSq].findIndex(
                (c) => c.owner === opFaction && !c.locked && c.rank >= 9
              );
              const gBoard = applySimMicroMove(
                strikeBoard,
                {
                  fromIdx: uSq,
                  toIdx: targetSq,
                  cardPosInTile: gSlot,
                  rank: strikeBoard[uSq][gSlot].rank,
                },
                opFaction
              );
              const gSc = evaluateTurnEndState(
                gBoard,
                opFaction,
                ZERO_UNSEEN_BELIEF,
                opDraw,
                nextTurn,
                false,
                false
              );
              recordOpReply(gBoard, gSc);
            }
          }
        }
      }

      // 2. Check 2-Card & 3-Card Opponent Stack / Pincer Convergence (`d1 + d2 <= 3` or `d1 + d2 + d3 <= 3`)
      // onto ANY of our Aces OR our 2+ card stacks (including Opponent 2-Ace Rule-1 executions against our Joker stacks!)
      if (targetHasMyAce || myCntOnTarget >= 2) {
        const opAttackersToTarget: Array<{ sq: number; slot: number; rank: number; d: number }> = [];
        for (const [uSq, dm] of opScannerDistBySq.entries()) {
          if (uSq === targetSq) continue;
          const d = dm[targetSq];
          if (d < 1 || d > 2) continue;
          const uTile = postMyBoard[uSq];
          for (let slot = 0; slot < uTile.length; slot++) {
            const oc = uTile[slot];
            if (oc.owner === opFaction && !oc.locked) {
              opAttackersToTarget.push({ sq: uSq, slot, rank: oc.rank, d });
            }
          }
        }
        if (opAttackersToTarget.length >= 2) {
          for (let a = 0; a < opAttackersToTarget.length; a++) {
            for (let b = a + 1; b < opAttackersToTarget.length; b++) {
              const attA = opAttackersToTarget[a];
              const attB = opAttackersToTarget[b];
              if (attA.d + attB.d > 3) continue;
              const b1 = applySimMicroMove(
                postMyBoard,
                { fromIdx: attA.sq, toIdx: targetSq, cardPosInTile: attA.slot, rank: attA.rank },
                opFaction
              );
              const slotB = b1[attB.sq].findIndex(
                (c) => c.owner === opFaction && !c.locked && c.rank === attB.rank
              );
              if (slotB >= 0) {
                const b2 = applySimMicroMove(
                  b1,
                  { fromIdx: attB.sq, toIdx: targetSq, cardPosInTile: slotB, rank: attB.rank },
                  opFaction
                );
                const sc = scaleBlindSnipeScore(
                  evaluateTurnEndState(
                    b2,
                    opFaction,
                    ZERO_UNSEEN_BELIEF,
                    opDraw,
                    nextTurn,
                    false,
                    false
                  ),
                  Math.max(attA.d, attB.d)
                );
                recordOpReply(b2, sc);

                if (attA.d + attB.d === 2 && opAttackersToTarget.length >= 3) {
                  for (let cIdx = b + 1; cIdx < opAttackersToTarget.length; cIdx++) {
                    const attC = opAttackersToTarget[cIdx];
                    if (attC.d !== 1) continue;
                    const slotC = b2[attC.sq].findIndex(
                      (c) => c.owner === opFaction && !c.locked && c.rank === attC.rank
                    );
                    if (slotC >= 0) {
                      const b3 = applySimMicroMove(
                        b2,
                        { fromIdx: attC.sq, toIdx: targetSq, cardPosInTile: slotC, rank: attC.rank },
                        opFaction
                      );
                      const sc3 = scaleBlindSnipeScore(
                        evaluateTurnEndState(
                          b3,
                          opFaction,
                          ZERO_UNSEEN_BELIEF,
                          opDraw,
                          nextTurn,
                          false,
                          false
                        ),
                        Math.max(attA.d, attB.d, attC.d)
                      );
                      recordOpReply(b3, sc3);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // 3. Phase 2 Opponent Threatened-Ace Escape + Bodyguard Rendezvous Scanner:
    for (let opAceSq = 0; opAceSq < 49; opAceSq++) {
      const oaTile = postMyBoard[opAceSq];
      const aceSlot = oaTile.findIndex((c) => c.owner === opFaction && !c.locked && c.rank === 1);
      if (aceSlot < 0) continue;
      const oax = (opAceSq / 7) | 0;
      const oay = opAceSq % 7;
      let threatenedByUs = false;
      for (let mSq = 0; mSq < 49; mSq++) {
        if (postMyBoard[mSq].some((c) => c.owner === myFaction)) {
          const mx = (mSq / 7) | 0;
          const my = mSq % 7;
          if (Math.max(Math.abs(oax - mx), Math.abs(oay - my)) <= 2) {
            threatenedByUs = true;
            break;
          }
        }
      }
      if (!threatenedByUs) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = oax + dx;
        if (nx < 0 || nx >= 7) continue;
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const ny = oay + dy;
          if (ny < 0 || ny >= 7) continue;
          const escSq = nx * 7 + ny;
          if (postMyBoard[escSq].some((c) => c.owner === myFaction)) continue;
          const bEsc1 = applySimMicroMove(
            postMyBoard,
            { fromIdx: opAceSq, toIdx: escSq, cardPosInTile: aceSlot, rank: 1 },
            opFaction
          );
          for (let gdx = -1; gdx <= 1; gdx++) {
            const gx = nx + gdx;
            if (gx < 0 || gx >= 7) continue;
            for (let gdy = -1; gdy <= 1; gdy++) {
              if (gdx === 0 && gdy === 0) continue;
              const gy = ny + gdy;
              if (gy < 0 || gy >= 7) continue;
              const gSq = gx * 7 + gy;
              if (bEsc1[gSq].some((c) => c.owner === myFaction)) continue;
              const gSlot = bEsc1[gSq].findIndex(
                (c) => c.owner === opFaction && !c.locked && c.rank >= 9
              );
              if (gSlot >= 0) {
                const bEsc2 = applySimMicroMove(
                  bEsc1,
                  { fromIdx: gSq, toIdx: escSq, cardPosInTile: gSlot, rank: bEsc1[gSq][gSlot].rank },
                  opFaction
                );
                const scEsc = evaluateTurnEndState(
                  bEsc2,
                  opFaction,
                  ZERO_UNSEEN_BELIEF,
                  opDraw,
                  nextTurn,
                  false,
                  false
                );
                recordOpReply(bEsc2, scEsc);
              }
            }
          }
        }
      }
    }
  }

  // Opponent Step 1
  const m1List = generateSimMicroMoves(postMyBoard, opFaction);
  if (m1List.length === 0) {
    globalBeliefTracker.startOfTurnMyHash = savedStartHash;
    globalBeliefTracker.recentBoardHashes = savedRecent;
    return maxOpScore === -Infinity ? 0 : maxOpScore;
  }

  interface OpNode {
    board: SimCard[][];
    fromIdx: number;
    toIdx: number;
    prio: number;
  }

  // Locate our Aces on `postMyBoard` so Opponent Step-1 & Step-2 beam search
  // prioritizes 3-step assassin approaches (d=3->2->1->0) toward our Aces
  // (excluding camouflaged 1-card unrevealed home-row Aces with no enemy within d<=2 so the beam search doesn't cheat with X-ray snipes!).
  const camouflagedHomeAceOnPost = new Uint8Array(49);
  const myAceSquaresOnPost: number[] = [];
  for (let sq = 0; sq < 49; sq++) {
    const t = postMyBoard[sq];
    let hasMyAce = false;
    let aceRev = false;
    let myCnt = 0;
    for (let k = 0; k < t.length; k++) {
      if (t[k].owner === myFaction) {
        myCnt++;
        if (t[k].rank === 1) {
          hasMyAce = true;
          if (t[k].revealed) aceRev = true;
        }
      }
    }
    if (hasMyAce) {
      const ay = sq % 7;
      const aDepth = myFaction === 0 ? ay : 6 - ay;
      let minOpDist = 99;
      const ax = (sq / 7) | 0;
      for (let eSq = 0; eSq < 49; eSq++) {
        if (postMyBoard[eSq].some((c) => c.owner === opFaction)) {
          const d = Math.max(Math.abs(ax - ((eSq / 7) | 0)), Math.abs(ay - (eSq % 7)));
          if (d < minOpDist) minOpDist = d;
        }
      }
      if (
        !aceRev &&
        aDepth === 0 &&
        myCnt === 1 &&
        initMyAces >= 2 &&
        unrevFriendlyBackCandidates >= 2 &&
        minOpDist >= 3
      ) {
        camouflagedHomeAceOnPost[sq] = 1;
      } else {
        myAceSquaresOnPost.push(sq);
      }
    }
  }

  const opL1: OpNode[] = [];
  for (let i = 0; i < m1List.length; i++) {
    const m1 = m1List[i];
    const b1 = applySimMicroMove(postMyBoard, m1, opFaction);
    let prio = evaluateTurnEndState(
      b1,
      opFaction,
      ZERO_UNSEEN_BELIEF,
      opDraw,
      nextTurn,
      false,
      true
    );
    if (postMyBoard[m1.fromIdx].length >= 2) {
      prio += postMyBoard[m1.toIdx].some((c) => c.owner === myFaction) ? 18500 : 6500;
    }

    // Part 2.C: Boost opponent Step-1 moves that step closer (d <= 2) to our Aces!
    const fx = (m1.fromIdx / 7) | 0;
    const fy = m1.fromIdx % 7;
    const tx = (m1.toIdx / 7) | 0;
    const ty = m1.toIdx % 7;
    for (let a = 0; a < myAceSquaresOnPost.length; a++) {
      const aSq = myAceSquaresOnPost[a];
      const ax = (aSq / 7) | 0;
      const ay = aSq % 7;
      const dBefore = Math.max(Math.abs(fx - ax), Math.abs(fy - ay));
      const dAfter = Math.max(Math.abs(tx - ax), Math.abs(ty - ay));
      if (dAfter < dBefore && dAfter <= 2) {
        prio += (3 - dAfter) * (m1.rank === 1 ? 24000 : 16000);
      }
    }

    opL1.push({ board: b1, fromIdx: m1.fromIdx, toIdx: m1.toIdx, prio });
  }
  opL1.sort((a, b) => b.prio - a.prio);
  const opBeam1 = opL1.slice(0, 6);

  // Opponent Step 2
  const opL2Map = new Map<number, OpNode>();
  const opL2BaseSc = new Map<number, number>();
  for (let bIdx = 0; bIdx < opBeam1.length; bIdx++) {
    const n1 = opBeam1[bIdx];
    const m2List = generateSimMicroMoves(n1.board, opFaction);
    if (m2List.length === 0) {
      const sc = evaluateTurnEndState(
        n1.board,
        opFaction,
        ZERO_UNSEEN_BELIEF,
        opDraw,
        nextTurn,
        false,
        false
      );
      recordOpReply(n1.board, sc);
      continue;
    }
    for (let i = 0; i < m2List.length; i++) {
      const m2 = m2List[i];
      if (m2.fromIdx === n1.toIdx && m2.toIdx === n1.fromIdx) continue;
      const b2 = applySimMicroMove(n1.board, m2, opFaction);
      const h2 = hashSimBoard(b2);
      const dstTile = b2[m2.toIdx];
      let baseSc2 = opL2BaseSc.get(h2);
      if (baseSc2 === undefined) {
        baseSc2 = evaluateTurnEndState(
          b2,
          opFaction,
          ZERO_UNSEEN_BELIEF,
          opDraw,
          nextTurn,
          false,
          true
        );
        opL2BaseSc.set(h2, baseSc2);
      }
      let prio = baseSc2;
      let hasMyCard = false;
      let opCnt = 0;
      for (let k = 0; k < dstTile.length; k++) {
        if (dstTile[k].owner === myFaction) hasMyCard = true;
        else opCnt++;
      }
      if (hasMyCard) prio += 12000;
      if (opCnt >= 2) prio += 5500 * opCnt;
      if (m2.fromIdx === n1.fromIdx && m2.toIdx === n1.toIdx) prio += 8500;

      const toX = (m2.toIdx / 7) | 0;
      const toY = m2.toIdx % 7;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = toX + dx;
        if (nx < 0 || nx >= 7) continue;
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const ny = toY + dy;
          if (ny < 0 || ny >= 7) continue;
          const adjTile = b2[nx * 7 + ny];
          for (let k = 0; k < adjTile.length; k++) {
            if (adjTile[k].owner === myFaction) {
              prio += 16000;
              break;
            }
          }
        }
      }

      const prev = opL2Map.get(h2);
      if (!prev || prio > prev.prio) {
        opL2Map.set(h2, { board: b2, fromIdx: m2.fromIdx, toIdx: m2.toIdx, prio });
      }
    }
  }

  const opBeam2 = Array.from(opL2Map.values())
    .sort((a, b) => b.prio - a.prio)
    .slice(0, 6);
  const evalOpHashes = new Set<number>();

  // Opponent Step 3
  for (let bIdx = 0; bIdx < opBeam2.length; bIdx++) {
    const n2 = opBeam2[bIdx];
    const m3List = generateSimMicroMoves(n2.board, opFaction);
    if (m3List.length === 0) {
      const sc = evaluateTurnEndState(
        n2.board,
        opFaction,
        ZERO_UNSEEN_BELIEF,
        opDraw,
        nextTurn,
        false,
        false
      );
      recordOpReply(n2.board, sc);
      continue;
    }
    for (let i = 0; i < m3List.length; i++) {
      const m3 = m3List[i];
      if (m3.fromIdx === n2.toIdx && m3.toIdx === n2.fromIdx) continue;
      if (camouflagedHomeAceOnPost[m3.toIdx] === 1) continue;
      const dst = n2.board[m3.toIdx];
      // Prioritize tactical captures, stack merges, 3-step marches, or Ace moves in Opponent Step 3
      if (dst.length === 0 && m3.rank !== 1 && m3.fromIdx !== n2.toIdx && m3.fromIdx !== n2.fromIdx) {
        const fy = m3.fromIdx % 7;
        const ty = m3.toIdx % 7;
        const isForward = opFaction === 0 ? ty > fy : ty < fy;
        if (!isForward || bIdx >= 3 || i > 10) continue;
      }

      const b3 = applySimMicroMove(n2.board, m3, opFaction);
      const h3 = hashSimBoard(b3);
      if (evalOpHashes.has(h3)) continue;
      evalOpHashes.add(h3);

      const sc = evaluateTurnEndState(
        b3,
        opFaction,
        ZERO_UNSEEN_BELIEF,
        opDraw,
        nextTurn,
        false,
        false
      );
      recordOpReply(b3, sc);
    }
  }

  // Phase 2 Selective 3-Turn (9-Micro-Move) Forcing Extension (`Turn T -> Turn T+1 -> Turn T+2`):
  // Resolve the opponent's best Turn T+1 reply (`bestOpEndBoard`) and check if our surviving stacks
  // STILL have a verified 3-move lethal execution on Turn T+2 against an enemy Ace or 2+ card stack!
  let turn3ForcingBonusForUs = 0;
  if (maxOpScore < 110000 && bestOpEndBoard) {
    const postTurn2 = cloneSimBoard(bestOpEndBoard);
    let mySurvAcesAfterT2 = 0;
    for (let sq = 0; sq < 49; sq++) {
      const t = postTurn2[sq];
      if (t.length === 0) continue;
      const opC: SimCard[] = [];
      const myC: SimCard[] = [];
      for (let k = 0; k < t.length; k++) {
        t[k].locked = false;
        if (t[k].owner === opFaction) opC.push(t[k]);
        else myC.push(t[k]);
      }
      if (opC.length > 0 && myC.length > 0) {
        const res = resolveCombat(opC, myC);
        if (res.defenderDies && !res.attackerDies) postTurn2[sq] = opC;
        else if (res.defenderDies && res.attackerDies) postTurn2[sq] = [];
        else postTurn2[sq] = myC;
      }
      for (let k = 0; k < postTurn2[sq].length; k++) {
        if (postTurn2[sq][k].owner === myFaction && postTurn2[sq][k].rank === 1) {
          mySurvAcesAfterT2++;
        }
      }
    }
    if (mySurvAcesAfterT2 > 0) {
      for (let eSq = 0; eSq < 49; eSq++) {
        const eTile = postTurn2[eSq];
        if (!eTile.some((c) => c.owner === opFaction)) continue;
        let opDefPts = 0;
        let opCnt = 0;
        let opHasAce = false;
        let opHasJoker = false;
        for (let k = 0; k < eTile.length; k++) {
          const ec = eTile[k];
          if (ec.owner === opFaction) {
            opCnt++;
            opDefPts += rankPoints(ec.rank);
            if (ec.rank === 1) opHasAce = true;
            else if (ec.rank === 0) opHasJoker = true;
          }
        }
        const pAce = opHasAce ? 1.0 : opBelief.tileAceProb[eSq];
        if (pAce < 0.35 && opCnt < 2) continue;
        const ex = (eSq / 7) | 0;
        const ey = eSq % 7;
        let d1Top0 = 0;
        let d1Top1 = 0;
        let d2Top0 = 0;
        let reachAces = 0;
        for (let mSq = 0; mSq < 49; mSq++) {
          if (mSq === eSq) continue;
          const mTile = postTurn2[mSq];
          if (!mTile.some((c) => c.owner === myFaction)) continue;
          const mx = (mSq / 7) | 0;
          const my = mSq % 7;
          const d = Math.max(Math.abs(mx - ex), Math.abs(my - ey));
          if (d < 1 || d > 2) continue;
          for (let k = 0; k < mTile.length; k++) {
            const mc = mTile[k];
            if (mc.owner !== myFaction) continue;
            if (mc.rank === 1 && (mySurvAcesAfterT2 >= 2 || opHasAce)) {
              reachAces++;
            }
            const pts = rankPoints(mc.rank);
            if (d === 1) {
              if (pts >= d1Top0) {
                d1Top1 = d1Top0;
                d1Top0 = pts;
              } else if (pts > d1Top1) {
                d1Top1 = pts;
              }
            } else if (d === 2 && pts > d2Top0) {
              d2Top0 = pts;
            }
          }
        }
        const t3ReachPts = Math.max(d1Top0 + d1Top1, d1Top0 + d2Top0);
        const verifiedT3Kill =
          (!opHasJoker && t3ReachPts > opDefPts) ||
          (!opHasJoker && reachAces >= 1 && pAce >= 0.45) ||
          (opHasJoker && reachAces >= 2);
        if (verifiedT3Kill) {
          if (pAce >= 0.35) {
            turn3ForcingBonusForUs = Math.max(turn3ForcingBonusForUs, Math.round(16500 * pAce));
          } else if (opCnt >= 2) {
            turn3ForcingBonusForUs = Math.max(turn3ForcingBonusForUs, 4200);
          }
        }
      }
    }
  }

  globalBeliefTracker.startOfTurnMyHash = savedStartHash;
  globalBeliefTracker.recentBoardHashes = savedRecent;
  const beamOpScore =
    (maxOpScore === -Infinity ? 0 : maxOpScore) -
    turn3ForcingBonusForUs -
    disguisedJokerTrapBonusForUs;
  // Prevent Determinization Procrastination Paradox:
  // When the opponent still has unrevealed Aces (`opBelief.unseenAces > 0`), `assignDeterminizedWorld`
  // assigns `rank = 1` to uncontested squares. Anchor `effectivePvsOpScore` relative to `beamOpScore - 28000`
  // so a speculative Turn-3 determinized mate (-950,000) never overrides real Turn-1 captures or Turn-2 board value!
  const effectivePvsOpScore =
    opBelief.unseenAces > 0
      ? Math.max(pvsCombinedOpScore, beamOpScore - 28000)
      : pvsCombinedOpScore;
  let rawReplyScore: number;
  if (effectivePvsOpScore >= 800000 || beamOpScore >= 800000) {
    rawReplyScore = Math.max(effectivePvsOpScore, beamOpScore);
  } else if (effectivePvsOpScore <= -800000 && opBelief.unseenAces === 0) {
    rawReplyScore = Math.min(effectivePvsOpScore, beamOpScore);
  } else {
    rawReplyScore = Math.round(0.55 * beamOpScore + 0.45 * effectivePvsOpScore);
  }
  return rawReplyScore;
}

export function chooseGrandmasterAction(
  state: SmartEngineState,
  skipMinimax = false
): {
  actionIndex: number;
  score: number;
  reason: string;
} | null {
  if (skipMinimax) {
    const sq = [...globalBeliefTracker.plannedTurnQueue];
    const st = globalBeliefTracker.plannedTurnNumber;
    const sf = globalBeliefTracker.plannedTurnFaction;
    const sh = globalBeliefTracker.startOfTurnMyHash;
    const sr = [...globalBeliefTracker.recentBoardHashes];
    const pt = globalBeliefTracker.prevStepTurn;
    const pf = globalBeliefTracker.prevStepFaction;
    const pfi = globalBeliefTracker.prevStepFromIdx;
    const pti = globalBeliefTracker.prevStepToIdx;
    try {
      return chooseGrandmasterActionImpl(state, true);
    } finally {
      globalBeliefTracker.plannedTurnQueue = sq;
      globalBeliefTracker.plannedTurnNumber = st;
      globalBeliefTracker.plannedTurnFaction = sf;
      globalBeliefTracker.startOfTurnMyHash = sh;
      globalBeliefTracker.recentBoardHashes = sr;
      globalBeliefTracker.prevStepTurn = pt;
      globalBeliefTracker.prevStepFaction = pf;
      globalBeliefTracker.prevStepFromIdx = pfi;
      globalBeliefTracker.prevStepToIdx = pti;
    }
  }
  return chooseGrandmasterActionImpl(state, false);
}

function chooseGrandmasterActionImpl(
  state: SmartEngineState,
  skipMinimax = false
): {
  actionIndex: number;
  score: number;
  reason: string;
} | null {
  if (!state || !state.legal || state.legal.length === 0 || state.phase !== 'play') {
    return null;
  }

  if (!skipMinimax || (state.publicLog && state.publicLog.length > 0)) {
    globalBeliefTracker.observeState(state);
  }

  const myFaction = state.mover;
  const movesRem = Math.max(1, Math.min(3, state.movesRemaining || 3));
  const initialBoard = createInitialSimBoard(state);

  // Record current myFaction board hash at start of turn to forbid 3-step no-op circles
  if (movesRem === 3) {
    const startMyHash = hashMyBoard(initialBoard, myFaction);
    const startNonAceHash = hashMyNonAceBoard(initialBoard, myFaction);
    globalBeliefTracker.startOfTurnMyHash = startMyHash;
    if (
      globalBeliefTracker.recentBoardHashes.length === 0 ||
      globalBeliefTracker.recentBoardHashes[globalBeliefTracker.recentBoardHashes.length - 1] !==
        startMyHash
    ) {
      globalBeliefTracker.recentBoardHashes.push(startMyHash);
      if (startNonAceHash !== 0) {
        globalBeliefTracker.recentBoardHashes.push(startNonAceHash);
      }
      while (globalBeliefTracker.recentBoardHashes.length > 24) {
        globalBeliefTracker.recentBoardHashes.shift();
      }
    }
  }

  // Phase 4 Progressive 3-Stage Verification on Move 2 (`movesRem === 2`) and Move 3 (`movesRem === 1`):
  // Seed the search with `warmPlannedStep` + `warmPlannedSecondStep` and run full Turn-2 Minimax + Multi-World PVS
  // verification on the remaining micro-moves, while strictly forbidding intra-turn round-trip reversals of the previous step!
  let warmPlannedStep: PlannedMicroMove | null = null;
  let warmPlannedSecondStep: PlannedMicroMove | null = null;
  if (
    movesRem < 3 &&
    globalBeliefTracker.plannedTurnNumber === state.turn &&
    globalBeliefTracker.plannedTurnFaction === myFaction &&
    globalBeliefTracker.plannedTurnQueue.length > 0
  ) {
    warmPlannedStep = globalBeliefTracker.plannedTurnQueue[0];
    if (globalBeliefTracker.plannedTurnQueue.length > 1) {
      warmPlannedSecondStep = globalBeliefTracker.plannedTurnQueue[1];
    }
  }
  const banReverseFromIdx =
    movesRem < 3 &&
    globalBeliefTracker.prevStepTurn === state.turn &&
    globalBeliefTracker.prevStepFaction === myFaction
      ? globalBeliefTracker.prevStepToIdx
      : -1;
  const banReverseToIdx =
    movesRem < 3 &&
    globalBeliefTracker.prevStepTurn === state.turn &&
    globalBeliefTracker.prevStepFaction === myFaction
      ? globalBeliefTracker.prevStepFromIdx
      : -1;

  // On Move 2 (`movesRem === 2`) and Move 3 (`movesRem === 1`), Move 1 (`movesRem === 3`) ALREADY
  // evaluated all 3-move sequences + Whole-Turn Macros (Phalanx Shift, 2-Card Intact Shift, 2-Card Stack Plan,
  // Convergent Pincer, Ace+Guard Rendezvous, 3-Step Assassin) on the exact same deterministic board and
  // verified the full 3-move plan against Multi-World Stockfish PVS. Execute the verified follow-up step directly!
  if (!skipMinimax && movesRem < 3 && warmPlannedStep !== null) {
    let matchedIdx = -1;
    for (let i = 0; i < state.legal.length; i++) {
      const act = state.legal[i];
      if (act.spawn || !act.from || !act.to) continue;
      const fx = Array.isArray(act.from) ? act.from[0] : act.from.x;
      const fy = Array.isArray(act.from) ? act.from[1] : act.from.y;
      const tx = Array.isArray(act.to) ? act.to[0] : act.to.x;
      const ty = Array.isArray(act.to) ? act.to[1] : act.to.y;
      const fromIdx = fx * 7 + fy;
      const toIdx = tx * 7 + ty;
      if (banReverseFromIdx >= 0 && fromIdx === banReverseFromIdx && toIdx === banReverseToIdx) {
        continue;
      }
      if (
        fx === warmPlannedStep.fromX &&
        fy === warmPlannedStep.fromY &&
        tx === warmPlannedStep.toX &&
        ty === warmPlannedStep.toY
      ) {
        const r = parseCardRank(act.card || act.name, act.cardRank);
        if (warmPlannedStep.rank === -1 || r === warmPlannedStep.rank) {
          matchedIdx = i;
          break;
        }
        if (matchedIdx === -1) matchedIdx = i;
      }
    }
    if (matchedIdx !== -1) {
      globalBeliefTracker.plannedTurnQueue = globalBeliefTracker.plannedTurnQueue.slice(1);
      globalBeliefTracker.prevStepTurn = state.turn;
      globalBeliefTracker.prevStepFaction = myFaction;
      globalBeliefTracker.prevStepFromIdx = warmPlannedStep.fromX * 7 + warmPlannedStep.fromY;
      globalBeliefTracker.prevStepToIdx = warmPlannedStep.toX * 7 + warmPlannedStep.toY;
      const chosen = state.legal[matchedIdx];
      return {
        actionIndex: matchedIdx,
        score: 0,
        reason: `Verified Turn Plan: ${chosen.card || chosen.name || 'Card'} (${warmPlannedStep.fromX},${warmPlannedStep.fromY})->(${warmPlannedStep.toX},${warmPlannedStep.toY})`,
      };
    }
  }

  const opFaction = 1 - myFaction;
  const opBelief = computeBelief(state.board, state.draw, opFaction);
  const myBelief = computeBelief(state.board, state.draw, myFaction);

  const buildUnseenDrawRanks = (b: FactionBelief): number[] => {
    const out: number[] = [];
    const hc = b.unseenHighCards;
    for (let k = 0; k < (hc.K || 0); k++) out.push(13);
    for (let k = 0; k < (hc.Q || 0); k++) out.push(12);
    for (let k = 0; k < (hc.J || 0); k++) out.push(11);
    for (let k = 0; k < (hc['10'] || 0); k++) out.push(10);
    for (let k = 0; k < (hc['9'] || 0); k++) out.push(9);
    if (b.unseenJoker) out.push(0);
    while (out.length < 6) out.push(10);
    return out;
  };

  const myDrawRanks = state.drawPileRanks?.[myFaction] ?? buildUnseenDrawRanks(myBelief);
  const opDrawRanks = state.drawPileRanks?.[opFaction] ?? buildUnseenDrawRanks(opBelief);
  const nextMySpawnRank = Math.round(myBelief.expectedUnseenCourt || 10);

  interface TurnCandidate {
    firstIdx: number;
    firstDesc: string;
    followUps: PlannedMicroMove[];
    endBoard: SimCard[][];
    endHash: number;
    turn1Score: number;
  }

  // Phase 3 Root Null-Move Threat Vector & Interposition Map:
  // Identify enemy stacks within d <= 3 of our Aces and mark both the enemy attacker square
  // (for pre-emptive counter-strikes) and all shortest-path transit squares (for interposition!).
  const interpositionBonusSq = new Int32Array(49);
  const rootMyAceSqs: number[] = [];
  for (let sq = 0; sq < 49; sq++) {
    if (initialBoard[sq].some((c) => c.owner === myFaction && c.rank === 1)) {
      rootMyAceSqs.push(sq);
    }
  }
  for (let a = 0; a < rootMyAceSqs.length; a++) {
    const aSq = rootMyAceSqs[a];
    const ax = (aSq / 7) | 0;
    const ay = aSq % 7;
    const aDepth = myFaction === 0 ? ay : 6 - ay;
    const aTile = initialBoard[aSq];
    const aceRev = aTile.some((c) => c.owner === myFaction && c.rank === 1 && c.revealed);
    const maxThreatDist =
      !aceRev && aDepth === 0 && aTile.length === 1 && rootMyAceSqs.length >= 2 ? 2 : 3;
    interpositionBonusSq[aSq] += 6000; // Reward armoring our threatened Ace square!
    for (let eSq = 0; eSq < 49; eSq++) {
      const eTile = initialBoard[eSq];
      if (!eTile.some((c) => c.owner === opFaction)) continue;
      const ex = (eSq / 7) | 0;
      const ey = eSq % 7;
      const d = Math.max(Math.abs(ax - ex), Math.abs(ay - ey));
      const eIsLikelyAce =
        eTile.some((c) => c.owner === opFaction && c.rank === 1) || opBelief.tileAceProb[eSq] >= 0.32;
      if (d >= 1 && (d <= maxThreatDist || (d === 3 && eIsLikelyAce))) {
        interpositionBonusSq[eSq] += 11000; // Pre-emptive strike on the enemy threat!
        for (let mSq = 0; mSq < 49; mSq++) {
          const mx = (mSq / 7) | 0;
          const my = mSq % 7;
          const d1 = Math.max(Math.abs(ex - mx), Math.abs(ey - my));
          const d2 = Math.max(Math.abs(mx - ax), Math.abs(my - ay));
          if (d1 >= 1 && d2 >= 1 && d1 + d2 === d) {
            interpositionBonusSq[mSq] += 7500; // Interpose on the shortest attack ray!
          }
        }
      }
    }
  }

  // Helper to penalize unnecessary shuffling of an unthreatened back-row Ace onto an empty square
  // when it is not attacking an enemy, not armoring with a friendly guard, and not evading an enemy within d<=3.
  const computeUnnecessaryAceMovePenalty = (
    boardBeforeMove: SimCard[][],
    fromSq: number,
    toSq: number,
    movedRank: number
  ): number => {
    if (movedRank !== 1) return 0;
    const toTile = boardBeforeMove[toSq];
    // Attacking an enemy or merging onto a friendly guard card is purposeful!
    if (toTile.length > 0) return 0;
    const fromTile = boardBeforeMove[fromSq];
    // Separating two friendly Aces stacked on the same square is mandatory!
    let acesOnFrom = 0;
    for (let k = 0; k < fromTile.length; k++) {
      if (fromTile[k].owner === myFaction && fromTile[k].rank === 1) acesOnFrom++;
    }
    if (acesOnFrom >= 2) return 0;
    // Check if any enemy piece is within Chebyshev distance <= 3 of `fromSq`
    const fx = (fromSq / 7) | 0;
    const fy = fromSq % 7;
    const tx = (toSq / 7) | 0;
    const ty = toSq % 7;
    const fromDepth = myFaction === 0 ? fy : 6 - fy;
    const toDepth = myFaction === 0 ? ty : 6 - ty;
    // Allow an Ace that ended up forward (fromDepth >= 1) to retreat toward the back row
    if (fromDepth >= 1 && toDepth < fromDepth) return 0;
    const aceIsRevealed = fromTile.some((c) => c.owner === myFaction && c.rank === 1 && c.revealed);
    const isCamouflagedHomeAce =
      !aceIsRevealed && fromDepth === 0 && fromTile.length === 1 && rootMyAceSqs.length >= 2;
    for (let eSq = 0; eSq < 49; eSq++) {
      const eTile = boardBeforeMove[eSq];
      if (!eTile.some((c) => c.owner === opFaction)) continue;
      const ex = (eSq / 7) | 0;
      const ey = eSq % 7;
      const dBefore = Math.max(Math.abs(fx - ex), Math.abs(fy - ey));
      const dAfter = Math.max(Math.abs(tx - ex), Math.abs(ty - ey));
      const eIsLikelyAce =
        eTile.some((c) => c.owner === opFaction && c.rank === 1) ||
        opBelief.tileAceProb[eSq] >= 0.32;
      if (dBefore <= (isCamouflagedHomeAce && !eIsLikelyAce ? 2 : 3) && dAfter >= dBefore) {
        return 0; // Threatened Ace evading!
      }
    }
    if (!aceIsRevealed && fromTile.length === 1 && toDepth <= 1) {
      let safeAtTo = true;
      for (let oSq = 0; oSq < 49; oSq++) {
        if (oSq === fromSq) continue;
        const oTile = boardBeforeMove[oSq];
        if (oTile.length === 0) continue;
        const ox = (oSq / 7) | 0;
        const oy = oSq % 7;
        if (oTile.some((c) => c.owner === opFaction) && Math.max(Math.abs(tx - ox), Math.abs(ty - oy)) <= 3) {
          safeAtTo = false;
          break;
        }
        if (oTile.some((c) => c.owner === myFaction && c.rank === 1) && Math.abs(tx - ox) < 2) {
          safeAtTo = false;
          break;
        }
      }
      if (safeAtTo) {
        return 5500;
      }
    }
    return toDepth > fromDepth ? 65000 : 45000; // Unthreatened Ace shuffling onto an empty square wastes a micro-move and telegraphs movement!
  };

  // Part 2.A: Keep up to 2 top distinct end-of-turn plans per `firstIdx` (deduplicated by `endHash`)
  // so a greedy Move-3 blunder NEVER overwrites a safe Move-2/Move-3 continuation sharing the same Move 1!
  const candidatesByFirstIdx = new Map<number, TurnCandidate[]>();
  const recordCandidate = (
    firstIdx: number,
    firstDesc: string,
    followUps: PlannedMicroMove[],
    endBoard: SimCard[][],
    rawScore: number
  ) => {
    const endHash = hashSimBoard(endBoard);
    const list = candidatesByFirstIdx.get(firstIdx) || [];
    const existingSameHash = list.findIndex((c) => c.endHash === endHash);
    if (existingSameHash >= 0) {
      if (rawScore > list[existingSameHash].turn1Score) {
        list[existingSameHash] = {
          firstIdx,
          firstDesc,
          followUps,
          endBoard,
          endHash,
          turn1Score: rawScore,
        };
        list.sort((a, b) => b.turn1Score - a.turn1Score);
      }
      return;
    }
    list.push({
      firstIdx,
      firstDesc,
      followUps,
      endBoard,
      endHash,
      turn1Score: rawScore,
    });
    list.sort((a, b) => b.turn1Score - a.turn1Score);
    if (list.length > 4) list.pop();
    candidatesByFirstIdx.set(firstIdx, list);
  };

  // 1. Evaluate all legal Spawn actions (if movesRemaining === 3)
  state.legal.forEach((act, idx) => {
    if (!act.spawn) return;
    const afterSpawnBoard = applyLegalActionToSim(initialBoard, act, myFaction, nextMySpawnRank);
    const toX = Array.isArray(act.to) ? act.to[0] : act.to.x;
    const toY = Array.isArray(act.to) ? act.to[1] : act.to.y;

    let score = evaluateTurnEndState(
      afterSpawnBoard,
      myFaction,
      opBelief,
      Math.max(0, (state.draw[myFaction] || 0) - 1),
      state.turn,
      true,
      false
    );

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const nx = toX + dx;
        const ny = toY + dy;
        if (nx >= 0 && nx < 7 && ny >= 0 && ny < 7) {
          const adj = initialBoard[nx * 7 + ny].filter((c) => c.owner === myFaction);
          if (adj.some((c) => c.rank === 1 && adj.length === 1)) {
            score += 1200;
          } else if (adj.length > 0) {
            score += 300;
          }
        }
      }
    }

    recordCandidate(idx, `Deploy reinforcement onto (${toX}, ${toY})`, [], afterSpawnBoard, score);
  });

  // 2. Evaluate all 1-move, 2-move, or 3-move sequences starting from each non-spawn legal action
  interface SearchNode {
    board: SimCard[][];
    firstIdx: number;
    firstDesc: string;
    lastFromIdx: number;
    lastToIdx: number;
    heuristic: number;
    cumulPen: number;
    followUps: PlannedMicroMove[];
  }

  const level1Nodes: SearchNode[] = [];

  state.legal.forEach((act, idx) => {
    if (act.spawn) return;
    const b1 = applyLegalActionToSim(initialBoard, act, myFaction);
    const fx = act.from ? (Array.isArray(act.from) ? act.from[0] : act.from.x) : 0;
    const fy = act.from ? (Array.isArray(act.from) ? act.from[1] : act.from.y) : 0;
    const tx = Array.isArray(act.to) ? act.to[0] : act.to.x;
    const ty = Array.isArray(act.to) ? act.to[1] : act.to.y;
    const fromIdx = fx * 7 + fy;
    const toIdx = tx * 7 + ty;
    // Never reverse the immediately preceding micro-move of the same turn (e.g. Move 2 A->B followed by Move 3 B->A)!
    if (
      banReverseFromIdx >= 0 &&
      fromIdx === banReverseFromIdx &&
      toIdx === banReverseToIdx &&
      state.legal.length > 1
    ) {
      return;
    }
    // Ban Move-1 -> Move-2 triangle detours onto empty squares (`prevFrom -> prevTo -> toIdx` where Chebyshev(prevFrom, toIdx) <= 1)
    if (
      movesRem === 2 &&
      banReverseFromIdx >= 0 &&
      banReverseToIdx >= 0 &&
      fromIdx === banReverseFromIdx &&
      !initialBoard[banReverseFromIdx].some((c) => c.owner === opFaction) &&
      !initialBoard[toIdx].some((c) => c.owner === myFaction)
    ) {
      const pfx = (banReverseToIdx / 7) | 0;
      const pfy = banReverseToIdx % 7;
      if (Math.max(Math.abs(tx - pfx), Math.abs(ty - pfy)) <= 1 && state.legal.length > 2) {
        return;
      }
    }
    const movedRank1 = parseCardRank(act.card || act.name, act.cardRank);
    const aceShufflePen1 = computeUnnecessaryAceMovePenalty(initialBoard, fromIdx, toIdx, movedRank1);
    const desc = `${act.card || act.name || 'Card'} (${fx},${fy})->(${tx},${ty})`;

    const matchesWarmPlan =
      warmPlannedStep !== null &&
      fx === warmPlannedStep.fromX &&
      fy === warmPlannedStep.fromY &&
      tx === warmPlannedStep.toX &&
      ty === warmPlannedStep.toY &&
      (warmPlannedStep.rank === -1 || movedRank1 === warmPlannedStep.rank);
    const warmBonus = matchesWarmPlan ? 11500 : 0;

    if (movesRem === 1) {
      const sc =
        evaluateTurnEndState(
          b1,
          myFaction,
          opBelief,
          state.draw[myFaction] || 0,
          state.turn,
          false,
          false
        ) +
        warmBonus -
        aceShufflePen1;
      recordCandidate(idx, desc, [], b1, sc);
    } else {
      let interScore =
        evaluateTurnEndState(
          b1,
          myFaction,
          opBelief,
          state.draw[myFaction] || 0,
          state.turn,
          false,
          true
        ) +
        warmBonus -
        aceShufflePen1;
      // If Move 1 peels the first card off a 2+ card stack, boost interScore so stack marches are never penalized!
      // Especially when `toIdx` has an enemy stack (`opOnTo`), peeling the 1st card of our 2+ card stack temporarily
      // looks like a 1-on-2 loss on `b1` until the 2nd card lands on `toIdx` on Step 2!
      if (initialBoard[fromIdx].length >= 2) {
        interScore += initialBoard[toIdx].some((c) => c.owner === opFaction) ? 22000 : 5500;
      }
      if (interpositionBonusSq[toIdx] > 0) {
        interScore += interpositionBonusSq[toIdx];
      }
      level1Nodes.push({
        board: b1,
        firstIdx: idx,
        firstDesc: desc,
        lastFromIdx: fromIdx,
        lastToIdx: toIdx,
        heuristic: interScore,
        cumulPen: aceShufflePen1,
        followUps: [],
      });
    }
  });

  // Phase 1 Whole-Turn Macro Generator (Arimaa-style 3-Step Tactical Primitives):
  // Explicitly generate 3-card Phalanx Shifts, 3-Step Deep Assassin Strikes (d=3),
  // 2-Card Convergent Pincer Strikes (d=2 + d=1), and Emergency Ace Evasion + Escort Macros
  // so they can NEVER be pruned by intermediate split-stack beam heuristics!
  if (movesRem === 3) {
    state.legal.forEach((act, idx) => {
      if (act.spawn || !act.from || !act.to) return;
      const fx = Array.isArray(act.from) ? act.from[0] : act.from.x;
      const fy = Array.isArray(act.from) ? act.from[1] : act.from.y;
      const tx = Array.isArray(act.to) ? act.to[0] : act.to.x;
      const ty = Array.isArray(act.to) ? act.to[1] : act.to.y;
      const fromIdx = fx * 7 + fy;
      const toIdx = tx * 7 + ty;
      const movedRank1 = parseCardRank(act.card || act.name, act.cardRank);
      const myFromCards = initialBoard[fromIdx].filter((c) => c.owner === myFaction && !c.locked);
      const myToCards = initialBoard[toIdx].filter((c) => c.owner === myFaction);
      const opOnTo = initialBoard[toIdx].some((c) => c.owner === opFaction);

      // Macro 1: 3-Card Phalanx Shift (moving all 3 cards of a 3-card stack 1 square together)
      if (myFromCards.length === 3 && myToCards.length <= 1) {
        const b1 = applyLegalActionToSim(initialBoard, act, myFaction);
        const rem1 = b1[fromIdx].findIndex((c) => c.owner === myFaction && !c.locked);
        if (rem1 >= 0) {
          const r2 = b1[fromIdx][rem1].rank;
          const b2 = applySimMicroMove(
            b1,
            { fromIdx, toIdx, cardPosInTile: rem1, rank: r2 },
            myFaction
          );
          const rem2 = b2[fromIdx].findIndex((c) => c.owner === myFaction && !c.locked);
          if (rem2 >= 0) {
            const r3 = b2[fromIdx][rem2].rank;
            const b3 = applySimMicroMove(
              b2,
              { fromIdx, toIdx, cardPosInTile: rem2, rank: r3 },
              myFaction
            );
            const sc = evaluateTurnEndState(
              b3,
              myFaction,
              opBelief,
              state.draw[myFaction] || 0,
              state.turn,
              false,
              false
            );
            recordCandidate(
              idx,
              `Phalanx Shift (${fx},${fy})->(${tx},${ty})`,
              [
                { fromX: fx, fromY: fy, toX: tx, toY: ty, rank: r2 },
                { fromX: fx, fromY: fy, toX: tx, toY: ty, rank: r3 },
              ],
              b3,
              sc
            );
          }
        }
      }

      // Macro 1B: 2-Card Stack 3-Step Intact Shift (`Card1: fromIdx -> toIdx`, `Card2: fromIdx -> midIdx -> toIdx`):
      // When a threatened 2-card stack (or a 2-card stack in the endgame with no better 3rd move) needs to move 1 square
      // intact using all 3 micro-moves of a turn without splitting, Card 2 triangulates via an adjacent `midIdx`!
      if (myFromCards.length === 2 && myToCards.length <= 2 && !opOnTo) {
        const b1 = applyLegalActionToSim(initialBoard, act, myFaction);
        const pen1 = computeUnnecessaryAceMovePenalty(initialBoard, fromIdx, toIdx, movedRank1);
        const rem1 = b1[fromIdx].findIndex((c) => c.owner === myFaction && !c.locked);
        if (rem1 >= 0 && !(movedRank1 === 1 && pen1 > 0)) {
          const r2 = b1[fromIdx][rem1].rank;
          for (let dxm = -1; dxm <= 1; dxm++) {
            const mx = fx + dxm;
            if (mx < 0 || mx >= 7) continue;
            for (let dym = -1; dym <= 1; dym++) {
              if (dxm === 0 && dym === 0) continue;
              const my = fy + dym;
              if (my < 0 || my >= 7) continue;
              if (mx === tx && my === ty) continue;
              if (Math.max(Math.abs(mx - tx), Math.abs(my - ty)) !== 1) continue;
              const midIdx = mx * 7 + my;
              if (b1[midIdx].some((c) => c.owner === opFaction)) continue;
              if (b1[midIdx].filter((c) => c.owner === myFaction).length >= 4) continue;
              const pen2 = computeUnnecessaryAceMovePenalty(b1, fromIdx, midIdx, r2);
              if (r2 === 1 && pen2 > 0) continue;
              const b2 = applySimMicroMove(
                b1,
                { fromIdx, toIdx: midIdx, cardPosInTile: rem1, rank: r2 },
                myFaction
              );
              const slotMid = b2[midIdx].findIndex(
                (c) => c.owner === myFaction && !c.locked && c.rank === r2
              );
              if (slotMid >= 0) {
                const pen3 = computeUnnecessaryAceMovePenalty(b2, midIdx, toIdx, r2);
                const b3 = applySimMicroMove(
                  b2,
                  { fromIdx: midIdx, toIdx, cardPosInTile: slotMid, rank: r2 },
                  myFaction
                );
                const sc =
                  evaluateTurnEndState(
                    b3,
                    myFaction,
                    opBelief,
                    state.draw[myFaction] || 0,
                    state.turn,
                    false,
                    false
                  ) -
                  pen1 -
                  pen2 -
                  pen3 -
                  8200;
                recordCandidate(
                  idx,
                  `2-Card Intact Shift (${fx},${fy})->(${tx},${ty})`,
                  [
                    { fromX: fx, fromY: fy, toX: mx, toY: my, rank: r2 },
                    { fromX: mx, fromY: my, toX: tx, toY: ty, rank: r2 },
                  ],
                  b3,
                  sc
                );
              }
            }
          }
        }
      }
      // Macro 1C: 2-Card Stack Move / Assault + Best 3rd Micro-Move (`Card1: fromIdx -> toIdx`, `Card2: fromIdx -> toIdx`, `Card3: m3`)
      // Tests EVERY distinct unlocked rank on `fromIdx` as the 2nd card (so `[Joker, King, 9]` tests both `[King, Joker]` and `[King, 9]`)!
      if (myFromCards.length >= 2 && myToCards.length <= 1) {
        const b1 = applyLegalActionToSim(initialBoard, act, myFaction);
        let testedSecondRanksMask = 0;
        for (let rem1 = 0; rem1 < b1[fromIdx].length; rem1++) {
          const c2 = b1[fromIdx][rem1];
          if (c2.owner !== myFaction || c2.locked) continue;
          const r2 = c2.rank;
          const r2Bit = 1 << Math.max(0, r2 + 2);
          if ((testedSecondRanksMask & r2Bit) !== 0) continue;
          testedSecondRanksMask |= r2Bit;

          const b2 = applySimMicroMove(
            b1,
            { fromIdx, toIdx, cardPosInTile: rem1, rank: r2 },
            myFaction
          );
          const step2AttackPlan: PlannedMicroMove = {
            fromX: fx,
            fromY: fy,
            toX: tx,
            toY: ty,
            rank: r2,
          };
          const m3Cands = generateSimMicroMoves(b2, myFaction);
          for (let m3i = 0; m3i < m3Cands.length; m3i++) {
            const m3 = m3Cands[m3i];
            // Never immediately split the 2-card stack we just moved to `toIdx` onto an empty square;
            // allow Leapfrog Escorted Strike when `m3.toIdx` holds an enemy card (`b2[m3.toIdx]` has opFaction)!
            if (m3.fromIdx === toIdx && !b2[m3.toIdx].some((c) => c.owner === opFaction)) continue;
            const pen3 = computeUnnecessaryAceMovePenalty(b2, m3.fromIdx, m3.toIdx, m3.rank);
            if (m3.rank === 1 && pen3 > 0) continue;
            const b3 = applySimMicroMove(b2, m3, myFaction);
            const sc =
              evaluateTurnEndState(
                b3,
                myFaction,
                opBelief,
                state.draw[myFaction] || 0,
                state.turn,
                false,
                false
              ) - pen3;
            recordCandidate(
              idx,
              `2-Card Stack Plan (${fx},${fy})->(${tx},${ty})`,
              [
                step2AttackPlan,
                {
                  fromX: (m3.fromIdx / 7) | 0,
                  fromY: m3.fromIdx % 7,
                  toX: (m3.toIdx / 7) | 0,
                  toY: m3.toIdx % 7,
                  rank: m3.rank,
                },
              ],
              b3,
              sc
            );
          }
        }
      }

      // Macro 2B & 2C: When Move 1 (`act`) steps directly onto an enemy square `toIdx` (`opOnTo === true`):
      // - Macro 2B: Reverse-Order 1-Step + 2-Step Convergent Pincer (`Card1(d=1) -> toIdx` on Move 1, then `Card2(d=2) -> mid -> toIdx` on Moves 2 & 3!)
      // - Macro 2C: 3-Card Multi-Origin Convergence (`Card1(d=1) -> toIdx` + `Card2(d=1) -> toIdx` + `Card3(d=1) -> toIdx`) to crush heavy enemy fortresses!
      if (opOnTo && myToCards.length <= 2) {
        const b1 = applyLegalActionToSim(initialBoard, act, myFaction);
        // Macro 2B: Scan all friendly unlocked cards at d=2 from `toIdx`
        for (let auxSq = 0; auxSq < 49; auxSq++) {
          if (auxSq === toIdx) continue;
          const ax = (auxSq / 7) | 0;
          const ay = auxSq % 7;
          if (Math.max(Math.abs(ax - tx), Math.abs(ay - ty)) !== 2) continue;
          if (b1[auxSq].some((c) => c.owner === opFaction)) continue;
          const auxSlot = b1[auxSq].findIndex((c) => c.owner === myFaction && !c.locked);
          if (auxSlot < 0) continue;
          const auxRank = b1[auxSq][auxSlot].rank;
          // Find a clear intermediate square `midSq` at d=1 from both `auxSq` and `toIdx`
          for (let dxm = -1; dxm <= 1; dxm++) {
            const mx = ax + dxm;
            if (mx < 0 || mx >= 7) continue;
            for (let dym = -1; dym <= 1; dym++) {
              if (dxm === 0 && dym === 0) continue;
              const my = ay + dym;
              if (my < 0 || my >= 7) continue;
              if (Math.max(Math.abs(mx - tx), Math.abs(my - ty)) !== 1) continue;
              const midIdx = mx * 7 + my;
              if (b1[midIdx].some((c) => c.owner === opFaction)) continue;
              if (b1[midIdx].filter((c) => c.owner === myFaction).length >= 4) continue;
              const b2 = applySimMicroMove(
                b1,
                { fromIdx: auxSq, toIdx: midIdx, cardPosInTile: auxSlot, rank: auxRank },
                myFaction
              );
              const midSlot = b2[midIdx].findIndex(
                (c) => c.owner === myFaction && !c.locked && c.rank === auxRank
              );
              if (midSlot >= 0) {
                const b3 = applySimMicroMove(
                  b2,
                  { fromIdx: midIdx, toIdx, cardPosInTile: midSlot, rank: auxRank },
                  myFaction
                );
                const sc = evaluateTurnEndState(
                  b3,
                  myFaction,
                  opBelief,
                  state.draw[myFaction] || 0,
                  state.turn,
                  false,
                  false
                );
                recordCandidate(
                  idx,
                  `Convergent Pincer (${fx},${fy})+((${ax},${ay}))->(${tx},${ty})`,
                  [
                    { fromX: ax, fromY: ay, toX: mx, toY: my, rank: auxRank },
                    { fromX: mx, fromY: my, toX: tx, toY: ty, rank: auxRank },
                  ],
                  b3,
                  sc
                );
              }
              break;
            }
          }
        }
        // Macro 2C: 3-Card Multi-Origin Convergence onto `toIdx` (3 friendly cards at d=1 all converging onto `toIdx`)
        if (myToCards.length <= 1) {
          const d1Sources: Array<{ sq: number; x: number; y: number }> = [];
          for (let dx = -1; dx <= 1; dx++) {
            const nx = tx + dx;
            if (nx < 0 || nx >= 7) continue;
            for (let dy = -1; dy <= 1; dy++) {
              if (dx === 0 && dy === 0) continue;
              const ny = ty + dy;
              if (ny < 0 || ny >= 7) continue;
              const nSq = nx * 7 + ny;
              if (b1[nSq].some((c) => c.owner === opFaction)) continue;
              if (b1[nSq].some((c) => c.owner === myFaction && !c.locked)) {
                d1Sources.push({ sq: nSq, x: nx, y: ny });
              }
            }
          }
          for (let sA = 0; sA < d1Sources.length; sA++) {
            const srcA = d1Sources[sA];
            const slotA = b1[srcA.sq].findIndex((c) => c.owner === myFaction && !c.locked);
            if (slotA < 0) continue;
            const rankA = b1[srcA.sq][slotA].rank;
            const b2 = applySimMicroMove(
              b1,
              { fromIdx: srcA.sq, toIdx, cardPosInTile: slotA, rank: rankA },
              myFaction
            );
            for (let sB = sA; sB < d1Sources.length; sB++) {
              const srcB = d1Sources[sB];
              const slotB = b2[srcB.sq].findIndex((c) => c.owner === myFaction && !c.locked);
              if (slotB < 0) continue;
              const rankB = b2[srcB.sq][slotB].rank;
              const b3 = applySimMicroMove(
                b2,
                { fromIdx: srcB.sq, toIdx, cardPosInTile: slotB, rank: rankB },
                myFaction
              );
              const sc = evaluateTurnEndState(
                b3,
                myFaction,
                opBelief,
                state.draw[myFaction] || 0,
                state.turn,
                false,
                false
              );
              recordCandidate(
                idx,
                `3-Card Siege Ram ->(${tx},${ty})`,
                [
                  { fromX: srcA.x, fromY: srcA.y, toX: tx, toY: ty, rank: rankA },
                  { fromX: srcB.x, fromY: srcB.y, toX: tx, toY: ty, rank: rankB },
                ],
                b3,
                sc
              );
            }
          }
        }

        // Phase 3 Macro 6 (Precision 1-Card Kill + 2-Card Stack Shift) & Macro 7 (Simultaneous Dual-Square Attack Fork):
        for (let auxSq = 0; auxSq < 49; auxSq++) {
          if (auxSq === toIdx) continue;
          if (b1[auxSq].some((c) => c.owner === opFaction)) continue;
          const myAuxCards = b1[auxSq].filter((c) => c.owner === myFaction && !c.locked);
          if (myAuxCards.length === 0) continue;
          const ax = (auxSq / 7) | 0;
          const ay = auxSq % 7;

          if (myAuxCards.length >= 2) {
            const slotA = b1[auxSq].findIndex((c) => c.owner === myFaction && !c.locked);
            const rankA = b1[auxSq][slotA].rank;
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              const dxX = ax + dx2;
              if (dxX < 0 || dxX >= 7) continue;
              for (let dy2 = -1; dy2 <= 1; dy2++) {
                if (dx2 === 0 && dy2 === 0) continue;
                const dyY = ay + dy2;
                if (dyY < 0 || dyY >= 7) continue;
                const dstSq = dxX * 7 + dyY;
                if (dstSq === toIdx) continue;
                if (b1[dstSq].filter((c) => c.owner === myFaction).length >= 3) continue;
                const penA = computeUnnecessaryAceMovePenalty(b1, auxSq, dstSq, rankA);
                if (rankA === 1 && penA > 0) continue;
                const b2 = applySimMicroMove(
                  b1,
                  { fromIdx: auxSq, toIdx: dstSq, cardPosInTile: slotA, rank: rankA },
                  myFaction
                );
                const slotB = b2[auxSq].findIndex((c) => c.owner === myFaction && !c.locked);
                if (slotB >= 0) {
                  const rankB = b2[auxSq][slotB].rank;
                  const penB = computeUnnecessaryAceMovePenalty(b2, auxSq, dstSq, rankB);
                  if (rankB === 1 && penB > 0) continue;
                  const b3 = applySimMicroMove(
                    b2,
                    { fromIdx: auxSq, toIdx: dstSq, cardPosInTile: slotB, rank: rankB },
                    myFaction
                  );
                  const sc =
                    evaluateTurnEndState(
                      b3,
                      myFaction,
                      opBelief,
                      state.draw[myFaction] || 0,
                      state.turn,
                      false,
                      false
                    ) -
                    penA -
                    penB;
                  const isDualAttack = b1[dstSq].some((c) => c.owner === opFaction);
                  recordCandidate(
                    idx,
                    isDualAttack
                      ? `Dual-Square Strike (${tx},${ty})+(${dxX},${dyY})`
                      : `1-Card Strike + 2-Card Shift (${tx},${ty})+(${dxX},${dyY})`,
                    [
                      { fromX: ax, fromY: ay, toX: dxX, toY: dyY, rank: rankA },
                      { fromX: ax, fromY: ay, toX: dxX, toY: dyY, rank: rankB },
                    ],
                    b3,
                    sc
                  );
                }
              }
            }
          }

          const slot1 = b1[auxSq].findIndex((c) => c.owner === myFaction && !c.locked);
          if (slot1 >= 0) {
            const rank1 = b1[auxSq][slot1].rank;
            for (let dxm = -1; dxm <= 1; dxm++) {
              const mx = ax + dxm;
              if (mx < 0 || mx >= 7) continue;
              for (let dym = -1; dym <= 1; dym++) {
                if (dxm === 0 && dym === 0) continue;
                const my = ay + dym;
                if (my < 0 || my >= 7) continue;
                const midSq = mx * 7 + my;
                if (midSq === toIdx || b1[midSq].some((c) => c.owner === opFaction)) continue;
                if (b1[midSq].filter((c) => c.owner === myFaction).length >= 4) continue;
                const b2 = applySimMicroMove(
                  b1,
                  { fromIdx: auxSq, toIdx: midSq, cardPosInTile: slot1, rank: rank1 },
                  myFaction
                );
                const slotMid = b2[midSq].findIndex(
                  (c) => c.owner === myFaction && !c.locked && c.rank === rank1
                );
                if (slotMid >= 0) {
                  for (let dxe = -1; dxe <= 1; dxe++) {
                    const ex2 = mx + dxe;
                    if (ex2 < 0 || ex2 >= 7) continue;
                    for (let dye = -1; dye <= 1; dye++) {
                      if (dxe === 0 && dye === 0) continue;
                      const ey2 = my + dye;
                      if (ey2 < 0 || ey2 >= 7) continue;
                      if (Math.max(Math.abs(ex2 - ax), Math.abs(ey2 - ay)) <= 1) continue;
                      const enemySq2 = ex2 * 7 + ey2;
                      if (enemySq2 === toIdx || !b2[enemySq2].some((c) => c.owner === opFaction)) continue;
                      const b3 = applySimMicroMove(
                        b2,
                        { fromIdx: midSq, toIdx: enemySq2, cardPosInTile: slotMid, rank: rank1 },
                        myFaction
                      );
                      const sc = evaluateTurnEndState(
                        b3,
                        myFaction,
                        opBelief,
                        state.draw[myFaction] || 0,
                        state.turn,
                        false,
                        false
                      );
                      recordCandidate(
                        idx,
                        `Dual-Square Assassin (${tx},${ty})+(${ex2},${ey2})`,
                        [
                          { fromX: ax, fromY: ay, toX: mx, toY: my, rank: rank1 },
                          { fromX: mx, fromY: my, toX: ex2, toY: ey2, rank: rank1 },
                        ],
                        b3,
                        sc
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }

      // check for 3-Step Deep Assassin Strikes (`fromIdx -> toIdx -> mid2 -> enemySq`) AND
      // 2-Card Convergent Pincer Strikes (`fromIdx -> toIdx -> enemySq` + `otherSq(d=1) -> enemySq`)!
      if (!opOnTo) {
        const b1 = applyLegalActionToSim(initialBoard, act, myFaction);
        const pen1NonAttack = computeUnnecessaryAceMovePenalty(initialBoard, fromIdx, toIdx, movedRank1);

        // Macro 6B (Conveyor-Belt Phalanx Progression & Defend/Stage-First + 2-Card Stack Strike):
        // When Move 1 (`act`) steps onto a non-enemy square (`!opOnTo`, e.g. armoring/evacuating an Ace or advancing a front scout),
        // evaluate moving any 2-card stack at `auxSq` on Moves 2 & 3 either:
        //   (1) into the just-vacated `fromIdx` (Conveyor-Belt Phalanx Progression), OR
        //   (2) onto an adjacent enemy-occupied square `dstSq` (Defend-First + 2-Card Stack Strike)!
        if (!(movedRank1 === 1 && pen1NonAttack > 6000)) {
          for (let auxSq = 0; auxSq < 49; auxSq++) {
            if (auxSq === toIdx || auxSq === fromIdx) continue;
            if (b1[auxSq].some((c) => c.owner === opFaction)) continue;
            const slotA = b1[auxSq].findIndex((c) => c.owner === myFaction && !c.locked);
            if (slotA < 0) continue;
            let unlockedCntOnAux = 0;
            for (let k = 0; k < b1[auxSq].length; k++) {
              if (b1[auxSq][k].owner === myFaction && !b1[auxSq][k].locked) unlockedCntOnAux++;
            }
            if (unlockedCntOnAux < 2) continue;
            const rankA = b1[auxSq][slotA].rank;
            const ax = (auxSq / 7) | 0;
            const ay = auxSq % 7;
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              const dxX = ax + dx2;
              if (dxX < 0 || dxX >= 7) continue;
              for (let dy2 = -1; dy2 <= 1; dy2++) {
                if (dx2 === 0 && dy2 === 0) continue;
                const dyY = ay + dy2;
                if (dyY < 0 || dyY >= 7) continue;
                const dstSq = dxX * 7 + dyY;
                if (dstSq === toIdx) continue;
                const isConveyorIntoVacated = dstSq === fromIdx && b1[fromIdx].length <= 1;
                const isEnemyTarget = b1[dstSq].some((c) => c.owner === opFaction);
                if (!isConveyorIntoVacated && !isEnemyTarget) continue;
                if (b1[dstSq].filter((c) => c.owner === myFaction).length >= 3) continue;
                const penA = computeUnnecessaryAceMovePenalty(b1, auxSq, dstSq, rankA);
                if (rankA === 1 && penA > 0) continue;
                const b2 = applySimMicroMove(
                  b1,
                  { fromIdx: auxSq, toIdx: dstSq, cardPosInTile: slotA, rank: rankA },
                  myFaction
                );
                const slotB = b2[auxSq].findIndex((c) => c.owner === myFaction && !c.locked);
                if (slotB >= 0) {
                  const rankB = b2[auxSq][slotB].rank;
                  const penB = computeUnnecessaryAceMovePenalty(b2, auxSq, dstSq, rankB);
                  if (rankB === 1 && penB > 0) continue;
                  const b3 = applySimMicroMove(
                    b2,
                    { fromIdx: auxSq, toIdx: dstSq, cardPosInTile: slotB, rank: rankB },
                    myFaction
                  );
                  const sc =
                    evaluateTurnEndState(
                      b3,
                      myFaction,
                      opBelief,
                      state.draw[myFaction] || 0,
                      state.turn,
                      false,
                      false
                    ) -
                    pen1NonAttack -
                    penA -
                    penB;
                  recordCandidate(
                    idx,
                    isEnemyTarget
                      ? `Stage (${fx},${fy})->(${tx},${ty}) + 2-Card Strike (${dxX},${dyY})`
                      : `Conveyor Phalanx (${ax},${ay})->(${dxX},${dyY})->(${tx},${ty})`,
                    [
                      { fromX: ax, fromY: ay, toX: dxX, toY: dyY, rank: rankA },
                      { fromX: ax, fromY: ay, toX: dxX, toY: dyY, rank: rankB },
                    ],
                    b3,
                    sc
                  );
                }
              }
            }
          }
        }

        // Phase 3 Macro 8 (Geodesic Shadow-Screen / Joker Trap Interposition + Ace Armor/Evasion):
        if (movedRank1 !== 1 && interpositionBonusSq[toIdx] >= 7500 && rootMyAceSqs.length > 0) {
          for (let a = 0; a < rootMyAceSqs.length; a++) {
            const aSq = rootMyAceSqs[a];
            const ax = (aSq / 7) | 0;
            const ay = aSq % 7;
            const aceSlot = b1[aSq].findIndex((c) => c.owner === myFaction && !c.locked && c.rank === 1);
            if (aceSlot >= 0) {
              for (let dx2 = -1; dx2 <= 1; dx2++) {
                const escX = ax + dx2;
                if (escX < 0 || escX >= 7) continue;
                for (let dy2 = -1; dy2 <= 1; dy2++) {
                  if (dx2 === 0 && dy2 === 0) continue;
                  const escY = ay + dy2;
                  if (escY < 0 || escY >= 7) continue;
                  const escSq = escX * 7 + escY;
                  if (b1[escSq].some((c) => c.owner === opFaction)) continue;
                  if (b1[escSq].filter((c) => c.owner === myFaction).length >= 3) continue;
                  const b2 = applySimMicroMove(
                    b1,
                    { fromIdx: aSq, toIdx: escSq, cardPosInTile: aceSlot, rank: 1 },
                    myFaction
                  );
                  for (let dx3 = -1; dx3 <= 1; dx3++) {
                    const gx = escX + dx3;
                    if (gx < 0 || gx >= 7) continue;
                    for (let dy3 = -1; dy3 <= 1; dy3++) {
                      if (dx3 === 0 && dy3 === 0) continue;
                      const gy = escY + dy3;
                      if (gy < 0 || gy >= 7) continue;
                      const gSq = gx * 7 + gy;
                      if (gSq === toIdx || b2[gSq].some((c) => c.owner === opFaction)) continue;
                      const gSlot = b2[gSq].findIndex(
                        (c) => c.owner === myFaction && !c.locked && c.rank >= 9
                      );
                      if (gSlot >= 0) {
                        const gRank = b2[gSq][gSlot].rank;
                        const b3 = applySimMicroMove(
                          b2,
                          { fromIdx: gSq, toIdx: escSq, cardPosInTile: gSlot, rank: gRank },
                          myFaction
                        );
                        const sc = evaluateTurnEndState(
                          b3,
                          myFaction,
                          opBelief,
                          state.draw[myFaction] || 0,
                          state.turn,
                          false,
                          false
                        );
                        recordCandidate(
                          idx,
                          `Shadow Screen (${tx},${ty}) + Ace Citadel (${escX},${escY})`,
                          [
                            { fromX: ax, fromY: ay, toX: escX, toY: escY, rank: 1 },
                            { fromX: gx, fromY: gy, toX: escX, toY: escY, rank: gRank },
                          ],
                          b3,
                          sc
                        );
                      }
                    }
                  }
                }
              }
            }
          }
        }
        // Phase 4 Macro 4B (1-Step Ace Evasion / Reposition + 2-Step Court Guard Rendezvous):
        // When Move 1 (`act`) steps a friendly Ace 1 square onto an empty square `toIdx` (`movedRank1 === 1`, such as `AH* (2,0) -> (1,0)` on Turn 25!),
        // check all friendly unlocked Court cards (`rank >= 9`) at Chebyshev distance d=2 from `toIdx` (such as `KD` at `(2,2)`)
        // that can take 2 steps (`auxSq -> midIdx -> toIdx`) on Moves 2 & 3 to land on `toIdx` and armor our Ace in 1 turn!
        if (movedRank1 === 1 && myToCards.length === 0) {
          for (let auxSq = 0; auxSq < 49; auxSq++) {
            if (auxSq === toIdx || auxSq === fromIdx) continue;
            const ax = (auxSq / 7) | 0;
            const ay = auxSq % 7;
            if (Math.max(Math.abs(ax - tx), Math.abs(ay - ty)) !== 2) continue;
            if (b1[auxSq].some((c) => c.owner === opFaction)) continue;
            const auxSlot = b1[auxSq].findIndex(
              (c) => c.owner === myFaction && !c.locked && c.rank >= 9
            );
            if (auxSlot < 0) continue;
            const auxRank = b1[auxSq][auxSlot].rank;
            for (let dxm = -1; dxm <= 1; dxm++) {
              const mx = ax + dxm;
              if (mx < 0 || mx >= 7) continue;
              for (let dym = -1; dym <= 1; dym++) {
                if (dxm === 0 && dym === 0) continue;
                const my = ay + dym;
                if (my < 0 || my >= 7) continue;
                if (Math.max(Math.abs(mx - tx), Math.abs(my - ty)) !== 1) continue;
                const midIdx = mx * 7 + my;
                if (b1[midIdx].some((c) => c.owner === opFaction)) continue;
                if (b1[midIdx].filter((c) => c.owner === myFaction).length >= 4) continue;
                const b2 = applySimMicroMove(
                  b1,
                  { fromIdx: auxSq, toIdx: midIdx, cardPosInTile: auxSlot, rank: auxRank },
                  myFaction
                );
                const midSlot = b2[midIdx].findIndex(
                  (c) => c.owner === myFaction && !c.locked && c.rank === auxRank
                );
                if (midSlot >= 0) {
                  const b3 = applySimMicroMove(
                    b2,
                    { fromIdx: midIdx, toIdx, cardPosInTile: midSlot, rank: auxRank },
                    myFaction
                  );
                  const sc = evaluateTurnEndState(
                    b3,
                    myFaction,
                    opBelief,
                    state.draw[myFaction] || 0,
                    state.turn,
                    false,
                    false
                  );
                  recordCandidate(
                    idx,
                    `Ace Evasion (${fx},${fy})->(${tx},${ty}) + 2-Step Guard (${ax},${ay})`,
                    [
                      { fromX: ax, fromY: ay, toX: mx, toY: my, rank: auxRank },
                      { fromX: mx, fromY: my, toX: tx, toY: ty, rank: auxRank },
                    ],
                    b3,
                    sc
                  );
                }
                break;
              }
            }
          }
        }
        const slotOnTo1 = b1[toIdx].findIndex(
          (c) => c.owner === myFaction && !c.locked && c.rank === movedRank1
        );
        if (slotOnTo1 >= 0) {
          for (let dx2 = -1; dx2 <= 1; dx2++) {
            const m2x = tx + dx2;
            if (m2x < 0 || m2x >= 7) continue;
            for (let dy2 = -1; dy2 <= 1; dy2++) {
              if (dx2 === 0 && dy2 === 0) continue;
              const m2y = ty + dy2;
              if (m2y < 0 || m2y >= 7) continue;
              // Skip triangle detours where (m2x, m2y) was already within d<=1 of (fx, fy)
              if (Math.max(Math.abs(m2x - fx), Math.abs(m2y - fy)) <= 1) continue;
              const mid2Idx = m2x * 7 + m2y;
              const mid2Tile = b1[mid2Idx];
              const opOnMid2 = mid2Tile.some((c) => c.owner === opFaction);
              const myCntMid2 = mid2Tile.filter((c) => c.owner === myFaction).length;
              if (myCntMid2 >= 4) continue;

              const b2 = applySimMicroMove(
                b1,
                { fromIdx: toIdx, toIdx: mid2Idx, cardPosInTile: slotOnTo1, rank: movedRank1 },
                myFaction
              );
              const step2Plan: PlannedMicroMove = {
                fromX: tx,
                fromY: ty,
                toX: m2x,
                toY: m2y,
                rank: movedRank1,
              };

              if (opOnMid2) {
                // 2-Step Attack (`fromIdx -> toIdx -> mid2Idx`) landed on an enemy square `mid2Idx`!
                // 1) Check if any OTHER friendly unlocked card at d=1 of `mid2Idx` can converge onto `mid2Idx` on Step 3!
                for (let dx3 = -1; dx3 <= 1; dx3++) {
                  const s3x = m2x + dx3;
                  if (s3x < 0 || s3x >= 7) continue;
                  for (let dy3 = -1; dy3 <= 1; dy3++) {
                    if (dx3 === 0 && dy3 === 0) continue;
                    const s3y = m2y + dy3;
                    if (s3y < 0 || s3y >= 7) continue;
                    const auxIdx = s3x * 7 + s3y;
                    if (b2[auxIdx].some((c) => c.owner === opFaction)) continue;
                    const auxSlot = b2[auxIdx].findIndex((c) => c.owner === myFaction && !c.locked);
                    if (auxSlot >= 0) {
                      const auxRank = b2[auxIdx][auxSlot].rank;
                      const b3 = applySimMicroMove(
                        b2,
                        { fromIdx: auxIdx, toIdx: mid2Idx, cardPosInTile: auxSlot, rank: auxRank },
                        myFaction
                      );
                      const sc = evaluateTurnEndState(
                        b3,
                        myFaction,
                        opBelief,
                        state.draw[myFaction] || 0,
                        state.turn,
                        false,
                        false
                      );
                      recordCandidate(
                        idx,
                        `Convergent Pincer (${fx},${fy})+((${s3x},${s3y}))->(${m2x},${m2y})`,
                        [
                          step2Plan,
                          { fromX: s3x, fromY: s3y, toX: m2x, toY: m2y, rank: auxRank },
                        ],
                        b3,
                        sc
                      );
                    }
                  }
                }
                // 2) Phase 4 Macro 2D (2-Step Winning Strike / Revealed-Ace Assassination + Best 3rd Micro-Move across the board!):
                // When our 1-card 2-step attack (`fromIdx -> toIdx -> mid2Idx`, such as `KD (3,1)->(3,2)->(3,3)` killing Black's
                // revealed Ace `AC` at `(3,3)` on Turn 23!) ALREADY wins or ties on `mid2Idx` by itself, evaluate using Step 3
                // to move our threatened Ace to safety (e.g. `AH* (3,0)->(2,0)`), advance our Joker screen (`Jkr* (3,1)->(3,2)`),
                // or reposition another friendly unit!
                const m3After2StepStrike = generateSimMicroMoves(b2, myFaction);
                for (let m3i = 0; m3i < m3After2StepStrike.length; m3i++) {
                  const m3 = m3After2StepStrike[m3i];
                  if (m3.fromIdx === mid2Idx) continue;
                  const pen3 = computeUnnecessaryAceMovePenalty(b2, m3.fromIdx, m3.toIdx, m3.rank);
                  if (m3.rank === 1 && pen3 > 6000) continue;
                  const b3 = applySimMicroMove(b2, m3, myFaction);
                  const sc =
                    evaluateTurnEndState(
                      b3,
                      myFaction,
                      opBelief,
                      state.draw[myFaction] || 0,
                      state.turn,
                      false,
                      false
                    ) - pen3;
                  recordCandidate(
                    idx,
                    `2-Step Strike (${fx},${fy})->(${m2x},${m2y}) + Support`,
                    [
                      step2Plan,
                      {
                        fromX: (m3.fromIdx / 7) | 0,
                        fromY: m3.fromIdx % 7,
                        toX: (m3.toIdx / 7) | 0,
                        toY: m3.toIdx % 7,
                        rank: m3.rank,
                      },
                    ],
                    b3,
                    sc
                  );
                }
              } else {
                // `mid2Idx` has no enemy cards:
                // Macro 4 & Macro 5:
                // - Macro 4: If `movedRank1 === 1` (our Ace took 2 steps `fromIdx -> toIdx -> mid2Idx`), check if any friendly court guard (`rank >= 9`) at d=1 of `mid2Idx` can converge onto `mid2Idx` on Step 3 to armor our Ace!
                // - Macro 5: If `movedRank1 !== 1` (a friendly Court/Joker card took 2 steps `fromIdx -> toIdx -> mid2Idx`), check if any OTHER friendly card at d=1 of `mid2Idx` can converge onto `mid2Idx` on Step 3 to form a 2-card power stack (or armor a friendly Ace) in 1 turn!
                if (myCntMid2 === 0) {
                  for (let dx3 = -1; dx3 <= 1; dx3++) {
                    const g3x = m2x + dx3;
                    if (g3x < 0 || g3x >= 7) continue;
                    for (let dy3 = -1; dy3 <= 1; dy3++) {
                      if (dx3 === 0 && dy3 === 0) continue;
                      const g3y = m2y + dy3;
                      if (g3y < 0 || g3y >= 7) continue;
                      const guardIdx = g3x * 7 + g3y;
                      if (guardIdx === mid2Idx || b2[guardIdx].some((c) => c.owner === opFaction)) continue;
                      const guardSlot = b2[guardIdx].findIndex(
                        (c) =>
                          c.owner === myFaction &&
                          !c.locked &&
                          (movedRank1 === 1 ? c.rank >= 9 : c.rank !== 1)
                      );
                      if (guardSlot >= 0) {
                        const guardRank = b2[guardIdx][guardSlot].rank;
                        const b3 = applySimMicroMove(
                          b2,
                          {
                            fromIdx: guardIdx,
                            toIdx: mid2Idx,
                            cardPosInTile: guardSlot,
                            rank: guardRank,
                          },
                          myFaction
                        );
                        const sc = evaluateTurnEndState(
                          b3,
                          myFaction,
                          opBelief,
                          state.draw[myFaction] || 0,
                          state.turn,
                          false,
                          false
                        );
                        recordCandidate(
                          idx,
                          movedRank1 === 1
                            ? `Ace+Guard Rendezvous (${fx},${fy})+((${g3x},${g3y}))->(${m2x},${m2y})`
                            : `Stack Rendezvous (${fx},${fy})+((${g3x},${g3y}))->(${m2x},${m2y})`,
                          [
                            step2Plan,
                            { fromX: g3x, fromY: g3y, toX: m2x, toY: m2y, rank: guardRank },
                          ],
                          b3,
                          sc
                        );
                      }
                    }
                  }
                }

                // Macro 3: Check Step 3 for a 3-Step Deep Assassin Strike onto an adjacent enemy square!
                const slotOnMid2 = b2[mid2Idx].findIndex(
                  (c) => c.owner === myFaction && !c.locked && c.rank === movedRank1
                );
                if (slotOnMid2 >= 0) {
                  for (let dx3 = -1; dx3 <= 1; dx3++) {
                    const t3x = m2x + dx3;
                    if (t3x < 0 || t3x >= 7) continue;
                    for (let dy3 = -1; dy3 <= 1; dy3++) {
                      if (dx3 === 0 && dy3 === 0) continue;
                      const t3y = m2y + dy3;
                      if (t3y < 0 || t3y >= 7) continue;
                      if (Math.max(Math.abs(t3x - tx), Math.abs(t3y - ty)) <= 1) continue;
                      const target3Idx = t3x * 7 + t3y;
                      if (!b2[target3Idx].some((c) => c.owner === opFaction)) continue;
                      const b3 = applySimMicroMove(
                        b2,
                        {
                          fromIdx: mid2Idx,
                          toIdx: target3Idx,
                          cardPosInTile: slotOnMid2,
                          rank: movedRank1,
                        },
                        myFaction
                      );
                      const sc = evaluateTurnEndState(
                        b3,
                        myFaction,
                        opBelief,
                        state.draw[myFaction] || 0,
                        state.turn,
                        false,
                        false
                      );
                      recordCandidate(
                        idx,
                        `3-Step Assassin (${fx},${fy})->(${t3x},${t3y})`,
                        [
                          step2Plan,
                          { fromX: m2x, fromY: m2y, toX: t3x, toY: t3y, rank: movedRank1 },
                        ],
                        b3,
                        sc
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    });
  }

  if (movesRem >= 2 && level1Nodes.length > 0) {
    level1Nodes.sort((a, b) => b.heuristic - a.heuristic);
    // Keep all Level-1 nodes (up to 64) so peeling from a 2-card or 3-card stack is never pruned at Step 1!
    const beam1 = level1Nodes.slice(0, 64);
    const level2Map = new Map<number, SearchNode>();
    const level2BaseEval = new Map<number, number>();

    for (const n1 of beam1) {
      const m2List = generateSimMicroMoves(n1.board, myFaction);
      if (m2List.length === 0) {
        const sc = evaluateTurnEndState(
          n1.board,
          myFaction,
          opBelief,
          state.draw[myFaction] || 0,
          state.turn,
          false,
          false
        );
        recordCandidate(n1.firstIdx, n1.firstDesc, [], n1.board, sc);
        continue;
      }

      for (let i = 0; i < m2List.length; i++) {
        const m2 = m2List[i];
        // Ban immediate intra-turn round-trip reversal (A -> B followed by B -> A)
        if (m2.fromIdx === n1.lastToIdx && m2.toIdx === n1.lastFromIdx) continue;

        const b2 = applySimMicroMove(n1.board, m2, myFaction);
        const toX = (m2.toIdx / 7) | 0;
        const toY = m2.toIdx % 7;
        const step2Plan: PlannedMicroMove = {
          fromX: (m2.fromIdx / 7) | 0,
          fromY: m2.fromIdx % 7,
          toX,
          toY,
          rank: m2.rank,
        };

        // Ban 2-step triangle detours onto EMPTY squares (A -> B -> C where Chebyshev(A, C) <= 1 and C has no friendly stack to merge with):
        // Note: When C already holds a friendly card (`hasFriendlyOnTo2`), A -> B -> C is a valid 3-tempo 2-card stack rendezvous!
        if (m2.fromIdx === n1.lastToIdx && !n1.board[n1.lastToIdx].some((c) => c.owner === opFaction)) {
          const origX = (n1.lastFromIdx / 7) | 0;
          const origY = n1.lastFromIdx % 7;
          const hasFriendlyOnTo2 = n1.board[m2.toIdx].some((c) => c.owner === myFaction);
          if (!hasFriendlyOnTo2 && Math.max(Math.abs(toX - origX), Math.abs(toY - origY)) <= 1) {
            continue;
          }
          // When `movesRem === 2`, also ban 3-step loops/detours relative to Move 1 (`banReverseToIdx -> banReverseFromIdx`)
          if (
            movesRem === 2 &&
            banReverseFromIdx >= 0 &&
            banReverseToIdx >= 0 &&
            n1.lastFromIdx === banReverseFromIdx &&
            !initialBoard[banReverseFromIdx].some((c) => c.owner === opFaction)
          ) {
            if (m2.toIdx === banReverseToIdx) continue;
            const pfx = (banReverseToIdx / 7) | 0;
            const pfy = banReverseToIdx % 7;
            if (!hasFriendlyOnTo2 && Math.max(Math.abs(toX - pfx), Math.abs(toY - pfy)) <= 1) {
              continue;
            }
          }
        }
        const detourPen = computeUnnecessaryAceMovePenalty(n1.board, m2.fromIdx, m2.toIdx, m2.rank);
        const cumulPen2 = n1.cumulPen + detourPen;

        if (movesRem === 2) {
          const sc =
            evaluateTurnEndState(
              b2,
              myFaction,
              opBelief,
              state.draw[myFaction] || 0,
              state.turn,
              false,
              false
            ) - cumulPen2;
          recordCandidate(n1.firstIdx, n1.firstDesc, [step2Plan], b2, sc);
        } else {
          const h = hashSimBoard(b2);
          const dstTile = b2[m2.toIdx];
          let baseL2 = level2BaseEval.get(h);
          if (baseL2 === undefined) {
            baseL2 = evaluateTurnEndState(
              b2,
              myFaction,
              opBelief,
              state.draw[myFaction] || 0,
              state.turn,
              false,
              true
            );
            level2BaseEval.set(h, baseL2);
          }
          let prio = baseL2 - cumulPen2;
          let hasOp = false;
          let myCnt = 0;
          for (let k = 0; k < dstTile.length; k++) {
            if (dstTile[k].owner === opFaction) hasOp = true;
            else myCnt++;
          }
          if (hasOp) prio += 12000;
          if (myCnt >= 2) prio += 5500 * myCnt;

          // Split-Stack-in-Transit Continuity Boost on Step 2:
          // When Step 2 peels the 1st card of a 2+ card friendly stack onto `m2.toIdx` (especially onto an enemy stack `hasOp`),
          // compensate for the temporary 1-card combat evaluation on `b2` before the 2nd card arrives on Step 3!
          if (b2[m2.fromIdx].some((c) => c.owner === myFaction && !c.locked)) {
            prio += hasOp ? 16000 : 4500;
          }

          // Stack-March Continuity Boost: moving a 2nd card from the same origin square to the same destination square!
          if (m2.fromIdx === n1.lastFromIdx && m2.toIdx === n1.lastToIdx) {
            prio += 9500;
          }
          if (interpositionBonusSq[m2.toIdx] > 0) {
            prio += interpositionBonusSq[m2.toIdx];
          }

          // Guarantee beam retention for 3-step assassin strikes!
          for (let dx = -1; dx <= 1; dx++) {
            const nx = toX + dx;
            if (nx < 0 || nx >= 7) continue;
            for (let dy = -1; dy <= 1; dy++) {
              if (dx === 0 && dy === 0) continue;
              const ny = toY + dy;
              if (ny < 0 || ny >= 7) continue;
              const adjTile = b2[nx * 7 + ny];
              for (let k = 0; k < adjTile.length; k++) {
                if (adjTile[k].owner === opFaction) {
                  prio += 18000;
                  break;
                }
              }
            }
          }

          const prev = level2Map.get(h);
          if (!prev || prio > prev.heuristic) {
            level2Map.set(h, {
              board: b2,
              firstIdx: n1.firstIdx,
              firstDesc: n1.firstDesc,
              lastFromIdx: m2.fromIdx,
              lastToIdx: m2.toIdx,
              heuristic: prio,
              cumulPen: cumulPen2,
              followUps: [step2Plan],
            });
          }
        }
      }
    }

    if (movesRem === 3) {
      // Expand top 56 Level-2 nodes to Level 3 (enabled by 10x faster 53-bit Zobrist hashing!)
      const level2Nodes = Array.from(level2Map.values()).sort((a, b) => b.heuristic - a.heuristic);
      const beam2 = level2Nodes.slice(0, 56);
      const evaluatedHashes = new Set<number>();

      for (let bIdx = 0; bIdx < beam2.length; bIdx++) {
        const n2 = beam2[bIdx];
        const m3List = generateSimMicroMoves(n2.board, myFaction);
        if (m3List.length === 0) {
          const sc = evaluateTurnEndState(
            n2.board,
            myFaction,
            opBelief,
            state.draw[myFaction] || 0,
            state.turn,
            false,
            false
          );
          recordCandidate(n2.firstIdx, n2.firstDesc, n2.followUps, n2.board, sc);
          continue;
        }

        for (let i = 0; i < m3List.length; i++) {
          const m3 = m3List[i];
          // Ban intra-turn round-trip reversals on Step 3 (B -> A reversing Step 2, or reversing Step 1)
          // AND ban Step-1 -> Step-3 triangle detours (where Step 1 moved s1From -> s1To and Step 3 moves s1To -> m3.toIdx with Chebyshev(s1From, m3.toIdx) <= 1)
          if (m3.fromIdx === n2.lastToIdx && m3.toIdx === n2.lastFromIdx) continue;
          const m3tx = (m3.toIdx / 7) | 0;
          const m3ty = m3.toIdx % 7;
          const step1Act = state.legal[n2.firstIdx];
          if (step1Act && !step1Act.spawn && step1Act.from && step1Act.to) {
            const s1fx = Array.isArray(step1Act.from) ? step1Act.from[0] : step1Act.from.x;
            const s1fy = Array.isArray(step1Act.from) ? step1Act.from[1] : step1Act.from.y;
            const s1tx = Array.isArray(step1Act.to) ? step1Act.to[0] : step1Act.to.x;
            const s1ty = Array.isArray(step1Act.to) ? step1Act.to[1] : step1Act.to.y;
            const s1ToIdx = s1tx * 7 + s1ty;
            if (m3.fromIdx === s1ToIdx && m3.toIdx === s1fx * 7 + s1fy) continue;
            if (
              m3.fromIdx === s1ToIdx &&
              !initialBoard[s1ToIdx].some((c) => c.owner === opFaction) &&
              Math.max(Math.abs(m3tx - s1fx), Math.abs(m3ty - s1fy)) <= 1
            ) {
              continue;
            }
          }

          // Ban Step-2 -> Step-3 triangle detours onto EMPTY squares (B -> C -> D where Chebyshev(B, D) <= 1 and D has no friendly card)
          if (m3.fromIdx === n2.lastToIdx && !n2.board[n2.lastToIdx].some((c) => c.owner === opFaction)) {
            const origX = (n2.lastFromIdx / 7) | 0;
            const origY = n2.lastFromIdx % 7;
            const hasFriendlyOnTo3 = n2.board[m3.toIdx].some((c) => c.owner === myFaction);
            if (!hasFriendlyOnTo3 && Math.max(Math.abs(m3tx - origX), Math.abs(m3ty - origY)) <= 1) {
              continue;
            }
          }
          const detourPen3 = computeUnnecessaryAceMovePenalty(n2.board, m3.fromIdx, m3.toIdx, m3.rank);
          const cumulPen3 = n2.cumulPen + detourPen3;

          const b3 = applySimMicroMove(n2.board, m3, myFaction);
          const h3 = hashSimBoard(b3);
          if (evaluatedHashes.has(h3)) continue;
          evaluatedHashes.add(h3);

          const sc =
            evaluateTurnEndState(
              b3,
              myFaction,
              opBelief,
              state.draw[myFaction] || 0,
              state.turn,
              false,
              false
            ) - cumulPen3;
          const step3Plan: PlannedMicroMove = {
            fromX: (m3.fromIdx / 7) | 0,
            fromY: m3.fromIdx % 7,
            toX: (m3.toIdx / 7) | 0,
            toY: m3.toIdx % 7,
            rank: m3.rank,
          };
          recordCandidate(n2.firstIdx, n2.firstDesc, [...n2.followUps, step3Plan], b3, sc);
        }
      }
    }
  }

  // Phase 4 Quota-Protected Root Candidate Diversity:
  // Prevent 6-8 slight variations of a single greedy Move-1 action from crowding out all other root plans
  // (such as Reserve Spawns, Ace Armoring, or Flank Stack Consolidations) before Minimax + PVS verification!
  const allCandidates: TurnCandidate[] = [];
  const overflowCandidates: TurnCandidate[] = [];
  const seenEndHashes = new Set<number>();
  const countPerFirstIdx = new Map<number, number>();
  const flatLists = Array.from(candidatesByFirstIdx.values()).flat();
  flatLists.sort((a, b) => b.turn1Score - a.turn1Score);

  for (let i = 0; i < flatLists.length; i++) {
    const c = flatLists[i];
    if (seenEndHashes.has(c.endHash)) continue;
    seenEndHashes.add(c.endHash);

    // If `movesRem === 2` and `warmPlannedSecondStep` is set, boost the exact 2-step planned continuation
    if (
      movesRem === 2 &&
      warmPlannedStep !== null &&
      warmPlannedSecondStep !== null &&
      c.followUps.length === 1
    ) {
      const f2 = c.followUps[0];
      const act1 = state.legal[c.firstIdx];
      if (act1 && !act1.spawn && act1.from && act1.to) {
        const fx1 = Array.isArray(act1.from) ? act1.from[0] : act1.from.x;
        const fy1 = Array.isArray(act1.from) ? act1.from[1] : act1.from.y;
        const tx1 = Array.isArray(act1.to) ? act1.to[0] : act1.to.x;
        const ty1 = Array.isArray(act1.to) ? act1.to[1] : act1.to.y;
        if (
          fx1 === warmPlannedStep.fromX &&
          fy1 === warmPlannedStep.fromY &&
          tx1 === warmPlannedStep.toX &&
          ty1 === warmPlannedStep.toY &&
          f2.fromX === warmPlannedSecondStep.fromX &&
          f2.fromY === warmPlannedSecondStep.fromY &&
          f2.toX === warmPlannedSecondStep.toX &&
          f2.toY === warmPlannedSecondStep.toY
        ) {
          c.turn1Score += 10500;
        }
      }
    }

    const usedForFirst = countPerFirstIdx.get(c.firstIdx) || 0;
    if (usedForFirst < 2) {
      countPerFirstIdx.set(c.firstIdx, usedForFirst + 1);
      allCandidates.push(c);
    } else {
      overflowCandidates.push(c);
    }
  }
  allCandidates.sort((a, b) => b.turn1Score - a.turn1Score);

  // Guarantee that the top Spawn candidate (if legal and competitive) is within the primary minimax window (`index <= 8`)
  const bestSpawnPos = allCandidates.findIndex((c) => Boolean(state.legal[c.firstIdx]?.spawn));
  if (
    bestSpawnPos > 8 &&
    allCandidates[0] &&
    allCandidates[bestSpawnPos].turn1Score >= allCandidates[0].turn1Score - 38000
  ) {
    const [spCand] = allCandidates.splice(bestSpawnPos, 1);
    allCandidates.splice(7, 0, spCand);
  }

  const candidates = [...allCandidates, ...overflowCandidates];

  if (candidates.length === 0) {
    return { actionIndex: 0, score: 0, reason: 'Fallback legal move' };
  }

  let bestCand = candidates[0];
  let bestFinalScore = bestCand.turn1Score;

  if (bestCand.turn1Score >= 850000) {
    lastStockfishTelemetry.mateDetected = 'MATE_IN_1';
  }

  // 3. Phase 5-6 + Part 2.B Multi-World Stockfish PVS + Quiescence + Exact Refutation Propagation!
  if (!skipMinimax && candidates.length > 1 && bestCand.turn1Score < 850000) {
    advanceStockfishSearchGeneration();

    // Detect if our Ace is in danger on many candidate lines (Emergency Evasion Mode)
    const dangerLines = candidates.slice(0, 10).filter((c) => c.turn1Score < -80000).length;
    const isEmergencyEvasion = dangerLines >= 2 || bestCand.turn1Score < 0;
    let maxK = Math.min(
      candidates.length,
      movesRem === 2 ? (isEmergencyEvasion ? 11 : 7) : isEmergencyEvasion ? 14 : 10
    );
    const hardCapK = Math.min(candidates.length, 12);
    const perCandBudgetMs = isEmergencyEvasion ? 22 : 18;

    let bestMinimaxScore = -Infinity;
    for (let k = 0; k < maxK; k++) {
      const cand = candidates[k];
      // Skip candidates that already lose our last Ace on Turn 1
      if (cand.turn1Score <= -500000 && k > 0) continue;

      const opReplyScore = findBestOpponentReplyScore(
        cand.endBoard,
        myFaction,
        opBelief,
        state.draw[myFaction] || 0,
        state.draw[opFaction] || 0,
        state.turn + 1,
        perCandBudgetMs,
        myDrawRanks,
        opDrawRanks
      );

      // Part 2.B: Exact Refutation & Mate Propagation
      let combinedScore: number;
      if (opReplyScore >= 400000) {
        // Opponent has a forced checkmate or kills our last Ace on their reply turn: hard refutation!
        combinedScore = cand.turn1Score - opReplyScore * 1.25;
      } else if (opReplyScore >= 110000) {
        // Opponent kills 1 of our 2 Aces on their reply turn
        combinedScore = cand.turn1Score - opReplyScore * 0.92;
      } else if (opReplyScore <= -400000) {
        // Forced 2-turn checkmate in our favor even after opponent's best defense!
        combinedScore = cand.turn1Score - opReplyScore * 0.85;
      } else {
        combinedScore = cand.turn1Score - 0.65 * opReplyScore;
      }

      if (combinedScore > bestMinimaxScore) {
        bestMinimaxScore = combinedScore;
        bestCand = cand;
        bestFinalScore = combinedScore;
      }

      // If all candidates checked so far were refuted by an opponent Ace-kill (bestMinimaxScore < -60000),
      // dynamically expand the candidate window up to `hardCapK` until we find a safe survival line!
      if (k === maxK - 1 && bestMinimaxScore < -60000 && maxK < hardCapK) {
        maxK = hardCapK;
      }
    }

    if (isEmergencyEvasion && bestFinalScore > -50000 && lastStockfishTelemetry.mateDetected === 'NONE') {
      lastStockfishTelemetry.mateDetected = 'EVASION_SAVED';
    }
  }

  globalBeliefTracker.plannedTurnNumber = state.turn;
  globalBeliefTracker.plannedTurnFaction = myFaction;
  globalBeliefTracker.plannedTurnQueue = bestCand.followUps;

  const chosenAct = state.legal[bestCand.firstIdx];
  if (chosenAct && !chosenAct.spawn && chosenAct.from && chosenAct.to) {
    const cfx = Array.isArray(chosenAct.from) ? chosenAct.from[0] : chosenAct.from.x;
    const cfy = Array.isArray(chosenAct.from) ? chosenAct.from[1] : chosenAct.from.y;
    const ctx = Array.isArray(chosenAct.to) ? chosenAct.to[0] : chosenAct.to.x;
    const cty = Array.isArray(chosenAct.to) ? chosenAct.to[1] : chosenAct.to.y;
    globalBeliefTracker.prevStepTurn = state.turn;
    globalBeliefTracker.prevStepFaction = myFaction;
    globalBeliefTracker.prevStepFromIdx = cfx * 7 + cfy;
    globalBeliefTracker.prevStepToIdx = ctx * 7 + cty;
  } else {
    globalBeliefTracker.prevStepTurn = -1;
  }

  return {
    actionIndex: bestCand.firstIdx,
    score: bestFinalScore,
    reason: bestCand.firstDesc,
  };
}

// ---------------------------------------------------------------------------
// 6. Tactical Strike Advisor (Used by UI EvaluationBar & Hints)
// ---------------------------------------------------------------------------

export interface TacticalStrike {
  actionIndex: number;
  priority: number;
  type: 'instant_mate' | 'ace_snipe' | 'favourable_combat' | 'safe_cover' | 'advance';
  reason: string;
}

const advisorTurnState = {
  plannedTurnNumber: -1,
  plannedTurnFaction: -1,
  plannedTurnQueue: [] as PlannedMicroMove[],
  startOfTurnMyHash: 0,
  recentBoardHashes: [] as number[],
};

export function findTacticalStrike(
  state: SmartEngineState,
  myFaction: number
): TacticalStrike | null {
  if (!state.legal || state.legal.length === 0 || state.phase !== 'play') return null;
  // Avoid running hint search on the AI's turn when S has masked "??" cards for the AI
  if (typeof state.human === 'number' && state.mover !== state.human) return null;

  const savedQueue = [...globalBeliefTracker.plannedTurnQueue];
  const savedTurn = globalBeliefTracker.plannedTurnNumber;
  const savedFac = globalBeliefTracker.plannedTurnFaction;
  const savedStartHash = globalBeliefTracker.startOfTurnMyHash;
  const savedRecent = [...globalBeliefTracker.recentBoardHashes];

  // Swap in the isolated Advisor turn-plan & repetition history so multi-step human hints
  // execute coherent 3-move plans without touching the AI's own turn queue!
  globalBeliefTracker.plannedTurnQueue = [...advisorTurnState.plannedTurnQueue];
  globalBeliefTracker.plannedTurnNumber = advisorTurnState.plannedTurnNumber;
  globalBeliefTracker.plannedTurnFaction = advisorTurnState.plannedTurnFaction;
  globalBeliefTracker.startOfTurnMyHash = advisorTurnState.startOfTurnMyHash;
  globalBeliefTracker.recentBoardHashes = [...advisorTurnState.recentBoardHashes];

  const gm = chooseGrandmasterAction(state, false);

  advisorTurnState.plannedTurnQueue = [...globalBeliefTracker.plannedTurnQueue];
  advisorTurnState.plannedTurnNumber = globalBeliefTracker.plannedTurnNumber;
  advisorTurnState.plannedTurnFaction = globalBeliefTracker.plannedTurnFaction;
  advisorTurnState.startOfTurnMyHash = globalBeliefTracker.startOfTurnMyHash;
  advisorTurnState.recentBoardHashes = [...globalBeliefTracker.recentBoardHashes];

  // Restore AI's queue & hashes untouched
  globalBeliefTracker.plannedTurnQueue = savedQueue;
  globalBeliefTracker.plannedTurnNumber = savedTurn;
  globalBeliefTracker.plannedTurnFaction = savedFac;
  globalBeliefTracker.startOfTurnMyHash = savedStartHash;
  globalBeliefTracker.recentBoardHashes = savedRecent;

  if (!gm) return null;

  const chosen = state.legal[gm.actionIndex];
  if (!chosen) return null;

  const toX = Array.isArray(chosen.to) ? chosen.to[0] : chosen.to.x;
  const toY = Array.isArray(chosen.to) ? chosen.to[1] : chosen.to.y;
  const targetTile = state.board[toX * 7 + toY] || [];
  const hasEnemy = targetTile.some((c) => c.owner === 1 - myFaction);

  let type: TacticalStrike['type'] = 'advance';
  if (gm.score >= 500000) type = 'instant_mate';
  else if (gm.score >= 60000) type = 'ace_snipe';
  else if (hasEnemy) type = 'favourable_combat';
  else if (chosen.spawn) type = 'safe_cover';

  return {
    actionIndex: gm.actionIndex,
    priority: Math.round(gm.score),
    type,
    reason: gm.reason,
  };
}

export function isBlunderAction(
  action: LegalAction,
  state: SmartEngineState,
  myFaction: number
): boolean {
  if (action.spawn) return false;
  const initialBoard = createInitialSimBoard(state);
  const afterBoard = applyLegalActionToSim(initialBoard, action, myFaction);
  const opBelief = computeBelief(state.board, state.draw, 1 - myFaction);
  const sc = evaluateTurnEndState(
    afterBoard,
    myFaction,
    opBelief,
    state.draw[myFaction] || 0,
    state.turn,
    false,
    false
  );
  return sc < -50000;
}
