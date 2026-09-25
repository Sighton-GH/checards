#include "checards/features.hpp"
#include <algorithm>

namespace checards {

std::array<float, kPlanesPerSquare> squarePlaneVector(const Board& board, Coordinate sq, Faction perspective,
                                                        const BeliefState& belief, bool concreteKnown) {
    std::array<float, kPlanesPerSquare> v{};
    const Tile& t = board.at(sq);
    Faction opp = otherFaction(perspective);
    int friendlyCount = 0, enemyCount = 0;
    bool anyHiddenEnemy = false;

    for (int i = 0; i < t.count; i++) {
        const Card& c = t.cards[i];
        bool isFriendly = (c.owner == perspective);
        if (isFriendly) friendlyCount++; else enemyCount++;

        if (isFriendly || c.revealed || concreteKnown) {
            int plane = rankPlaneIndex(c.rank);
            int base = isFriendly ? 0 : 7;
            v[base + plane] += 1.0f;
        } else {
            anyHiddenEnemy = true;
            auto dist = belief.decks[factionIndex(opp)].rankDistribution();
            for (int p = 0; p < kNumRankPlanes; p++) v[7 + p] += static_cast<float>(dist[p]);
        }
    }
    if (friendlyCount >= 2) v[14] = 1.f;
    if (friendlyCount >= 3) v[15] = 1.f;
    if (friendlyCount >= 4) v[16] = 1.f;
    if (enemyCount >= 2) v[17] = 1.f;
    if (enemyCount >= 3) v[18] = 1.f;
    if (enemyCount >= 4) v[19] = 1.f;
    if (anyHiddenEnemy) v[20] = 1.f;
    return v;
}

std::vector<WeightedFeature> fullPieceSquareFeatures(const Board& board, Faction perspective,
                                                       const BeliefState& belief, bool concreteKnown) {
    std::vector<WeightedFeature> out;
    out.reserve(256);
    for (int y = 0; y < kBoardSize; y++) {
        for (int x = 0; x < kBoardSize; x++) {
            Coordinate sq{static_cast<int8_t>(x), static_cast<int8_t>(y)};
            auto v = squarePlaneVector(board, sq, perspective, belief, concreteKnown);
            int base = squareIndex(sq) * kPlanesPerSquare;
            for (int p = 0; p < kPlanesPerSquare; p++) {
                if (v[p] != 0.f) out.push_back({base + p, v[p]});
            }
        }
    }
    return out;
}

namespace {

int gamePhaseIndexImpl(const Board& board) {
    int totalPieces = 0;
    for (int x = 0; x < kBoardSize; x++)
        for (int y = 0; y < kBoardSize; y++) totalPieces += board.grid[x][y].count;
    int acesLeft = board.acesAlive[0] + board.acesAlive[1];
    if (board.totalPlies < 10) return 0;       // opening
    if (acesLeft <= 2 || totalPieces <= 6) return 2; // endgame
    return 1;                                   // midgame
}

} // namespace

int gamePhaseIndex(const Board& board) { return gamePhaseIndexImpl(board); }

// Sum of combat values of `f`'s own on-board cards. Always exact: a faction's
// own cards are, by definition, never hidden from itself.
float materialSum(const Board& board, Faction f) {
    float sum = 0.f;
    for (int x = 0; x < kBoardSize; x++)
        for (int y = 0; y < kBoardSize; y++)
            for (int i = 0; i < board.grid[x][y].count; i++)
                if (board.grid[x][y].cards[i].owner == f) sum += static_cast<float>(board.grid[x][y].cards[i].value());
    return sum;
}

float territoryFraction(const Board& board, Faction f) {
    int n = 0;
    for (int x = 0; x < kBoardSize; x++)
        for (int y = 0; y < kBoardSize; y++)
            if (board.grid[x][y].countOwner(f) > board.grid[x][y].countOwner(otherFaction(f))) n++;
    return static_cast<float>(n) / static_cast<float>(kNumSquares);
}

namespace {

// Expected material for a faction whose *own* cards are always concrete —
// only meaningful as "expected" when summing the OPPONENT's hidden pieces
// under the current belief distribution (used by globalFeatures()).
float expectedMaterialUnderBelief(const Board& board, Faction of, const BeliefState& belief, bool concreteKnown) {
    float sum = 0.f;
    const DeckPool& pool = belief.decks[factionIndex(of)];
    auto dist = pool.rankDistribution();
    float expectedRankValue = 0.f;
    for (int p = 0; p < kNumRankPlanes; p++) expectedRankValue += static_cast<float>(dist[p]) * combatValue(kAllRanks[p]);

    for (int x = 0; x < kBoardSize; x++) {
        for (int y = 0; y < kBoardSize; y++) {
            const Tile& t = board.grid[x][y];
            for (int i = 0; i < t.count; i++) {
                const Card& c = t.cards[i];
                if (c.owner != of) continue;
                if (c.revealed || concreteKnown) sum += static_cast<float>(c.value());
                else sum += expectedRankValue;
            }
        }
    }
    return sum;
}

} // namespace

std::array<float, kNumGlobalFeatures> globalFeatures(const Board& board, Faction perspective, int movesRemaining,
                                                       Faction currentMover, const BeliefState& belief,
                                                       bool concreteKnown) {
    std::array<float, kNumGlobalFeatures> g{};
    Faction opp = otherFaction(perspective);
    int pi = factionIndex(perspective), oi = factionIndex(opp);

    g[0] = board.acesAlive[pi] / 2.0f;
    g[1] = board.acesAlive[oi] / 2.0f;
    g[2] = board.drawPileSize[pi] / 6.0f;
    g[3] = board.drawPileSize[oi] / 6.0f;
    g[4] = movesRemaining / 3.0f;
    g[5] = (movesRemaining == kMovesPerTurn) ? 1.f : 0.f;
    g[6] = std::min(1.0f, board.totalPlies / 60.0f);
    g[7] = std::min(1.0f, board.inactivityPlies / static_cast<float>(std::max(1, board.maxInactivityPlies)));

    int phase = gamePhaseIndex(board);
    g[8] = (phase == 0) ? 1.f : 0.f;
    g[9] = (phase == 1) ? 1.f : 0.f;
    g[10] = (phase == 2) ? 1.f : 0.f;

    g[11] = materialSum(board, perspective) / 80.0f; // own cards are always concrete
    g[12] = expectedMaterialUnderBelief(board, opp, belief, concreteKnown) / 80.0f;

    double maxEntropy = std::log2(static_cast<double>(kPersonalDeck));
    g[13] = maxEntropy > 0 ? static_cast<float>(belief.entropyBits(opp) / maxEntropy) : 0.f;

    auto dist = belief.decks[oi].rankDistribution();
    for (int p = 0; p < kNumRankPlanes; p++) g[14 + p] = static_cast<float>(dist[p]);

    int ownCount = 0, enemyRevealedCount = 0, enemyHiddenCount = 0;
    int ownAlone = 0, ownStacked = 0, ownTotalForStackFrac = 0;
    float expectedEnemyLoneAce = 0.f;
    for (int x = 0; x < kBoardSize; x++) {
        for (int y = 0; y < kBoardSize; y++) {
            const Tile& t = board.grid[x][y];
            int ownHere = t.countOwner(perspective);
            if (ownHere > 0) {
                ownCount += ownHere;
                ownTotalForStackFrac += ownHere;
                if (ownHere == 1) {
                    // Is this lone own card an ace? Own cards are always known.
                    for (int i = 0; i < t.count; i++)
                        if (t.cards[i].owner == perspective && t.cards[i].rank == RankVal::Ace) ownAlone++;
                } else {
                    ownStacked += ownHere;
                }
            }
            int enemyHere = t.countOwner(opp);
            if (enemyHere > 0) {
                for (int i = 0; i < t.count; i++) {
                    if (t.cards[i].owner != opp) continue;
                    if (t.cards[i].revealed) enemyRevealedCount++;
                    else enemyHiddenCount++;
                }
                if (enemyHere == 1 && !t.cards[0].revealed && t.cards[0].owner == opp) {
                    expectedEnemyLoneAce += static_cast<float>(belief.decks[oi].rankProbability(RankVal::Ace));
                }
            }
        }
    }
    g[21] = ownCount / 13.0f;
    g[22] = enemyRevealedCount / 13.0f;
    g[23] = (currentMover == perspective) ? 1.f : 0.f;
    g[24] = territoryFraction(board, perspective);
    g[25] = territoryFraction(board, opp);
    g[26] = ownAlone / 2.0f;
    g[27] = std::min(2.0f, expectedEnemyLoneAce) / 2.0f;
    g[28] = ownTotalForStackFrac > 0 ? static_cast<float>(ownStacked) / ownTotalForStackFrac : 0.f;
    g[29] = enemyHiddenCount / 13.0f;
    return g;
}

} // namespace checards
