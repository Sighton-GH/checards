#pragma once
// =============================================================================
// selfplay.hpp — plays games, records training data, and trains the network.
//
// Every atomic action in a game is fed to BOTH players' observe() hooks
// (see ai_player.hpp's header comment for why "observe everything uniformly"
// is deliberate), which is what keeps belief and each side's persistent
// search tree correctly synchronized without special-casing "my move" vs
// "opponent's move" in the driver itself.
//
// GameActor is the abstraction that lets the same playGame() loop drive
// AI-vs-AI (true self-play — both sides trained on), AI-vs-baseline (only
// the learner's decisions are recorded), or baseline-vs-baseline (useful for
// quickly sanity-checking the rules engine at scale, no network involved).
// =============================================================================

#include <array>
#include <functional>
#include <memory>
#include <random>
#include <string>
#include <vector>
#include "checards/ai_player.hpp"
#include "checards/baseline_bots.hpp"
#include "checards/network.hpp"

namespace checards {

struct TrainingExample {
    std::vector<WeightedFeature> sparse;
    std::array<float, kNumGlobalFeatures> global{};
    std::array<float, kNumAtomicActions> tacticalPolicy{};
    std::array<float, kNumAtomicActions> strategicPolicy{};
    std::array<float, kNumSelectorActions> selectorPolicy{}; // per-tile normalized; all-zero tiles are loss-masked
    float gateTarget = 0.f;
    float rootValueEstimate = 0.f;
    std::array<float, kNumAtomicActions> rootActionValues{};
    std::array<uint8_t, kNumAtomicActions> rootActionValueMask{};
    std::array<int, kNumAtomicActions> rootActionVisits{};
    float materialTarget = 0.f;
    float territoryTarget = 0.f;
    std::array<float, 3> phaseTarget{};
    std::array<float, 3> wdlTarget{}; // filled in by backfillOutcome() once the game ends
    Faction perspective = Faction::None;
};

void backfillOutcome(std::vector<TrainingExample>& examples, EndCondition end);

class ReplayBuffer {
public:
    std::vector<TrainingExample> buffer;
    size_t maxSize;
    std::mt19937 rng;

    explicit ReplayBuffer(size_t maxSize_ = 60000, uint64_t seed = 1) : maxSize(maxSize_), rng(seed) {}

    void addGame(std::vector<TrainingExample>& gameExamples) {
        if (buffer.size() + gameExamples.size() > maxSize) {
            size_t overflow = std::min(buffer.size(), buffer.size() + gameExamples.size() - maxSize);
            buffer.erase(buffer.begin(), buffer.begin() + overflow);
        }
        for (auto& e : gameExamples) buffer.push_back(std::move(e));
    }

    std::vector<TrainingExample*> sampleBatch(size_t n) {
        std::vector<TrainingExample*> batch;
        if (buffer.empty()) return batch;
        std::uniform_int_distribution<size_t> dist(0, buffer.size() - 1);
        batch.reserve(n);
        for (size_t i = 0; i < n; i++) batch.push_back(&buffer[dist(rng)]);
        return batch;
    }

    // Selector-focused replay: sample only positions carrying at least one
    // non-uniform conditional stack target. This does not invent or alter
    // game states; it merely avoids spending selector-only updates on the
    // overwhelmingly common positions with no exact stacked-card choice.
    std::vector<TrainingExample*> sampleSelectorBatch(size_t n) {
        std::vector<size_t> eligible;
        eligible.reserve(buffer.size());
        for (size_t i = 0; i < buffer.size(); i++) {
            const auto& p = buffer[i].selectorPolicy;
            bool informative = false;
            for (int tile = 0; tile < kNumSquares && !informative; tile++) {
                float mass = 0.f, maxv = 0.f;
                int positive = 0;
                for (int slot = 0; slot < kMaxStack; slot++) {
                    float v = p[tile * kMaxStack + slot];
                    mass += v; maxv = std::max(maxv, v); if (v > 1e-6f) positive++;
                }
                informative = mass > 0.f && (positive > 1 || maxv < 0.999999f);
            }
            if (informative) eligible.push_back(i);
        }
        std::vector<TrainingExample*> batch;
        if (eligible.empty()) return batch;
        std::uniform_int_distribution<size_t> dist(0, eligible.size() - 1);
        batch.reserve(n);
        for (size_t i = 0; i < n; i++) batch.push_back(&buffer[eligible[dist(rng)]]);
        return batch;
    }
};

// --- GameActor: the common interface playGame() drives ---------------------
class GameActor {
public:
    virtual ~GameActor() = default;
    virtual Faction faction() const = 0;
    virtual void performSetup(Board& board) = 0;
    virtual Action chooseAction(const Board& trueBoard, const TurnContext& ctx) = 0;
    virtual void observe(const Action& action, bool wasAttack, Faction mover, const Board& boardAfter,
                          const TurnContext& ctxAfter, const std::vector<CombatEvent>* events) = 0;
    virtual bool wantsTrainingData() const = 0;
    virtual void recordDecision(std::vector<TrainingExample>& out, const Board& trueBoard, const TurnContext& ctx) = 0;
};

class AIActor : public GameActor {
public:
    AIPlayer player;
    explicit AIActor(Faction f, Network* net, SearchConfig cfg, uint64_t seed) : player(f, net, cfg, seed) {}

