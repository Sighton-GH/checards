// ============================================================================
// STOCKFISH-GRADE ENGINE FOR CHECARDS (PHASES 1 - 6 COMPLETE)
// Phase 1: Zero-Allocation Flat TypedArray Board + Incremental Make/Unmake
// Phase 2: 64-Bit Order-Independent Zobrist Hashing + Flat Transposition Table
// Phase 3: Iterative Deepening Principal Variation Search (ID-PVS) with
//          Aspiration Windows, MVV-LVA, Killer Moves, Countermoves, History & LMR
// Phase 4: Turn-Boundary Quiescence Search (qsearch) for Combat & Check Chains
// Phase 5: Tapered MG/EG Piece-Square + HalfKA Mating-Net Evaluator &
//          Bayesian Multi-World Information-Set Determinization
// Phase 6: Retrograde Forced Mate / Evasion Solver, Opening Book & Time Manager
// ============================================================================

import { SmartEngineState, LegalAction } from './smartEngine';

// ----------------------------------------------------------------------------
// 1. CARD BYTE ENCODING (8 bits per card)
// Bits 0..3 (0x0F): Rank (0=Joker, 1=Ace, 9..13=9..K, 15=Unknown)
// Bit  4    (0x10): Owner (0=Red, 1=Black)
// Bit  5    (0x20): Revealed (0=Hidden, 1=Revealed)
// Bit  6    (0x40): Combat-Locked this turn (0=Can Move, 1=Locked)
// Bit  7    (0x80): Stationary on initial setup square
// ----------------------------------------------------------------------------

const RANK_MASK = 0x0f;
const OWNER_SHIFT = 4;
const OWNER_BIT = 0x10;
const REVEALED_BIT = 0x20;
const LOCKED_BIT = 0x40;
const STATIONARY_BIT = 0x80;

export const MOVE_FROM_MASK = 0x3f;
export const MOVE_TO_SHIFT = 6;
export const MOVE_TO_MASK = 0x3f;
export const MOVE_RANK_SHIFT = 12;
export const MOVE_RANK_MASK = 0x0f;
export const SPAWN_MOVE_BIT = 1 << 16;
export const PASS_MOVE_BIT = 1 << 17;

export function encodeMicroMove(fromSq: number, toSq: number, rank: number): number {
  return (fromSq & 0x3f) | ((toSq & 0x3f) << 6) | ((rank & 0x0f) << 12);
}

export function encodeSpawnMove(spawnSq: number): number {
  return SPAWN_MOVE_BIT | ((spawnSq & 0x3f) << 6);
}

function rankPointsFast(r: number): number {
  if (r === 0 || r === 1) return 1;
  if (r >= 9 && r <= 13) return r;
  return 11;
}

function cardMaterialValue(r: number): number {
  switch (r) {
    case 1:
      return 95000;
    case 0:
      return 15500;
    case 13:
      return 2700;
    case 12:
      return 2350;
    case 11:
      return 1980;
    case 10:
      return 1680;
    case 9:
      return 1420;
    default:
      return 2000;
  }
}

// Precomputed 8-way adjacency list for all 49 squares (zero allocation)
const NEIGHBORS = new Int8Array(49 * 8);
const NEIGHBOR_COUNTS = new Uint8Array(49);
const CHEB_DIST = new Uint8Array(49 * 49);

(function initGeometryTables() {
  for (let sq = 0; sq < 49; sq++) {
    const x = (sq / 7) | 0;
    const y = sq % 7;
    let cnt = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < 7 && ny >= 0 && ny < 7) {
          NEIGHBORS[sq * 8 + cnt++] = nx * 7 + ny;
        }
      }
    }
    NEIGHBOR_COUNTS[sq] = cnt;

    for (let sq2 = 0; sq2 < 49; sq2++) {
      const x2 = (sq2 / 7) | 0;
      const y2 = sq2 % 7;
      const d = Math.max(Math.abs(x - x2), Math.abs(y - y2));
      CHEB_DIST[sq * 49 + sq2] = d;
    }
  }
})();

// ----------------------------------------------------------------------------
// 2. 64-BIT ORDER-INDEPENDENT ZOBRIST HASHING & TRANSPOSITION TABLE (PHASE 2)
// Indexed by (sq, cardByte, occurrenceIndexOnSq) so any permutation of
// micro-moves reaching the same multiset of cards on each square produces
// the EXACT same 64-bit Zobrist hash!
// ----------------------------------------------------------------------------

const ZOBRIST_SQ_CARD_LO = new Uint32Array(49 * 256 * 4);
const ZOBRIST_SQ_CARD_HI = new Uint32Array(49 * 256 * 4);
const ZOBRIST_MOVER_LO = new Uint32Array(2);
const ZOBRIST_MOVER_HI = new Uint32Array(2);
const ZOBRIST_MOVES_REM_LO = new Uint32Array(4);
const ZOBRIST_MOVES_REM_HI = new Uint32Array(4);
const ZOBRIST_DRAW_LO = new Uint32Array(2 * 8);
const ZOBRIST_DRAW_HI = new Uint32Array(2 * 8);

(function initZobristTables() {
  let s0 = 0x9e3779b9 >>> 0;
  let s1 = 0x243f6a88 >>> 0;
  const nextRand32 = (): number => {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= (x << 23) >>> 0;
    x ^= x >>> 17;
    x ^= y ^ (y >>> 26);
    s1 = x >>> 0;
    return (s0 + s1) >>> 0;
  };

  for (let i = 0; i < ZOBRIST_SQ_CARD_LO.length; i++) {
    ZOBRIST_SQ_CARD_LO[i] = nextRand32();
    ZOBRIST_SQ_CARD_HI[i] = nextRand32();
  }
  for (let i = 0; i < 2; i++) {
    ZOBRIST_MOVER_LO[i] = nextRand32();
    ZOBRIST_MOVER_HI[i] = nextRand32();
  }
  for (let i = 0; i < 4; i++) {
    ZOBRIST_MOVES_REM_LO[i] = nextRand32();
    ZOBRIST_MOVES_REM_HI[i] = nextRand32();
  }
  for (let i = 0; i < 16; i++) {
    ZOBRIST_DRAW_LO[i] = nextRand32();
    ZOBRIST_DRAW_HI[i] = nextRand32();
  }
})();

// Flat Transposition Table: 2^18 = 262,144 entries
const TT_BITS = 18;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;

const TT_FLAG_NONE = 0;
const TT_FLAG_EXACT = 1;
const TT_FLAG_LOWER = 2; // Beta cutoff (score >= beta)
const TT_FLAG_UPPER = 3; // Alpha bound (score <= alpha)

const ttHashLo = new Uint32Array(TT_SIZE);
const ttHashHi = new Uint32Array(TT_SIZE);
const ttScore = new Int32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttFlag = new Uint8Array(TT_SIZE);
const ttBestMove = new Uint32Array(TT_SIZE);
const ttGeneration = new Uint8Array(TT_SIZE);
let currentSearchGen = 1;

export function clearTranspositionTable(): void {
  ttFlag.fill(TT_FLAG_NONE);
  killerMoves.fill(0);
  historyTable.fill(0);
  counterMoves.fill(0);
}

// ----------------------------------------------------------------------------
// 3. ZERO-ALLOCATION FLAT BOARD & INCREMENTAL MAKE/UNMAKE (PHASE 1)
// ----------------------------------------------------------------------------

const MAX_PLY = 48;

export class FlatBoard {
  // Up to 8 cards per square (4 Red + 4 Black)
  public cells = new Uint8Array(49 * 8);
  public counts = new Uint8Array(49);
  public factionCounts = new Uint8Array(49 * 2); // [sq * 2 + faction]
  public aceCounts = new Uint8Array(2); // total surviving Aces on board for [Red, Black]
  public drawCount = new Uint8Array(2);
  public drawPile = new Uint8Array(2 * 8); // [faction * 8 + drawIdx] -> cardByte
  public acePrior = new Uint8Array(49); // 0..100 Bayesian Ace probability prior
  public jokerPrior = new Uint8Array(49); // 0..100 Bayesian Joker probability prior
  public camouflagedHomeAce = new Uint8Array(49); // 1 if unrevealed 1-card home-row Ace has no enemy within d<=2

  public mover: number = 0;
  public movesRemaining: number = 3;
  public turnNumber: number = 1;
  public hashLo: number = 0;
  public hashHi: number = 0;

  // Pre-allocated Undo Stack for MAX_PLY plies
  private undoMover = new Uint8Array(MAX_PLY);
  private undoMovesRem = new Uint8Array(MAX_PLY);
  private undoTurnNumber = new Uint16Array(MAX_PLY);
  private undoHashLo = new Uint32Array(MAX_PLY);
  private undoHashHi = new Uint32Array(MAX_PLY);
  private undoAce0 = new Uint8Array(MAX_PLY);
  private undoAce1 = new Uint8Array(MAX_PLY);
  private undoDraw0 = new Uint8Array(MAX_PLY);
  private undoDraw1 = new Uint8Array(MAX_PLY);

  // Per-ply modified square snapshots (handles both normal micro-moves and turn-ending combat/unlocks)
  private undoModSqCount = new Uint8Array(MAX_PLY);
  private undoModSqIdx = new Uint8Array(MAX_PLY * 16);
  private undoModSqLen = new Uint8Array(MAX_PLY * 16);
  private undoModSqF0 = new Uint8Array(MAX_PLY * 16);
  private undoModSqF1 = new Uint8Array(MAX_PLY * 16);
  private undoModSqCards = new Uint8Array(MAX_PLY * 16 * 8);

  public reset(): void {
    this.counts.fill(0);
    this.factionCounts.fill(0);
    this.aceCounts[0] = 0;
    this.aceCounts[1] = 0;
    this.drawCount[0] = 0;
    this.drawCount[1] = 0;
    this.acePrior.fill(0);
    this.jokerPrior.fill(0);
    this.camouflagedHomeAce.fill(0);
    this.hashLo = 0;
    this.hashHi = 0;
  }

  public xorCardOnSquare(sq: number, cardByte: number): void {
    // Canonicalize cardByte for hashing: clear stationary bit so equivalent states hash identically
    const canonicalByte = cardByte & 0x7f;
    const base = sq << 3;
    const len = this.counts[sq];
    let occ = 0;
    for (let i = 0; i < len; i++) {
      if ((this.cells[base + i] & 0x7f) === canonicalByte) {
        occ++;
      }
    }
    const zIdx = ((sq << 8) | canonicalByte) * 4 + (occ & 3);
    this.hashLo = (this.hashLo ^ ZOBRIST_SQ_CARD_LO[zIdx]) >>> 0;
    this.hashHi = (this.hashHi ^ ZOBRIST_SQ_CARD_HI[zIdx]) >>> 0;
  }

  public addCardToSquare(sq: number, cardByte: number): void {
    this.xorCardOnSquare(sq, cardByte);
    const base = sq << 3;
    const len = this.counts[sq];
    this.cells[base + len] = cardByte;
    this.counts[sq] = len + 1;
    const owner = (cardByte >> OWNER_SHIFT) & 1;
    this.factionCounts[(sq << 1) + owner]++;
    if ((cardByte & RANK_MASK) === 1) {
      this.aceCounts[owner]++;
    }
  }

  public removeCardSlotFromSquare(sq: number, slot: number): number {
    const base = sq << 3;
    const len = this.counts[sq];
    const cardByte = this.cells[base + slot];
    // Shift remaining cards down first so xorCardOnSquare sees the remaining occurrences
    for (let i = slot; i < len - 1; i++) {
      this.cells[base + i] = this.cells[base + i + 1];
    }
    this.counts[sq] = len - 1;
    const owner = (cardByte >> OWNER_SHIFT) & 1;
    this.factionCounts[(sq << 1) + owner]--;
    if ((cardByte & RANK_MASK) === 1) {
      this.aceCounts[owner]--;
    }
    this.xorCardOnSquare(sq, cardByte);
    return cardByte;
  }

  public recomputeFullHash(): void {
    let lo = ZOBRIST_MOVER_LO[this.mover] ^ ZOBRIST_MOVES_REM_LO[this.movesRemaining & 3];
    let hi = ZOBRIST_MOVER_HI[this.mover] ^ ZOBRIST_MOVES_REM_HI[this.movesRemaining & 3];
    lo ^= ZOBRIST_DRAW_LO[this.drawCount[0] & 7] ^ ZOBRIST_DRAW_LO[8 + (this.drawCount[1] & 7)];
    hi ^= ZOBRIST_DRAW_HI[this.drawCount[0] & 7] ^ ZOBRIST_DRAW_HI[8 + (this.drawCount[1] & 7)];

    for (let sq = 0; sq < 49; sq++) {
      const len = this.counts[sq];
      if (len === 0) continue;
      const base = sq << 3;
      for (let i = 0; i < len; i++) {
        const c = this.cells[base + i] & 0x7f;
        let occ = 0;
        for (let j = 0; j < i; j++) {
          if ((this.cells[base + j] & 0x7f) === c) occ++;
        }
        const zIdx = ((sq << 8) | c) * 4 + (occ & 3);
        lo ^= ZOBRIST_SQ_CARD_LO[zIdx];
        hi ^= ZOBRIST_SQ_CARD_HI[zIdx];
      }
    }
    this.hashLo = lo >>> 0;
    this.hashHi = hi >>> 0;
  }

  private saveSquareForUndo(ply: number, sq: number): void {
    const count = this.undoModSqCount[ply];
    const plyBase = ply * 16;
    // Check if already saved at this ply
    for (let i = 0; i < count; i++) {
      if (this.undoModSqIdx[plyBase + i] === sq) return;
    }
    const idx = plyBase + count;
    this.undoModSqIdx[idx] = sq;
    const len = this.counts[sq];
    this.undoModSqLen[idx] = len;
    this.undoModSqF0[idx] = this.factionCounts[sq << 1];
    this.undoModSqF1[idx] = this.factionCounts[(sq << 1) + 1];
    const srcBase = sq << 3;
    const dstBase = idx << 3;
    for (let k = 0; k < len; k++) {
      this.undoModSqCards[dstBase + k] = this.cells[srcBase + k];
    }
    this.undoModSqCount[ply] = count + 1;
  }

