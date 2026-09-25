#pragma once
// =============================================================================
// legacy_hybrid.hpp — hybrid_engine_3.hpp adapted as a benchmark opponent.
//
// PORTED EXACTLY (verified against the uploaded source, and bob.bin's byte
// size matches this format precisely — 686*32*8 + 32*8 + 32*8 + 8 bytes):
//   - NNUEEvaluator: 686 inputs (49 tiles x 7 ranks x 2 owners), 32 hidden
//     (ReLU), 1 output (tanh). Feature index = (owner==perspective?0:343) +
//     rankIdx*49 + tileIndex, rankIdx: Joker->0, Ace->1, {9..13}->{2..6}.
//   - evaluateBoardState: Ace=500, Joker=425, {9..13}=rank*10, -50 if an own
//     Ace/Joker is revealed, +-999999 terminal spikes.
//   - Leaf blend: terminal states use depth-adjusted +-1; otherwise
//     0.75*tanh(heuristic/1000) + 0.25*nnueEval.
//   - PUCT with cpuct=1.5, root Dirichlet noise (alpha=0.3, epsilon=0.25),
//     uniform (not learned) priors — the original had no policy head.
//   - Immediate-forced-win shortcut checked before searching.
//   - Default 1000ms search, rebuilt fresh every micro-move (no subtree
//     reuse — that's a genuine inefficiency in the original, not a
//     behavioral trait worth preserving, but reproducing it keeps this
//     port simple and single-threaded, which is all a benchmark opponent
//     needs to be).
//
// DELIBERATELY NOT PORTED: the original's own move generation (missing
// frozen-piece tracking) and its independent-per-square determinization
// (could invent extra Aces) — seeULE README.md sections 2-3. Running the
// old brain on buggy mechanics wouldn't make it a more faithful opponent,
// just a differently-broken one; this uses rules.hpp/combat.hpp/belief.hpp
// throughout so games are actually rules-legal on both sides.
// =============================================================================

#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <memory>
#include <random>
#include <vector>
#include "checards/belief.hpp"
#include "checards/board.hpp"
#include "checards/combat.hpp"
#include "checards/mcts_node.hpp"
#include "checards/rules.hpp"
#include "checards/selfplay.hpp"

namespace checards {
namespace legacy {

constexpr int kLegacyInputSize = 686;
constexpr int kLegacyHiddenSize = 32;

inline int legacyRankIdx(Rank r) {
    if (r == RankVal::Joker) return 0;
    if (r == RankVal::Ace) return 1;
    return static_cast<int>(r) - 7; // 9->2, 10->3, 11->4, 12->5, 13->6
}

class LegacyNNUE {
public:
    std::vector<std::vector<double>> inputWeights; // [686][32]
    std::vector<double> hiddenBiases;               // [32]
    std::vector<double> outputWeights;               // [32]
    double outputBias = 0.0;
    bool loaded = false;

    bool loadWeights(const std::string& filename) {
        std::ifstream in(filename, std::ios::binary);
        if (!in.is_open()) return false;
        inputWeights.assign(kLegacyInputSize, std::vector<double>(kLegacyHiddenSize));
        hiddenBiases.assign(kLegacyHiddenSize, 0.0);
        outputWeights.assign(kLegacyHiddenSize, 0.0);
        for (int i = 0; i < kLegacyInputSize; i++)
            in.read(reinterpret_cast<char*>(inputWeights[i].data()), kLegacyHiddenSize * sizeof(double));
        in.read(reinterpret_cast<char*>(hiddenBiases.data()), kLegacyHiddenSize * sizeof(double));
        in.read(reinterpret_cast<char*>(outputWeights.data()), kLegacyHiddenSize * sizeof(double));
        in.read(reinterpret_cast<char*>(&outputBias), sizeof(double));
        loaded = static_cast<bool>(in) && !inputWeights.empty();
        return loaded;
    }