    Faction faction() const override { return player.faction; }
    void performSetup(Board& board) override { player.performSetup(board); }
    Action chooseAction(const Board& trueBoard, const TurnContext& ctx) override {
        return player.chooseTurnAction(trueBoard, ctx);
    }
    void observe(const Action& action, bool wasAttack, Faction mover, const Board& boardAfter,
                 const TurnContext& ctxAfter, const std::vector<CombatEvent>* events) override {
        player.observeExternalAction(action, wasAttack, mover, boardAfter, ctxAfter, events);
    }
    bool wantsTrainingData() const override { return true; }
    void recordDecision(std::vector<TrainingExample>& out, const Board& trueBoard, const TurnContext& ctx) override;
};

class BaselineActor : public GameActor {
public:
    BaselineBot bot;
    BeliefState belief;
    explicit BaselineActor(Faction f, Personality p, uint64_t seed) : bot(f, std::move(p), seed) {
        belief.resetForNewGame();
    }

    Faction faction() const override { return bot.faction; }
    void performSetup(Board& board) override {
        std::vector<Card> deck = AIPlayer::fullPersonalDeck(bot.faction);
        std::array<Card, 2> aces{};
        std::vector<Card> nonAce;
        int ai = 0;
        for (auto& c : deck) { if (c.rank == RankVal::Ace) aces[ai++] = c; else nonAce.push_back(c); }
        auto choice = bot.chooseSetup(board, nonAce, aces);
        for (size_t i = 0; i < choice.draft.size(); i++) {
            Card placed = choice.draft[i];
            placed.isInitial = true;
            board.at(choice.placement[i]).push(placed);
        }
        board.drawPileSize[factionIndex(bot.faction)] = static_cast<int>(nonAce.size()) - 5;
    }
    Action chooseAction(const Board& trueBoard, const TurnContext& ctx) override {
        return bot.chooseAction(trueBoard, ctx, belief);
    }
    void observe(const Action&, bool, Faction, const Board&, const TurnContext&,
                 const std::vector<CombatEvent>* events) override {
        if (events) {
            for (const auto& ev : *events) {
                for (const auto& c : ev.attackerCards) belief.onReveal(c.rank, c.suit, c.owner);
                for (const auto& c : ev.defenderCards) belief.onReveal(c.rank, c.suit, c.owner);
            }
        }
    }
    bool wantsTrainingData() const override { return false; }
    void recordDecision(std::vector<TrainingExample>&, const Board&, const TurnContext&) override {}
};

// Plays one full game (setup through terminal condition, or the maxPlies
// engineering safety net — see the EndCondition::AbortedPlyLimit comment
// in board.hpp for why that's deliberately a *very* generous last resort,
// not a normal outcome). Red always sets up and moves first (see
// types.hpp header comment — a fixed game rule, not a choice made here).
// Returns the final EndCondition.
EndCondition playGame(GameActor& redActor, GameActor& blackActor, std::mt19937& driverRng,
                       std::vector<TrainingExample>& outExamples, int maxPlies = 1500);

struct TrainingHarnessConfig {
    size_t replayBufferSize = 60000;
    double baselineOpponentFraction = 0.5; // fraction of games played vs a baseline personality rather than self-play
    int checkpointEveryGames = 20;
    // Reduced from an earlier default of 200: at batchSize=64 that was
    // 12,800 example-draws per checkpoint against ~1000 newly-added
    // examples (20 games * ~50 examples/game) — each example in the buffer
    // was being trained on roughly 50+ times before eviction over a long
    // run, which is a real overfitting risk, especially early when the
    // buffer's contents are still a narrow, low-diversity slice of self-play.
    // 25 keeps new-data-to-training-steps much closer to parity. Still a
    // starting point, not a tuned value — revisit with real loss curves
    // (TrainingHarness::lossHistory) once you have some.
    int trainStepsPerCheckpoint = 25;
    int batchSize = 64;
    float learningRate = 2e-4f;
    // Iteration 27d: value-target mixing (not serialized; 0 = legacy outcome-only).
    // wdl = (1-m)*outcome + m*{pw,0,1-pw}, pw = clamp((rootValueEstimate+1)/2). Assumes root value in [-1,1] (W-L).
    float valueTargetMix = 0.f;
    // Iteration 28: draw aversion (training target only; not serialized; 0 = legacy).
    // Draw examples train toward {0, 1+d, -d} so expected value W-L = d (e.g. d=-0.1). Rules untouched.
    float drawValue = 0.f;
    // Iteration 28 draw-pred: fraction of learner-vs-learner games played with the
    // deployment (gate/play-page) search settings - PUCT root, no exploration - so the
    // WDL head sees realistic draw rates. Those games train value/aux heads only
    // (policy targets zeroed = masked). 0 = off; the RNG stream is untouched when 0.
    float deployGameFraction = 0.f;
    // Iteration 28 patient-attacker branch: share of baseline-opponent games played against
    // PatientActor (patient_bot.hpp: builds up fully, then attacks in force; same net + search
    // underneath). 0 = off; RNG stream untouched when 0.
    float patientFraction = 0.f;
    // it31: fraction of self-play games where BOTH sides are PatientActor (the it30 champion policy) with
    // training data recorded on the moves where the inner search ran. 0 = old behavior.
    float hybridLearnerFraction = 0.f;
    std::string checkpointPath = "checards_model.bin";
    // When non-empty, a full trainer-state sidecar (Adam moments, harness and
    // buffer RNG state, replay buffer, counters, loss history, config echo)
    // is written to this path at every checkpoint and at the end of runGames,
    // making the run resumable via TrainingHarness::loadTrainerState.
    std::string trainerStatePath = "";
};

class TrainingHarness {
public:
    Network* net;
    ReplayBuffer buffer;
    SearchConfig selfplayCfg;
    TrainingHarnessConfig cfg;
    std::mt19937 rng;
    int gamesPlayed = 0;
    int discardedAbortedGames = 0;    // games that hit AbortedPlyLimit — not trained on, see board.hpp
    float lastCheckpointAvgLoss = -1.f; // -1 = no checkpoint has run yet
    std::vector<float> lossHistory;    // one entry per checkpoint; plot this to sanity-check a training run