  // Execute a micro-move or spawn; if this ends the turn, automatically resolve
  // end-of-turn combats, unlock surviving cards, and advance to opponent's turn!
  public makeStep(mv: number, ply: number): void {
    this.undoMover[ply] = this.mover;
    this.undoMovesRem[ply] = this.movesRemaining;
    this.undoTurnNumber[ply] = this.turnNumber;
    this.undoHashLo[ply] = this.hashLo;
    this.undoHashHi[ply] = this.hashHi;
    this.undoAce0[ply] = this.aceCounts[0];
    this.undoAce1[ply] = this.aceCounts[1];
    this.undoDraw0[ply] = this.drawCount[0];
    this.undoDraw1[ply] = this.drawCount[1];
    this.undoModSqCount[ply] = 0;

    const myFaction = this.mover;
    const opFaction = 1 - myFaction;

    if ((mv & PASS_MOVE_BIT) !== 0) {
      this.finishTurnAndResolveCombats(ply);
      return;
    }

    if ((mv & SPAWN_MOVE_BIT) !== 0) {
      const spawnSq = (mv >> MOVE_TO_SHIFT) & MOVE_TO_MASK;
      this.saveSquareForUndo(ply, spawnSq);
      const dLeft = this.drawCount[myFaction];
      let spawnedCard = (9 | (myFaction << OWNER_SHIFT)) >>> 0;
      if (dLeft > 0) {
        // Draw piles have 6 cards initially; take next card in order
        const drawIdx = Math.max(0, 6 - dLeft);
        spawnedCard = this.drawPile[(myFaction << 3) + drawIdx];
        this.hashLo =
          (this.hashLo ^
            ZOBRIST_DRAW_LO[(myFaction << 3) + (dLeft & 7)] ^
            ZOBRIST_DRAW_LO[(myFaction << 3) + ((dLeft - 1) & 7)]) >>>
          0;
        this.hashHi =
          (this.hashHi ^
            ZOBRIST_DRAW_HI[(myFaction << 3) + (dLeft & 7)] ^
            ZOBRIST_DRAW_HI[(myFaction << 3) + ((dLeft - 1) & 7)]) >>>
          0;
        this.drawCount[myFaction] = dLeft - 1;
      }
      const hasEnemy = this.factionCounts[(spawnSq << 1) + opFaction] > 0;
      if (hasEnemy) spawnedCard |= LOCKED_BIT;
      this.addCardToSquare(spawnSq, spawnedCard);
      this.finishTurnAndResolveCombats(ply);
      return;
    }

    // Normal micro-move
    const fromSq = mv & MOVE_FROM_MASK;
    const toSq = (mv >> MOVE_TO_SHIFT) & MOVE_TO_MASK;
    const targetRank = (mv >> MOVE_RANK_SHIFT) & MOVE_RANK_MASK;

    this.saveSquareForUndo(ply, fromSq);
    this.saveSquareForUndo(ply, toSq);

    const fromBase = fromSq << 3;
    const fromLen = this.counts[fromSq];
    let slotToMove = -1;
    for (let i = 0; i < fromLen; i++) {
      const c = this.cells[fromBase + i];
      if (((c >> OWNER_SHIFT) & 1) !== myFaction) continue;
      if ((c & LOCKED_BIT) !== 0) continue;
      if ((c & RANK_MASK) === targetRank) {
        slotToMove = i;
        break;
      }
      if (slotToMove === -1) slotToMove = i;
    }

    if (slotToMove !== -1) {
      let movedCard = this.removeCardSlotFromSquare(fromSq, slotToMove);
      movedCard &= ~STATIONARY_BIT;
      if (this.factionCounts[(toSq << 1) + opFaction] > 0) {
        movedCard |= LOCKED_BIT;
      }
      this.addCardToSquare(toSq, movedCard);
    }

    if (this.movesRemaining > 1) {
      // Intra-turn transition: same mover, decrement movesRemaining
      const oldRem = this.movesRemaining;
      const newRem = oldRem - 1;
      this.movesRemaining = newRem;
      this.hashLo = (this.hashLo ^ ZOBRIST_MOVES_REM_LO[oldRem] ^ ZOBRIST_MOVES_REM_LO[newRem]) >>> 0;
      this.hashHi = (this.hashHi ^ ZOBRIST_MOVES_REM_HI[oldRem] ^ ZOBRIST_MOVES_REM_HI[newRem]) >>> 0;
    } else {
      // End of 3-move turn: resolve combats, unlock, switch mover!
      this.finishTurnAndResolveCombats(ply);
    }
  }

  private finishTurnAndResolveCombats(ply: number): void {
    const attFaction = this.mover;
    const defFaction = 1 - attFaction;

    for (let sq = 0; sq < 49; sq++) {
      const len = this.counts[sq];
      if (len === 0) continue;
      const f0 = this.factionCounts[sq << 1];
      const f1 = this.factionCounts[(sq << 1) + 1];

      if (f0 > 0 && f1 > 0) {
        // Contested square: resolve combat under exact 5-tier Checards rules!
        this.saveSquareForUndo(ply, sq);
        this.resolveSquareCombatExact(sq, attFaction, defFaction);
      } else {
        // Uncontested square: check if any card has LOCKED_BIT set and clear it
        const base = sq << 3;
        let hasLocked = false;
        for (let i = 0; i < len; i++) {
          if ((this.cells[base + i] & LOCKED_BIT) !== 0) {
            hasLocked = true;
            break;
          }
        }
        if (hasLocked) {
          this.saveSquareForUndo(ply, sq);
          for (let i = 0; i < len; i++) {
            const c = this.cells[base + i];
            if ((c & LOCKED_BIT) !== 0) {
              this.xorCardOnSquare(sq, c);
              this.cells[base + i] = c & ~LOCKED_BIT;
              this.xorCardOnSquare(sq, c & ~LOCKED_BIT);
            }
          }
        }
      }
    }

    // Flip mover and reset movesRemaining = 3
    const nextMover = 1 - attFaction;
    this.mover = nextMover;
    this.movesRemaining = 3;
    this.turnNumber++;
    this.recomputeFullHash();
  }

  private resolveSquareCombatExact(sq: number, attFaction: number, defFaction: number): void {
    const base = sq << 3;
    const len = this.counts[sq];

    let attAces = 0;
    let attTotal = 0;

    let defAces = 0;
    let defJokers = 0;
    let defTotal = 0;

    for (let i = 0; i < len; i++) {
      const c = this.cells[base + i];
      const owner = (c >> OWNER_SHIFT) & 1;
      const r = c & RANK_MASK;
      const pts = rankPointsFast(r);
      if (owner === attFaction) {
        if (r === 1) attAces++;
        attTotal += pts;
      } else {
        if (r === 1) defAces++;
        else if (r === 0) defJokers++;
        defTotal += pts;
      }
    }

    let attDies = false;
    let defDies = false;

    // Exact 5-Tier Checards Combat Resolution:
    // Rule 1: Two attacking Aces overwhelm defending Joker -> defender dies, attacker lives
    if (attAces >= 2 && defJokers >= 1) {
      defDies = true;
    }
    // Rule 2: One attacking Ace trades with defending Joker -> both die
    else if (attAces === 1 && defJokers >= 1) {
      attDies = true;
      defDies = true;
    }
    // Rule 3: Attacking Ace against any non-Joker -> automatic attacker victory
    else if (attAces >= 1 && defJokers === 0) {
      defDies = true;
    }
    // Rule 4: Defending Joker beats any attack without an Ace -> attacker dies, defender lives
    else if (attAces === 0 && defJokers >= 1) {
      attDies = true;
    }
    // Rule 5: Total point sum comparison (ties destroy both stacks)
    else if (attTotal > defTotal) {
      defDies = true;
    } else if (defTotal > attTotal) {
      attDies = true;
    } else {
      attDies = true;
      defDies = true;
    }

    // Rebuild square stack with survivors (revealed = 1, locked = 0)
    this.aceCounts[attFaction] -= attAces;
    this.aceCounts[defFaction] -= defAces;

    if (attDies && defDies) {
      this.counts[sq] = 0;
      this.factionCounts[sq << 1] = 0;
      this.factionCounts[(sq << 1) + 1] = 0;
    } else if (defDies) {
      let newLen = 0;
      for (let i = 0; i < len; i++) {
        const c = this.cells[base + i];
        if (((c >> OWNER_SHIFT) & 1) === attFaction) {
          const r = c & RANK_MASK;
          const surv = (c | REVEALED_BIT) & ~LOCKED_BIT;
          this.cells[base + newLen++] = surv;
          if (r === 1) this.aceCounts[attFaction]++;
        }
      }
      this.counts[sq] = newLen;
      this.factionCounts[(sq << 1) + attFaction] = newLen;
      this.factionCounts[(sq << 1) + defFaction] = 0;
    } else {
      let newLen = 0;
      for (let i = 0; i < len; i++) {
        const c = this.cells[base + i];
        if (((c >> OWNER_SHIFT) & 1) === defFaction) {
          const r = c & RANK_MASK;
          const surv = (c | REVEALED_BIT) & ~LOCKED_BIT;
          this.cells[base + newLen++] = surv;
          if (r === 1) this.aceCounts[defFaction]++;
        }
      }
      this.counts[sq] = newLen;
      this.factionCounts[(sq << 1) + defFaction] = newLen;
      this.factionCounts[(sq << 1) + attFaction] = 0;
    }
  }

  public unmakeStep(ply: number): void {
    this.mover = this.undoMover[ply];
    this.movesRemaining = this.undoMovesRem[ply];
    this.turnNumber = this.undoTurnNumber[ply];
    this.hashLo = this.undoHashLo[ply];
    this.hashHi = this.undoHashHi[ply];
    this.aceCounts[0] = this.undoAce0[ply];
    this.aceCounts[1] = this.undoAce1[ply];
    this.drawCount[0] = this.undoDraw0[ply];
    this.drawCount[1] = this.undoDraw1[ply];

    const modCount = this.undoModSqCount[ply];
    const plyBase = ply * 16;
    for (let i = modCount - 1; i >= 0; i--) {
      const idx = plyBase + i;
      const sq = this.undoModSqIdx[idx];
      const len = this.undoModSqLen[idx];
      this.counts[sq] = len;
      this.factionCounts[sq << 1] = this.undoModSqF0[idx];
      this.factionCounts[(sq << 1) + 1] = this.undoModSqF1[idx];
      const dstBase = sq << 3;
      const srcBase = idx << 3;
      for (let k = 0; k < len; k++) {
        this.cells[dstBase + k] = this.undoModSqCards[srcBase + k];
      }
    }
  }
}

// ----------------------------------------------------------------------------
// 4. ZERO-ALLOCATION MOVE GENERATION & MOVE ORDERING (PHASE 3)
// ----------------------------------------------------------------------------

const plyMoveList = new Uint32Array(MAX_PLY * 128);
const plyMoveScores = new Int32Array(MAX_PLY * 128);
const plyMoveCount = new Uint8Array(MAX_PLY);

// Killer Moves (2 per ply) & History Heuristic [faction][fromSq][toSq] & Countermoves
const killerMoves = new Uint32Array(MAX_PLY * 2);
const historyTable = new Int32Array(2 * 49 * 49);
const counterMoves = new Uint32Array(2 * 4096);

export function resetSearchHeuristics(): void {
  killerMoves.fill(0);
  for (let i = 0; i < historyTable.length; i++) {
    historyTable[i] = (historyTable[i] * 3) >> 2;
  }
}

