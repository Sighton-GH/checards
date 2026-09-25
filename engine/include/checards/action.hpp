#pragma once
// =============================================================================
// action.hpp — the atomic action space.
//
// A "turn" is up to 3 atomic actions (or exactly 1 spawn, which consumes the
// whole turn). Every atomic action is one of:
//   - a single king-step of one card in one of 8 directions from one of the
//     49 squares  -> 49 * 8 = 392 actions
//   - a spawn into one of the 7 back-row columns                 -> 7 actions
// Total: 399. This matches the size the user's own brainstorm notes arrived
// at independently ("~399 logits" / "legal outputs when looking ahead").
// Doubling this (399*2=798, also a number from those notes) is exactly the
// size of the two policy heads concatenated — see network.hpp.
// =============================================================================

#include <algorithm>
#include <array>
#include <cmath>
#include <vector>
#include "checards/board.hpp"
#include "checards/types.hpp"

namespace checards {

constexpr int8_t kDx[8] = {0, 1, 1, 1, 0, -1, -1, -1};
constexpr int8_t kDy[8] = {-1, -1, 0, 1, 1, 1, 0, -1};
// Direction names, same order, purely for logging/CLI.
inline const char* directionName(int d) {
    static const char* n[8] = {"N", "NE", "E", "SE", "S", "SW", "W", "NW"};
    return n[d];
}

constexpr int kNumSquares      = kBoardSize * kBoardSize;      // 49
constexpr int kNumDirections   = 8;
constexpr int kNumMoveActions  = kNumSquares * kNumDirections; // 392
constexpr int kNumSpawnActions = kBoardSize;                   // 7
constexpr int kNumAtomicActions = kNumMoveActions + kNumSpawnActions; // 399

// The card-selector factor: given a source tile, WHICH of the mover's stacked
// cards moves is a conditional choice over owner-relative ordinals 0..3
// (kMaxStack). Indexed tile*kMaxStack + ordinal. The policy heads stay
// geometric (399); this second factor resolves the in-stack ambiguity the
// geometric index cannot express.
constexpr int kNumSelectorActions = kNumSquares * kMaxStack; // 196


inline int squareIndex(Coordinate c) { return c.y * kBoardSize + c.x; }

inline int selectorIndex(Coordinate from, int ownerOrdinal) {
    return squareIndex(from) * kMaxStack + ownerOrdinal;
}
inline Coordinate squareFromIndex(int idx) {
    return Coordinate{static_cast<int8_t>(idx % kBoardSize), static_cast<int8_t>(idx / kBoardSize)};
}
inline int encodeMoveAction(Coordinate from, int direction) { return squareIndex(from) * kNumDirections + direction; }
inline int encodeSpawnAction(int column) { return kNumMoveActions + column; }

struct Action {
    bool isSpawn = false;
    Coordinate from{}, to{};
    int direction = -1;          // 0..7 for moves, -1 for spawn
    // Stable information-set selector: the Nth card owned by the mover on
    // the source tile, in tile order. Unlike rank/suit, this does not change
    // when a hidden card is re-determinized. cardRank/cardSuit remain the
    // exact identity shown to the real player and used for logging/UI only.
    int8_t ownerOrdinal = 0;
    Rank cardRank = RankVal::Joker;
    Suit cardSuit = SuitVal::JokerSuit;

    int atomicIndex() const {
        return isSpawn ? encodeSpawnAction(to.x) : encodeMoveAction(from, direction);
    }
    bool operator==(const Action& o) const {
        return isSpawn == o.isSpawn && from == o.from && to == o.to &&
               (isSpawn || ownerOrdinal == o.ownerOrdinal);
    }
};

// ---------------------------------------------------------------------------
// selectorMultipliers — one conditional probability per legal action, to be
// multiplied into the geometric policy prior at tree expansion:
//
//     prior(exact action) = P_geometry(atomicIndex) * multiplier
//
// Semantics:
//   - Spawns have no in-stack choice: multiplier 1.0.
//   - Moves: the selector head emits 4 logits per tile (one per stack
//     ordinal). Within each GEOMETRIC group (all legal actions sharing one
//     atomicIndex, i.e. same source+direction with different stacked cards),
//     the multiplier is a softmax over the selector logits of the ordinals
//     actually present in that group. Normalizing per geometric group (not
//     per tile) keeps total prior mass conserved per group and reproduces
//     the pre-selector uniform split EXACTLY when the selector logits are
//     all zero — which is how v1 checkpoints behave after migration.
// ---------------------------------------------------------------------------
inline std::vector<float> selectorMultipliers(const std::array<float, kNumSelectorActions>& selectorLogits,
                                               const std::vector<Action>& legalActions) {
    std::vector<float> mult(legalActions.size(), 1.0f);
    std::array<int, kNumAtomicActions> ordinalMask{};  // ordinals present per geometric group
    std::array<float, kNumAtomicActions> groupLogZ{};
    std::array<char, kNumAtomicActions> logZComputed{};
    ordinalMask.fill(0);
    groupLogZ.fill(0.f);
    logZComputed.fill(0);
    for (const auto& a : legalActions) {
        if (!a.isSpawn) ordinalMask[a.atomicIndex()] |= (1 << a.ownerOrdinal);
    }
    for (size_t i = 0; i < legalActions.size(); i++) {
        const Action& a = legalActions[i];
        if (a.isSpawn) continue;
        int idx = a.atomicIndex();
        if (!logZComputed[idx]) {
            int mask = ordinalMask[idx];
            int tile = squareIndex(a.from);
            float mx = -1e30f;
            for (int s = 0; s < kMaxStack; s++)
                if (mask & (1 << s)) mx = std::max(mx, selectorLogits[tile * kMaxStack + s]);
            float sum = 0.f;
            for (int s = 0; s < kMaxStack; s++)
                if (mask & (1 << s)) sum += std::exp(selectorLogits[tile * kMaxStack + s] - mx);
            groupLogZ[idx] = mx + std::log(std::max(1e-30f, sum));
            logZComputed[idx] = 1;
        }
        mult[i] = std::exp(selectorLogits[squareIndex(a.from) * kMaxStack + a.ownerOrdinal] - groupLogZ[idx]);
    }
    return mult;
}

inline Action decodeAtomicAction(int idx, Faction mover) {
    Action a{};
    if (idx >= kNumMoveActions) {
        a.isSpawn = true;
        int col = idx - kNumMoveActions;
        int row = Board::homeRow(mover);
        a.from = a.to = Coordinate{static_cast<int8_t>(col), static_cast<int8_t>(row)};
        a.direction = -1;
        return a;
    }
    a.isSpawn = false;
    int sq = idx / kNumDirections;
    a.direction = idx % kNumDirections;
    a.from = squareFromIndex(sq);
    a.to = Coordinate{static_cast<int8_t>(a.from.x + kDx[a.direction]),
                       static_cast<int8_t>(a.from.y + kDy[a.direction])};
    return a;
}

} // namespace checards
