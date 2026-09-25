#pragma once
// =============================================================================
// ai_player.hpp — the bot itself: setup-phase placement + turn-phase search,
// with belief and the persistent search tree kept in sync by the driver
// calling observeExternalAction() after *every* atomic action in the game
// (this AI's own moves included, not just the opponent's).
//
// This uniform "observe everything" contract is deliberate: rather than one
// code path for "my move just happened" and a different one for "the
// opponent just moved" (a common source of subtle desync bugs — belief and
// the search tree only need to be correct, they don't care who acted), the
// driver (selfplay.cpp / main.cpp) treats every action identically.
// =============================================================================

#include <algorithm>
#include <memory>
#include <random>
#include <vector>
#include "checards/belief.hpp"
#include "checards/board.hpp"
#include "checards/combat.hpp"
#include "checards/features.hpp"
#include "checards/network.hpp"
#include "checards/opponent_model.hpp"
#include "checards/rules.hpp"
#include "checards/search.hpp"

namespace checards {

class AIPlayer {
public:
    Faction faction;
    Network* network;
    BeliefState belief;
    OpponentModel opponentModel;
    SearchConfig searchConfig;
    std::mt19937 rng;
    std::unique_ptr<SearchTree> tree;
    SearchTree::SearchResult lastSearchResult; // stashed for training-data recording by selfplay.cpp

    AIPlayer(Faction f, Network* net, SearchConfig cfg, uint64_t seed)
        : faction(f), network(net), searchConfig(cfg), rng(seed) {
        belief.resetForNewGame();
    }

    static std::vector<Card> fullPersonalDeck(Faction f) {
        std::vector<Card> deck;
        deck.push_back(Card(RankVal::Joker, SuitVal::JokerSuit, f));
        auto suits = suitsOf(f);
        deck.push_back(Card(RankVal::Ace, suits[0], f));
        deck.push_back(Card(RankVal::Ace, suits[1], f));
        for (Rank r : {RankVal::Nine, RankVal::Ten, RankVal::Jack, RankVal::Queen, RankVal::King}) {
            deck.push_back(Card(r, suits[0], f));
            deck.push_back(Card(r, suits[1], f));
        }
        return deck;
    }

    // Chooses 5 non-ace cards + placements for all 7 starting cards and
    // commits them directly onto `board`. `board` may already contain the
    // *other* player's placed-but-hidden cards if we're setting up second —
    // exactly like the reference engine, we can see their positions (fog of
    // war hides identity, not presence) and evaluation is fog-aware, so this
    // naturally "counter-picks" placement relative to visible enemy squares.
    void performSetup(Board& board, int setupIterations = 600) {
        belief.resetForNewGame();
        std::vector<Card> deck = fullPersonalDeck(faction);
        std::array<Card, 2> aces{};
        std::vector<Card> nonAcePool;
        int ai = 0;
        for (auto& c : deck) { if (c.rank == RankVal::Ace) aces[ai++] = c; else nonAcePool.push_back(c); }

        std::vector<Card> bestDraft;
        std::vector<Coordinate> bestPlacement;
        float bestScore = -1e18f;
        int yStart = (faction == Faction::Red) ? 0 : kBoardSize - kSetupBandRows;

        for (int it = 0; it < setupIterations; it++) {
            std::vector<Card> draft = {aces[0], aces[1]};
            std::vector<Card> pool = nonAcePool;
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

            auto sparse = fullPieceSquareFeatures(trial, faction, belief, false);
            auto glob = globalFeatures(trial, faction, kMovesPerTurn, faction, belief, false);
            auto out = network->forward(sparse, glob, nullptr);
            float score = out.wdl[0] - out.wdl[2];
            std::uniform_real_distribution<float> noise(-1e-4f, 1e-4f);
            score += noise(rng);
            if (score > bestScore) { bestScore = score; bestDraft = draft; bestPlacement = placement; }
        }

        for (size_t i = 0; i < bestDraft.size(); i++) {
            Card placed = bestDraft[i];
            placed.isInitial = true;
            board.at(bestPlacement[i]).push(placed);
        }
        board.drawPileSize[factionIndex(faction)] = static_cast<int>(nonAcePool.size()) - 5; // 11-5=6
    }

    Action chooseTurnAction(const Board& trueBoard, const TurnContext& ctx) {
        // No legal action at all: return the invalid Action{} sentinel. The
        // driver (selfplay.cpp / main.cpp) turns that into a rules-conformant
        // pass; spending search budget on an unexpandable root would produce
        // the same sentinel anyway, just slower.
        if (generateLegalActions(trueBoard, ctx).empty()) return Action{};
        if (!tree) {
            tree = std::make_unique<SearchTree>(faction, network, searchConfig);
            // Seed from our own (caller-seeded) RNG so the whole game —
            // setup, Dirichlet noise, determinizations — is reproducible
            // from the AIPlayer's constructor seed alone.
            tree->setMasterSeed(rng());
            tree->resetRoot(trueBoard, ctx, belief);
        }
        tree->opponentModel = &opponentModel;
        lastSearchResult = tree->search();
        return lastSearchResult.bestAction;
    }

    // Call after EVERY atomic action in the game (this player's own moves
    // included). `combatEvents` should be non-null only on the action that
    // ended a turn and triggered resolveAllCombats().
    void observeExternalAction(const Action& action, bool wasAttack, Faction mover, const Board& boardAfterAction,
                                const TurnContext& ctxAfterAction, const std::vector<CombatEvent>* combatEvents) {
        if (combatEvents) {
            for (const auto& ev : *combatEvents) {
                for (const auto& c : ev.attackerCards) belief.onReveal(c.rank, c.suit, c.owner);
                for (const auto& c : ev.defenderCards) belief.onReveal(c.rank, c.suit, c.owner);
            }
        }
        // Invalid (pass) actions carry no histogram-usable index; they only
        // sync belief (above) and reset the tree root (below).
        if (mover != faction && (action.isSpawn || action.from.valid()))
            opponentModel.recordRealAction(action, wasAttack, mover, &boardAfterAction);
        if (tree) tree->advanceRoot(action, boardAfterAction, ctxAfterAction, belief);
    }
};

} // namespace checards
