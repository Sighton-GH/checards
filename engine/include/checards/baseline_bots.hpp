#pragma once
// =============================================================================
// baseline_bots.hpp — "multi personality opponents during training" and
// "short pre-training generated from minimax bots with varying
// personalities" from the brainstorm notes.
//
// These are deliberately cheap (a single determinized sample + 1-ply
// lookahead, no tree search) so thousands of self-play games against a
// varied roster of them are affordable early in training, before the NNUE
// is any good — and so the trained bot always has a fast, legible sanity
// opponent to benchmark against later. They respect the same fog of war as
// the real engine (each bot keeps its own BeliefState and evaluates
// candidates against one determinized sample, never the true hidden board),
// so they are a fair, if simple-minded, opponent rather than a cheating one.
// =============================================================================

#include <random>
#include <string>
#include <vector>
#include "checards/belief.hpp"
#include "checards/board.hpp"
#include "checards/combat.hpp"
#include "checards/features.hpp"
#include "checards/rules.hpp"

namespace checards {

struct Personality {
    std::string name = "balanced";
    float aggression = 1.0f;   // weight on capturing / material swing this move creates
    float materialism = 1.0f;  // weight on raw card-value sums
    float positional = 0.5f;   // weight on territory control
    float aceSafety = 1.0f;    // penalty weight for leaving own aces alone/unstacked
    float temperature = 40.0f; // softmax temperature over heuristic scores (0 = pure greedy)
};

inline std::vector<Personality> defaultPersonalityRoster() {
    return {
        {"aggressive", 2.0f, 0.8f, 0.2f, 0.4f, 30.0f},
        {"turtle",     0.5f, 1.0f, 0.6f, 2.0f, 30.0f},
        {"material",   1.0f, 2.0f, 0.2f, 0.8f, 30.0f},
        {"positional", 0.8f, 0.6f, 2.0f, 1.0f, 30.0f},
        {"gambler",    1.2f, 1.0f, 0.5f, 0.3f, 90.0f}, // high temperature: noisy, unpredictable
        {"balanced",   1.0f, 1.0f, 0.5f, 1.0f, 40.0f},
    };
}

class BaselineBot {
public:
    Faction faction;
    Personality personality;
    std::mt19937 rng;

    BaselineBot(Faction f, Personality p, uint64_t seed) : faction(f), personality(std::move(p)), rng(seed) {}

    struct SetupChoice {
        std::vector<Card> draft;          // includes the 2 mandatory aces first
        std::vector<Coordinate> placement; // parallel array
    };

    SetupChoice chooseSetup(const Board& currentBoard, std::vector<Card> availableNonAceCards,
                             const std::array<Card, 2>& aces, int iterations = 300) {
        SetupChoice best;
        float bestScore = -1e18f;
        int yStart = (faction == Faction::Red) ? 0 : kBoardSize - kSetupBandRows;

        for (int it = 0; it < iterations; it++) {
            std::vector<Card> draft = {aces[0], aces[1]};
            std::vector<Card> pool = availableNonAceCards;
            std::shuffle(pool.begin(), pool.end(), rng);
            for (int i = 0; i < 5 && i < static_cast<int>(pool.size()); i++) draft.push_back(pool[i]);

            Board trial = currentBoard;
            std::vector<Coordinate> placement;
            bool ok = true;
            for (auto& c : draft) {
                Coordinate pos;
                int attempts = 0;
                do {
                    pos.x = static_cast<int8_t>(rng() % kBoardSize);
                    pos.y = static_cast<int8_t>(yStart + rng() % kSetupBandRows);
                    if (++attempts > 200) { ok = false; break; }
                } while (!legalSetupSquare(trial, faction, pos));
                if (!ok) break;
                Card placed = c;
                placed.isInitial = true;
                trial.at(pos).push(placed);
                placement.push_back(pos);
            }
            if (!ok) continue;

            float score = heuristicValue(trial);
            if (score > bestScore) { bestScore = score; best.draft = draft; best.placement = placement; }
        }
        return best;
    }

