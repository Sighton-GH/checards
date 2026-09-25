#pragma once
// =============================================================================
// combat.hpp — pure combat resolution.
//
// RULE PRIORITY (derived from rules.txt, cross-checked against monster.cpp's
// Board::attackResolve and hybrid_engine_3.hpp's resolveSimulatedCombat, and
// corrected per clarification from the game's designer: an earlier version
// of this file had a "lone defending Ace is beaten by anything,
// unconditionally" rule that doesn't actually exist — see the correction
// note below):
//
//   1. attackerAces == 2 AND defenderHasJoker  -> defender dies, attacker lives.
//      (Two aces overwhelm a defending joker's auto-win power.)
//   2. attackerAces == 1 AND defenderHasJoker  -> mutual destruction.
//      (A lone attacking ace trades with a defending joker.)
//   3. attackerAces > 0 (and neither 1/2 applied, i.e. no defending joker)
//      -> attacker automatically wins. "No counter possible."
//   4. defenderHasJoker (and attackerAces == 0, since >0 was handled above)
//      -> defender automatically wins.
//   5. Otherwise: compare combat-value sums. Higher sum wins; exact tie is
//      mutual destruction. A defending Ace ALWAYS contributes exactly 1 to
//      the sum here — whether it's alone on the tile or stacked with other
//      cards, there is no separate rule for "alone." This is what makes an
//      attacking lone Joker (value 1) vs. a defending lone Ace (value 1) a
//      tie -> mutual destruction, not an automatic defender loss.
//
// CORRECTION NOTE: an earlier version of this file read "alone, beat by
// anything. If in a stack, counts as 1" as two different rules — a special
// unconditional loss when alone, layered on top of the ordinary sum
// comparison when stacked. That was a misreading: both phrases describe the
// *same* underlying rule (a defending Ace is always worth 1) from two
// angles, not two different behaviors. There is no special case for a lone
// defending Ace beyond what the ordinary sum comparison already gives it by
// virtue of being weak. Ace-vs-ace is unaffected either way: an attacking
// Ace auto-wins per rule 3 regardless of what the defender has, which was
// never in question. The regression test this claim originally shipped
// with tested the wrong expected behavior — correctly per its own logic,
// incorrectly per the actual rules, a reminder that a passing test only
// proves consistency with what it was written to expect.
//
// A stack lives or dies as a whole: "stacked cards act as a singular value"
// for combat purposes, so the outcome (die/survive) always applies to an
// entire side's stack on that tile, never to individual cards within it.
// =============================================================================

#include <vector>
#include "checards/types.hpp"
#include "checards/board.hpp"

namespace checards {

struct CombatResult {
    bool attackerDies = false;
    bool defenderDies = false;
    bool occurred = false; // false if one side had no cards present (no combat to resolve)
};

// Summary of one side's stack, computed once and reused by resolveCombat and
// by evaluation/feature code that wants the same numbers without re-deriving them.
struct StackSummary {
    int count = 0;
    int aces = 0;
    int jokers = 0;
    int sum = 0; // combat-value sum (ace/joker each count as 1)

    bool hasJoker() const { return jokers > 0; }
};

inline StackSummary summarize(const Tile& tile, Faction side) {
    StackSummary s;
    for (int i = 0; i < tile.count; i++) {
        const Card& c = tile.cards[i];
        if (c.owner != side) continue;
        s.count++;
        if (c.rank == RankVal::Ace) s.aces++;
        else if (c.rank == RankVal::Joker) s.jokers++;
        s.sum += c.value();
    }
    return s;
}

inline CombatResult resolveCombat(const StackSummary& att, const StackSummary& def) {
    CombatResult r;
    if (att.count == 0 || def.count == 0) return r; // nothing to resolve
    r.occurred = true;

    if (att.aces == 2 && def.hasJoker()) {
        r.defenderDies = true;
    } else if (att.aces == 1 && def.hasJoker()) {
        r.attackerDies = true;
        r.defenderDies = true;
    } else if (att.aces > 0) {
        r.defenderDies = true;
    } else if (def.hasJoker()) {
        r.attackerDies = true;
    } else {
        // Standard sum comparison. A defending Ace (alone or stacked) simply
        // contributes 1 here, same as it would anywhere else — no special case.
        if (att.sum > def.sum) r.defenderDies = true;
        else if (def.sum > att.sum) r.attackerDies = true;
        else { r.attackerDies = true; r.defenderDies = true; }
    }
    return r;
}

inline CombatResult resolveCombat(const Tile& tile, Faction attacker, Faction defender) {
    return resolveCombat(summarize(tile, attacker), summarize(tile, defender));
}

struct CombatEvent {
    Coordinate at;
    Faction attacker = Faction::None, defender = Faction::None;
    bool attackerDied = false, defenderDied = false;
    // Snapshot of every card that took part, captured *before* any removal —
    // combat always reveals both sides even when a side is wiped out, so
    // callers (belief.hpp bookkeeping) need identities that may no longer
    // exist on the board by the time they process this event.
    std::vector<Card> attackerCards;
    std::vector<Card> defenderCards;
};

// Scans the whole board for tiles where both `mover` and its opponent are
// present, resolves each (mover is always "attacker" — see combat.cpp for
// why that invariant holds), removes losing stacks, reveals every card that
// took part, and updates acesAlive / inactivity / endCondition. Called once
// per turn after all of that turn's moves (or the spawn) are committed.
std::vector<CombatEvent> resolveAllCombats(Board& board, Faction mover);

} // namespace checards
