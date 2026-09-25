#pragma once
// =============================================================================
// features.hpp — turns a Board (+ belief, + turn context) into NNUE inputs.
//
// PIECE-SQUARE PLANES (21 per square, 49 squares = 1029 total):
//   [0..6]   friendly rank one-hot (7 planes, kAllRanks order)
//   [7..13]  enemy rank planes — one-hot if the card is revealed; if it is
//            still hidden AND we are not inside a determinized rollout, this
//            is instead the *belief distribution* spread across all 7 planes
//            (fractional weights, not one-hot). This is the "explicit belief
//            rather than a single sample" idea from the brainstorm notes,
//            implemented directly as weighted feature activations.
//   [14..16] friendly stack-depth thermometer (>=2, >=3, ==4)
//   [17..19] enemy stack-depth thermometer (>=2, >=3, ==4)
//   [20]     "an unresolved hidden enemy card sits here" indicator
//
// `concreteKnown` selects which of two evaluation modes is active:
//   - false ("fog-aware"): used to evaluate the TRUE current position
//     without committing to any guess about hidden cards. Hidden enemy
//     squares get belief-weighted plane activations.
//   - true ("determinized rollout"): used inside MCTS, on a board already
//     produced by belief.hpp's determinize(). Every card — including the
//     guessed ones — is treated as concrete/one-hot, because from that
//     iteration's internal hypothesis nothing is hidden anymore. Averaging
//     over many such hypotheses is what the search itself does.
// =============================================================================

#include <array>
#include <vector>
#include "checards/action.hpp"
#include "checards/belief.hpp"
#include "checards/board.hpp"
#include "checards/types.hpp"

namespace checards {

constexpr int kPlanesPerSquare = 21;
constexpr int kNumPieceSquareFeatures = kNumSquares * kPlanesPerSquare; // 1029
constexpr int kNumGlobalFeatures = 30;

struct WeightedFeature {
    int index;
    float weight;
};

std::array<float, kPlanesPerSquare> squarePlaneVector(const Board& board, Coordinate sq, Faction perspective,
                                                        const BeliefState& belief, bool concreteKnown);

std::vector<WeightedFeature> fullPieceSquareFeatures(const Board& board, Faction perspective,
                                                       const BeliefState& belief, bool concreteKnown);

std::array<float, kNumGlobalFeatures> globalFeatures(const Board& board, Faction perspective, int movesRemaining,
                                                       Faction currentMover, const BeliefState& belief,
                                                       bool concreteKnown);

// Exposed for selfplay.cpp, which needs these exact ground-truth numbers to
// build auxiliary-head training targets (see the long comment in
// selfplay.cpp about why aux targets are computed independently of whatever
// a mid-search determinization happened to guess).
int gamePhaseIndex(const Board& board);
float materialSum(const Board& board, Faction f);
float territoryFraction(const Board& board, Faction f);

} // namespace checards