    // `board` must already be concrete (post-determinization) — the
    // original always evaluated determinized boards, never a fog-of-war one.
    double evaluate(const Board& board, Faction perspective) const {
        std::vector<double> hidden(kLegacyHiddenSize, 0.0);
        for (int x = 0; x < kBoardSize; x++) {
            for (int y = 0; y < kBoardSize; y++) {
                int tileIndex = y * kBoardSize + x; // matches action.hpp's squareIndex()
                const Tile& t = board.grid[x][y];
                for (int i = 0; i < t.count; i++) {
                    const Card& c = t.cards[i];
                    int rankIdx = legacyRankIdx(c.rank);
                    int featureIndex = (c.owner == perspective ? 0 : 343) + rankIdx * 49 + tileIndex;
                    const auto& row = inputWeights[featureIndex];
                    for (int j = 0; j < kLegacyHiddenSize; j++) hidden[j] += row[j];
                }
            }
        }
        double value = outputBias;
        for (int j = 0; j < kLegacyHiddenSize; j++) {
            double activated = std::max(0.0, hidden[j] + hiddenBiases[j]);
            value += activated * outputWeights[j];
        }
        return std::tanh(value);
    }
};

inline int legacyHeuristicScore(const Board& board, Faction myFaction) {
    int score = 0, myAces = 0, enemyAces = 0;
    for (int x = 0; x < kBoardSize; x++) {
        for (int y = 0; y < kBoardSize; y++) {
            const Tile& t = board.grid[x][y];
            for (int i = 0; i < t.count; i++) {
                const Card& c = t.cards[i];
                int cardValue = 0;
                if (c.rank == RankVal::Ace) {
                    if (c.owner == myFaction) myAces++; else enemyAces++;
                    cardValue = 500;
                } else if (c.rank == RankVal::Joker) {
                    cardValue = 425;
                } else if (c.rank >= RankVal::Nine && c.rank <= RankVal::King) {
                    cardValue = static_cast<int>(c.rank) * 10;
                }
                if (c.owner == myFaction && c.revealed && c.rank <= RankVal::Ace) cardValue -= 50;
                score += (c.owner == myFaction) ? cardValue : -cardValue;
            }
        }
    }
    if (enemyAces == 0) return 999999;
    if (myAces == 0) return -999999;
    return score;
}

class LegacyHybridBot {
public:
    Faction faction;
    LegacyNNUE nnue;
    BeliefState belief;
    std::mt19937 rng;
    double cpuct = 1.5;
    double dirichletAlpha = 0.3;
    double dirichletEpsilon = 0.25;
    int timeLimitMs = 1000;

    explicit LegacyHybridBot(Faction f, uint64_t seed) : faction(f), rng(seed) { belief.resetForNewGame(); }

    bool loadWeights(const std::string& path) { return nnue.loadWeights(path); }

    void performSetup(Board& board, int iterations = 3000) {
        std::vector<Card> deck = AIPlayer::fullPersonalDeck(faction);
        std::array<Card, 2> aces{};
        std::vector<Card> nonAce;
        int ai = 0;
        for (auto& c : deck) { if (c.rank == RankVal::Ace) aces[ai++] = c; else nonAce.push_back(c); }

        std::vector<Card> bestDraft;
        std::vector<Coordinate> bestPlacement;
        double bestScore = -1e18;
        int yStart = (faction == Faction::Red) ? 0 : kBoardSize - kSetupBandRows;

        for (int it = 0; it < iterations; it++) {
            std::vector<Card> draft = {aces[0], aces[1]};
            std::vector<Card> pool = nonAce;
            std::shuffle(pool.begin(), pool.end(), rng);
            for (int i = 0; i < 5 && i < static_cast<int>(pool.size()); i++) draft.push_back(pool[i]);

            Board trial = board;
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

            double score = nnue.evaluate(trial, faction); // original scored setup via NNUE alone, no heuristic blend
            std::uniform_real_distribution<double> noise(-1e-4, 1e-4);
            score += noise(rng);
            if (score > bestScore) { bestScore = score; bestDraft = draft; bestPlacement = placement; }
        }

        for (size_t i = 0; i < bestDraft.size(); i++) {
            Card placed = bestDraft[i];
            placed.isInitial = true;
            board.at(bestPlacement[i]).push(placed);
        }
        board.drawPileSize[factionIndex(faction)] = static_cast<int>(nonAce.size()) - 5;
    }