    // Picks one atomic action. Caller is responsible for checking legal
    // actions are non-empty first (a bot with zero legal actions should
    // never be asked to choose).
    Action chooseAction(const Board& trueBoard, const TurnContext& ctx, const BeliefState& belief) {
        auto legal = generateLegalActions(trueBoard, ctx);
        if (legal.empty()) return Action{};

        Determinization det = determinize(trueBoard, faction, belief, rng);
        std::vector<float> scores(legal.size());
        int oppCardsBefore = 0;
        for (int x = 0; x < kBoardSize; x++)
            for (int y = 0; y < kBoardSize; y++) oppCardsBefore += det.board.grid[x][y].countOwner(otherFaction(faction));

        for (size_t i = 0; i < legal.size(); i++) {
            Board trial = det.board;
            TurnContext trialCtx = ctx;
            ApplyOutcome outcome;
            if (legal[i].isSpawn) {
                Rank r = RankVal::Nine;
                Suit s = suitsOf(faction)[0];
                int fi = factionIndex(faction);
                if (!det.futureDraws[fi].empty()) { r = det.futureDraws[fi][0].first; s = det.futureDraws[fi][0].second; }
                outcome = applyAction(trial, trialCtx, legal[i], r, s);
            } else {
                outcome = applyAction(trial, trialCtx, legal[i]);
            }
            if (outcome.turnEnded) resolveAllCombats(trial, faction);
            scores[i] = heuristicValue(trial);

            if (personality.aggression != 1.0f) {
                int oppCardsAfter = 0;
                for (int x = 0; x < kBoardSize; x++)
                    for (int y = 0; y < kBoardSize; y++) oppCardsAfter += trial.grid[x][y].countOwner(otherFaction(faction));
                int captured = std::max(0, oppCardsBefore - oppCardsAfter);
                scores[i] += (personality.aggression - 1.0f) * captured * 15.f;
            }
        }

        if (personality.temperature <= 1e-4f) {
            size_t bestIdx = 0;
            for (size_t i = 1; i < scores.size(); i++) if (scores[i] > scores[bestIdx]) bestIdx = i;
            return legal[bestIdx];
        }
        float maxS = *std::max_element(scores.begin(), scores.end());
        std::vector<double> w(scores.size());
        for (size_t i = 0; i < scores.size(); i++) {
            w[i] = std::exp(static_cast<double>(scores[i] - maxS) / personality.temperature);
        }
        std::discrete_distribution<size_t> dist(w.begin(), w.end());
        return legal[dist(rng)];
    }

private:
    float heuristicValue(const Board& board) const {
        Faction opp = otherFaction(faction);
        float score = 0.f;
        int myAces = 0, oppAces = 0;
        for (int x = 0; x < kBoardSize; x++) {
            for (int y = 0; y < kBoardSize; y++) {
                const Tile& t = board.grid[x][y];
                for (int i = 0; i < t.count; i++) {
                    const Card& c = t.cards[i];
                    float v;
                    if (c.rank == RankVal::Ace) { v = 50.f; if (c.owner == faction) myAces++; else oppAces++; }
                    else if (c.rank == RankVal::Joker) v = 42.f;
                    else v = static_cast<float>(c.rank) * personality.materialism;
                    score += (c.owner == faction) ? v : -v;
                }
                int mine = t.countOwner(faction);
                if (mine == 1) {
                    for (int i = 0; i < t.count; i++)
                        if (t.cards[i].owner == faction && t.cards[i].rank == RankVal::Ace)
                            score -= personality.aceSafety * 40.f; // lone ace: one attack from death, per combat.hpp rule 1
                }
            }
        }
        if (oppAces == 0) return 1e6f;
        if (myAces == 0) return -1e6f;

        int myTerr = 0, oppTerr = 0;
        for (int x = 0; x < kBoardSize; x++)
            for (int y = 0; y < kBoardSize; y++) {
                if (board.grid[x][y].countOwner(faction) > board.grid[x][y].countOwner(opp)) myTerr++;
                else if (board.grid[x][y].countOwner(opp) > board.grid[x][y].countOwner(faction)) oppTerr++;
            }
        score += personality.positional * static_cast<float>(myTerr - oppTerr);
        return score;
    }
};

} // namespace checards
