#pragma once
// =============================================================================
// opponent_model.hpp — "build an idea of what the other player is doing,
// rather than assuming they play like you" (brainstorm notes).
//
// This is deliberately lightweight: an empirical histogram of the specific
// opponent's actual chosen actions so far *this game*, blended into the
// priors search.cpp uses when simulating that opponent's replies deeper in
// the tree. It is a bias on top of the network's self-play policy, not a
// replacement for it — with too few observations it contributes nothing
// (see minObservations below), so it can only ever sharpen exploitation of
// a specific opponent's tendencies, never override the principled
// self-play-trained prior when there isn't yet evidence to justify doing so.
//
// This module tracks CARD-IDENTITY-BLIND behavioural statistics (which
// squares/directions/attacks the opponent tends to choose) — it is
// deliberately independent from belief.hpp's DeckPool, which tracks hidden
// CARD IDENTITY. The brainstorm notes call these out as "different things",
// and keeping them as separate classes with separate responsibilities is
// the direct implementation of that distinction.
//
// TELEMETRY (cycle 2): beyond the flat histogram, recordRealAction also
// accumulates the PUBLIC, card-identity-blind context statistics a future
// evidence-based tendency model needs: how often the opponent attacks a
// still-hidden target vs an already-revealed one (risk appetite under
// uncertainty), how often they move a card off a shared stack (stacking vs
// spreading), and how often they spawn. These are recorded so a later
// probabilistic model can infer tendencies such as risk tolerance, hidden
// aggression, stacking preference, and spawn reliance WITHOUT ever touching
// hidden state. They deliberately do NOT influence search today.
//
// KNOWN LIMITS (read before building on this): the model is per-game (no
// cross-game persistence or opponent identity), identity-blind, and its
// counts are sparse early in a game — aggressionEstimate() on 3 moves is a
// coin flip, not a read. It cannot distinguish "gambler" from "had no safe
// alternative" without position context, and the empirical histogram
// conflates a strong habitual reply with a forced one. Any future
// "personality" output should be a distribution over tendencies with
// explicit confidence, never a fixed label from a handful of moves.
//
// Extension point: persist an OpponentModel per named opponent across games
// (keyed by player name/id) instead of resetting every match, and/or replace
// the flat histogram with a small learned classifier over recent move
// features, for a richer "personality" read.
// =============================================================================

#include <array>
#include <vector>
#include "checards/action.hpp"
#include "checards/board.hpp"

namespace checards {

class OpponentModel {
public:
    std::array<int, kNumAtomicActions> actionCounts{};
    int totalObserved = 0;
    int attackCount = 0;
    int spawnCount = 0;
    // Public-context telemetry (see header comment): recorded only, never
    // fed back into priors.
    int attacksOnHiddenTarget = 0;
    int attacksOnRevealedTarget = 0;
    int stackSourceMoves = 0;   // moved a card off a tile that still holds mover cards after
    int moveCount = 0;          // non-spawn actions

    void reset() {
        actionCounts.fill(0);
        totalObserved = 0;
        attackCount = 0;
        spawnCount = 0;
        attacksOnHiddenTarget = 0;
        attacksOnRevealedTarget = 0;
        stackSourceMoves = 0;
        moveCount = 0;
    }

    void recordRealAction(const Action& a, bool wasAttack) {
        recordRealAction(a, wasAttack, Faction::None, nullptr);
    }

    // The 4-argument form additionally records public-context telemetry from
    // the post-action board. `mover` is the faction that took the action
    // (the observed opponent); boardAfter may be nullptr (telemetry skipped).
    void recordRealAction(const Action& a, bool wasAttack, Faction mover, const Board* boardAfter) {
        int idx = a.atomicIndex();
        if (idx < 0 || idx >= kNumAtomicActions) return; // invalid/pass sentinel: nothing to record
        actionCounts[idx]++;
        totalObserved++;
        if (a.isSpawn) {
            spawnCount++;
            return;
        }
        moveCount++;
        if (wasAttack) attackCount++;
        if (boardAfter != nullptr && mover != Faction::None) {
            // A card just left `from`; if mover cards remain, it came off a stack.
            if (boardAfter->at(a.from).countOwner(mover) >= 1) stackSourceMoves++;
            if (wasAttack) {
                // The destination still holds the attacked enemy cards
                // (combat resolves only at turn end), so their reveal flags
                // here reflect what the mover could NOT see: hidden or not.
                bool anyHidden = false, anyEnemy = false;
                const Tile& t = boardAfter->at(a.to);
                for (int i = 0; i < t.count; i++) {
                    if (t.cards[i].owner == otherFaction(mover)) {
                        anyEnemy = true;
                        if (!t.cards[i].revealed) anyHidden = true;
                    }
                }
                if (anyEnemy) (anyHidden ? attacksOnHiddenTarget : attacksOnRevealedTarget)++;
            }
        }
    }

    // Snapshot of the telemetry as tendency estimates with their sample
    // sizes, so callers can judge confidence instead of reading raw ratios.
    // All shares are neutral (0.5) with no data.
    struct TendencySummary {
        int observations = 0;
        double attackShare = 0.5;       // attacks / moves
        double hiddenAttackShare = 0.5; // attacks on hidden targets / attacks with known visibility
        double stackSourceShare = 0.5;  // moves off shared stacks / moves
        double spawnShare = 0.0;        // spawns / all actions
    };
    TendencySummary tendencies() const {
        TendencySummary t;
        t.observations = totalObserved;
        if (moveCount > 0) t.attackShare = static_cast<double>(attackCount) / moveCount;
        int visibilityKnown = attacksOnHiddenTarget + attacksOnRevealedTarget;
        if (visibilityKnown > 0) t.hiddenAttackShare = static_cast<double>(attacksOnHiddenTarget) / visibilityKnown;
        if (moveCount > 0) t.stackSourceShare = static_cast<double>(stackSourceMoves) / moveCount;
        if (totalObserved > 0) t.spawnShare = static_cast<double>(spawnCount) / totalObserved;
        return t;
    }

    // Fraction of non-spawn moves that were attacks — a crude aggression
    // proxy usable by baseline_bots.hpp's personality knobs or for logging.
    // Starts at a neutral 0.5 prior with no data.
    double aggressionEstimate() const {
        int nonSpawn = totalObserved - spawnCount;
        return nonSpawn > 0 ? static_cast<double>(attackCount) / nonSpawn : 0.5;
    }

    // Empirical distribution over `candidateIndices` (typically: the
    // distinct atomicIndex()es among a node's legal children), renormalized
    // over just those candidates. Returns false (and leaves outDist zeroed)
    // if there isn't enough data yet to be worth using.
    bool empiricalDistributionOver(const std::vector<int>& candidateIndices, std::array<float, kNumAtomicActions>& outDist,
                                    int minObservations = 6) const {
        outDist.fill(0.f);
        if (totalObserved < minObservations) return false;
        double sum = 0.0;
        for (int idx : candidateIndices) sum += actionCounts[idx];
        if (sum <= 0.0) return false;
        for (int idx : candidateIndices) outDist[idx] = static_cast<float>(actionCounts[idx] / sum);
        return true;
    }
};

} // namespace checards