    Action chooseAction(const Board& trueBoard, const TurnContext& ctx) {
        auto legal = generateLegalActions(trueBoard, ctx);
        if (legal.empty()) return Action{};

        // Forced-win shortcut (moveCreatesImmediateWin in the original).
        for (auto& a : legal) {
            Board trial = trueBoard;
            TurnContext trialCtx = ctx;
            Rank sr = RankVal::Nine;
            Suit ss = suitsOf(faction)[0];
            ApplyOutcome outcome = applyAction(trial, trialCtx, a, sr, ss);
            if (outcome.turnEnded) resolveAllCombats(trial, faction);
            if (trial.acesAlive[factionIndex(otherFaction(faction))] <= 0) return a;
        }

        auto root = std::make_unique<MCTSNode>();
        root->toMoveAfter = ctx.mover;
        root->moverAtNode = faction; // convention: root has no real incoming action, treat as this bot's own
        expandUniform(root.get(), legal, /*isRoot=*/true);

        auto start = std::chrono::steady_clock::now();
        int iterations = 0;
        while (true) {
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
            if (elapsed >= timeLimitMs) break;
            runOneIteration(root.get(), trueBoard, ctx);
            iterations++;
            if (iterations > 200000) break; // safety net
        }

        int maxVisits = -1;
        Action best = legal[0];
        for (auto& c : root->children) {
            int v = c->visits.load();
            if (v > maxVisits) { maxVisits = v; best = c->action; }
        }
        return best;
    }

    void observeExternalAction(const Action&, bool, Faction, const Board&, const TurnContext&,
                                const std::vector<CombatEvent>* events) {
        if (events) {
            for (const auto& ev : *events) {
                for (const auto& c : ev.attackerCards) belief.onReveal(c.rank, c.suit, c.owner);
                for (const auto& c : ev.defenderCards) belief.onReveal(c.rank, c.suit, c.owner);
            }
        }
    }

private:
    void expandUniform(MCTSNode* node, const std::vector<Action>& actions, bool isRoot) {
        double uniform = 1.0 / std::max<size_t>(1, actions.size());
        std::vector<double> noise(actions.size(), uniform);
        if (isRoot && !actions.empty()) {
            std::gamma_distribution<double> gamma(dirichletAlpha, 1.0);
            std::vector<double> g(actions.size());
            double sum = 0;
            for (auto& x : g) { x = std::max(1e-6, gamma(rng)); sum += x; }
            for (auto& x : g) x /= sum;
            noise = g;
        }
        node->children.reserve(actions.size());
        for (size_t i = 0; i < actions.size(); i++) {
            auto child = std::make_unique<MCTSNode>();
            child->action = actions[i];
            child->parent = node;
            child->prior = static_cast<float>(isRoot ? (1.0 - dirichletEpsilon) * uniform + dirichletEpsilon * noise[i]
                                                       : uniform);
            node->children.push_back(std::move(child));
        }
        node->expanded.store(true);
    }

    MCTSNode* selectChild(MCTSNode* node) {
        int parentVisits = node->visits.load();
        // FPU here borrows the parent's raw q() with no perspective
        // conversion, exactly matching the original's literal
        // `node->totalValue / node->visits` — this project's own SearchTree
        // (search.cpp) converts this properly via valueFromMoverPerspective,
        // but that's a deliberate improvement over the original algorithm,
        // not a faithfulness bug; this port intentionally keeps the
        // original's (mildly imprecise, only-matters-for-FPU) behavior.
        // Visited children's own q() needs no such conversion: they always
        // share moverAtNode == node->toMoveAfter by construction, so
        // comparing their raw q() values directly is always correct.
        double parentQ = node->q();
        MCTSNode* best = nullptr;
        double bestScore = -1e18;
        for (auto& c : node->children) {
            int cv = c->visits.load();
            double q = (cv > 0) ? c->q() : parentQ;
            double u = cpuct * c->prior * std::sqrt(static_cast<double>(std::max(1, parentVisits))) / (1.0 + cv);
            double score = q + u;
            if (score > bestScore) { bestScore = score; best = c.get(); }
        }
        return best;
    }