export function generateFlatMoves(
  board: FlatBoard,
  ply: number,
  ttMove: number,
  prevMove: number
): number {
  const myFaction = board.mover;
  const opFaction = 1 - myFaction;
  const listBase = ply * 128;
  let count = 0;

  const prevFrom = prevMove > 0 && (prevMove & SPAWN_MOVE_BIT) === 0 ? prevMove & MOVE_FROM_MASK : -1;
  const prevTo =
    prevMove > 0 && (prevMove & SPAWN_MOVE_BIT) === 0
      ? (prevMove >> MOVE_TO_SHIFT) & MOVE_TO_MASK
      : -1;
  const killer0 = killerMoves[ply * 2];
  const killer1 = killerMoves[ply * 2 + 1];
  const counterMv =
    prevMove > 0 ? counterMoves[(myFaction << 12) | (prevMove & 0xfff)] : 0;

  // Locate enemy Aces for tactical check/approach ordering
  // Information-Set Honesty: Only treat an enemy Ace as a known bullseye target in move ordering
  // if it is revealed (`REVEALED_BIT`) OR sits on the opponent's setup rows (`opDepth <= 1`).
  let opAceSq0 = -1;
  let opAceSq1 = -1;
  let myAceSq0 = -1;
  let myAceSq1 = -1;
  for (let sq = 0; sq < 49; sq++) {
    const len = board.counts[sq];
    if (len === 0) continue;
    const base = sq << 3;
    const y = sq % 7;
    const opDepth = opFaction === 0 ? y : 6 - y;
    for (let i = 0; i < len; i++) {
      const c = board.cells[base + i];
      if ((c & RANK_MASK) === 1) {
        if (((c >> OWNER_SHIFT) & 1) === opFaction) {
          if ((c & REVEALED_BIT) !== 0 || opDepth <= 1 || len >= 2) {
            if (opAceSq0 === -1) opAceSq0 = sq;
            else opAceSq1 = sq;
          }
        } else {
          if (myAceSq0 === -1) myAceSq0 = sq;
          else myAceSq1 = sq;
        }
      }
    }
  }

  // 1. Spawn actions (legal at start of turn when movesRemaining === 3 and drawCount > 0 on ANY empty home-row square!)
  if (board.movesRemaining === 3 && board.drawCount[myFaction] > 0) {
    const homeY = myFaction === 0 ? 0 : 6;
    for (let x = 0; x < 7; x++) {
      const spawnSq = x * 7 + homeY;
      if (board.counts[spawnSq] === 0) {
        const mv = encodeSpawnMove(spawnSq);
        plyMoveList[listBase + count] = mv;
        let sc = board.turnNumber <= 2 ? 45000 : 165000 + (3 - Math.abs(x - 3)) * 9000;
        if (mv === ttMove) {
          sc = 10000000;
        } else {
          if (
            (myAceSq0 !== -1 && CHEB_DIST[spawnSq * 49 + myAceSq0] === 1) ||
            (myAceSq1 !== -1 && CHEB_DIST[spawnSq * 49 + myAceSq1] === 1)
          ) {
            sc += 135000;
          }
        }
        plyMoveScores[listBase + count] = sc;
        count++;
      }
    }
  }

  // 2. Micro-moves for each square with unlocked friendly cards
  const histBase = myFaction * 2401;
  for (let sq = 0; sq < 49; sq++) {
    if (board.factionCounts[(sq << 1) + myFaction] === 0) continue;
    const base = sq << 3;
    const len = board.counts[sq];

    // Deduplicate movable card ranks on `sq`
    let seenRanksMask = 0;
    for (let slot = 0; slot < len; slot++) {
      const c = board.cells[base + slot];
      if (((c >> OWNER_SHIFT) & 1) !== myFaction) continue;
      if ((c & LOCKED_BIT) !== 0) continue;
      const r = c & RANK_MASK;
      const rBit = 1 << r;
      if ((seenRanksMask & rBit) !== 0) continue;
      seenRanksMask |= rBit;

      const nCnt = NEIGHBOR_COUNTS[sq];
      const nBase = sq * 8;
      for (let n = 0; n < nCnt; n++) {
        const toSq = NEIGHBORS[nBase + n];
        const myDestCnt = board.factionCounts[(toSq << 1) + myFaction];
        if (myDestCnt >= 4) continue;
        const opDestCnt = board.factionCounts[(toSq << 1) + opFaction];
        // Never stack a friendly Ace onto another friendly Ace unless attacking an enemy square!
        if (r === 1 && opDestCnt === 0 && (toSq === myAceSq0 || toSq === myAceSq1)) {
          continue;
        }
        // Prevent omniscient 3-step midline X-ray snipes on Turn T+1 (`ply <= 2`) onto a camouflaged unrevealed home-row Ace!
        if (ply <= 2 && board.camouflagedHomeAce[toSq] === 1) {
          continue;
        }
        // Hard-prune intra-turn round-trip reversals (prevTo -> prevFrom) and 2-step triangle detours
        // onto empty squares (prevFrom -> prevTo -> toSq where CHEB_DIST[prevFrom, toSq] <= 1 and myDestCnt === 0).
        // NOTE: When myDestCnt > 0 (e.g. a 2-card stack [K, Ace] shifting 1 square intact via Card1: A->C, Card2: A->B->C),
        // the 2-step triangle is the ONLY mathematical way for a 2-card stack to move 1 square in 3 micro-moves!
        if (board.movesRemaining < 3 && sq === prevTo && prevFrom >= 0) {
          if (toSq === prevFrom) continue;
          if (
            opDestCnt === 0 &&
            myDestCnt === 0 &&
            board.factionCounts[(prevTo << 1) + opFaction] === 0 &&
            CHEB_DIST[prevFrom * 49 + toSq] <= 1
          ) {
            continue;
          }
        }

        const mv = encodeMicroMove(sq, toSq, r);
        let sc = 0;

        if (mv === ttMove) {
          sc = 10000000;
        } else {
          if (opDestCnt > 0) {
            // Tactical Combat Move (MVV-LVA under exact 5-tier Checards rules)!
            let opVal = 0;
            let opSum = 0;
            let opHasAce = false;
            let opHasJoker = false;
            let myExistingAces = r === 1 ? 1 : 0;
            let myExistingSum = rankPointsFast(r);
            const dstBase = toSq << 3;
            const dstLen = board.counts[toSq];
            for (let k = 0; k < dstLen; k++) {
              const dc = board.cells[dstBase + k];
              const dr = dc & RANK_MASK;
              if (((dc >> OWNER_SHIFT) & 1) === opFaction) {
                if (dr === 1) opHasAce = true;
                if (dr === 0) opHasJoker = true;
                opVal += cardMaterialValue(dr);
                opSum += rankPointsFast(dr);
              } else {
                if (dr === 1) myExistingAces++;
                myExistingSum += rankPointsFast(dr);
              }
            }
            if (opHasAce) {
              // Prioritize lethal Ace captures!
              if (!opHasJoker && (myExistingAces >= 1 || myExistingSum >= opSum)) {
                sc = 6500000 + opVal - (r === 1 ? 5000 : r * 100);
              } else if (opHasJoker && myExistingAces >= 1) {
                sc = 5800000 + opVal;
              } else {
                sc = 2800000 + opVal;
              }
            } else if (r === 0) {
              // Joker offensive doctrine:
              // Include Joker in an attack when our accompanying court cards on `toSq` make `myExistingSum > opSum`
              // OR when our 2 Aces (`myExistingAces >= 2`) are executing an enemy Joker under Rule 1
              // (Post-Capture Joker Lock: the Joker survives combat and shields the captured square on the opponent's turn!)
              if (
                (!opHasJoker && myExistingAces === 0 && myDestCnt >= 1 && myExistingSum > opSum) ||
                (opHasJoker && myExistingAces >= 2)
              ) {
                sc = 4600000 + opVal * 12;
              } else {
                sc = -850000;
              }
            } else if (opHasJoker && myExistingAces === 0) {
              // Attacking a defending Joker without an Ace loses under Rule 4!
              sc = -650000;
            } else if (r === 1 && opHasJoker && board.aceCounts[myFaction] <= 1 && !opHasAce) {
              // Never trade our LAST Ace into an enemy non-Ace Joker stack (Rule 2 mutual destruction loses the game!)
              sc = -900000;
            } else if (r === 1 && !opHasJoker && !opHasAce && myDestCnt >= 1 && myExistingSum - 1 > opSum) {
              // Never needlessly drag our Ace into a battle already won by our court card(s) on `toSq` (reveals our Ace!)
              sc = -550000;
            } else if (opHasJoker && myExistingAces >= 2) {
              // Rule 1: Two attacking Aces overwhelm a defending Joker with zero losses!
              sc = 5400000 + opVal * 14;
            } else if (opHasJoker && myExistingAces === 1 && !opHasAce) {
              // 1st Ace stepping onto a non-Ace Joker: only profitable if our 2nd Ace can ALSO reach `toSq` this turn (Rule 1)!
              const otherAceSq = sq === myAceSq0 ? myAceSq1 : myAceSq0;
              const otherAceDist = otherAceSq !== -1 ? CHEB_DIST[otherAceSq * 49 + toSq] : 99;
              if (board.movesRemaining > 1 && otherAceDist <= board.movesRemaining - 1) {
                sc = 4800000 + opVal * 12;
              } else {
                sc = -650000;
              }
            } else if (!opHasJoker && (myExistingAces >= 1 || myExistingSum > opSum)) {
              sc = 2600000 + opVal * 12 - (r === 1 ? (opDestCnt >= 2 ? 2000 : 35000) : r * 80);
            } else if (!opHasJoker && board.movesRemaining > 1) {
              sc = 1150000 + opVal * 6;
            } else {
              sc = -450000;
            }
          } else {
            // Quiet move ordering:
            // (a) Stack-March Continuation (peeling sibling card from prevFrom -> prevTo)
            if (sq === prevFrom && toSq === prevTo) {
              sc += 1100000;
            }
            // (a2) Contested Battle Pincer Reinforcement (bringing a 2nd attacker or 2nd Ace from d=2 to d=1 of an active battle on prevTo!)
            if (
              board.movesRemaining === 2 &&
              prevTo >= 0 &&
              board.factionCounts[(prevTo << 1) + opFaction] > 0 &&
              board.factionCounts[(prevTo << 1) + myFaction] > 0 &&
              CHEB_DIST[toSq * 49 + prevTo] === 1 &&
              CHEB_DIST[sq * 49 + prevTo] === 2
            ) {
              sc += r === 1 ? 1950000 : 1650000;
            }
            // (b) Continuing the same card's multi-step march (prevTo -> new square)
            if (sq === prevTo && toSq !== prevFrom) {
              sc += 520000;
            }
            // (c) Reversing the previous micro-move (prevTo -> prevFrom) is almost always a wasted 2-step oscillation
            if (sq === prevTo && toSq === prevFrom) {
              sc -= 750000;
            }
            // (d) Merging onto a friendly stack (never merge two Aces together, and avoid merging Joker onto Ace when opponent has Aces!)
            if (myDestCnt > 0 && r !== 1) {
              if (
                r === 0 &&
                board.aceCounts[opFaction] >= 1 &&
                (toSq === myAceSq0 || toSq === myAceSq1)
              ) {
                sc -= 450000;
              } else {
                sc += 310000 + myDestCnt * 65000;
              }
            }
            // (e) Multi-Step Assassination Corridor & Direct Check toward enemy Aces!
            const dBefore0 = opAceSq0 !== -1 ? CHEB_DIST[sq * 49 + opAceSq0] : 99;
            const dAfter0 = opAceSq0 !== -1 ? CHEB_DIST[toSq * 49 + opAceSq0] : 99;
            const dBefore1 = opAceSq1 !== -1 ? CHEB_DIST[sq * 49 + opAceSq1] : 99;
            const dAfter1 = opAceSq1 !== -1 ? CHEB_DIST[toSq * 49 + opAceSq1] : 99;

            if (
              (dAfter0 < dBefore0 && dAfter0 <= board.movesRemaining - 1) ||
              (dAfter1 < dBefore1 && dAfter1 <= board.movesRemaining - 1)
            ) {
              // Can reach and attack enemy Ace THIS turn!
              const minD = dAfter0 < dAfter1 ? dAfter0 : dAfter1;
              sc += 1550000 + (3 - minD) * 250000;
            } else if (dAfter0 === 1 || dAfter1 === 1) {
              sc += r === 0 ? 920000 : r !== 1 ? 850000 : 380000;
            } else if ((dAfter0 === 2 && dBefore0 === 3) || (dAfter1 === 2 && dBefore1 === 3)) {
              sc += 440000;
            }

            // (f) Stepping adjacent to our own Ace to guard/interpose, evading with a threatened Ace,
            // OR marching an Ace (`r === 1`) to assassinate an enemy 2+ card non-Joker stack / lone Joker THIS turn (Rule 3 / Rule 1)!
            if (r === 1) {
              let minEnemyBefore = 99;
              let minEnemyAfter = 99;
              let canAssassinateStackThisTurn = false;
              for (let eSq = 0; eSq < 49; eSq++) {
                const opCntOnE = board.factionCounts[(eSq << 1) + opFaction];
                if (opCntOnE > 0) {
                  const db = CHEB_DIST[sq * 49 + eSq];
                  const da = CHEB_DIST[toSq * 49 + eSq];
                  if (db < minEnemyBefore) minEnemyBefore = db;
                  if (da < minEnemyAfter) minEnemyAfter = da;
                  if (da < db && da <= board.movesRemaining - 1 && board.aceCounts[myFaction] >= 2) {
                    const eBase = eSq << 3;
                    const eLen = board.counts[eSq];
                    let eHasJoker = false;
                    for (let k = 0; k < eLen; k++) {
                      const ec = board.cells[eBase + k];
                      if (((ec >> OWNER_SHIFT) & 1) === opFaction && (ec & RANK_MASK) === 0) {
                        eHasJoker = true;
                        break;
                      }
                    }
                    if ((!eHasJoker && opCntOnE >= 2) || (eHasJoker && opCntOnE === 1)) {
                      canAssassinateStackThisTurn = true;
                    }
                  }
                }
              }
              if (canAssassinateStackThisTurn) {
                sc += 1450000;
              } else if (minEnemyBefore <= 3 && (minEnemyAfter > minEnemyBefore || myDestCnt > 0)) {
                sc += 1350000 + (minEnemyAfter - minEnemyBefore) * 200000;
              } else if (
                minEnemyBefore > 3 &&
                myDestCnt === 0 &&
                !(board.aceCounts[myFaction] === 2 && board.aceCounts[opFaction] === 1)
              ) {
                // Never waste PVS branching factor shuffling an unthreatened back-row Ace onto an empty square!
                sc -= 650000;
              }
            } else if (
              (myAceSq0 !== -1 && CHEB_DIST[toSq * 49 + myAceSq0] === 1) ||
              (myAceSq1 !== -1 && CHEB_DIST[toSq * 49 + myAceSq1] === 1)
            ) {
              sc += 240000;
            }
            // (g) Killer & Countermove & History heuristics
            if (mv === killer0) sc += 650000;
            else if (mv === killer1) sc += 580000;
            else if (mv === counterMv) sc += 510000;

            sc += Math.min(350000, historyTable[histBase + sq * 49 + toSq]);

            // Forward progression for non-Ace cards
            const fromY = sq % 7;
            const toY = toSq % 7;
            const dy = myFaction === 0 ? toY - fromY : fromY - toY;
            if (r !== 1) {
              sc += dy * 18000;
            } else {
              sc -= dy * 25000;
            }
          }
        }

        plyMoveList[listBase + count] = mv;
        plyMoveScores[listBase + count] = sc;
        count++;
      }
    }
  }

  plyMoveCount[ply] = count;
  return count;
}

// Pick-best selection sort at index `idx` (avoids sorting moves after a beta cutoff!)
function pickNextBestMove(ply: number, idx: number, total: number): number {
  const base = ply * 128;
  let bestIdx = idx;
  let bestScore = plyMoveScores[base + idx];
  for (let i = idx + 1; i < total; i++) {
    const sc = plyMoveScores[base + i];
    if (sc > bestScore) {
      bestScore = sc;
      bestIdx = i;
    }
  }
  if (bestIdx !== idx) {
    const tmpMv = plyMoveList[base + idx];
    plyMoveList[base + idx] = plyMoveList[base + bestIdx];
    plyMoveList[base + bestIdx] = tmpMv;

    const tmpSc = plyMoveScores[base + idx];
    plyMoveScores[base + idx] = plyMoveScores[base + bestIdx];
    plyMoveScores[base + bestIdx] = tmpSc;
  }
  return plyMoveList[base + idx];
}

// ----------------------------------------------------------------------------
// 5. ZERO-ALLOCATION STATIC EVALUATOR (CALLED AT TURN BOUNDARIES)
// ----------------------------------------------------------------------------

// Pre-allocated buffers for evaluateFlatBoard (zero GC allocation per node)
const evalMySq = new Uint8Array(24);
const evalMyCnt = new Uint8Array(24);
const evalMyAces = new Uint8Array(24);
const evalMyJokers = new Uint8Array(24);
const evalMySum = new Uint16Array(24);
const evalMyMax1 = new Uint8Array(24);
const evalMyMax2 = new Uint8Array(24);
const evalMyVal = new Int32Array(24);
const evalMyCondemned = new Uint8Array(24);
const evalMyAceExposed = new Uint8Array(24);

const evalOpSq = new Uint8Array(24);
const evalOpCnt = new Uint8Array(24);
const evalOpAces = new Uint8Array(24);
const evalOpJokers = new Uint8Array(24);
const evalOpSum = new Uint16Array(24);
const evalOpMax1 = new Uint8Array(24);
const evalOpMax2 = new Uint8Array(24);
const evalOpVal = new Int32Array(24);
const evalOpCondemned = new Uint8Array(24);
const evalOpAceExposed = new Uint8Array(24);

