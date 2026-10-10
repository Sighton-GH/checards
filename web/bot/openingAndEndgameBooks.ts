// ============================================================================
// CHECARDS GRANDMASTER OPENING BOOK & ENDGAME TABLEBASE RULES
// ============================================================================
// Purely fair (zero hidden-information peeking) Opening Theory (Turns 1-7)
// and Exact Endgame Tablebase & Siege Solver (Reserve Depletion / Last-Ace /
// Opposition / Fortress Breakers).
// ============================================================================

import type { FactionBelief } from './smartEngine';

export interface BookSimCard {
  owner: number;
  name: string;
  rank: number; // -1 = unknown, 0 = Joker, 1 = Ace, 9..13 = 9..K
  revealed: boolean;
  locked: boolean;
}

export type OpponentOpeningArchetype =
  | 'BLITZ_RUSH'
  | 'TURTLE_FORTRESS'
  | 'FLANK_OVERLOAD_LEFT'
  | 'FLANK_OVERLOAD_RIGHT'
  | 'LONE_ASSASSIN_PROBE'
  | 'BALANCED_STANDARD';

export type GamePhaseBookMode = 'OPENING_BOOK' | 'MIDDLEGAME' | 'ENDGAME_TABLEBASE';

export interface ActiveBookTelemetry {
  phaseMode: GamePhaseBookMode;
  activeBookName: string;
  activeRuleSummary: string;
  opponentArchetype: OpponentOpeningArchetype;
  endgamePattern: string | null;
}

export const lastBookTelemetry: ActiveBookTelemetry = {
  phaseMode: 'OPENING_BOOK',
  activeBookName: 'Twin-Citadel & Royal Spearhead',
  activeRuleSummary: 'Consolidating starting court cards into 24+ pt power stacks before reserve deployment.',
  opponentArchetype: 'BALANCED_STANDARD',
  endgamePattern: null,
};

function cardPoints(rank: number): number {
  if (rank === 0 || rank === 1) return 1;
  if (rank >= 9 && rank <= 13) return rank;
  return 11;
}

// ============================================================================
// 1. OPPONENT OPENING ARCHETYPE DETECTOR (100% PUBLIC INFORMATION)
// ============================================================================

export function detectOpponentOpeningArchetype(
  board: BookSimCard[][],
  myFaction: number,
  opBelief: FactionBelief,
  opDraw: number,
  turnNumber: number
): OpponentOpeningArchetype {
  const opFaction = 1 - myFaction;
  let rushingUnits = 0;
  let loneDeepStalkers = 0;
  let backRowStacks = 0;
  let leftFlankCards = 0; // x <= 2
  let rightFlankCards = 0; // x >= 4
  let totalOpBoardCards = 0;

  for (let sq = 0; sq < 49; sq++) {
    const tile = board[sq];
    if (!tile || tile.length === 0) continue;
    let opCnt = 0;
    for (let k = 0; k < tile.length; k++) {
      if (tile[k].owner === opFaction) opCnt++;
    }
    if (opCnt === 0) continue;

    totalOpBoardCards += opCnt;
    const x = (sq / 7) | 0;
    const y = sq % 7;
    const opDepth = opFaction === 0 ? y : 6 - y;

    if (x <= 2) leftFlankCards += opCnt;
    else if (x >= 4) rightFlankCards += opCnt;

    if (opDepth >= 3) {
      rushingUnits += opCnt;
      if (opCnt === 1 && (opBelief.tileAceProb[sq] >= 0.25 || opBelief.tileJokerProb[sq] >= 0.2)) {
        loneDeepStalkers++;
      }
    }
    if (opDepth <= 1 && opCnt >= 2) {
      backRowStacks++;
    }
  }

  if (loneDeepStalkers >= 1 && rushingUnits === 1) {
    return 'LONE_ASSASSIN_PROBE';
  }
  if (rushingUnits >= 2 || (turnNumber <= 3 && rushingUnits >= 1)) {
    return 'BLITZ_RUSH';
  }
  if (backRowStacks >= 2 || (turnNumber <= 4 && opDraw <= 6 && rushingUnits === 0)) {
    return 'TURTLE_FORTRESS';
  }
  if (totalOpBoardCards >= 6 && leftFlankCards >= totalOpBoardCards - 1) {
    return 'FLANK_OVERLOAD_LEFT';
  }
  if (totalOpBoardCards >= 6 && rightFlankCards >= totalOpBoardCards - 1) {
    return 'FLANK_OVERLOAD_RIGHT';
  }
  return 'BALANCED_STANDARD';
}

// ============================================================================
// 2. GRANDMASTER OPENING BOOK EVALUATOR (TURNS 1 - 7)
// ============================================================================
// Enforces Rules O1 - O5 and Adaptive Counter-Books A - E:
// - Rule O1: Royal Spearhead Merge (pair top court cards into 24-26 pt or Joker+Court stacks on depth 1-2)
// - Rule O2: Ace Shadow Screen & Flank Separation (keep Aces on depth 0-1 separated by >= 2 files with column screens)
// - Rule O3: Back-Row Runway Clearing (vacate non-Ace singles from depth 0 on Turns 1-2 to open spawn slots)
// - Rule O4: Anti-Premature Spawn Discipline (never waste Turn 1-2 spawning before starting court cards are paired)
// - Rule O5: Adaptive Counter-Opening positioning against Blitz, Turtle, Flank-Overload, and Lone-Assassin openings
// ============================================================================