    TrainingHarness(Network* net_, SearchConfig searchCfg, TrainingHarnessConfig cfg_, uint64_t seed)
        : net(net_), buffer(cfg_.replayBufferSize, seed), selfplayCfg(searchCfg), cfg(cfg_), rng(seed ^ 0xABCDEF) {}

    // Plays `numGames` games (alternating colors, mixing self-play and
    // baseline opponents per cfg.baselineOpponentFraction), training and
    // checkpointing periodically. `onGameDone`, if set, is called after each
    // game with (gameIndex, EndCondition, examplesRecorded) for logging —
    // examplesRecorded is 0 for a discarded AbortedPlyLimit game.
    void runGames(int numGames, const std::function<void(int, EndCondition, size_t)>& onGameDone = nullptr);

    // --- Resumable trainer state (CHKTRN01 sidecar) ---
    // saveTrainerState persists everything a checkpoint alone does NOT:
    // Adam first/second moments for every layer, harness + replay-buffer RNG
    // states, the replay buffer itself, games-played/discarded counters, and
    // the loss history. Resume protocol: construct Network, load() the
    // matching checkpoint (adamT must match the sidecar's), construct a
    // TrainingHarness with the SAME config, then loadTrainerState(). A run
    // resumed this way is bit-for-bit identical to an uninterrupted run
    // (verified by smoke_selector.cpp's resume test). The replay buffer is
    // the bulk of the file (~4-5 KB/example), practical for bounded runs;
    // very long runs should raise replayBufferSize only with disk in mind.
    bool saveTrainerState(const std::string& path) const;
    bool loadTrainerState(const std::string& path);
};

} // namespace checards