// Fast zero-allocation obstacle-aware reachability check for d = 1, 2, 3:
// Returns minimum steps (1..3) for `attackerFaction` from `fromSq` to `toSq` without passing through
// an enemy-occupied square (which combat-locks the moving card!) or a 4-card friendly stack. Returns 99 if unreachable.
function minStepsObstacleAware(
  board: FlatBoard,
  attackerFaction: number,
  fromSq: number,
  toSq: number
): number {
  const cheb = CHEB_DIST[fromSq * 49 + toSq];
  if (cheb === 0 || cheb > 3) return 99;
  if (board.factionCounts[(toSq << 1) + attackerFaction] >= 4) return 99;
  if (cheb === 1) return 1;

  const defFaction = 1 - attackerFaction;
  const n1Cnt = NEIGHBOR_COUNTS[fromSq];
  const n1Base = fromSq * 8;

  if (cheb === 2) {
    for (let i = 0; i < n1Cnt; i++) {
      const midSq = NEIGHBORS[n1Base + i];
      if (CHEB_DIST[midSq * 49 + toSq] !== 1) continue;
      if (board.factionCounts[(midSq << 1) + defFaction] > 0) continue;
      if (board.factionCounts[(midSq << 1) + attackerFaction] >= 4) continue;
      return 2;
    }
    return 99;
  }

  // cheb === 3: try 3-step path through mid1 (d=1 from start, d=2 from target) -> mid2 (d=1 from mid1 and target)
  for (let i = 0; i < n1Cnt; i++) {
    const mid1 = NEIGHBORS[n1Base + i];
    if (CHEB_DIST[mid1 * 49 + toSq] > 2) continue;
    if (board.factionCounts[(mid1 << 1) + defFaction] > 0) continue;
    if (board.factionCounts[(mid1 << 1) + attackerFaction] >= 4) continue;

    const n2Cnt = NEIGHBOR_COUNTS[mid1];
    const n2Base = mid1 * 8;
    for (let j = 0; j < n2Cnt; j++) {
      const mid2 = NEIGHBORS[n2Base + j];
      if (CHEB_DIST[mid2 * 49 + toSq] !== 1) continue;
      if (board.factionCounts[(mid2 << 1) + defFaction] > 0) continue;
      if (board.factionCounts[(mid2 << 1) + attackerFaction] >= 4) continue;
      return 3;
    }
  }
  return 99;
}

// Phase 5: Tapered Middlegame (MG) & Endgame (EG) Piece-Square Tables
// Indexed by [role * 49 + (x * 7 + forwardDepth)]
// Roles: 0 = Joker, 1 = Ace, 2 = High Court (K, Q), 3 = Mid/Low Court (J, 10, 9)
const PST_MG = new Int16Array(4 * 49);
const PST_EG = new Int16Array(4 * 49);

(function initTaperedPST() {
  for (let x = 0; x < 7; x++) {
    const centerDist = Math.abs(x - 3);
    for (let fd = 0; fd < 7; fd++) {
      const idx = x * 7 + fd;

      // Role 0: Joker (MG shields center vanguard; EG hunts forward or escorts siege stacks)
      PST_MG[0 * 49 + idx] =
        (fd >= 1 && fd <= 3 ? 650 : fd === 0 ? 150 : 420) + (3 - centerDist) * 180;
      PST_EG[0 * 49 + idx] = fd * 290 + (3 - centerDist) * 210;

      // Role 1: Ace (MG strictly fortified on back row away from spawn x=3; EG values safe escape geometry)
      if (fd === 0) {
        PST_MG[1 * 49 + idx] = x === 1 || x === 5 ? 3800 : x === 2 || x === 4 ? 3100 : x === 3 ? -1600 : 2100;
        PST_EG[1 * 49 + idx] = x === 0 || x === 6 ? 1200 : x !== 3 ? 2600 : 400;
      } else if (fd === 1) {
        PST_MG[1 * 49 + idx] = -1800;
        PST_EG[1 * 49 + idx] = 600 + (3 - centerDist) * 150;
      } else {
        PST_MG[1 * 49 + idx] = -fd * 4200;
        PST_EG[1 * 49 + idx] = -fd * 1100 + (3 - centerDist) * 180;
      }

      // Role 2: High Court (K, Q)
      PST_MG[2 * 49 + idx] = fd * 360 + (3 - centerDist) * 210 + (fd >= 1 && fd <= 3 ? 350 : 0);
      PST_EG[2 * 49 + idx] = fd * 620 + (3 - centerDist) * 160 + (fd >= 4 ? 750 : 0);

      // Role 3: Mid/Low Court (J, 10, 9)
      PST_MG[3 * 49 + idx] = fd * 290 + (3 - centerDist) * 160 + (fd >= 1 && fd <= 2 ? 280 : 0);
      PST_EG[3 * 49 + idx] = fd * 510 + (3 - centerDist) * 140 + (fd >= 4 ? 550 : 0);
    }
  }
})();