export function evaluateOpeningBookRules(
  postBoard: BookSimCard[][],
  myFaction: number,
  opBelief: FactionBelief,
  myDrawAfter: number,
  opDraw: number,
  turnNumber: number,
  wasSpawn: boolean,
  isIntermediateStep: boolean,
  condemnedSq: Uint8Array
): number {
  if (turnNumber > 7) return 0;

  const opFaction = 1 - myFaction;
  const archetype = detectOpponentOpeningArchetype(postBoard, myFaction, opBelief, opDraw, turnNumber);

  let bookScore = 0;
  const myAceSquares: number[] = [];
  const myPowerStacks: Array<{ sq: number; x: number; depth: number; pts: number; hasJoker: boolean }> = [];
  let unmergedSingleCourtCardsOnBackRow = 0;
  let unmergedSingleCourtCardsTotal = 0;
  let hasLoneUnrevealedJoker = false;
  let backRowDecoyFile = -1;
  let totalMyCards = 0;
  let totalOpCards = 0;

  const opRushingSquares: number[] = [];

  for (let sq = 0; sq < 49; sq++) {
    const tile = postBoard[sq];
    if (!tile || tile.length === 0) continue;

    const x = (sq / 7) | 0;
    const y = sq % 7;
    const myDepth = myFaction === 0 ? y : 6 - y;
    const opDepth = opFaction === 0 ? y : 6 - y;

    let myCnt = 0;
    let opCnt = 0;
    let hasMyAce = false;
    let hasMyJoker = false;
    let hasMyUnrevJoker = false;
    let myPts = 0;

    for (let k = 0; k < tile.length; k++) {
      const c = tile[k];
      if (c.owner === myFaction) {
        myCnt++;
        if (c.rank === 1) hasMyAce = true;
        else if (c.rank === 0) {
          hasMyJoker = true;
          if (!c.revealed) hasMyUnrevJoker = true;
        }
        myPts += cardPoints(c.rank);
      } else {
        opCnt++;
      }
    }

    totalMyCards += myCnt;
    totalOpCards += opCnt;

    if (opCnt > 0 && opDepth >= 3) {
      opRushingSquares.push(sq);
    }

    if (myCnt > 0 && !condemnedSq[sq]) {
      if (hasMyAce) {
        myAceSquares.push(sq);
      } else if (myCnt >= 2 && (myPts >= 20 || (hasMyJoker && myPts >= 12))) {
        myPowerStacks.push({ sq, x, depth: myDepth, pts: myPts, hasJoker: hasMyJoker });
      } else if (myCnt === 1) {
        if (hasMyUnrevJoker) {
          hasLoneUnrevealedJoker = true;
        } else {
          unmergedSingleCourtCardsTotal++;
          if (myDepth === 0) {
            unmergedSingleCourtCardsOnBackRow++;
            backRowDecoyFile = x;
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rule O1: Royal Spearhead & Twin-Citadel Stack Consolidation
  // -------------------------------------------------------------------------
  for (let i = 0; i < myPowerStacks.length; i++) {
    const st = myPowerStacks[i];
    if (st.depth >= 1 && st.depth <= 3) {
      if (st.hasJoker && st.pts >= 13) {
        bookScore += 4200; // Invincible Joker+Court opening spearhead
      } else if (st.pts >= 24) {
        bookScore += 3900; // K+Q / K+J / Q+Q power stack
      } else if (st.pts >= 21) {
        bookScore += 2600;
      }
      // Central control bonus on columns x = 2, 3, 4
      if (st.x >= 2 && st.x <= 4) {
        bookScore += 950;
      }
    }
  }

  // Reward forming 2 independent power stacks in the opening ("Twin-Citadel")
  if (myPowerStacks.length >= 2) {
    bookScore += 3400;
    const dx = Math.abs(myPowerStacks[0].x - myPowerStacks[1].x);
    if (dx >= 2 && dx <= 4) {
      // Wide two-lane coverage across the board
      bookScore += 1400;
    }
  }

  // -------------------------------------------------------------------------
  // Rule O2: Ace Shadow Screen & Citadel Geometry
  // -------------------------------------------------------------------------
  if (myAceSquares.length === 2) {
    const ax0 = (myAceSquares[0] / 7) | 0;
    const ay0 = myAceSquares[0] % 7;
    const ax1 = (myAceSquares[1] / 7) | 0;
    const ay1 = myAceSquares[1] % 7;
    const fileSep = Math.abs(ax0 - ax1);
    // Keep Aces separated by at least 2 files so a single enemy breakthrough cannot fork both Aces!
    if (fileSep >= 3) bookScore += 2100;
    else if (fileSep === 2) bookScore += 1400;
    else bookScore -= 2800;

    // Allow Aces on depth 0 or 1 in the opening so 2nd-row concealed Aces and 1-step Ace camouflage shifts
    // are never penalized relative to "Statue Aces" on depth 0!
    const d0 = myFaction === 0 ? ay0 : 6 - ay0;
    const d1 = myFaction === 0 ? ay1 : 6 - ay1;
    if (d0 <= 1) bookScore += 1100;
    if (d1 <= 1) bookScore += 1100;
  }

  for (let a = 0; a < myAceSquares.length; a++) {
    const aSq = myAceSquares[a];
    const ax = (aSq / 7) | 0;
    const ay = aSq % 7;
    const aDepth = myFaction === 0 ? ay : 6 - ay;
    const aTile = postBoard[aSq];
    let aceArmored = false;
    let aceArmorPts = 0;
    for (let k = 0; k < aTile.length; k++) {
      if (aTile[k].owner === myFaction) {
        aceArmorPts += cardPoints(aTile[k].rank);
        if (aTile[k].rank !== 1) aceArmored = true;
      }
    }

    // Check if there is a friendly non-Ace screening stack in front of this Ace (depth 1-2, |x - ax| <= 1)
    let hasColumnScreen = false;
    for (let s = 0; s < myPowerStacks.length; s++) {
      const st = myPowerStacks[s];
      if (st.depth >= aDepth + 1 && st.depth <= aDepth + 2 && Math.abs(st.x - ax) <= 1) {
        hasColumnScreen = true;
        break;
      }
    }

    if (aceArmored && aceArmorPts >= 12 && opRushingSquares.length > 0) {
      bookScore += 2200;
    } else if (aceArmored && opRushingSquares.length === 0 && turnNumber <= 4) {
      // Keep starting Kings/Queens in active 2-card power stacks on depth 1-2 instead of tying them up on unthreatened back-row Aces!
      bookScore -= 1800;
    }
    if (hasColumnScreen) {
      bookScore += 2800;
    }
  }

  // -------------------------------------------------------------------------
  // Rule O3 & O4: Deceptive Back-Row Decoy Anchor & Spawn Tempo Discipline
  // -------------------------------------------------------------------------
  if (!isIntermediateStep) {
    // Disguised Joker Law: Never leave an unrevealed Joker wandering alone as a 1-card tell in the opening!
    // Merge it on Turn 1 into a 2-card [Court, Jkr*] stack so it looks identical to a normal [K, Q] stack!
    if (hasLoneUnrevealedJoker) {
      bookScore -= 5800;
    }

    const preSpawnBackRowSingles = wasSpawn
      ? Math.max(0, unmergedSingleCourtCardsOnBackRow - 1)
      : unmergedSingleCourtCardsOnBackRow;
    // Phase 1 Anti-"Statue Ace" Tell:
    // Allow 1 Stationary Back-Row Decoy Anchor (`preSpawnBackRowSingles === 1`) on depth 0 during Turns 1-5
    // so the opponent sees 3 stationary back-row cards (or 2 back-row cards when 1 Ace is on row 1) and cannot
    // deduce which squares hold our Aces! Only penalize excess singles above 1 (`preSpawnBackRowSingles >= 2`).
    if (preSpawnBackRowSingles === 1 && turnNumber <= 5 && backRowDecoyFile >= 0) {
      bookScore += 1650;
    } else if (preSpawnBackRowSingles >= 2) {
      bookScore -= (preSpawnBackRowSingles - 1) * 1450;
    }

    if (wasSpawn) {
      if (turnNumber <= 2 && myPowerStacks.length < 2) {
        // Strict Opening Book Law: On Turns 1-2, consolidate starting pieces into 2-card stacks BEFORE spawning!
        bookScore -= 6500;
      } else if (preSpawnBackRowSingles >= 2 || unmergedSingleCourtCardsTotal >= 3) {
        // Never spam-spawn when we already have >= 2 unmerged 1-card singles sitting on the back row!
        // (1 stationary decoy anchor on the back row is allowed.)
        bookScore -= 8500;
      } else if (turnNumber >= 3 && myPowerStacks.length >= 2 && unmergedSingleCourtCardsTotal <= 2) {
        // Rule O6 (Reserve Deployment Cadence):
        // Once starting cards are paired into Twin-Citadel stacks, reward tempo spawns to build reserve lead
        // and prevent falling behind a human who deploys reserves steadily on Turns 3-7!
        const behindInReserves = myDrawAfter >= opDraw || totalMyCards < totalOpCards;
        bookScore += behindInReserves ? 5400 : 2200;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rule O5: Adaptive Counter-Book Adjustments (Archetypes A - D)
  // -------------------------------------------------------------------------
  if (archetype === 'BLITZ_RUSH' || archetype === 'LONE_ASSASSIN_PROBE') {
    // Counter-Book A & D: Intercept rushing enemy pieces with a 24+ pt or Joker stack & armor Aces!
    for (let r = 0; r < opRushingSquares.length; r++) {
      const rSq = opRushingSquares[r];
      const rx = (rSq / 7) | 0;
      const ry = rSq % 7;
      let bestInterceptorDist = 99;
      for (let s = 0; s < myPowerStacks.length; s++) {
        const st = myPowerStacks[s];
        const sx = (st.sq / 7) | 0;
        const sy = st.sq % 7;
        const d = Math.max(Math.abs(sx - rx), Math.abs(sy - ry));
        if (d < bestInterceptorDist) bestInterceptorDist = d;
      }
      if (bestInterceptorDist <= 2) {
        bookScore += (3 - bestInterceptorDist) * 2400;
      }
    }
    if (wasSpawn && opRushingSquares.length > 0 && turnNumber <= 4) {
      // Do not waste a full turn spawning while an enemy blitz piece is crossing the midline uncontested!
      bookScore -= 3800;
    }
  } else if (archetype === 'FLANK_OVERLOAD_LEFT' || archetype === 'FLANK_OVERLOAD_RIGHT') {
    // Counter-Book C: Anchor defense on the overloaded flank, advance spearhead down the weak opposite wing!
    const overloadedLeft = archetype === 'FLANK_OVERLOAD_LEFT';
    for (let s = 0; s < myPowerStacks.length; s++) {
      const st = myPowerStacks[s];
      const onWeakFlank = overloadedLeft ? st.x >= 4 : st.x <= 2;
      const onStrongFlank = overloadedLeft ? st.x <= 2 : st.x >= 4;
      if (onWeakFlank && st.depth >= 2) {
        bookScore += st.depth * 1150; // Counter-punch down the undefended flank!
      }
      if (onStrongFlank && st.depth <= 2 && (st.hasJoker || st.pts >= 24)) {
        bookScore += 1800; // Defensive cork on the overloaded flank
      }
    }
  } else if (archetype === 'TURTLE_FORTRESS') {
    // Counter-Book B: Claim central rows (depth 2-3) with Joker+Court or 24+ pt stacks & match reserve spawns
    for (let s = 0; s < myPowerStacks.length; s++) {
      const st = myPowerStacks[s];
      if (st.depth >= 2 && st.depth <= 3 && st.x >= 2 && st.x <= 4) {
        bookScore += 1950;
      }
    }
  }

  // Update telemetry when evaluating root-level turns
  if (!isIntermediateStep) {
    lastBookTelemetry.phaseMode = 'OPENING_BOOK';
    lastBookTelemetry.opponentArchetype = archetype;
    lastBookTelemetry.endgamePattern = null;
    switch (archetype) {
      case 'BLITZ_RUSH':
        lastBookTelemetry.activeBookName = 'Counter-Book A: Anti-Blitz Interceptor';
        lastBookTelemetry.activeRuleSummary =
          'Armoring home Aces and converging 24+ pt / Joker stacks to crush early midline rush.';
        break;
      case 'TURTLE_FORTRESS':
        lastBookTelemetry.activeBookName = 'Counter-Book B: Siege & Midfield Domination';
        lastBookTelemetry.activeRuleSummary =
          'Seizing central files (c-e) and deploying reserve reinforcements to break passive fortress.';
        break;
      case 'FLANK_OVERLOAD_LEFT':
      case 'FLANK_OVERLOAD_RIGHT':
        lastBookTelemetry.activeBookName = 'Counter-Book C: Asymmetric Wing Counter-Punch';
        lastBookTelemetry.activeRuleSummary =
          'Corking overloaded flank with heavy guard while launching rapid strike down weak opposite wing.';
        break;
      case 'LONE_ASSASSIN_PROBE':
        lastBookTelemetry.activeBookName = 'Counter-Book D: Anti-Assassin Stalker Trap';
        lastBookTelemetry.activeRuleSummary =
          'Screening court stacks against hidden Ace/Joker probe and preparing low-card/Joker trap.';
        break;
      default:
        lastBookTelemetry.activeBookName = 'Grandmaster Book: Twin-Citadel & Spearhead';
        lastBookTelemetry.activeRuleSummary =
          'Merging starting court cards into dual 24+ pt stacks with screened flank Aces.';
        break;
    }
  }

  return bookScore;
}

// ============================================================================
// 3. GRANDMASTER ENDGAME BOOK & TABLEBASE SOLVER
// ============================================================================
// Activates when:
// - Both draw piles are depleted or nearly depleted (myDraw + opDraw <= 2), OR
// - Either player is down to 1 Ace (myAces <= 1 || opAces <= 1), OR
// - Total board cards <= 12, OR turnNumber >= 18.
//
// Enforces 7 Exact Endgame Tablebase Laws:
// - Rule E1: Last-Ace "Hound & Net" Bounding-Box Constriction (reduces enemy Last-Ace escape squares to 0)
// - Rule E2: Last-Ace Survival Citadel (forbids Joker-on-Last-Ace Rule-2 suicide; keeps escape lanes open)
// - Rule E3: 2-Aces vs 1-Ace Liquidation & Offensive Hunter Ace Activation
// - Rule E4: Anti-Fortress Can-Opener (cracking Ace+Court and Ace+Joker turtles)
// - Rule E5: Immortal Joker Bulldozer (when enemy Joker is eliminated, Joker+Court marches uncontested)
// - Rule E6: Reserve Exhaustion Straggler Mobilization (eliminates idle back-row stragglers when myDraw === 0)
// - Rule E7: Stack Opposition & Standoff Distance Parity (Chebyshev d=2 Zugzwang control between 2-card stacks)
// ============================================================================

export function isEndgamePhase(
  myAcesCount: number,
  opAcesCount: number,
  myDraw: number,
  opDraw: number,
  totalBoardCards: number,
  turnNumber: number
): boolean {
  if (myAcesCount <= 1 || opAcesCount <= 1) return true;
  if (myDraw + opDraw <= 2) return true;
  if (totalBoardCards <= 12 && turnNumber >= 8) return true;
  if (turnNumber >= 18) return true;
  return false;
}

export function evaluateEndgameBookRules(
  postBoard: BookSimCard[][],
  myFaction: number,
  opBelief: FactionBelief,
  myDrawAfter: number,
  opDraw: number,
  turnNumber: number,
  remainingMyAces: number[],
  totalOpAcesRemaining: number,
  isIntermediateStep: boolean,
  condemnedSq: Uint8Array
): number {
  const opFaction = 1 - myFaction;

  let totalBoardCards = 0;
  const myStacks: Array<{
    sq: number;
    x: number;
    y: number;
    depth: number;
    cnt: number;
    pts: number;
    hasAce: boolean;
    hasJoker: boolean;
  }> = [];
  const opStacks: Array<{
    sq: number;
    x: number;
    y: number;
    cnt: number;
    knownPts: number;
    expectedPts: number;
    hasRevAce: boolean;
    hasRevJoker: boolean;
    aceProb: number;
    jokerProb: number;
  }> = [];

  let opHasAnyJokerAlive = opBelief.unseenJoker;
  const maxCourt = opBelief.maxUnseenCourt || 13;
  const topSetupCourt = Math.round(opBelief.expectedSetupCourt || maxCourt);
  const secondCourt = Math.min(
    12,
    Math.round(opBelief.secondMaxUnseenCourt || opBelief.expectedUnseenCourt || 11)
  );

  for (let sq = 0; sq < 49; sq++) {
    const tile = postBoard[sq];
    if (!tile || tile.length === 0) continue;

    const x = (sq / 7) | 0;
    const y = sq % 7;
    const myDepth = myFaction === 0 ? y : 6 - y;

    let myCnt = 0;
    let myPts = 0;
    let myHasAce = false;
    let myHasJoker = false;

    let opCnt = 0;
    let opUnrevCnt = 0;
    let opKnownPts = 0;
    let opRevAce = false;
    let opRevJoker = false;

    for (let k = 0; k < tile.length; k++) {
      const c = tile[k];
      if (c.owner === myFaction) {
        myCnt++;
        myPts += cardPoints(c.rank);
        if (c.rank === 1) myHasAce = true;
        else if (c.rank === 0) myHasJoker = true;
      } else {
        opCnt++;
        if (c.rank !== -1) {
          const pts = cardPoints(c.rank);
          opKnownPts += pts;
          if (c.rank === 1) opRevAce = true;
          else if (c.rank === 0) {
            opRevJoker = true;
            opHasAnyJokerAlive = true;
          }
        } else {
          opUnrevCnt++;
        }
      }
    }

    const sqAceProb = opRevAce ? 1.0 : opBelief.tileAceProb[sq];
    let opExpectedPts = opKnownPts;
    if (opUnrevCnt > 0) {
      // Exact Deck & Ace-Citadel Point Mechanics:
      // Only when `sqAceProb >= 0.65` (a high-certainty deduced unrevealed Ace stack) do we cap one
      // unrevealed slot at 1 pt (`1 + maxCourt <= 14` pts for a 2-card Ace+Guard stack); otherwise keep
      // `maxCourt` for the 1st card and `secondCourt` for 2+ cards so we never underestimate a Court stack!
      if (!opRevAce && sqAceProb >= 0.65) {
        opExpectedPts += 1 + (opUnrevCnt >= 2 ? maxCourt : 0) + Math.max(0, opUnrevCnt - 2) * 11;
      } else {
        opExpectedPts +=
          maxCourt +
          (opUnrevCnt >= 2 ? secondCourt : 0) +
          Math.max(0, opUnrevCnt - 2) * 11;
      }
    }

    totalBoardCards += myCnt + opCnt;

    if (myCnt > 0 && !condemnedSq[sq]) {
      myStacks.push({
        sq,
        x,
        y,
        depth: myDepth,
        cnt: myCnt,
        pts: myPts,
        hasAce: myHasAce,
        hasJoker: myHasJoker,
      });
    }
    if (opCnt > 0) {
      opStacks.push({
        sq,
        x,
        y,
        cnt: opCnt,
        knownPts: opKnownPts,
        expectedPts: opExpectedPts,
        hasRevAce: opRevAce,
        hasRevJoker: opRevJoker,
        aceProb: sqAceProb,
        jokerProb: opRevJoker ? 1.0 : opBelief.tileJokerProb[sq],
      });
    }
  }

  const myAcesCount = remainingMyAces.length;
  if (
    !isEndgamePhase(
      myAcesCount,
      totalOpAcesRemaining,
      myDrawAfter,
      opDraw,
      totalBoardCards,
      turnNumber
    )
  ) {
    let mgScore = 0;
    if (turnNumber >= 6) {
      let unmergedBackSingles = 0;
      const myPowerStacks: Array<{
        sq: number;
        x: number;
        y: number;
        depth: number;
        cnt: number;
        pts: number;
        hasJoker: boolean;
      }> = [];
      let totalMyCards = 0;
      let totalOpCards = 0;

      for (let m = 0; m < myStacks.length; m++) {
        const st = myStacks[m];
        totalMyCards += st.cnt;
        if (!st.hasAce) {
          if (st.cnt >= 2 && (st.pts >= 19 || st.hasJoker)) {
            myPowerStacks.push(st);
          } else if (st.cnt === 1 && st.depth <= 1 && !st.hasJoker) {
            unmergedBackSingles++;
          }
        }
      }
      for (let e = 0; e < opStacks.length; e++) {
        totalOpCards += opStacks[e].cnt;
      }

      // Rule M1: Middlegame Reserve Deployment Cadence (Turns 6-17)
      // Never allow the opponent to out-deploy reserves while our draw pile sits full!
      if (!isIntermediateStep) {
        if (myDrawAfter > opDraw && myPowerStacks.length >= 2 && unmergedBackSingles <= 1) {
          mgScore -= (myDrawAfter - opDraw) * 1650;
        }
        if (totalMyCards < totalOpCards && myDrawAfter > 0 && unmergedBackSingles <= 1) {
          mgScore -= (totalOpCards - totalMyCards) * 1200;
        }
      }

      // Rule M2: Mutual Crossfire Phalanx Cohesion (keep power stacks within d=1..2 of each other)
      for (let i = 0; i < myPowerStacks.length; i++) {
        for (let j = i + 1; j < myPowerStacks.length; j++) {
          const d = Math.max(
            Math.abs(myPowerStacks[i].x - myPowerStacks[j].x),
            Math.abs(myPowerStacks[i].y - myPowerStacks[j].y)
          );
          if (d >= 1 && d <= 2) {
            mgScore += 1950;
          }
        }
      }

      // Rule M3: Coordinated Twin-Stack Siege Staging & Anti-Piecemeal Standoff Discipline
      for (let e = 0; e < opStacks.length; e++) {
        const opSt = opStacks[e];
        if (opSt.cnt < 2 && opSt.aceProb < 0.4) continue;

        let stagedAt1 = 0;
        let stagedWithin2 = 0;
        let stagedWithin3 = 0;
        let dominantPressAtD1 = false;
        let loneVulnerableAtD1 = false;

        for (let m = 0; m < myPowerStacks.length; m++) {
          const mySt = myPowerStacks[m];
          const d = Math.max(Math.abs(mySt.x - opSt.x), Math.abs(mySt.y - opSt.y));
          if (d === 1) stagedAt1++;
          if (d <= 2) stagedWithin2++;
          if (d <= 3) stagedWithin3++;
          // Walking a lone 2-card non-Joker stack to d=1 of an equal/stronger enemy 2+ card stack
          // (or an enemy Ace candidate where Rule 3 lets their attacking Ace kill a non-Joker stack)
          // without a second supporting stack gives the enemy first-strike initiative!
          if (d === 1) {
            const safeDominantAtD1 =
              !opSt.hasRevAce &&
              opSt.aceProb < 0.22 &&
              !opSt.hasRevJoker &&
              opSt.jokerProb < 0.2 &&
              (mySt.hasJoker || mySt.pts > opSt.expectedPts);
            if (safeDominantAtD1) {
              dominantPressAtD1 = true;
            } else if (
              opSt.cnt >= 2 &&
              !mySt.hasJoker &&
              mySt.cnt === 2 &&
              (mySt.pts <= opSt.expectedPts || opSt.aceProb >= 0.35)
            ) {
              loneVulnerableAtD1 = true;
            }
          }
        }

        if (stagedAt1 >= 1 && stagedWithin2 >= 2) {
          // True 3-Move Budget Pincer (d1 = 1, d2 <= 2 -> d1 + d2 <= 3): lethal convergence next turn!
          mgScore += 5400 + Math.round(3400 * opSt.aceProb);
        } else if (stagedWithin2 >= 2) {
          mgScore += 4200 + Math.round(2800 * opSt.aceProb);
        } else if (dominantPressAtD1) {
          mgScore += 2800;
        } else if (stagedWithin3 >= 2) {
          mgScore += 1800 + Math.round(1200 * opSt.aceProb);
        } else if (loneVulnerableAtD1 && !isIntermediateStep) {
          mgScore -= 3800;
        }
      }
    }

    if (!isIntermediateStep && turnNumber > 7) {
      lastBookTelemetry.phaseMode = 'MIDDLEGAME';
      lastBookTelemetry.activeBookName = 'Grandmaster Middlegame Siege & Tempo';
      lastBookTelemetry.activeRuleSummary =
        'Coordinating Twin-Stack d=2 Siege Pincers, Reserve Deployment Cadence & Multi-World PVS.';
      lastBookTelemetry.endgamePattern = null;
    }
    return mgScore;
  }

  let endgameScore = 0;
  let activePattern = 'Reserve Exhaustion Siege';
  let activeSummary = 'Mobilizing all court stacks and constricting enemy Ace escape lanes.';

  // -------------------------------------------------------------------------
  // Rule E1: Last-Ace "Hound & Net" Mating Net (When totalOpAcesRemaining === 1)
  // -------------------------------------------------------------------------
  if (totalOpAcesRemaining === 1) {
    activePattern = 'Last-Ace Hound & Mating Net';
    activeSummary = 'Enemy is down to 1 Ace: constricting escape box and converging crossfire pincers.';

    for (let e = 0; e < opStacks.length; e++) {
      const opSt = opStacks[e];
      if (opSt.aceProb < 0.25) continue;

      const weight = opSt.hasRevAce ? 1.0 : opSt.aceProb;

      // 1. Count how many of our offensive stacks/units are within Chebyshev distance <= 3 (Pincer Convergence)
      // AND evaluate Inside-Track Center Cutoff + Orthogonal Flanking Geometry (Anti-Kiting Vise)!
      let pincerUnitsAt1 = 0;
      let pincerUnitsWithin2 = 0;
      let pincerUnitsWithin3 = 0;
      const huntingVectors: Array<{ dx: number; dy: number; dist: number }> = [];
      const opCenterDist = Math.max(Math.abs(opSt.x - 3), Math.abs(opSt.y - 3));

      for (let m = 0; m < myStacks.length; m++) {
        const mySt = myStacks[m];
        // Don't use our own Last Ace as a frontline hunter unless it is strictly safe
        if (mySt.hasAce && myAcesCount === 1) continue;
        const canCrackTarget =
          (mySt.hasAce && myAcesCount >= 2) ||
          (!opSt.hasRevJoker && mySt.pts > opSt.expectedPts) ||
          (mySt.hasJoker && mySt.cnt >= 2 && !opSt.hasRevJoker && mySt.pts >= 13) ||
          (mySt.hasJoker && mySt.cnt === 1 && opSt.cnt === 1 && opSt.hasRevAce);

        if (!canCrackTarget && mySt.pts < 12) continue;

        const d = Math.max(Math.abs(mySt.x - opSt.x), Math.abs(mySt.y - opSt.y));
        if (d === 1) pincerUnitsAt1++;
        if (d <= 2) pincerUnitsWithin2++;
        if (d <= 3) pincerUnitsWithin3++;
        if (d >= 1 && d <= 4) {
          huntingVectors.push({ dx: mySt.x - opSt.x, dy: mySt.y - opSt.y, dist: d });
        }

        // Phase 4 Inside-Track Shepherding Bonus:
        // Standing closer to the board center (3,3) than the enemy's Last Ace (`myCenterDist <= opCenterDist`)
        // while within `d <= 3` herds the enemy Ace toward the board perimeter/corner!
        const myCenterDist = Math.max(Math.abs(mySt.x - 3), Math.abs(mySt.y - 3));
        if (d <= 3 && myCenterDist <= opCenterDist && opCenterDist >= 2) {
          endgameScore += Math.round((opCenterDist * 650 + (4 - d) * 450) * weight);
        }

        // Strong Hound Pull toward the enemy's Last Ace
        endgameScore += Math.round((10 - d) * 850 * weight);
      }

      // Phase 4 Anti-Kiting Orthogonal / Flanking Vise Bonus:
      // Two hunting stacks approaching from perpendicular or opposite directions (`dot <= 0`) trap the enemy Ace
      // in an inescapable crossfire, whereas chasing in single file (`dot > 0` along the same ray) lets the Ace kite!
      if (huntingVectors.length >= 2) {
        let bestFlankScore = 0;
        for (let a = 0; a < huntingVectors.length; a++) {
          for (let b = a + 1; b < huntingVectors.length; b++) {
            const va = huntingVectors[a];
            const vb = huntingVectors[b];
            const dot = va.dx * vb.dx + va.dy * vb.dy;
            if (dot < 0) {
              // Opposite-side pincer vise!
              bestFlankScore = Math.max(bestFlankScore, 5400);
            } else if (dot === 0 || va.dx * vb.dx <= 0 || va.dy * vb.dy <= 0) {
              // Orthogonal L-shaped cutoff sealing two perpendicular escape axes!
              bestFlankScore = Math.max(bestFlankScore, 3600);
            }
          }
        }
        endgameScore += Math.round(bestFlankScore * weight);
      }

      if (pincerUnitsAt1 >= 1 && pincerUnitsWithin2 >= 2) {
        // True 3-Move Budget Lethal Pincer (d1 = 1, d2 <= 2 -> d1 + d2 <= 3):
        // Two units can converge onto the enemy Last Ace in a single 3-move turn!
        endgameScore += Math.round(17200 * weight);
      } else if (pincerUnitsWithin2 >= 2) {
        // Two independent offensive stacks within 2 squares of the enemy Last Ace = Pincer Net!
        endgameScore += Math.round(14500 * weight);
      } else if (pincerUnitsWithin3 >= 2) {
        endgameScore += Math.round(6800 * weight);
      }

      // 2. Phase 4 Exact 3-Step Reachable Escape Component (`|E_op|`) Flood-Fill BFS & Bounding-Box Compression:
      // Pre-mark all squares `sq` that are either occupied by us OR covered by a 1-turn lethal strike
      // (including 2-unit crossfire convergence d1 + d2 <= 3) from our stacks!
      const isSquareSafeForOpAce = (sqIdx: number): boolean => {
        const nTile = postBoard[sqIdx];
        if (nTile.length > 0 && nTile[0].owner === myFaction) return false;
        const nx = (sqIdx / 7) | 0;
        const ny = sqIdx % 7;
        let topD1_0 = 0;
        let topD1_1 = 0;
        let topD2_0 = 0;
        for (let m = 0; m < myStacks.length; m++) {
          const mySt = myStacks[m];
          if (mySt.hasAce && myAcesCount === 1) continue;
          const dToEscape = Math.max(Math.abs(mySt.x - nx), Math.abs(mySt.y - ny));
          // A 1-card Ace/Court/Joker moves 3 squares; a 2-card stack moves 1 full square (or peels 1 card up to 2 squares)
          const maxFullStackReach = mySt.cnt === 1 ? 3 : 1;
          if (dToEscape <= maxFullStackReach) {
            if (
              (mySt.hasAce && myAcesCount >= 2) ||
              (!opSt.hasRevJoker && mySt.pts > opSt.expectedPts)
            ) {
              return false;
            }
          }
          // Even if the enemy Ace peels off its guard to run alone (1 pt), any single friendly card (`pts >= 9`, `Joker`, or spare `Ace`)
          // within `dToEscape <= 3` covers that square against a solo-fleeing Ace!
          if (
            opSt.cnt === 1 &&
            !opSt.hasRevJoker &&
            dToEscape <= 3 &&
            (mySt.pts >= 9 || mySt.hasJoker || (mySt.hasAce && myAcesCount >= 2))
          ) {
            return false;
          }
          // Track top single-card point contributions at d=1 and d=2 for 2-card (d1 + d2 <= 3) crossfire coverage!
          if (!mySt.hasAce && dToEscape <= 2) {
            const topCardPts =
              mySt.cnt === 1 ? mySt.pts : Math.min(13, Math.ceil((mySt.pts - (mySt.hasJoker ? 1 : 0)) / Math.max(1, mySt.cnt - (mySt.hasJoker ? 1 : 0))));
            if (dToEscape === 1) {
              if (topCardPts >= topD1_0) {
                topD1_1 = topD1_0;
                topD1_0 = topCardPts;
              } else if (topCardPts > topD1_1) {
                topD1_1 = topCardPts;
              }
            } else if (dToEscape === 2 && topCardPts > topD2_0) {
              topD2_0 = topCardPts;
            }
          }
        }
        if (!opSt.hasRevJoker && topD1_0 > 0 && topD1_0 + Math.max(topD1_1, topD2_0) > opSt.expectedPts) {
          return false;
        }
        return true;
      };

      let safeEscapeSquares = 0;
      const step1SafeSqs: number[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        const nx = opSt.x + dx;
        if (nx < 0 || nx >= 7) continue;
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const ny = opSt.y + dy;
          if (ny < 0 || ny >= 7) continue;
          const nSq = nx * 7 + ny;
          if (isSquareSafeForOpAce(nSq)) {
            safeEscapeSquares++;
            step1SafeSqs.push(nSq);
          }
        }
      }

      // Expand 3-Step BFS Escape Component (`|E_op|`) and compute its Bounding-Box Area!
      if (!isIntermediateStep) {
        const visitedEsc = new Uint8Array(49);
        const escQueue = new Int32Array(49);
        const escDepth = new Uint8Array(49);
        let qHead = 0;
        let qTail = 0;
        visitedEsc[opSt.sq] = 1;
        let minEscX = opSt.x;
        let maxEscX = opSt.x;
        let minEscY = opSt.y;
        let maxEscY = opSt.y;
        for (let s = 0; s < step1SafeSqs.length; s++) {
          const sq1 = step1SafeSqs[s];
          visitedEsc[sq1] = 1;
          escQueue[qTail] = sq1;
          escDepth[qTail] = 1;
          qTail++;
          const sx = (sq1 / 7) | 0;
          const sy = sq1 % 7;
          if (sx < minEscX) minEscX = sx;
          if (sx > maxEscX) maxEscX = sx;
          if (sy < minEscY) minEscY = sy;
          if (sy > maxEscY) maxEscY = sy;
        }
        const maxStepsForOpAce = opSt.cnt === 1 ? 3 : 2;
        while (qHead < qTail) {
          const curSq = escQueue[qHead];
          const curD = escDepth[qHead];
          qHead++;
          if (curD >= maxStepsForOpAce) continue;
          const cx = (curSq / 7) | 0;
          const cy = curSq % 7;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            if (nx < 0 || nx >= 7) continue;
            for (let dy = -1; dy <= 1; dy++) {
              if (dx === 0 && dy === 0) continue;
              const ny = cy + dy;
              if (ny < 0 || ny >= 7) continue;
              const nSq = nx * 7 + ny;
              if (visitedEsc[nSq]) continue;
              if (!isSquareSafeForOpAce(nSq)) continue;
              visitedEsc[nSq] = 1;
              escQueue[qTail] = nSq;
              escDepth[qTail] = curD + 1;
              qTail++;
              if (nx < minEscX) minEscX = nx;
              if (nx > maxEscX) maxEscX = nx;
              if (ny < minEscY) minEscY = ny;
              if (ny > maxEscY) maxEscY = ny;
            }
          }
        }
        const escapeComponentSize = qTail; // 0 to 35 reachable safe squares
        const escapeBoxArea = (maxEscX - minEscX + 1) * (maxEscY - minEscY + 1);
        // Strongly reward shrinking the enemy Ace's multi-step reachable component and bounding box!
        const componentConstriction = Math.max(0, 20 - escapeComponentSize);
        const boxConstriction = Math.max(0, 25 - escapeBoxArea);
        endgameScore += Math.round((componentConstriction * 480 + boxConstriction * 240) * weight);
      }

      // Reward constricting the enemy Last-Ace's 1-step safe escape squares!
      const constrictedSquares = Math.max(0, 8 - safeEscapeSquares);
      endgameScore += Math.round(constrictedSquares * 1350 * weight);
      if (safeEscapeSquares === 0) {
        // Mating Net Complete: Every escape square of the enemy Last Ace is covered!
        endgameScore += Math.round(18000 * weight);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rule E2: Last-Ace Survival Citadel (When myAcesCount === 1)
  // -------------------------------------------------------------------------
  // Enforce Law-2 Anti-[Ace + Joker] Survival Rule for ALL friendly Aces (even when myAcesCount === 2):
  // Never stack our Joker on the same square as a friendly Ace while the opponent still has an Ace!
  if (totalOpAcesRemaining >= 1) {
    for (let a = 0; a < remainingMyAces.length; a++) {
      const aSq = remainingMyAces[a];
      const aTile = postBoard[aSq];
      if (aTile.some((c) => c.owner === myFaction && c.rank === 0)) {
        endgameScore -= myAcesCount === 1 ? 145000 : 85000;
      }
    }
  }

  if (myAcesCount === 1) {
    const myLastAceSq = remainingMyAces[0];
    const ax = (myLastAceSq / 7) | 0;
    const ay = myLastAceSq % 7;
    const aTile = postBoard[myLastAceSq];

    let hasJokerOnLastAce = false;
    let lastAcePts = 0;
    let lastAceCnt = 0;
    for (let k = 0; k < aTile.length; k++) {
      if (aTile[k].owner === myFaction) {
        lastAceCnt++;
        lastAcePts += cardPoints(aTile[k].rank);
        if (aTile[k].rank === 0) hasJokerOnLastAce = true;
      }
    }

    // Strict Tablebase Rule E2-A: NEVER stack our Joker directly on our Last Ace while opponent has an Ace!
    // (Because 1 attacking enemy Ace triggers Rule 2 mutual destruction and kills our Last Ace!)
    if (hasJokerOnLastAce && totalOpAcesRemaining >= 1) {
      endgameScore -= 95000;
    } else if (!hasJokerOnLastAce && lastAceCnt === 2 && lastAcePts >= 10) {
      // Ideal Last-Ace Armor: Ace + King/Queen (13-14 pts) or Ace + Jack/10/9 (10-12 pts)
      endgameScore += lastAcePts >= 13 ? 7500 : 5500;
    } else if (lastAceCnt === 1) {
      // Bare Last Ace in the endgame is dangerously exposed!
      endgameScore -= 11500;
    }

    // Rule E2-B: Keep our Joker or Court Screen on an INTERPOSING square (d === 1..2) directly between our Last Ace
    // and any enemy Ace/stack, and NEVER let our Last Ace sit at d === 1 from an enemy 2+ card stack or Ace!
    for (let e = 0; e < opStacks.length; e++) {
      const opSt = opStacks[e];
      const dToEnemy = Math.max(Math.abs(opSt.x - ax), Math.abs(opSt.y - ay));
      // An enemy 2-card stack (like [Ace + Joker] or [K + Q]) can only move 1 square per turn with BOTH cards!
      // At d === 1 it slaughters our Last Ace while keeping its 2-card protection; at d >= 2 it CANNOT reach with both cards!
      if (dToEnemy === 1 && (opSt.cnt >= 2 || opSt.hasRevJoker || opSt.aceProb >= 0.35)) {
        endgameScore -= 75000;
      } else if (dToEnemy === 2 && (opSt.hasRevJoker || opSt.aceProb >= 0.35)) {
        endgameScore -= 24000;
      } else if (dToEnemy >= 3 && (opSt.hasRevJoker || opSt.aceProb >= 0.35)) {
        endgameScore += Math.min(4, dToEnemy) * 6500;
      }
    }

    for (let m = 0; m < myStacks.length; m++) {
      const st = myStacks[m];
      if (st.sq === myLastAceSq) continue;
      const d = Math.max(Math.abs(st.x - ax), Math.abs(st.y - ay));
      if (d >= 1 && d <= 2) {
        if (st.hasJoker) {
          endgameScore += d === 1 ? 8500 : 4800; // Separate Joker screen absorbs enemy Ace in 1-for-1 Rule-2 trade!
          // Extra Geodesic Interposition Bonus if our Joker stands directly between our Last Ace and an enemy Ace/Joker stack!
          for (let e = 0; e < opStacks.length; e++) {
            const opSt = opStacks[e];
            if (opSt.hasRevJoker || opSt.aceProb >= 0.25) {
              const dJkrToEnemy = Math.max(Math.abs(st.x - opSt.x), Math.abs(st.y - opSt.y));
              const dAceToEnemy = Math.max(Math.abs(ax - opSt.x), Math.abs(ay - opSt.y));
              if (dJkrToEnemy < dAceToEnemy && d + dJkrToEnemy === dAceToEnemy) {
                endgameScore += 14500;
              } else if (dJkrToEnemy < dAceToEnemy && dJkrToEnemy <= 2) {
                endgameScore += 9500;
              }
            }
          }
        } else if (d === 1 && st.pts >= 12 && lastAceCnt === 1) {
          endgameScore += 3200; // Adjacent court bodyguard
        }
      }
    }

    // Rule E2-C: Avoid cornering our own Last Ace on (0,0), (6,0), (0,6), (6,6) where only 3 adjacent squares exist
    if ((ax === 0 || ax === 6) && (ay === 0 || ay === 6)) {
      endgameScore -= 3600;
    }

    if (totalOpAcesRemaining >= 2) {
      activePattern = 'Last-Ace Fortress & Counter-Strike';
      activeSummary = 'Protecting our sole remaining Ace with Court armor and adjacent Joker screen.';
    }
  }

  // -------------------------------------------------------------------------
  // Rule E3: 2-Aces Liquidation & Anti-[Joker + Card] Hunter-Ace Activation
  // -------------------------------------------------------------------------
  if (myAcesCount === 2) {
    if (totalOpAcesRemaining === 1) {
      activePattern = '2-Aces vs 1-Ace Liquidation Tablebase';
      activeSummary = 'Converging court stacks and hunter Ace to force a winning liquidation.';
    }

    // Only activate a 1-card unarmored Hunter Ace against a REVEALED enemy Joker phalanx
    // (where Rule 2 mutual destruction liquidates their Joker+Ace/Court stack!).
    // Never march a multi-card Armored Ace stack across the board when court stacks can hunt!
    let bestHunterBonus = 0;
    for (let a = 0; a < remainingMyAces.length; a++) {
      const aSq = remainingMyAces[a];
      const aTile = postBoard[aSq];
      const myCntOnAce = aTile.filter((c) => c.owner === myFaction).length;
      if (myCntOnAce > 1) continue; // Keep armored Aces in their defensive citadel!
      const ax = (aSq / 7) | 0;
      const ay = aSq % 7;
      for (let e = 0; e < opStacks.length; e++) {
        const opSt = opStacks[e];
        const isJokerPhalanxTarget = opSt.hasRevJoker && opSt.cnt >= 2;
        if (!isJokerPhalanxTarget) continue;

        const d = Math.max(Math.abs(ax - opSt.x), Math.abs(ay - opSt.y));
        if (d <= 4) {
          const weight = Math.max(0.85, opSt.aceProb);
          const b = Math.round((6 - d) * 3200 * weight);
          if (b > bestHunterBonus) bestHunterBonus = b;
        }
      }
    }
    endgameScore += bestHunterBonus;
  }

  // -------------------------------------------------------------------------
  // Rule E4 & E5: Immortal Joker Bulldozer & Anti-Fortress Can-Opener
  // -------------------------------------------------------------------------
  for (let e = 0; e < opStacks.length; e++) {
    const opSt = opStacks[e];
    // Rule E4: Anti-Fortress Can-Opener against an armored enemy Ace stack (cnt >= 2, aceProb >= 0.40)
    if (opSt.cnt >= 2 && opSt.aceProb >= 0.4) {
      let breakersAt1 = 0;
      let convergingBreakers = 0;
      for (let m = 0; m < myStacks.length; m++) {
        const mySt = myStacks[m];
        if (mySt.hasAce && myAcesCount === 1) continue;
        const d = Math.max(Math.abs(mySt.x - opSt.x), Math.abs(mySt.y - opSt.y));
        if (d <= 2 && (mySt.cnt >= 2 || mySt.pts >= 12 || (mySt.hasAce && myAcesCount >= 2))) {
          if (d === 1) breakersAt1++;
          convergingBreakers++;
          if (mySt.cnt === 3 && mySt.pts >= 31 && !opSt.hasRevJoker) {
            // 3-card 31+ pt siege ram at d <= 2 cracks any 2-card Ace+Court fortress!
            endgameScore += Math.round(5800 * opSt.aceProb);
          }
        }
      }
      if (breakersAt1 >= 1 && convergingBreakers >= 2) {
        endgameScore += Math.round(8600 * opSt.aceProb);
      } else if (convergingBreakers >= 2) {
        endgameScore += Math.round(6400 * opSt.aceProb);
      }
    }
  }

  for (let m = 0; m < myStacks.length; m++) {
    const st = myStacks[m];
    if (st.hasAce) continue;

    // Rule E5-A: If opponent has NO Joker left in the game, our Joker+Court stack (pts >= 13)
    // is an unstoppable bulldozer against all non-Ace enemy stacks!
    if (st.hasJoker && st.cnt >= 2 && st.pts >= 13 && !opHasAnyJokerAlive) {
      endgameScore += 8200;
      activePattern = 'Immortal Joker-Phalanx Bulldozer';
      activeSummary = 'Enemy Joker eliminated: marching invincible Joker+Court phalanx into enemy citadel.';
      for (let e = 0; e < opStacks.length; e++) {
        const opSt = opStacks[e];
        const d = Math.max(Math.abs(st.x - opSt.x), Math.abs(st.y - opSt.y));
        endgameScore += Math.round((8 - d) * 650 * (0.4 + opSt.aceProb));
      }
    }

    // Rule E5-B: Lone Joker Sniper against a lone revealed/high-prob 1-card enemy Ace!
    if (st.hasJoker && st.cnt === 1) {
      for (let e = 0; e < opStacks.length; e++) {
        const opSt = opStacks[e];
        if (opSt.cnt === 1 && opSt.aceProb >= 0.55) {
          const d = Math.max(Math.abs(st.x - opSt.x), Math.abs(st.y - opSt.y));
          if (d <= 3) {
            endgameScore += Math.round((5 - d) * 3200 * opSt.aceProb);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rule E8: 2-Turn Forced Checkmate Corridor (High-Prob Enemy Ace Escape Denial)
  // -------------------------------------------------------------------------
  if (!isIntermediateStep) {
    for (let e = 0; e < opStacks.length; e++) {
      const opSt = opStacks[e];
      if (opSt.aceProb < 0.48) continue;
      let totalLegalEscapes = 0;
      let deniedEscapes = 0;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = opSt.x + dx;
        if (nx < 0 || nx >= 7) continue;
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const ny = opSt.y + dy;
          if (ny < 0 || ny >= 7) continue;
          totalLegalEscapes++;
          const nSq = nx * 7 + ny;
          const nTile = postBoard[nSq];
          if (nTile.length > 0 && nTile[0].owner === myFaction) {
            deniedEscapes++;
            continue;
          }
          let deniedSingle = false;
          let topD1_0 = 0;
          let topD1_1 = 0;
          let topD2_0 = 0;
          for (let m = 0; m < myStacks.length; m++) {
            const mySt = myStacks[m];
            if (mySt.hasAce && myAcesCount === 1) continue;
            const dEsc = Math.max(Math.abs(mySt.x - nx), Math.abs(mySt.y - ny));
            const reach = mySt.cnt === 1 ? 3 : 1;
            if (
              (dEsc <= reach && (mySt.pts > opSt.expectedPts || (mySt.hasAce && myAcesCount >= 2))) ||
              (opSt.cnt === 1 && !opSt.hasRevJoker && dEsc <= 3 && (mySt.pts >= 9 || mySt.hasJoker))
            ) {
              deniedSingle = true;
              break;
            }
            if (!mySt.hasAce && dEsc <= 2) {
              const topCardPts =
                mySt.cnt === 1
                  ? mySt.pts
                  : Math.min(
                      13,
                      Math.ceil((mySt.pts - (mySt.hasJoker ? 1 : 0)) / Math.max(1, mySt.cnt - (mySt.hasJoker ? 1 : 0)))
                    );
              if (dEsc === 1) {
                if (topCardPts >= topD1_0) {
                  topD1_1 = topD1_0;
                  topD1_0 = topCardPts;
                } else if (topCardPts > topD1_1) {
                  topD1_1 = topCardPts;
                }
              } else if (dEsc === 2 && topCardPts > topD2_0) {
                topD2_0 = topCardPts;
              }
            }
          }
          if (
            deniedSingle ||
            (!opSt.hasRevJoker && topD1_0 > 0 && topD1_0 + Math.max(topD1_1, topD2_0) > opSt.expectedPts)
          ) {
            deniedEscapes++;
          }
        }
      }
      if (totalLegalEscapes > 0 && deniedEscapes >= totalLegalEscapes - 1) {
        endgameScore += Math.round((deniedEscapes === totalLegalEscapes ? 12500 : 6200) * opSt.aceProb);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rule E6: Reserve Exhaustion & Straggler Mobilization (myDrawAfter === 0)
  // -------------------------------------------------------------------------
  if (myDrawAfter === 0) {
    for (let m = 0; m < myStacks.length; m++) {
      const st = myStacks[m];
      if (st.hasAce) continue;

      // Find distance to nearest enemy stack and nearest friendly non-Ace stack
      let minDistToEnemy = 99;
      for (let e = 0; e < opStacks.length; e++) {
        const d = Math.max(Math.abs(st.x - opStacks[e].x), Math.abs(st.y - opStacks[e].y));
        if (d < minDistToEnemy) minDistToEnemy = d;
      }

      let minDistToFriendlyAce = 99;
      for (let a = 0; a < remainingMyAces.length; a++) {
        const ax = (remainingMyAces[a] / 7) | 0;
        const ay = remainingMyAces[a] % 7;
        const d = Math.max(Math.abs(st.x - ax), Math.abs(st.y - ay));
        if (d < minDistToFriendlyAce) minDistToFriendlyAce = d;
      }

      // Penalize straggler court cards sitting idle on back rows (depth <= 1) far from enemy and not guarding an Ace
      if (st.cnt === 1 && st.depth <= 1 && minDistToEnemy >= 4 && minDistToFriendlyAce >= 2) {
        endgameScore -= (minDistToEnemy - 2) * 1450;
      }

      // Reward advancing consolidated stacks toward the enemy's half of the board
      if (st.cnt >= 2 || st.pts >= 12) {
        endgameScore += Math.max(0, 7 - minDistToEnemy) * 620;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rule E7: Stack Opposition & Standoff Distance Parity (Chebyshev d=2 Zugzwang)
  // -------------------------------------------------------------------------
  if (!isIntermediateStep) {
    for (let m = 0; m < myStacks.length; m++) {
      const mySt = myStacks[m];
      if (mySt.hasAce || mySt.cnt < 2) continue;

      for (let e = 0; e < opStacks.length; e++) {
        const opSt = opStacks[e];
        if (opSt.cnt < 2) continue;

        const d = Math.max(Math.abs(mySt.x - opSt.x), Math.abs(mySt.y - opSt.y));
        // Check if our 2+ card stack is immune/dominant at d=1 (either we have a Joker and enemy has no Ace,
        // or our stack strictly out-points their stack and they have no Joker or Ace):
        const isSafeDominantPressAtD1 =
          !opSt.hasRevAce &&
          opSt.aceProb < 0.18 &&
          ((mySt.hasJoker && !opSt.hasRevJoker) ||
            (mySt.pts > opSt.expectedPts && !opSt.hasRevJoker && opSt.jokerProb < 0.18));

        if (d === 1 && isSafeDominantPressAtD1) {
          endgameScore += 4400; // Press directly to d=1 when opponent cannot counter-attack our stronger/Joker-shielded stack!
        } else if (d === 2) {
          if (mySt.pts > opSt.expectedPts || (mySt.hasJoker && !opSt.hasRevJoker)) {
            endgameScore += 2900; // Dominant Direct Opposition!
          } else {
            endgameScore += 1400; // Defensive Standoff Opposition (prevents their 2-card stack from advancing safely)
          }
        }
      }
    }

    lastBookTelemetry.phaseMode = 'ENDGAME_TABLEBASE';
    lastBookTelemetry.activeBookName = `Endgame Book: ${activePattern}`;
    lastBookTelemetry.activeRuleSummary = activeSummary;
    lastBookTelemetry.endgamePattern = activePattern;
  }

  return endgameScore;
}