    void runOneIteration(MCTSNode* root, const Board& trueBoard, const TurnContext& rootCtx) {
        Determinization det = determinize(trueBoard, faction, belief, rng);
        Board simBoard = det.board;
        TurnContext ctx = rootCtx;
        size_t futureCursor[2] = {0, 0};

        root->visits.fetch_add(1);
        MCTSNode* node = root;
        int depth = 0;

        while (!simBoard.isTerminal() && node->expanded.load() && !node->children.empty()) {
            MCTSNode* chosen = selectChild(node);
            if (!chosen) break;
            chosen->visits.fetch_add(1);

            Faction mover = ctx.mover;
            Rank spawnRank = RankVal::Joker;
            Suit spawnSuit = SuitVal::JokerSuit;
            if (chosen->action.isSpawn) {
                int fi = factionIndex(mover);
                if (futureCursor[fi] < det.futureDraws[fi].size()) {
                    spawnRank = det.futureDraws[fi][futureCursor[fi]].first;
                    spawnSuit = det.futureDraws[fi][futureCursor[fi]].second;
                    futureCursor[fi]++;
                }
                ApplyOutcome out = applyAction(simBoard, ctx, chosen->action, spawnRank, spawnSuit);
                if (out.turnEnded) {
                    resolveAllCombats(simBoard, mover);
                    if (!simBoard.isTerminal()) ctx.resetForNewTurn(otherFaction(mover));
                }
            } else {
                ApplyOutcome out = applyAction(simBoard, ctx, chosen->action);
                if (out.turnEnded) {
                    resolveAllCombats(simBoard, mover);
                    if (!simBoard.isTerminal()) ctx.resetForNewTurn(otherFaction(mover));
                }
            }
            node = chosen;
            depth++;
        }

        double leafValue;
        if (simBoard.isTerminal()) {
            bool won = (simBoard.endCondition == EndCondition::RedWins && faction == Faction::Red) ||
                       (simBoard.endCondition == EndCondition::BlackWins && faction == Faction::Black);
            bool lost = (simBoard.endCondition == EndCondition::RedWins && faction == Faction::Black) ||
                        (simBoard.endCondition == EndCondition::BlackWins && faction == Faction::Red);
            leafValue = won ? 1.0 : (lost ? -1.0 : 0.0);
        } else {
            if (!node->expanded.load()) {
                auto acts = generateLegalActions(simBoard, ctx);
                if (!acts.empty()) expandUniform(node, acts, false);
            }
            int heuristicScore = legacyHeuristicScore(simBoard, faction);
            if (heuristicScore >= 999999) {
                leafValue = 1.0 - depth * 0.001;
            } else if (heuristicScore <= -999999) {
                leafValue = -1.0 + depth * 0.001;
            } else {
                double heuristicEval = std::tanh(heuristicScore / 1000.0);
                double nnueEval = nnue.evaluate(simBoard, faction);
                leafValue = 0.75 * heuristicEval + 0.25 * nnueEval;
            }
        }

        // leafValue is always expressed in `faction`'s (this bot's own, and
        // the tree root's) perspective. Every OTHER node's valueSum must be
        // expressed in *its own* moverAtNode's perspective for PUCT
        // maximization to correctly model an adversarial opponent — see the
        // long comment above SearchTree::runOneIteration in search.cpp for
        // the full derivation. This mirrors the original engine's backprop
        // exactly: `perspectiveValue = (node->parent->turnToMove == faction)
        // ? leafValue : -leafValue`. Root's moverAtNode is set to `faction`
        // by convention in chooseAction() below, so this formula applies
        // uniformly including at the root.
        MCTSNode* n = node;
        while (n != nullptr) {
            double contribution = (n->moverAtNode == faction) ? leafValue : -leafValue;
            atomicAddDouble(n->valueSum, contribution);
            n = n->parent;
        }
    }
};

} // namespace legacy

// GameActor wrapper so LegacyHybridBot drops directly into selfplay.hpp's
// playGame()/TrainingHarness.
class LegacyHybridActor : public GameActor {
public:
    legacy::LegacyHybridBot bot;
    explicit LegacyHybridActor(Faction f, uint64_t seed) : bot(f, seed) {}

    Faction faction() const override { return bot.faction; }
    void performSetup(Board& board) override { bot.performSetup(board); }
    Action chooseAction(const Board& trueBoard, const TurnContext& ctx) override {
        return bot.chooseAction(trueBoard, ctx);
    }
    void observe(const Action& action, bool wasAttack, Faction mover, const Board& boardAfter,
                 const TurnContext& ctxAfter, const std::vector<CombatEvent>* events) override {
        bot.observeExternalAction(action, wasAttack, mover, boardAfter, ctxAfter, events);
    }
    bool wantsTrainingData() const override { return false; }
    void recordDecision(std::vector<TrainingExample>&, const Board&, const TurnContext&) override {}
};

} // namespace checards