export function evaluateFlatBoard(board: FlatBoard, perspectiveFaction: number): number {
  const opFaction = 1 - perspectiveFaction;
  const myAcesTotal = board.aceCounts[perspectiveFaction];
  const opAcesTotal = board.aceCounts[opFaction];

  if (opAcesTotal === 0 && myAcesTotal > 0) return 900000;
  if (myAcesTotal === 0 && opAcesTotal > 0) return -900000;
  if (myAcesTotal === 0 && opAcesTotal === 0) return 0;

  let score = (myAcesTotal - opAcesTotal) * 165000;
  score += (board.drawCount[perspectiveFaction] - board.drawCount[opFaction]) * 3100;

  let myStackCount = 0;
  let opStackCount = 0;

  let myAceSq0 = -1;
  let myAceSq1 = -1;
  let opAceSq0 = -1;
  let opAceSq1 = -1;

  for (let sq = 0; sq < 49; sq++) {
    const len = board.counts[sq];
    if (len === 0) continue;
    const base = sq << 3;
    const owner = (board.cells[base] >> OWNER_SHIFT) & 1;

    let aces = 0;
    let jokers = 0;
    let sum = 0;
    let max1 = 0;
    let max2 = 0;
    let matVal = 0;
    let hiddenInfoBonus = 0;

    for (let i = 0; i < len; i++) {
      const c = board.cells[base + i];
      const r = c & RANK_MASK;
      const pts = rankPointsFast(r);
      if (r === 1) aces++;
      else if (r === 0) jokers++;
      sum += pts;
      if (pts >= max1) {
        max2 = max1;
        max1 = pts;
      } else if (pts > max2) {
        max2 = pts;
      }
      matVal += r === 1 ? 22000 : cardMaterialValue(r);
      if ((c & REVEALED_BIT) === 0) {
        if (r === 1) hiddenInfoBonus += 2600; // Unrevealed Ace conceals vital target location
        else if (r === 0) hiddenInfoBonus += 2800; // Unrevealed Joker retains full surprise trap value
        else hiddenInfoBonus += 750; // Unrevealed Court card conceals stack point threshold
      }
    }
    if (aces > 0 && len >= 2 && hiddenInfoBonus > 0) {
      // Unrevealed armor on an Ace conceals the exact points needed to crack the Ace stack
      hiddenInfoBonus += (len - 1) * 450;
    }

    const x = (sq / 7) | 0;
    const y = sq % 7;
    const forwardDepth = owner === 0 ? y : 6 - y;
    const pstSq = x * 7 + forwardDepth;

    // Tapered MG/EG phase calculation (0 = pure Endgame, 24 = Opening/Middlegame)
    const phaseWeight = Math.min(24, board.drawCount[0] + board.drawCount[1] + 10);

    // Stack synergy & information value bonuses
    let posBonus = hiddenInfoBonus;
    if (aces >= 2) {
      // Only apply a mild consolidation reminder (-16000) when 2 Aces are shielded by a friendly Joker on `sq`
      // (e.g. right after a [AC, AS, Jkr*] Rule-1 Joker execution!), otherwise heavily penalize unshielded 2-Ace stacks!
      posBonus -= jokers > 0 ? 16000 : 85000;
    }
    if (aces > 0) {
      const mgAce = PST_MG[1 * 49 + pstSq];
      const egAce = PST_EG[1 * 49 + pstSq];
      posBonus += ((mgAce * phaseWeight + egAce * (24 - phaseWeight)) / 24) | 0;
      // Only reward court armor on an Ace if the Ace has been revealed or moved off the back row
      if (len === 2 && jokers === 0) {
        posBonus += hiddenInfoBonus === 0 || forwardDepth >= 1 ? 1400 : -900;
      } else if (len >= 2 && jokers > 0) {
        // Ace + Joker on the same square is vulnerable to a 1-Ace Rule 2 double-kill!
        posBonus -= board.aceCounts[1 - owner] >= 1 ? (board.aceCounts[owner] <= 1 ? 36000 : 22000) : 2000;
      }
    } else {
      const role = jokers > 0 ? 0 : sum / len >= 12 ? 2 : 3;
      const mgRole = PST_MG[role * 49 + pstSq];
      const egRole = PST_EG[role * 49 + pstSq];
      posBonus += ((mgRole * phaseWeight + egRole * (24 - phaseWeight)) / 24) | 0;

      // Non-Ace stack synergy
      if (len === 1 && jokers === 0 && forwardDepth >= 3) {
        // Penalize leaving a lone 1-card court piece exposed across the midline at turn end!
        posBonus -= 5200;
      } else if (len === 2) {
        posBonus += 1850;
        if (jokers > 0) posBonus += 4200; // Joker-shielded court card phalanx!
        else if (sum >= 25) posBonus += 4200;
        else if (sum >= 23) posBonus += 3100;
      } else if (len === 3) {
        if (jokers > 0) posBonus += 4800;
        else if (sum >= 33) posBonus += 2400;
        else posBonus -= 2800;
      } else if (len >= 4) {
        // A 4-card stack cannot move as a unit in a 3-move turn!
        posBonus -= 12000;
      }
    }

    if (owner === perspectiveFaction) {
      score += matVal + posBonus;
      const idx = myStackCount++;
      evalMySq[idx] = sq;
      evalMyCnt[idx] = len;
      evalMyAces[idx] = aces;
      evalMyJokers[idx] = jokers;
      evalMySum[idx] = sum;
      evalMyMax1[idx] = max1;
      evalMyMax2[idx] = max2;
      evalMyVal[idx] = matVal;
      evalMyCondemned[idx] = 0;
      evalMyAceExposed[idx] = aces > 0 && (hiddenInfoBonus === 0 || forwardDepth >= 1) ? 1 : 0;
      if (aces > 0) {
        if (myAceSq0 === -1) myAceSq0 = sq;
        else myAceSq1 = sq;
      }
    } else {
      score -= matVal + posBonus;
      const idx = opStackCount++;
      evalOpSq[idx] = sq;
      evalOpCnt[idx] = len;
      evalOpAces[idx] = aces;
      evalOpJokers[idx] = jokers;
      evalOpSum[idx] = sum;
      evalOpMax1[idx] = max1;
      evalOpMax2[idx] = max2;
      evalOpVal[idx] = matVal;
      evalOpCondemned[idx] = 0;
      evalOpAceExposed[idx] = aces > 0 && (hiddenInfoBonus === 0 || forwardDepth >= 1) ? 1 : 0;
      if (aces > 0) {
        if (opAceSq0 === -1) opAceSq0 = sq;
        else opAceSq1 = sq;
      }
    }
  }

  // Ace Separation & Escort Shielding
  if (myAceSq0 !== -1 && myAceSq1 !== -1) {
    const aceDist = CHEB_DIST[myAceSq0 * 49 + myAceSq1];
    if (aceDist >= 3) score += 3200;
    else if (aceDist === 1) score -= 5500;
  }
  if (opAceSq0 !== -1 && opAceSq1 !== -1) {
    const aceDist = CHEB_DIST[opAceSq0 * 49 + opAceSq1];
    if (aceDist >= 3) score -= 3200;
    else if (aceDist === 1) score += 5500;
  }

  // Evaluate Exact 3-Step Obstacle-Aware Knapsack Reachability Threats!
  // Note: `evaluateFlatBoard` is always called at a turn boundary (`board.movesRemaining === 3`),
  // where `board.mover === perspectiveFaction` (`myMovesFirst = true`) or `board.mover === opFaction` (`opMovesFirst = true`).
  const opMovesFirst = board.mover === opFaction;
  const myMovesFirst = board.mover === perspectiveFaction;
  let firstCondemnedMyAceDist = 99;
  let firstCondemnedOpAceDist = 99;
  let opScreenBlockBonusForOp = 0;
  let myScreenBlockBonus = 0;

  // Helper to check if `perspectiveFaction` can kill enemy stack `j` (using non-condemned `my` stacks)
  const evaluateMyAttacks = () => {
    for (let j = 0; j < opStackCount; j++) {
      const oSq = evalOpSq[j];
      const oAces = evalOpAces[j];
      const oJokers = evalOpJokers[j];
      const oSum = evalOpSum[j];
      const oVal = evalOpVal[j];

      let canWeKill = false;
      let minKillDist = 99;
      let mTop1_0 = 0;
      let mTop1_1 = 0;
      let mTop1_2 = 0;
      let mTop2_0 = 0;
      let mTop2_1 = 0;
      let mTop2_2 = 0;
      let mTop3_0 = 0;
      let mTop3_1 = 0;
      let mAceDist0 = 99;
      let mAceDist1 = 99;

      for (let i = 0; i < myStackCount; i++) {
        if (evalMyCondemned[i] === 1) continue;
        const mSq = evalMySq[i];
        const dCheb = CHEB_DIST[mSq * 49 + oSq];
        if (dCheb > 3) continue;
        const d = minStepsObstacleAware(board, perspectiveFaction, mSq, oSq);
        if (oAces > 0 && d > dCheb && !(board.camouflagedHomeAce[oSq] === 1 && dCheb === 3)) {
          opScreenBlockBonusForOp += d > 3 ? 2200 : 1100;
        }
        if (d > 3) continue;

        const mCnt = evalMyCnt[i];
        const mAces = evalMyAces[i];
        const mJokers = evalMyJokers[i];
        const mSum = evalMySum[i];
        const mMax1 = evalMyMax1[i];
        const mMax2 = evalMyMax2[i];

        if (mAces > 0) {
          for (let a = 0; a < mAces; a++) {
            if (d <= mAceDist0) {
              mAceDist1 = mAceDist0;
              mAceDist0 = d;
            } else if (d < mAceDist1) {
              mAceDist1 = d;
            }
          }
        }

        if (oJokers === 0 && oSum === 1 && mJokers > 0) {
          canWeKill = true;
          if (d < minKillDist) minKillDist = d;
        }

        if (d === 1) {
          const c0 = mMax1;
          const c1 = mCnt >= 2 ? mMax2 : 0;
          const c2 = mCnt >= 3 ? Math.max(1, mSum - mMax1 - mMax2) : 0;
          const arr = [c0, c1, c2];
          for (let k = 0; k < 3; k++) {
            const pts = arr[k];
            if (pts <= 0) break;
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
          }
        } else if (d === 2) {
          const c0 = mMax1;
          const c1 = mCnt >= 2 ? mMax2 : 0;
          const arr = [c0, c1];
          for (let k = 0; k < 2; k++) {
            const pts = arr[k];
            if (pts <= 0) break;
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
          }
        } else if (d === 3) {
          const c0 = mMax1;
          const c1 = mCnt >= 2 ? mMax2 : 0;
          if (c0 >= mTop3_0) {
            mTop3_1 = mTop3_0;
            mTop3_0 = c0;
            if (c1 > mTop3_1) mTop3_1 = c1;
          } else if (c0 > mTop3_1) {
            mTop3_1 = c0;
          }
        }
      }

      const neededPts = oAces > 0 ? oSum : oSum + 1;
      let maxReachPts = 0;
      if (oJokers > 0) {
        if (oAces > 0 && mAceDist0 <= 3 && (myAcesTotal >= 2 || opAcesTotal === 1)) {
          canWeKill = true;
          if (mAceDist0 < minKillDist) minKillDist = mAceDist0;
        } else if (mAceDist0 + mAceDist1 <= 3) {
          canWeKill = true;
          if (mAceDist0 < minKillDist) minKillDist = mAceDist0;
        }
      } else {
        if (mAceDist0 <= 3 && (oAces > 0 || evalOpCnt[j] >= 2 || myAcesTotal >= 2)) {
          canWeKill = true;
          if (mAceDist0 < minKillDist) minKillDist = mAceDist0;
        } else {
          const reach1 = Math.max(mTop1_0, mTop2_0, mTop3_0);
          const reach2 = mTop1_0 > 0 ? mTop1_0 + Math.max(mTop1_1, mTop2_0) : 0;
          const reach3 = mTop1_0 > 0 && mTop1_1 > 0 && mTop1_2 > 0 ? mTop1_0 + mTop1_1 + mTop1_2 : 0;
          maxReachPts = Math.max(reach1, reach2, reach3);
          if (maxReachPts >= neededPts) {
            canWeKill = true;
            if (mTop1_0 >= neededPts || reach2 >= neededPts || reach3 >= neededPts) {
              minKillDist = Math.min(minKillDist, 1);
            } else if (mTop2_0 >= neededPts) {
              minKillDist = Math.min(minKillDist, 2);
            } else {
              minKillDist = Math.min(minKillDist, 3);
            }
          }
        }
      }

      if (canWeKill) {
        if (oAces > 0 && board.camouflagedHomeAce[oSq] === 1 && minKillDist === 3) {
          score += myMovesFirst ? 4500 : 1800;
        } else if (myMovesFirst) {
          evalOpCondemned[j] = 1;
          if (oAces > 0) {
            if (opAcesTotal <= oAces) {
              score += 480000;
            } else if (firstCondemnedOpAceDist === 99) {
              firstCondemnedOpAceDist = minKillDist;
              score += 135000;
            } else if (firstCondemnedOpAceDist + minKillDist <= 3 && myStackCount >= 2) {
              score += 420000;
            } else {
              score += 32000;
            }
          } else if (oJokers > 0 && mAceDist0 + mAceDist1 <= 3) {
            // Rule-1 2-Ace Joker Overwhelm Bonus: executing the opponent's Joker stack!
            score += Math.round(oVal * 0.92) + 26000;
          } else {
            score += Math.round(oVal * 0.78);
          }
        } else {
          // `opFaction` moves first: only count our threat if it is at d=1 or d=2 (not a distant d=3 midline piece!)
          if (oAces > 0) {
            if (minKillDist === 1) score += opAcesTotal === 1 ? 115000 : 48000;
            else if (minKillDist === 2) score += opAcesTotal === 1 ? 42000 : 18000;
          } else if (oJokers > 0 && mAceDist0 + mAceDist1 <= 2) {
            score += Math.round(oVal * 0.55) + 14000;
          } else if (minKillDist <= 2) {
            score += Math.round(oVal * 0.35);
          }
        }
      } else {
        // Turn-After Reinforced Siege (2-Turn / 6-Move Horizon):
        // Check if our 2+ card power stacks at d = 2..3 (or 2 Aces with mAceDist0 + mAceDist1 <= 5)
        // can stage on Turn 1 and converge on Turn 2 (`twoTurnReachPts >= neededPts`)!
        const two2 = Math.max(
          mTop2_0 > 0 && mTop2_1 > 0 ? mTop2_0 + mTop2_1 : 0,
          mTop2_0 > 0 && mTop3_0 > 0 ? mTop2_0 + mTop3_0 : 0,
          mTop3_0 > 0 && mTop3_1 > 0 ? mTop3_0 + mTop3_1 : 0
        );
        const two3 = Math.max(
          mTop2_0 > 0 && mTop2_1 > 0 && mTop2_2 > 0 ? mTop2_0 + mTop2_1 + mTop2_2 : 0,
          mTop1_0 > 0 && mTop2_0 > 0 && mTop2_1 > 0 ? mTop1_0 + mTop2_0 + mTop2_1 : 0,
          mTop1_0 > 0 && mTop2_0 > 0 && mTop3_0 > 0 ? mTop1_0 + mTop2_0 + mTop3_0 : 0
        );
        const twoTurnReachPts = Math.max(maxReachPts, two2, two3);
        const canKillInTwoTurns =
          (oJokers === 0 && twoTurnReachPts >= neededPts) ||
          (oJokers > 0 && mAceDist0 + mAceDist1 <= 5);
        if (canKillInTwoTurns) {
          if (oAces > 0) {
            score += myMovesFirst
              ? opAcesTotal === 1
                ? 28000
                : 14500
              : opAcesTotal === 1
              ? 14000
              : 7200;
          } else if (evalOpCnt[j] >= 2) {
            score += Math.round(oVal * (myMovesFirst ? 0.24 : 0.14));
          }
        }
      }
    }
  };

  // Helper to check if `opFaction` can kill our stack `i` (using non-condemned `op` stacks)
  const evaluateOpAttacks = () => {
    for (let i = 0; i < myStackCount; i++) {
      const mSq = evalMySq[i];
      const mAces = evalMyAces[i];
      const mJokers = evalMyJokers[i];
      const mSum = evalMySum[i];
      const mVal = evalMyVal[i];

      let canOpKill = false;
      let minOpKillDist = 99;
      let top1_0 = 0;
      let top1_1 = 0;
      let top1_2 = 0;
      let top2_0 = 0;
      let top2_1 = 0;
      let top2_2 = 0;
      let top3_0 = 0;
      let top3_1 = 0;
      let minAceDist0 = 99;
      let minAceDist1 = 99;

      for (let j = 0; j < opStackCount; j++) {
        if (evalOpCondemned[j] === 1) continue;
        const oSq = evalOpSq[j];
        const dCheb = CHEB_DIST[oSq * 49 + mSq];
        if (dCheb > 3) continue;
        const d = minStepsObstacleAware(board, opFaction, oSq, mSq);
        if (mAces > 0 && d > dCheb && !(board.camouflagedHomeAce[mSq] === 1 && dCheb === 3)) {
          myScreenBlockBonus += d > 3 ? 2400 : 1200;
        }
        if (d > 3) continue;

        const oCnt = evalOpCnt[j];
        const oAces = evalOpAces[j];
        const oJokers = evalOpJokers[j];
        const oSum = evalOpSum[j];
        const oMax1 = evalOpMax1[j];
        const oMax2 = evalOpMax2[j];

        if (oAces > 0) {
          for (let a = 0; a < oAces; a++) {
            if (d <= minAceDist0) {
              minAceDist1 = minAceDist0;
              minAceDist0 = d;
            } else if (d < minAceDist1) {
              minAceDist1 = d;
            }
          }
        }

        if (mJokers === 0 && mSum === 1 && oJokers > 0) {
          canOpKill = true;
          if (d < minOpKillDist) minOpKillDist = d;
        }

        if (d === 1) {
          const c0 = oMax1;
          const c1 = oCnt >= 2 ? oMax2 : 0;
          const c2 = oCnt >= 3 ? Math.max(1, oSum - oMax1 - oMax2) : 0;
          const arr = [c0, c1, c2];
          for (let k = 0; k < 3; k++) {
            const pts = arr[k];
            if (pts <= 0) break;
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
          }
        } else if (d === 2) {
          const c0 = oMax1;
          const c1 = oCnt >= 2 ? oMax2 : 0;
          const arr = [c0, c1];
          for (let k = 0; k < 2; k++) {
            const pts = arr[k];
            if (pts <= 0) break;
            if (pts >= top2_0) {
              top2_2 = top2_1;
              top2_1 = top2_0;
              top2_0 = pts;
            } else if (pts >= top2_1) {
              top2_2 = top2_1;
              top2_1 = pts;
            } else if (pts > top2_2) {
              top2_2 = pts;
            }
          }
        } else if (d === 3) {
          const c0 = oMax1;
          const c1 = oCnt >= 2 ? oMax2 : 0;
          if (c0 >= top3_0) {
            top3_1 = top3_0;
            top3_0 = c0;
            if (c1 > top3_1) top3_1 = c1;
          } else if (c0 > top3_1) {
            top3_1 = c0;
          }
        }
      }

      const neededPts = mAces > 0 ? mSum : mSum + 1;
      const reach1 = Math.max(top1_0, top2_0, top3_0);
      const reach2 = top1_0 > 0 ? top1_0 + Math.max(top1_1, top2_0) : 0;
      const reach3 = top1_0 > 0 && top1_1 > 0 && top1_2 > 0 ? top1_0 + top1_1 + top1_2 : 0;
      const maxReachablePts = Math.max(reach1, reach2, reach3);

      if (mJokers > 0) {
        if (mAces > 0 && minAceDist0 <= 3) {
          canOpKill = true;
          if (minAceDist0 < minOpKillDist) minOpKillDist = minAceDist0;
        } else if (minAceDist0 + minAceDist1 <= 3) {
          canOpKill = true;
          if (minAceDist0 < minOpKillDist) minOpKillDist = minAceDist0;
        }
      } else {
        if (minAceDist0 <= 3) {
          canOpKill = true;
          if (minAceDist0 < minOpKillDist) minOpKillDist = minAceDist0;
        } else if (maxReachablePts >= neededPts) {
          canOpKill = true;
          if (top1_0 >= neededPts || reach2 >= neededPts || reach3 >= neededPts) {
            minOpKillDist = Math.min(minOpKillDist, 1);
          } else if (top2_0 >= neededPts) {
            minOpKillDist = Math.min(minOpKillDist, 2);
          } else {
            minOpKillDist = Math.min(minOpKillDist, 3);
          }
        }
      }

      // Compute our 3-Micro-Move Turn-After Friendly Avenger & Active Reinforcement Reach on `mSq`:
      let avTop1_0 = 0;
      let avTop1_1 = 0;
      let avTop2_0 = 0;
      let avTop3_0 = 0;
      let avHasAce = false;
      for (let k = 0; k < myStackCount; k++) {
        if (k === i || evalMyCondemned[k] === 1) continue;
        const aSq = evalMySq[k];
        const dAv = CHEB_DIST[aSq * 49 + mSq];
        if (dAv < 1 || dAv > 3) continue;
        if (evalMyAces[k] > 0 && myAcesTotal > mAces) {
          avHasAce = true;
        }
        const aMax1 = evalMyMax1[k];
        const aMax2 = evalMyCnt[k] >= 2 ? evalMyMax2[k] : 0;
        if (dAv === 1) {
          if (aMax1 >= avTop1_0) {
            avTop1_1 = avTop1_0;
            avTop1_0 = aMax1;
            if (aMax2 > avTop1_1) avTop1_1 = aMax2;
          } else if (aMax1 > avTop1_1) {
            avTop1_1 = aMax1;
          }
        } else if (dAv === 2) {
          if (aMax1 > avTop2_0) avTop2_0 = aMax1;
        } else if (dAv === 3) {
          if (aMax1 > avTop3_0) avTop3_0 = aMax1;
        }
      }
      const avMax1 = Math.max(avTop1_0, avTop2_0, avTop3_0);
      const avMax2 = avTop1_0 > 0 ? avTop1_0 + Math.max(avTop1_1, avTop2_0) : 0;
      const avMaxReachPts = Math.max(avMax1, avMax2);

      if (canOpKill) {
        if (mAces > 0 && board.camouflagedHomeAce[mSq] === 1 && minOpKillDist === 3) {
          score -= opMovesFirst ? 4500 : 1800;
        } else if (opMovesFirst) {
          evalMyCondemned[i] = 1;
          if (mAces > 0) {
            if (myAcesTotal <= mAces) {
              score -= 480000;
            } else if (firstCondemnedMyAceDist === 99) {
              firstCondemnedMyAceDist = minOpKillDist;
              score -= 135000;
            } else if (firstCondemnedMyAceDist + minOpKillDist <= 3 && opStackCount >= 2) {
              score -= 420000;
            } else {
              score -= 32000;
            }
          } else if (mJokers > 0 && minAceDist0 + minAceDist1 <= 3) {
            // Rule-1 2-Ace Joker Overwhelm Threat: walking our Joker stack into 2 enemy Aces!
            score -= Math.round(mVal * 0.92) + 26000;
          } else {
            const oppCommittedPts =
              reach1 >= neededPts ? reach1 : reach2 >= neededPts ? reach2 : Math.max(neededPts, reach3);
            const hasAvenger = avHasAce || avMaxReachPts >= oppCommittedPts;
            score -= Math.round(hasAvenger ? mVal * 0.48 : mVal * 0.88);
          }
        } else {
          // `perspectiveFaction` moves first (`myMovesFirst === true`):
          // We have 3 micro-moves BEFORE `opFaction` can move! Never condemn our Ace from a distant d=3 midline card!
          if (mAces > 0) {
            if (minOpKillDist === 1) score -= myAcesTotal === 1 ? 115000 : 48000;
            else if (minOpKillDist === 2) score -= myAcesTotal === 1 ? 42000 : 18000;
          } else if (mJokers > 0 && minAceDist0 + minAceDist1 <= 2) {
            score -= Math.round(mVal * 0.55) + 14000;
          } else if (minOpKillDist <= 2) {
            score -= Math.round(mVal * 0.35);
          }
        }
      } else {
        // Turn-After Enemy Reinforced Siege (2-Turn / 6-Move Horizon) vs. Our Active Reinforcement:
        const opTwo2 = Math.max(
          top2_0 > 0 && top2_1 > 0 ? top2_0 + top2_1 : 0,
          top2_0 > 0 && top3_0 > 0 ? top2_0 + top3_0 : 0,
          top3_0 > 0 && top3_1 > 0 ? top3_0 + top3_1 : 0
        );
        const opTwo3 = Math.max(
          top2_0 > 0 && top2_1 > 0 && top2_2 > 0 ? top2_0 + top2_1 + top2_2 : 0,
          top1_0 > 0 && top2_0 > 0 && top2_1 > 0 ? top1_0 + top2_0 + top2_1 : 0,
          top1_0 > 0 && top2_0 > 0 && top3_0 > 0 ? top1_0 + top2_0 + top3_0 : 0
        );
        const opTwoTurnReachPts = Math.max(maxReachablePts, opTwo2, opTwo3);
        const myReinforceCap = Math.max(0, 4 - evalMyCnt[i]);
        const myReinforcePts =
          myReinforceCap === 0 ? 0 : myReinforceCap === 1 ? avMax1 : avMaxReachPts;
        if (mJokers === 0 && opTwoTurnReachPts >= neededPts) {
          const unreinforceable = opTwoTurnReachPts >= neededPts + myReinforcePts;
          if (mAces > 0) {
            score -= unreinforceable
              ? myAcesTotal <= mAces
                ? 36000
                : 18500
              : myAcesTotal <= mAces
              ? 16000
              : 8500;
          } else if (evalMyCnt[i] >= 2 && unreinforceable && !avHasAce) {
            score -= Math.round(mVal * 0.22);
          }
        }
      }
    }
  };

  if (myMovesFirst) {
    evaluateMyAttacks();
    evaluateOpAttacks();
  } else {
    evaluateOpAttacks();
    evaluateMyAttacks();
  }
  if (opScreenBlockBonusForOp > 0) {
    score -= Math.min(4400, opScreenBlockBonusForOp);
  }
  if (myScreenBlockBonus > 0) {
    score += Math.min(4800, myScreenBlockBonus);
  }

  // 3. Siege proximity of our non-condemned stacks to enemy Aces & guard proximity to our Aces
  for (let i = 0; i < myStackCount; i++) {
    const mSq = evalMySq[i];
    const mAces = evalMyAces[i];
    const mJokers = evalMyJokers[i];
    const mCnt = evalMyCnt[i];
    if (mAces > 0) continue;

    // Guarding our own Aces
    if (
      (myAceSq0 !== -1 && CHEB_DIST[mSq * 49 + myAceSq0] === 1) ||
      (myAceSq1 !== -1 && CHEB_DIST[mSq * 49 + myAceSq1] === 1)
    ) {
      score += 1750 + (mCnt >= 2 ? 950 : 0);
    }

    // Closing in on enemy Aces (plus Bayesian suspected Ace squares from acePrior)
    if (evalMyCondemned[i] === 0) {
      const d0 = opAceSq0 !== -1 ? CHEB_DIST[mSq * 49 + opAceSq0] : 99;
      const d1 = opAceSq1 !== -1 ? CHEB_DIST[mSq * 49 + opAceSq1] : 99;
      const minD = d0 < d1 ? d0 : d1;
      if (minD <= 4) {
        const siegeBonus = (5 - minD) * (mJokers > 0 ? 2200 : mCnt >= 2 ? 1650 : 950);
        score += siegeBonus;
      }
      // Bayesian Prior Siege Guidance & Joker-Trap Caution:
      for (let j = 0; j < opStackCount; j++) {
        const oSq = evalOpSq[j];
        const d = CHEB_DIST[mSq * 49 + oSq];
        if (d <= 3) {
          const pAce = board.acePrior[oSq];
          if (pAce >= 38 && oSq !== opAceSq0 && oSq !== opAceSq1) {
            score += (((4 - d) * (mCnt >= 2 ? 950 : 480) * pAce) / 100) | 0;
          }
          const pJkr = board.jokerPrior[oSq];
          if (d === 1 && pJkr >= 42 && mJokers === 0 && mCnt >= 2 && opMovesFirst) {
            score -= ((2800 * pJkr) / 100) | 0;
          }
        }
      }
    }
  }

  // 4. Phase 5 HalfKA Ace-Relative Mating-Net & Escape-Square Geometry
  // (a) Constricting enemy Aces (escape square denial, multi-angle pincers & geodesic corridor clearance)
  for (let aIdx = 0; aIdx < 2; aIdx++) {
    const targetAceSq = aIdx === 0 ? opAceSq0 : opAceSq1;
    if (targetAceSq === -1) continue;

    let pincerAttackers = 0;
    let pincerAt1 = 0;
    let pincerWithin2 = 0;
    let insideTrackCutoffs = 0;
    let quadrantMask = 0;
    const ax = (targetAceSq / 7) | 0;
    const ay = targetAceSq % 7;
    const opCenterDist = Math.max(Math.abs(ax - 3), Math.abs(ay - 3));
    const targetAceIsLone = board.counts[targetAceSq] === 1;

    for (let i = 0; i < myStackCount; i++) {
      if (evalMyCondemned[i] === 1) continue;
      const mSq = evalMySq[i];
      const d = CHEB_DIST[mSq * 49 + targetAceSq];
      if (
        d <= 4 &&
        (evalMyCnt[i] >= 2 ||
          evalMyJokers[i] > 0 ||
          evalMySum[i] >= 12 ||
          (evalMyAces[i] > 0 && myAcesTotal >= 2))
      ) {
        pincerAttackers++;
        if (d === 1) pincerAt1++;
        if (d <= 2) pincerWithin2++;
        const mx = (mSq / 7) | 0;
        const my = mSq % 7;
        const myCenterDist = Math.max(Math.abs(mx - 3), Math.abs(my - 3));
        if (d <= 3 && myCenterDist <= opCenterDist && opCenterDist >= 2) {
          insideTrackCutoffs++;
        }
        const qBit = (mx < ax ? 1 : mx > ax ? 2 : 4) | (my < ay ? 8 : my > ay ? 16 : 32);
        quadrantMask |= qBit;
      }
    }

    // Count safe 1-step escape squares around targetAceSq
    const nCnt = NEIGHBOR_COUNTS[targetAceSq];
    const nBase = targetAceSq * 8;
    let safeEscapes = 0;
    for (let n = 0; n < nCnt; n++) {
      const escSq = NEIGHBORS[nBase + n];
      if (board.factionCounts[(escSq << 1) + opFaction] >= 4) continue;
      let controlledByUs = false;
      for (let i = 0; i < myStackCount; i++) {
        if (evalMyCondemned[i] === 1) continue;
        if (
          CHEB_DIST[evalMySq[i] * 49 + escSq] <= 2 &&
          (evalMySum[i] >= 10 ||
            (evalMyAces[i] > 0 && myAcesTotal >= 2) ||
            (evalMyJokers[i] > 0 && targetAceIsLone))
        ) {
          controlledByUs = true;
          break;
        }
      }
      if (!controlledByUs) safeEscapes++;
    }

    const endgameMult = opAcesTotal === 1 ? 1.85 : 1.0;
    if (insideTrackCutoffs > 0) {
      score += Math.round(insideTrackCutoffs * opCenterDist * 850 * endgameMult);
    }
    if (pincerAttackers >= 2) {
      // Multi-stack pincer around enemy Ace (opposite flanks OR orthogonal L-shaped cutoff)!
      const oppositeFlank = (quadrantMask & 3) === 3 || (quadrantMask & 24) === 24;
      const orthogonalL = (quadrantMask & 3) !== 0 && (quadrantMask & 24) !== 0;
      const multiAngle = oppositeFlank ? 1.4 : orthogonalL ? 1.25 : 1.0;
      score += Math.round(pincerAttackers * 4800 * endgameMult * multiAngle);
      // 3-Move Budget Pincer Closure (d1 = 1, d2 <= 2 -> d1 + d2 <= 3):
      if (pincerAt1 >= 1 && pincerWithin2 >= 2) {
        score += Math.round(3200 * endgameMult);
      } else if (pincerWithin2 >= 2) {
        score += Math.round(1600 * endgameMult);
      }
    }
    if (safeEscapes <= 2) {
      score += Math.round((3 - safeEscapes) * 6500 * endgameMult);
    }
    // Pursuit-Evasion Corner Kinematics: driving an enemy Ace into a 3-neighbor corner or edge with a siege attacker
    if (pincerAttackers >= 1) {
      const isCorner = (ax === 0 || ax === 6) && (ay === 0 || ay === 6);
      const isEdge = ax === 0 || ax === 6 || ay === 0 || ay === 6;
      if (isCorner) score += Math.round(8500 * endgameMult);
      else if (isEdge && safeEscapes <= 3) score += Math.round(3800 * endgameMult);
    }
  }

  // (b) Protecting our own Aces from mating nets (escape mobility, corner avoidance & geodesic ray interposition)
  for (let aIdx = 0; aIdx < 2; aIdx++) {
    const myAceSq = aIdx === 0 ? myAceSq0 : myAceSq1;
    if (myAceSq === -1) continue;

    let enemySiegeStacks = 0;
    let enemyAt1 = 0;
    let enemyWithin2 = 0;
    const myAceIsLone = board.counts[myAceSq] === 1;
    for (let j = 0; j < opStackCount; j++) {
      const oSq = evalOpSq[j];
      const d = CHEB_DIST[oSq * 49 + myAceSq];
      if (d <= 4) {
        enemySiegeStacks++;
        if (d === 1) enemyAt1++;
        if (d <= 2) enemyWithin2++;
      }
    }
    if (enemySiegeStacks > 0) {
      const nCnt = NEIGHBOR_COUNTS[myAceSq];
      const nBase = myAceSq * 8;
      let mySafeEscapes = 0;
      for (let n = 0; n < nCnt; n++) {
        const escSq = NEIGHBORS[nBase + n];
        if (board.factionCounts[(escSq << 1) + perspectiveFaction] >= 4) continue;
        let controlledByOp = false;
        for (let j = 0; j < opStackCount; j++) {
          if (
            CHEB_DIST[evalOpSq[j] * 49 + escSq] <= 2 &&
            (evalOpSum[j] >= 10 || evalOpAces[j] > 0 || (evalOpJokers[j] > 0 && myAceIsLone))
          ) {
            controlledByOp = true;
            break;
          }
        }
        if (!controlledByOp) mySafeEscapes++;
      }
      const myEndgameMult = myAcesTotal === 1 ? 1.85 : 1.0;
      if (mySafeEscapes <= 2) {
        score -= Math.round((3 - mySafeEscapes) * 6800 * myEndgameMult);
      }
      if (enemySiegeStacks >= 2) {
        score -= Math.round(enemySiegeStacks * 4200 * myEndgameMult);
        if (enemyAt1 >= 1 && enemyWithin2 >= 2) {
          score -= Math.round(3200 * myEndgameMult);
        } else if (enemyWithin2 >= 2) {
          score -= Math.round(1600 * myEndgameMult);
        }
      }
      // Corner-Trap Avoidance Kinematics: never back a pursued Ace into a 3-neighbor corner!
      const mx = (myAceSq / 7) | 0;
      const my = myAceSq % 7;
      const isCorner = (mx === 0 || mx === 6) && (my === 0 || my === 6);
      const isEdge = mx === 0 || mx === 6 || my === 0 || my === 6;
      if (isCorner) score -= Math.round(9200 * myEndgameMult);
      else if (isEdge && mySafeEscapes <= 3) score -= Math.round(4200 * myEndgameMult);
    }
  }

  // 5. Endgame Tablebase Laws (Hunter Ace Liquidation, Immortal Joker Bulldozer & Stack Opposition)
  let totalMyJokers = 0;
  let totalOpJokers = 0;
  for (let i = 0; i < myStackCount; i++) totalMyJokers += evalMyJokers[i];
  for (let j = 0; j < opStackCount; j++) totalOpJokers += evalOpJokers[j];

  // (a) Rule E3: 2-Aces vs 1-Ace Liquidation Hunter Ace Activation
  if (myAcesTotal === 2 && opAcesTotal === 1 && opAceSq0 !== -1) {
    const dA0 = myAceSq0 !== -1 ? CHEB_DIST[myAceSq0 * 49 + opAceSq0] : 99;
    const dA1 = myAceSq1 !== -1 ? CHEB_DIST[myAceSq1 * 49 + opAceSq0] : 99;
    const minHunterDist = dA0 < dA1 ? dA0 : dA1;
    if (minHunterDist <= 4) {
      score += (5 - minHunterDist) * 2800;
    }
  } else if (opAcesTotal === 2 && myAcesTotal === 1 && myAceSq0 !== -1) {
    const dA0 = opAceSq0 !== -1 ? CHEB_DIST[opAceSq0 * 49 + myAceSq0] : 99;
    const dA1 = opAceSq1 !== -1 ? CHEB_DIST[opAceSq1 * 49 + myAceSq0] : 99;
    const minHunterDist = dA0 < dA1 ? dA0 : dA1;
    if (minHunterDist <= 4) {
      score -= (5 - minHunterDist) * 2800;
    }
  }

  // (b) Rule E5 & E7: Immortal Joker Phalanx & Direct 2-Card Stack Opposition (d === 2 Zugzwang)
  for (let i = 0; i < myStackCount; i++) {
    if (evalMyCondemned[i] === 1 || evalMyAces[i] > 0) continue;
    const mSq = evalMySq[i];
    const mCnt = evalMyCnt[i];
    const mSum = evalMySum[i];
    const mJokers = evalMyJokers[i];

    // If opponent has NO Joker left on board, our Joker+Court stack is immortal against all non-Ace stacks!
    if (mJokers > 0 && mCnt >= 2 && mSum >= 13 && totalOpJokers === 0 && board.drawCount[opFaction] === 0) {
      score += 6800;
    }

    if (mCnt >= 2) {
      for (let j = 0; j < opStackCount; j++) {
        if (evalOpCnt[j] < 2) continue;
        const oSq = evalOpSq[j];
        const d = CHEB_DIST[mSq * 49 + oSq];
        if (d === 2) {
          // Chebyshev d=2 between 2-card stacks: whoever just finished their turn holds Direct Opposition!
          if (mSum > evalOpSum[j] || (mJokers > 0 && evalOpJokers[j] === 0)) {
            score += opMovesFirst ? 2600 : -1200;
          }
        }
      }
    }
  }

  return score;
}

// ----------------------------------------------------------------------------
// 6. TURN-BOUNDARY QUIESCENCE SEARCH (PHASE 4: `qsearch`)
// Resolves tactical combat sequences at the end of a turn so the engine never
// stops evaluating in the middle of a capture exchange or lethal Ace check!
// ----------------------------------------------------------------------------

const MAX_Q_PLIES = 6; // Up to 2 full tactical turns (6 micro-moves) beyond horizon

function generateTacticalMicroMoves(board: FlatBoard, ply: number): number {
  const myFaction = board.mover;
  const opFaction = 1 - myFaction;
  const listBase = ply * 128;
  let count = 0;

  // Locate enemy Aces and our Aces (including whether our Aces are currently under threat!)
  let opAceSq0 = -1;
  let opAceSq1 = -1;
  let myAceSq0 = -1;
  let myAceSq1 = -1;
  for (let sq = 0; sq < 49; sq++) {
    const len = board.counts[sq];
    if (len === 0) continue;
    const base = sq << 3;
    for (let i = 0; i < len; i++) {
      const c = board.cells[base + i];
      if ((c & RANK_MASK) === 1) {
        if (((c >> OWNER_SHIFT) & 1) === opFaction) {
          if (opAceSq0 === -1) opAceSq0 = sq;
          else opAceSq1 = sq;
        } else {
          if (myAceSq0 === -1) myAceSq0 = sq;
          else myAceSq1 = sq;
        }
      }
    }
  }

  let myAceInDanger0 = false;
  let myAceInDanger1 = false;
  if (myAceSq0 !== -1 || myAceSq1 !== -1) {
    for (let eSq = 0; eSq < 49; eSq++) {
      if (board.factionCounts[(eSq << 1) + opFaction] === 0) continue;
      if (myAceSq0 !== -1 && CHEB_DIST[eSq * 49 + myAceSq0] <= 3) myAceInDanger0 = true;
      if (myAceSq1 !== -1 && CHEB_DIST[eSq * 49 + myAceSq1] <= 3) myAceInDanger1 = true;
    }
  }

  for (let sq = 0; sq < 49; sq++) {
    if (board.factionCounts[(sq << 1) + myFaction] === 0) continue;
    const base = sq << 3;
    const len = board.counts[sq];
    let seenRanksMask = 0;

    for (let slot = 0; slot < len; slot++) {
      const c = board.cells[base + slot];
      if (((c >> OWNER_SHIFT) & 1) !== myFaction) continue;
      if ((c & LOCKED_BIT) !== 0) continue;
      const r = c & RANK_MASK;
      const rBit = 1 << r;
      if ((seenRanksMask & rBit) !== 0) continue;
      seenRanksMask |= rBit;

      const nCnt = NEIGHBOR_COUNTS[sq];
      const nBase = sq * 8;
      for (let n = 0; n < nCnt; n++) {
        const toSq = NEIGHBORS[nBase + n];
        const myDestCnt = board.factionCounts[(toSq << 1) + myFaction];
        if (myDestCnt >= 4) continue;
        if (ply <= 2 && board.camouflagedHomeAce[toSq] === 1) continue;
        const opDestCnt = board.factionCounts[(toSq << 1) + opFaction];

        const distToAce0 = opAceSq0 !== -1 ? CHEB_DIST[toSq * 49 + opAceSq0] : 99;
        const distToAce1 = opAceSq1 !== -1 ? CHEB_DIST[toSq * 49 + opAceSq1] : 99;
        const minAceDist = distToAce0 < distToAce1 ? distToAce0 : distToAce1;
        const prevDist0 = opAceSq0 !== -1 ? CHEB_DIST[sq * 49 + opAceSq0] : 99;
        const prevDist1 = opAceSq1 !== -1 ? CHEB_DIST[sq * 49 + opAceSq1] : 99;
        const minPrevDist = prevDist0 < prevDist1 ? prevDist0 : prevDist1;

        // Include move in Quiescence if:
        // 1. It steps directly onto an enemy square (combat capture, except suicidal lone Joker), OR
        // 2. When movesRemaining > 1, it steps closer to an enemy Ace (d <= movesRemaining - 1, including offensive Ace!), OR
        // 3. One of our Aces is in danger and this move evades or armors the threatened Ace!
        let isTactical = false;
        let sc = 0;

        if (opDestCnt > 0) {
          if (r === 0 && minAceDist !== 0 && myDestCnt === 0) {
            // Skip suicidal lone Joker attacks on non-Ace squares in qsearch
            isTactical = false;
          } else {
            isTactical = true;
            sc = 2200000 + opDestCnt * 60000 + (minAceDist === 0 ? 3500000 : 0);
          }
        } else if (
          board.movesRemaining > 1 &&
          minAceDist < minPrevDist &&
          minAceDist <= board.movesRemaining - 1
        ) {
          isTactical = true;
          sc = 1100000 + (3 - minAceDist) * 180000;
        } else if (
          (r === 1 && ((sq === myAceSq0 && myAceInDanger0) || (sq === myAceSq1 && myAceInDanger1))) ||
          (r !== 1 && ((toSq === myAceSq0 && myAceInDanger0) || (toSq === myAceSq1 && myAceInDanger1)))
        ) {
          // Emergency Ace Evasion or Armor in Quiescence Search!
          isTactical = true;
          sc = 1350000 + (myDestCnt > 0 ? 150000 : 0);
        } else if (board.movesRemaining > 1) {
          // Check if adjacent to an enemy square so next micro-move in the same turn can strike
          const n2Cnt = NEIGHBOR_COUNTS[toSq];
          const n2Base = toSq * 8;
          for (let k = 0; k < n2Cnt; k++) {
            const adjSq = NEIGHBORS[n2Base + k];
            if (board.factionCounts[(adjSq << 1) + opFaction] > 0) {
              isTactical = true;
              sc = 550000;
              break;
            }
          }
        }

        if (isTactical) {
          plyMoveList[listBase + count] = encodeMicroMove(sq, toSq, r);
          plyMoveScores[listBase + count] = sc;
          count++;
        }
      }
    }
  }

  plyMoveCount[ply] = count;
  return count;
}

// ----------------------------------------------------------------------------
// 7. ITERATIVE DEEPENING PRINCIPAL VARIATION SEARCH (PHASE 3: `pvs`)
// ----------------------------------------------------------------------------

let searchNodes = 0;
let searchTTHits = 0;
let searchDeadlineMs = 0;
let searchMaxNodes = 3600;
let searchAborted = false;

export interface StockfishSearchTelemetry {
  nodesSearched: number;
  ttHits: number;
  ttHitRate: number;
  depthReached: number;
  worldsEvaluated: number;
  mateDetected: 'NONE' | 'MATE_IN_1' | 'MATE_IN_2' | 'EVASION_SAVED';
  timeSpentMs: number;
}

export const lastStockfishTelemetry: StockfishSearchTelemetry = {
  nodesSearched: 0,
  ttHits: 0,
  ttHitRate: 0,
  depthReached: 0,
  worldsEvaluated: 0,
  mateDetected: 'NONE',
  timeSpentMs: 0,
};

function qsearch(board: FlatBoard, alpha: number, beta: number, treePly: number, qPly: number): number {
  searchNodes++;
  if (searchNodes >= searchMaxNodes) {
    searchAborted = true;
    return 0;
  }

  const myFaction = board.mover;
  const opFaction = 1 - myFaction;

  if (board.aceCounts[myFaction] === 0) return -900000 + treePly;
  if (board.aceCounts[opFaction] === 0) return 900000 - treePly;

  // At a turn boundary (movesRemaining === 3), compute stand-pat score
  if (board.movesRemaining === 3) {
    const standPat = evaluateFlatBoard(board, myFaction);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;
    if (qPly >= MAX_Q_PLIES || treePly >= MAX_PLY - 2) {
      return standPat;
    }
  } else if (treePly >= MAX_PLY - 2) {
    return evaluateFlatBoard(board, myFaction);
  }

  const numMoves = generateTacticalMicroMoves(board, treePly);
  if (numMoves === 0) {
    // If mid-turn in qsearch and no further tactical micro-moves, resolve turn end and evaluate
    if (board.movesRemaining < 3) {
      board.makeStep(PASS_MOVE_BIT, treePly);
      const sc = -qsearch(board, -beta, -alpha, treePly + 1, qPly + 1);
      board.unmakeStep(treePly);
      return sc > alpha ? sc : alpha;
    }
    return alpha;
  }

  const maxBranch = Math.min(numMoves, board.movesRemaining === 3 ? 6 : 5);
  for (let i = 0; i < maxBranch; i++) {
    const mv = pickNextBestMove(treePly, i, numMoves);
    const endsTurn = board.movesRemaining === 1 || (mv & SPAWN_MOVE_BIT) !== 0;

    board.makeStep(mv, treePly);
    let score: number;
    if (endsTurn) {
      score = -qsearch(board, -beta, -alpha, treePly + 1, qPly + 1);
    } else {
      score = qsearch(board, alpha, beta, treePly + 1, qPly + 1);
    }
    board.unmakeStep(treePly);

    if (searchAborted) return 0;
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }

  return alpha;
}

export function pvs(
  board: FlatBoard,
  plyRemaining: number,
  alpha: number,
  beta: number,
  treePly: number,
  prevMove: number
): number {
  searchNodes++;
  if (searchNodes >= searchMaxNodes) {
    searchAborted = true;
    return 0;
  }

  const myFaction = board.mover;
  const opFaction = 1 - myFaction;

  // Immediate terminal check at turn boundary
  if (board.movesRemaining === 3) {
    if (board.aceCounts[myFaction] === 0) return -900000 + treePly;
    if (board.aceCounts[opFaction] === 0) return 900000 - treePly;
  }

  // At a clean turn boundary (`board.movesRemaining === 3`) once `plyRemaining <= 0`,
  // all contested squares have already resolved combat and `evaluateFlatBoard` computes
  // exact 3-step obstacle-aware Knapsack reachability (`minStepsObstacleAware`).
  if ((plyRemaining <= 0 && board.movesRemaining === 3) || treePly >= MAX_PLY - 4) {
    return evaluateFlatBoard(board, myFaction);
  }

  // 1. Probe Lockless 64-Bit Zobrist Transposition Table
  const ttIdx = (board.hashLo ^ board.hashHi) & TT_MASK;
  const isTTHit =
    ttFlag[ttIdx] !== TT_FLAG_NONE &&
    ttHashLo[ttIdx] === board.hashLo &&
    ttHashHi[ttIdx] === board.hashHi;

  let ttMove = 0;
  if (isTTHit) {
    searchTTHits++;
    ttMove = ttBestMove[ttIdx];
    if (ttDepth[ttIdx] >= plyRemaining && treePly > 0) {
      const storedScore = ttScore[ttIdx];
      const flag = ttFlag[ttIdx];
      if (flag === TT_FLAG_EXACT) return storedScore;
      if (flag === TT_FLAG_LOWER && storedScore >= beta) return storedScore;
      if (flag === TT_FLAG_UPPER && storedScore <= alpha) return storedScore;
    }
  }

  const origAlpha = alpha;
  const numMoves = generateFlatMoves(board, treePly, ttMove, prevMove);
  if (numMoves === 0) {
    board.makeStep(PASS_MOVE_BIT, treePly);
    const sc = -pvs(board, plyRemaining - 1, -beta, -alpha, treePly + 1, 0);
    board.unmakeStep(treePly);
    return sc;
  }

  let bestScore = -1000000;
  let bestMove = plyMoveList[treePly * 128];

  // Taper micro-move width by turn step and tree depth so Iterative Deepening easily reaches Depth 6-9 (2-3 full turns!)
  const maxMovesToSearch =
    treePly === 0
      ? Math.min(numMoves, 22)
      : treePly <= 2
      ? Math.min(numMoves, board.movesRemaining === 1 ? 10 : 12)
      : Math.min(numMoves, board.movesRemaining === 1 ? 7 : 9);

  for (let i = 0; i < maxMovesToSearch; i++) {
    const mv = pickNextBestMove(treePly, i, numMoves);
    const isSpawn = (mv & SPAWN_MOVE_BIT) !== 0;
    const endsTurn = board.movesRemaining === 1 || isSpawn;
    const stepCost = isSpawn ? Math.min(plyRemaining, 3) : 1;
    let nextPlyRem = plyRemaining - stepCost;

    const opAcesBefore = board.aceCounts[opFaction];
    board.makeStep(mv, treePly);

    // Phase 3 Singular Check & Ace-Kill Extension:
    // If a turn ends by killing 1 of the opponent's 2 Aces OR placing an attacker at d=1 of an opponent Ace,
    // extend search depth and forbid Late Move Reductions!
    let isForcingCheckOrAceKill = false;
    if (endsTurn && !isSpawn && board.aceCounts[myFaction] > 0 && board.aceCounts[opFaction] > 0) {
      if (board.aceCounts[opFaction] < opAcesBefore) {
        isForcingCheckOrAceKill = true;
      } else {
        const toSq = (mv >> MOVE_TO_SHIFT) & MOVE_TO_MASK;
        const nCnt = NEIGHBOR_COUNTS[toSq];
        const nBase = toSq * 8;
        for (let n = 0; n < nCnt; n++) {
          const adjSq = NEIGHBORS[nBase + n];
          const adjLen = board.counts[adjSq];
          if (adjLen === 0) continue;
          const adjBase = adjSq << 3;
          for (let k = 0; k < adjLen; k++) {
            const c = board.cells[adjBase + k];
            if (((c >> OWNER_SHIFT) & 1) === opFaction && (c & RANK_MASK) === 1) {
              isForcingCheckOrAceKill = true;
              break;
            }
          }
          if (isForcingCheckOrAceKill) break;
        }
      }
      if (isForcingCheckOrAceKill && treePly <= 6 && nextPlyRem === 0) {
        nextPlyRem += 3;
      }
    }

    let score: number;
    if (endsTurn) {
      // Crosses turn boundary into opponent's turn (Negamax sign flip!)
      if (i === 0) {
        score = -pvs(board, nextPlyRem, -beta, -alpha, treePly + 1, 0);
      } else {
        // Late Move Reduction (LMR) in full 3-step turn increments for quiet late moves
        let reduction = 0;
        if (!isForcingCheckOrAceKill && i >= 3 && nextPlyRem >= 3) {
          reduction = 3;
        }
        // Null-window PVS scout search
        score = -pvs(board, nextPlyRem - reduction, -alpha - 1, -alpha, treePly + 1, 0);
        if (score > alpha && (score < beta || reduction > 0)) {
          score = -pvs(board, nextPlyRem, -beta, -alpha, treePly + 1, 0);
        }
      }
    } else {
      // Intra-turn micro-move: same mover continues! Use PVS null-window scout after first move
      if (i === 0) {
        score = pvs(board, nextPlyRem, alpha, beta, treePly + 1, mv);
      } else {
        let intraRed = 0;
        if (i >= 4 && nextPlyRem >= 4) {
          intraRed = 3;
        }
        score = pvs(board, nextPlyRem - intraRed, alpha, alpha + 1, treePly + 1, mv);
        if (score > alpha && (score < beta || intraRed > 0)) {
          score = pvs(board, nextPlyRem, alpha, beta, treePly + 1, mv);
        }
      }
    }

    board.unmakeStep(treePly);

    if (searchAborted) {
      // If aborted at root after completing at least 1 full root move (`i >= 1`), return the best score found so far!
      return treePly === 0 && bestScore > -999999 ? bestScore : 0;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMove = mv;
      if (score > alpha) {
        alpha = score;
        if (alpha >= beta) {
          // Beta cutoff! Update Killer, Countermove, and History tables
          if (!isSpawn) {
            const toSq = (mv >> MOVE_TO_SHIFT) & MOVE_TO_MASK;
            if (board.factionCounts[(toSq << 1) + opFaction] === 0) {
              if (killerMoves[treePly * 2] !== mv) {
                killerMoves[treePly * 2 + 1] = killerMoves[treePly * 2];
                killerMoves[treePly * 2] = mv;
              }
              const fromSq = mv & MOVE_FROM_MASK;
              historyTable[myFaction * 2401 + fromSq * 49 + toSq] +=
                (plyRemaining + 1) * (plyRemaining + 1) * 64;
              if (prevMove > 0 && (prevMove & SPAWN_MOVE_BIT) === 0) {
                counterMoves[(myFaction << 12) | (prevMove & 0xfff)] = mv;
              }
            }
          }
          break;
        }
      }
    }
  }

  // Store result in Transposition Table
  const prevGen = ttGeneration[ttIdx];
  if (
    ttFlag[ttIdx] === TT_FLAG_NONE ||
    prevGen !== currentSearchGen ||
    plyRemaining >= ttDepth[ttIdx] - 1
  ) {
    ttHashLo[ttIdx] = board.hashLo;
    ttHashHi[ttIdx] = board.hashHi;
    ttScore[ttIdx] = bestScore;
    ttDepth[ttIdx] = plyRemaining;
    ttBestMove[ttIdx] = bestMove;
    ttGeneration[ttIdx] = currentSearchGen;
    if (bestScore <= origAlpha) {
      ttFlag[ttIdx] = TT_FLAG_UPPER;
    } else if (bestScore >= beta) {
      ttFlag[ttIdx] = TT_FLAG_LOWER;
    } else {
      ttFlag[ttIdx] = TT_FLAG_EXACT;
    }
  }

  return bestScore;
}

// ----------------------------------------------------------------------------
// 8. ITERATIVE DEEPENING ROOT CONTROLLER & TURN VERIFIER
// ----------------------------------------------------------------------------

const sharedRootBoard = new FlatBoard();

export interface StockfishTurnVerifyResult {
  score: number;
  bestReplyMoves: number[];
  nodesSearched: number;
  depthReached: number;
}

export function advanceStockfishSearchGeneration(): void {
  currentSearchGen = (currentSearchGen + 1) & 0xff;
  if (currentSearchGen === 0) currentSearchGen = 1;
  resetSearchHeuristics();
  lastStockfishTelemetry.nodesSearched = 0;
  lastStockfishTelemetry.ttHits = 0;
  lastStockfishTelemetry.ttHitRate = 0;
  lastStockfishTelemetry.depthReached = 0;
  lastStockfishTelemetry.worldsEvaluated = 0;
  lastStockfishTelemetry.mateDetected = 'NONE';
  lastStockfishTelemetry.timeSpentMs = 0;
}

export interface SimCardLike {
  owner: number;
  rank: number;
  revealed: boolean;
  locked: boolean;
}

export function runStockfishPVSOnPostTurnBoard(
  postMyBoard: SimCardLike[][],
  myFaction: number,
  myDraw: number,
  opDraw: number,
  turnNumber: number,
  timeBudgetMs: number = 22,
  maxMicroMoveDepth: number = 6,
  myDrawRanks?: number[],
  opDrawRanks?: number[],
  opAceProb?: Float32Array,
  opJokerProb?: Float32Array
): { opScore: number; nodes: number; depthReached: number } {
  const opFaction = 1 - myFaction;
  const b = sharedRootBoard;
  b.reset();

  if (opAceProb) {
    for (let sq = 0; sq < 49; sq++) {
      b.acePrior[sq] = Math.min(100, Math.round(opAceProb[sq] * 100));
    }
  }
  if (opJokerProb) {
    for (let sq = 0; sq < 49; sq++) {
      b.jokerPrior[sq] = Math.min(100, Math.round(opJokerProb[sq] * 100));
    }
  }

  for (let sq = 0; sq < 49; sq++) {
    const tile = postMyBoard[sq];
    const len = Math.min(8, tile.length);
    if (len === 0) continue;
    const base = sq << 3;
    let f0 = 0;
    let f1 = 0;
    for (let i = 0; i < len; i++) {
      const c = tile[i];
      const r = c.rank >= 0 ? c.rank & 0x0f : 11;
      const owner = c.owner & 1;
      let cardByte = r | (owner << OWNER_SHIFT);
      if (c.revealed) cardByte |= REVEALED_BIT;
      if (c.locked) cardByte |= LOCKED_BIT;
      b.cells[base + i] = cardByte;
      if (owner === 0) f0++;
      else f1++;
      if (r === 1) b.aceCounts[owner]++;
    }
    b.counts[sq] = len;
    b.factionCounts[sq << 1] = f0;
    b.factionCounts[(sq << 1) + 1] = f1;
  }

  if (b.aceCounts[myFaction] === 0) {
    return { opScore: 900000, nodes: 1, depthReached: 0 };
  }
  if (b.aceCounts[opFaction] === 0) {
    return { opScore: -900000, nodes: 1, depthReached: 0 };
  }

  // Mark unrevealed 1-card home-row Aces of `myFaction` that have no enemy within d<=2 and are camouflaged among >=2 unrevealed home singles
  if (b.aceCounts[myFaction] >= 2) {
    let unrevHomeSingles = 0;
    for (let sq = 0; sq < 49; sq++) {
      const y = sq % 7;
      const myDepth = myFaction === 0 ? y : 6 - y;
      if (myDepth <= 1 && b.counts[sq] === 1 && b.factionCounts[(sq << 1) + myFaction] === 1) {
        if ((b.cells[sq << 3] & REVEALED_BIT) === 0) {
          unrevHomeSingles++;
        }
      }
    }
    if (unrevHomeSingles >= 2) {
      for (let sq = 0; sq < 49; sq++) {
        const y = sq % 7;
        const myDepth = myFaction === 0 ? y : 6 - y;
        if (myDepth === 0 && b.counts[sq] === 1 && b.factionCounts[(sq << 1) + myFaction] === 1) {
          const cardByte = b.cells[sq << 3];
          if ((cardByte & REVEALED_BIT) === 0 && (cardByte & RANK_MASK) === 1) {
            let enemyWithin2 = false;
            for (let eSq = 0; eSq < 49; eSq++) {
              if (b.factionCounts[(eSq << 1) + opFaction] > 0 && CHEB_DIST[eSq * 49 + sq] <= 2) {
                enemyWithin2 = true;
                break;
              }
            }
            if (!enemyWithin2) {
              b.camouflagedHomeAce[sq] = 1;
            }
          }
        }
      }
    }
  }

  b.drawCount[myFaction] = Math.max(0, Math.min(6, myDraw));
  b.drawCount[opFaction] = Math.max(0, Math.min(6, opDraw));

  const defaultDrawRanks = [11, 11, 10, 10, 9, 9];
  for (let i = 0; i < 6; i++) {
    const myR = myDrawRanks && myDrawRanks[i] !== undefined ? myDrawRanks[i] : defaultDrawRanks[i];
    const opR = opDrawRanks && opDrawRanks[i] !== undefined ? opDrawRanks[i] : defaultDrawRanks[i];
    b.drawPile[(myFaction << 3) + i] = (myR & 0x0f) | (myFaction << OWNER_SHIFT);
    b.drawPile[(opFaction << 3) + i] = (opR & 0x0f) | (opFaction << OWNER_SHIFT);
  }

  b.mover = opFaction;
  b.movesRemaining = 3;
  b.turnNumber = turnNumber;
  b.recomputeFullHash();

  searchNodes = 0;
  searchTTHits = 0;
  searchAborted = false;
  const startMs = Date.now();
  searchDeadlineMs = startMs + timeBudgetMs;
  searchMaxNodes = Math.max(1800, timeBudgetMs * 180);

  let bestOpScore = evaluateFlatBoard(b, opFaction);
  let depthReached = 0;

  for (let depth = 3; depth <= maxMicroMoveDepth; depth += 3) {
    const alpha = depth > 3 ? bestOpScore - 45000 : -950000;
    const beta = depth > 3 ? bestOpScore + 45000 : 950000;

    let sc = pvs(b, depth, alpha, beta, 0, 0);
    if (!searchAborted && (sc <= alpha || sc >= beta)) {
      sc = pvs(b, depth, -950000, 950000, 0, 0);
    }
    if (searchAborted) {
      if (sc > bestOpScore && sc <= 950000) {
        bestOpScore = sc;
      }
      break;
    }
    bestOpScore = sc;
    depthReached = depth;
    if (bestOpScore >= 850000 || bestOpScore <= -850000) {
      break;
    }
  }

  const elapsed = Date.now() - startMs;
  lastStockfishTelemetry.nodesSearched += searchNodes;
  lastStockfishTelemetry.ttHits += searchTTHits;
  lastStockfishTelemetry.ttHitRate =
    lastStockfishTelemetry.nodesSearched > 0
      ? Number((lastStockfishTelemetry.ttHits / lastStockfishTelemetry.nodesSearched).toFixed(3))
      : 0;
  if (depthReached > lastStockfishTelemetry.depthReached) {
    lastStockfishTelemetry.depthReached = depthReached;
  }
  lastStockfishTelemetry.worldsEvaluated++;
  lastStockfishTelemetry.timeSpentMs += elapsed;
  if (bestOpScore <= -850000) {
    lastStockfishTelemetry.mateDetected = 'MATE_IN_2';
  }

  const initialOpAceDiff = b.aceCounts[opFaction] - b.aceCounts[myFaction];
  const normalizedOpScore =
    Math.abs(bestOpScore) >= 750000 ? bestOpScore : bestOpScore - initialOpAceDiff * 187000;

  return { opScore: normalizedOpScore, nodes: searchNodes, depthReached };
}

// Evaluates a post-combat board state after our candidate 3-move turn using
// Iterative Deepening Alpha-Beta PVS + Transposition Table + Quiescence Search!
export function evaluateCandidateTurnWithStockfishPVS(
  postCombatCells: Uint8Array,
  postCombatCounts: Uint8Array,
  postCombatFactionCounts: Uint8Array,
  aceCounts0: number,
  aceCounts1: number,
  drawCount0: number,
  drawCount1: number,
  myFaction: number,
  turnNumber: number,
  timeBudgetMs: number = 38,
  maxMicroMoveDepth: number = 6
): number {
  const opFaction = 1 - myFaction;

  // Immediate terminal check
  if (aceCounts1 === 0 && myFaction === 0) return 900000;
  if (aceCounts0 === 0 && myFaction === 1) return 900000;
  if (aceCounts0 === 0 && myFaction === 0) return -900000;
  if (aceCounts1 === 0 && myFaction === 1) return -900000;

  const b = sharedRootBoard;
  b.cells.set(postCombatCells);
  b.counts.set(postCombatCounts);
  b.factionCounts.set(postCombatFactionCounts);
  b.aceCounts[0] = aceCounts0;
  b.aceCounts[1] = aceCounts1;
  b.drawCount[0] = drawCount0;
  b.drawCount[1] = drawCount1;

  // Populate default expected draw pile cards (King, Queen, Jack, 10, 9, 9)
  const defaultDrawRanks = [13, 12, 11, 10, 9, 9];
  for (let f = 0; f < 2; f++) {
    for (let i = 0; i < 6; i++) {
      b.drawPile[(f << 3) + i] = defaultDrawRanks[i] | (f << OWNER_SHIFT);
    }
  }

  b.mover = opFaction;
  b.movesRemaining = 3;
  b.turnNumber = turnNumber + 1;
  b.recomputeFullHash();

  currentSearchGen = (currentSearchGen + 1) & 0xff;
  if (currentSearchGen === 0) currentSearchGen = 1;

  searchNodes = 0;
  searchAborted = false;
  searchDeadlineMs = Date.now() + timeBudgetMs;

  // Iterative Deepening from Depth 3 (1 full opponent turn + qsearch)
  // up to maxMicroMoveDepth (2 full turns = opponent 3 moves + our 3 counter-moves + qsearch!)
  let bestOpScore = evaluateFlatBoard(b, opFaction);

  for (let depth = 3; depth <= maxMicroMoveDepth; depth += 3) {
    // Aspiration window around previous depth score
    let alpha = depth > 3 ? bestOpScore - 45000 : -950000;
    let beta = depth > 3 ? bestOpScore + 45000 : 950000;

    let sc = pvs(b, depth, alpha, beta, 0, 0);
    if (!searchAborted && (sc <= alpha || sc >= beta)) {
      sc = pvs(b, depth, -950000, 950000, 0, 0);
    }
    if (searchAborted) {
      break;
    }
    bestOpScore = sc;
    // Early exit if forced checkmate found
    if (bestOpScore >= 850000 || bestOpScore <= -850000) {
      break;
    }
  }

  // Return score from `myFaction`'s perspective
  return -bestOpScore;
}
