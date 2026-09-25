#include <cstdio>
#include "checards/selfplay.hpp"
#include "checards/patient_bot.hpp"
#include <algorithm>
#include <cstring>
#include <fstream>
#include <sstream>

namespace checards {

void backfillOutcome(std::vector<TrainingExample>& examples, EndCondition end) {
    for (auto& ex : examples) {
        if (end == EndCondition::DrawMutual || end == EndCondition::DrawInactivity) {
            ex.wdlTarget = {0.f, 1.f, 0.f};
            continue;
        }
        if (end == EndCondition::AbortedPlyLimit) {
            // Not a rules-based outcome (see the EndCondition comment in
            // board.hpp) — leaving wdlTarget at its default (all zeros)
            // rather than falling through to the loss-label branch below,
            // which would otherwise mislabel every example in the game as
            // a loss regardless of perspective. All-zero contributes
            // nothing to the value head's cross-entropy loss if this ever
            // does reach training, which is a safe (if not ideal) default.
            // TrainingHarness::runGames doesn't call this function at all
            // for AbortedPlyLimit games — it discards them before this
            // point — so this branch is a defensive fallback for any other
            // caller, not the primary safeguard.
            continue;
        }
        bool won = (end == EndCondition::RedWins && ex.perspective == Faction::Red) ||
                    (end == EndCondition::BlackWins && ex.perspective == Faction::Black);
        ex.wdlTarget = won ? std::array<float, 3>{1.f, 0.f, 0.f} : std::array<float, 3>{0.f, 0.f, 1.f};
    }
}

void AIActor::recordDecision(std::vector<TrainingExample>& out, const Board& trueBoard, const TurnContext& ctx) {
    TrainingExample ex;
    ex.perspective = player.faction;
    ex.sparse = fullPieceSquareFeatures(trueBoard, player.faction, player.belief, false);
    ex.global = globalFeatures(trueBoard, player.faction, ctx.movesRemaining, ctx.mover, player.belief, false);
    ex.tacticalPolicy = player.lastSearchResult.tacticalVisitPolicy;
    ex.strategicPolicy = player.lastSearchResult.visitPolicy;
    ex.selectorPolicy = player.lastSearchResult.selectorVisitPolicy;

    // Gate target: what fraction of the search's OWN attention went to
    // forcing/attacking actions, not "did a legal attack merely exist".
    // The latter is a much weaker, more permissive signal — in a game
    // where pieces spread across the board, *something* being technically
    // attackable is common even when attacking it would be a bad trade, so
    // training the gate on "any attack exists" teaches it to fire on
    // availability rather than merit. Search already did the work of
    // figuring out whether tactics were actually worth the tree's
    // attention; reuse that instead of a cheaper, weaker proxy.
    ex.gateTarget = player.lastSearchResult.tacticalVisitFraction;
    ex.rootValueEstimate = player.lastSearchResult.rootValueEstimate;
    ex.rootActionValues = player.lastSearchResult.rootActionValues;
    ex.rootActionValueMask = player.lastSearchResult.rootActionValueMask;
    ex.rootActionVisits = player.lastSearchResult.rootActionVisits;

    float myMat = materialSum(trueBoard, player.faction);
    float oppMat = materialSum(trueBoard, otherFaction(player.faction));
    ex.materialTarget = std::tanh((myMat - oppMat) / 40.0f);
    ex.territoryTarget = territoryFraction(trueBoard, player.faction);
    int phase = gamePhaseIndex(trueBoard);
    ex.phaseTarget = {phase == 0 ? 1.f : 0.f, phase == 1 ? 1.f : 0.f, phase == 2 ? 1.f : 0.f};
    out.push_back(std::move(ex));
}

namespace {
std::vector<Card> computeRemainingDrawPile(const Board& board, Faction f) {
    std::vector<Card> full = AIPlayer::fullPersonalDeck(f);
    std::vector<Card> remaining;
    int yStart = (f == Faction::Red) ? 0 : kBoardSize - kSetupBandRows;
    for (auto& c : full) {
        bool placed = false;
        for (int y = yStart; y < yStart + kSetupBandRows && !placed; y++)
            for (int x = 0; x < kBoardSize && !placed; x++)
                for (int i = 0; i < board.grid[x][y].count && !placed; i++) {
                    const Card& bc = board.grid[x][y].cards[i];
                    if (bc.rank == c.rank && bc.suit == c.suit && bc.owner == f) placed = true;
                }
        if (!placed) remaining.push_back(c);
    }
    return remaining;
}
} // namespace

EndCondition playGame(GameActor& redActor, GameActor& blackActor, std::mt19937& driverRng,
                       std::vector<TrainingExample>& outExamples, int maxPlies) {
    Board board;
    redActor.performSetup(board);
    blackActor.performSetup(board);
    board.recomputeAcesAlive();

    std::vector<Card> realDeck[2];
    realDeck[factionIndex(Faction::Red)] = computeRemainingDrawPile(board, Faction::Red);
    realDeck[factionIndex(Faction::Black)] = computeRemainingDrawPile(board, Faction::Black);
    std::shuffle(realDeck[0].begin(), realDeck[0].end(), driverRng);
    std::shuffle(realDeck[1].begin(), realDeck[1].end(), driverRng);
    board.drawPileSize[0] = static_cast<int>(realDeck[0].size());
    board.drawPileSize[1] = static_cast<int>(realDeck[1].size());

    TurnContext ctx;
    ctx.resetForNewTurn(Faction::Red); // Red always moves first

    int plies = 0;
    while (board.endCondition == EndCondition::Ongoing && plies < maxPlies) {
        GameActor& actor = (ctx.mover == Faction::Red) ? redActor : blackActor;
        Faction mover = ctx.mover;

        Action action = actor.chooseAction(board, ctx);
        if (!action.isSpawn && !action.from.valid()) {
            // NO-LEGAL-ACTION PASS. The rules already treat "no further legal
            // action exists" as ending a turn (rules.hpp, applyAction's
            // turnEnded); this is the turn-START form of the same state
            // (e.g. an empty draw pile with no movable card, or a fully
            // blocked-in position). Actors can only express it as an invalid
            // Action{}, and feeding that to applyAction / board.at() indexes
            // off the board — a latent out-of-bounds access that predates
            // this tranche. Handle it as a pass: resolve combats (which also
            // advances the inactivity counter, so repeated passing still
            // draws), hand over the turn, and sync both observers. The
            // invalid action is passed to observe() so belief gets the
            // combat events; observers must treat it as tree-reset-only (see
            // AIPlayer::observeExternalAction's validity guard).
            std::vector<CombatEvent> passEvents = resolveAllCombats(board, mover);
            if (!board.isTerminal()) {
                if (mover == Faction::Black) board.currentTurnNumber++;
                ctx.resetForNewTurn(otherFaction(mover));
            }
            redActor.observe(action, false, mover, board, ctx, &passEvents);
            blackActor.observe(action, false, mover, board, ctx, &passEvents);
            plies++;
            board.totalPlies++;
            continue;
        }
        if (actor.wantsTrainingData()) actor.recordDecision(outExamples, board, ctx);

        Rank spawnRank = RankVal::Joker;
        Suit spawnSuit = SuitVal::JokerSuit;
        if (action.isSpawn) {
            auto& pile = realDeck[factionIndex(mover)];
            if (!pile.empty()) { spawnRank = pile.back().rank; spawnSuit = pile.back().suit; pile.pop_back(); }
        }
        bool wasAttack = !action.isSpawn && board.at(action.to).hasFaction(otherFaction(mover));

        ApplyOutcome outcome = applyAction(board, ctx, action, spawnRank, spawnSuit);
        board.drawPileSize[factionIndex(mover)] = static_cast<int>(realDeck[factionIndex(mover)].size());
        board.totalPlies++;

        std::vector<CombatEvent> events;
        bool turnJustEnded = outcome.turnEnded;
        if (turnJustEnded) {
            events = resolveAllCombats(board, mover);
            if (!board.isTerminal()) {
                if (mover == Faction::Black) board.currentTurnNumber++;
                ctx.resetForNewTurn(otherFaction(mover));
            }
        }

        redActor.observe(action, wasAttack, mover, board, ctx, turnJustEnded ? &events : nullptr);
        blackActor.observe(action, wasAttack, mover, board, ctx, turnJustEnded ? &events : nullptr);

        plies++;
    }
    // Reaching this means Ongoing survived `maxPlies` total atomic actions
    // WITHOUT the real inactivity counter above ever tripping — which, by
    // construction, means combat kept happening periodically throughout
    // (every combat resets it to 0). That's the opposite of "inactive": it's
    // an unusually long, still-contested game hitting an engineering
    // safety net, not a rules-based draw. See the EndCondition comment in
    // board.hpp and TrainingHarness::runGames, which discards these rather
    // than training on a fabricated label.
    if (board.endCondition == EndCondition::Ongoing) board.endCondition = EndCondition::AbortedPlyLimit;
    return board.endCondition;
}

void TrainingHarness::runGames(int numGames, const std::function<void(int, EndCondition, size_t)>& onGameDone) {
    auto roster = defaultPersonalityRoster();
    std::uniform_real_distribution<double> coin(0.0, 1.0);

    for (int g = 0; g < numGames; g++) {
        bool vsBaseline = coin(rng) < cfg.baselineOpponentFraction;
        bool learnerIsRed = (g % 2 == 0);

        std::vector<TrainingExample> gameExamples;
        EndCondition end;

        if (vsBaseline) {
            bool patient = cfg.patientFraction > 0.f && coin(rng) < cfg.patientFraction;
            if (patient) {
                auto learner = std::make_unique<AIActor>(learnerIsRed ? Faction::Red : Faction::Black, net, selfplayCfg, rng());
                SearchConfig d; d.numThreads = 1; d.fixedIterations = selfplayCfg.fixedIterations; d.dirichletEpsilon = 0; d.fpuReduction = 0; d.selectorResidualWeight = 0;
                auto opp = std::make_unique<PatientActor>(learnerIsRed ? Faction::Black : Faction::Red, net, d, rng());
                end = learnerIsRed ? playGame(*learner, *opp, rng, gameExamples) : playGame(*opp, *learner, rng, gameExamples);
            } else {
            Personality p = roster[rng() % roster.size()];
            auto learner = std::make_unique<AIActor>(learnerIsRed ? Faction::Red : Faction::Black, net, selfplayCfg, rng());
            auto opp = std::make_unique<BaselineActor>(learnerIsRed ? Faction::Black : Faction::Red, p, rng());
            end = learnerIsRed ? playGame(*learner, *opp, rng, gameExamples) : playGame(*opp, *learner, rng, gameExamples);
            }
        } else {
            bool hybrid = cfg.hybridLearnerFraction > 0.f && coin(rng) < cfg.hybridLearnerFraction;
            if (hybrid) {
                PatientActor redP(Faction::Red, net, selfplayCfg, rng()), blackP(Faction::Black, net, selfplayCfg, rng());
                redP.recordData = true; blackP.recordData = true;
                end = playGame(redP, blackP, rng, gameExamples);
            } else {
            bool deploy = cfg.deployGameFraction > 0.f && coin(rng) < cfg.deployGameFraction;
            SearchConfig useCfg = selfplayCfg;
            if (deploy) { SearchConfig d; d.numThreads = 1; d.fixedIterations = selfplayCfg.fixedIterations; d.dirichletEpsilon = 0; d.fpuReduction = 0; d.selectorResidualWeight = 0; useCfg = d; }
            auto redA = std::make_unique<AIActor>(Faction::Red, net, useCfg, rng());
            auto blackA = std::make_unique<AIActor>(Faction::Black, net, useCfg, rng());
            end = playGame(*redA, *blackA, rng, gameExamples);
            if (deploy) for (auto& ex : gameExamples) { ex.tacticalPolicy.fill(0.f); ex.strategicPolicy.fill(0.f); ex.selectorPolicy.fill(0.f); }
            }
        }

        if (end == EndCondition::AbortedPlyLimit) {
            // Not a rules-based outcome (board.hpp) — discard rather than
            // train on a fabricated win/loss/draw label.
            discardedAbortedGames++;
            if (onGameDone) onGameDone(g, end, 0);
            continue;
        }

        backfillOutcome(gameExamples, end);
        size_t nExamples = gameExamples.size();
        buffer.addGame(gameExamples);
        gamesPlayed++;

        if (gamesPlayed % cfg.checkpointEveryGames == 0) {
            double lossSum = 0.0;
            int lossCount = 0;
            for (int step = 0; step < cfg.trainStepsPerCheckpoint; step++) {
                auto batch = buffer.sampleBatch(static_cast<size_t>(cfg.batchSize));
                if (batch.empty()) break;
                for (auto* ex : batch) {
                    Network::Targets t;
                    t.wdl = ex->wdlTarget;
                    if (cfg.drawValue < 0.f && ex->wdlTarget[0] == 0.f && ex->wdlTarget[1] == 1.f && ex->wdlTarget[2] == 0.f) {
                        t.wdl = {0.f, 1.f + cfg.drawValue, -cfg.drawValue};
                    }
                    if (cfg.valueTargetMix > 0.f && (ex->wdlTarget[0] + ex->wdlTarget[1] + ex->wdlTarget[2]) > 0.f) {
                        const float m = cfg.valueTargetMix;
                        const float pw = std::min(1.f, std::max(0.f, 0.5f * (ex->rootValueEstimate + 1.f)));
                        t.wdl = {(1.f - m) * ex->wdlTarget[0] + m * pw, (1.f - m) * ex->wdlTarget[1], (1.f - m) * ex->wdlTarget[2] + m * (1.f - pw)};
                    }
                    t.tacticalPolicy = ex->tacticalPolicy;
                    t.strategicPolicy = ex->strategicPolicy;
                    t.selector = ex->selectorPolicy;
                    t.gate = ex->gateTarget;
                    t.material = ex->materialTarget;
                    t.territory = ex->territoryTarget;
                    t.phase = ex->phaseTarget;
                    float loss = net->accumulateGradients(ex->sparse, ex->global, t, Network::LossWeights());
                    lossSum += loss;
                    lossCount++;
                }
                net->applyGradients(cfg.learningRate, static_cast<int>(batch.size()));
            }
            if (lossCount > 0) {
                lastCheckpointAvgLoss = static_cast<float>(lossSum / lossCount);
                lossHistory.push_back(lastCheckpointAvgLoss);
            }
            net->save(cfg.checkpointPath);
            if (!cfg.trainerStatePath.empty()) saveTrainerState(cfg.trainerStatePath);
        }

        if (onGameDone) onGameDone(g, end, nExamples);
    }
    if (!cfg.trainerStatePath.empty()) saveTrainerState(cfg.trainerStatePath);
}

// ---------------------------------------------------------------------------
// Trainer-state sidecar (CHKTRN01): full resume state. Layout:
//   magic[8] | u32 version(=1) | i32 adamT
//   i32 gamesPlayed | i32 discardedAbortedGames | f32 lastCheckpointAvgLoss
//   u32 lossHistoryCount | f32[lossHistoryCount]
//   harness-rng string (u64 len + bytes) | buffer-rng string (u64 len + bytes)
//   u32 bufferSize | serialized TrainingExample[bufferSize]
//   Adam moments for accInput then every denseLayers() entry, in order:
//     per layer: f32 mW[n] vW[n] mb[out] vb[out]  (n/out from the live net)
//   config echo: f64 baselineOpponentFraction | i32 checkpointEveryGames
//     i32 trainStepsPerCheckpoint | i32 batchSize | f32 learningRate
//     u64 replayBufferSize
// ---------------------------------------------------------------------------
namespace {

void writeString(std::ostream& os, const std::string& v) {
    uint64_t n = v.size();
    os.write(reinterpret_cast<const char*>(&n), sizeof(n));
    os.write(v.data(), static_cast<std::streamsize>(n));
}
bool readString(std::istream& is, std::string& v) {
    uint64_t n = 0;
    is.read(reinterpret_cast<char*>(&n), sizeof(n));
    if (!is || n > (1u << 26)) return false; // sanity bound: 64 MB of RNG state is nonsense
    v.resize(static_cast<size_t>(n));
    is.read(v.data(), static_cast<std::streamsize>(n));
    return static_cast<bool>(is);
}
std::string rngToString(const std::mt19937& rng) {
    std::stringstream ss;
    ss << rng;
    return ss.str();
}
bool stringToRng(const std::string& s, std::mt19937& rng) {
    std::stringstream ss(s);
    ss >> rng;
    return !ss.fail();
}

void writeExample(std::ostream& os, const TrainingExample& ex) {
    int8_t persp = static_cast<int8_t>(ex.perspective);
    os.write(reinterpret_cast<const char*>(&persp), sizeof(persp));
    uint32_t n = static_cast<uint32_t>(ex.sparse.size());
    os.write(reinterpret_cast<const char*>(&n), sizeof(n));
    for (const auto& f : ex.sparse) {
        os.write(reinterpret_cast<const char*>(&f.index), sizeof(f.index));
        os.write(reinterpret_cast<const char*>(&f.weight), sizeof(f.weight));
    }
    os.write(reinterpret_cast<const char*>(ex.global.data()), ex.global.size() * sizeof(float));
    os.write(reinterpret_cast<const char*>(ex.tacticalPolicy.data()), ex.tacticalPolicy.size() * sizeof(float));
    os.write(reinterpret_cast<const char*>(ex.strategicPolicy.data()), ex.strategicPolicy.size() * sizeof(float));
    os.write(reinterpret_cast<const char*>(ex.selectorPolicy.data()), ex.selectorPolicy.size() * sizeof(float));
    os.write(reinterpret_cast<const char*>(&ex.gateTarget), sizeof(float));
    os.write(reinterpret_cast<const char*>(&ex.materialTarget), sizeof(float));
    os.write(reinterpret_cast<const char*>(&ex.territoryTarget), sizeof(float));
    os.write(reinterpret_cast<const char*>(ex.phaseTarget.data()), ex.phaseTarget.size() * sizeof(float));
    os.write(reinterpret_cast<const char*>(ex.wdlTarget.data()), ex.wdlTarget.size() * sizeof(float));
}
bool readExample(std::istream& is, TrainingExample& ex) {
    int8_t persp = 0;
    is.read(reinterpret_cast<char*>(&persp), sizeof(persp));
    ex.perspective = static_cast<Faction>(persp);
    uint32_t n = 0;
    is.read(reinterpret_cast<char*>(&n), sizeof(n));
    if (!is || n > kNumPieceSquareFeatures) return false;
    ex.sparse.resize(n);
    for (auto& f : ex.sparse) {
        is.read(reinterpret_cast<char*>(&f.index), sizeof(f.index));
        is.read(reinterpret_cast<char*>(&f.weight), sizeof(f.weight));
    }
    is.read(reinterpret_cast<char*>(ex.global.data()), ex.global.size() * sizeof(float));
    is.read(reinterpret_cast<char*>(ex.tacticalPolicy.data()), ex.tacticalPolicy.size() * sizeof(float));
    is.read(reinterpret_cast<char*>(ex.strategicPolicy.data()), ex.strategicPolicy.size() * sizeof(float));
    is.read(reinterpret_cast<char*>(ex.selectorPolicy.data()), ex.selectorPolicy.size() * sizeof(float));
    is.read(reinterpret_cast<char*>(&ex.gateTarget), sizeof(float));
    is.read(reinterpret_cast<char*>(&ex.materialTarget), sizeof(float));
    is.read(reinterpret_cast<char*>(&ex.territoryTarget), sizeof(float));
    is.read(reinterpret_cast<char*>(ex.phaseTarget.data()), ex.phaseTarget.size() * sizeof(float));
    is.read(reinterpret_cast<char*>(ex.wdlTarget.data()), ex.wdlTarget.size() * sizeof(float));
    return static_cast<bool>(is);
}

void writeMoments(std::ostream& os, const DenseLayer& l) {
    os.write(reinterpret_cast<const char*>(l.mW.data()), l.mW.size() * sizeof(float));
    os.write(reinterpret_cast<const char*>(l.vW.data()), l.vW.size() * sizeof(float));
    os.write(reinterpret_cast<const char*>(l.mb.data()), l.mb.size() * sizeof(float));
    os.write(reinterpret_cast<const char*>(l.vb.data()), l.vb.size() * sizeof(float));
}
void writeMomentsSparse(std::ostream& os, const SparseInputLayer& l) {
    os.write(reinterpret_cast<const char*>(l.mW.data()), l.mW.size() * sizeof(float));
    os.write(reinterpret_cast<const char*>(l.vW.data()), l.vW.size() * sizeof(float));
    os.write(reinterpret_cast<const char*>(l.mb.data()), l.mb.size() * sizeof(float));
    os.write(reinterpret_cast<const char*>(l.vb.data()), l.vb.size() * sizeof(float));
}
bool readMoments(std::istream& is, DenseLayer& l) {
    is.read(reinterpret_cast<char*>(l.mW.data()), l.mW.size() * sizeof(float));
    is.read(reinterpret_cast<char*>(l.vW.data()), l.vW.size() * sizeof(float));
    is.read(reinterpret_cast<char*>(l.mb.data()), l.mb.size() * sizeof(float));
    is.read(reinterpret_cast<char*>(l.vb.data()), l.vb.size() * sizeof(float));
    return static_cast<bool>(is);
}
bool readMomentsSparse(std::istream& is, SparseInputLayer& l) {
    is.read(reinterpret_cast<char*>(l.mW.data()), l.mW.size() * sizeof(float));
    is.read(reinterpret_cast<char*>(l.vW.data()), l.vW.size() * sizeof(float));
    is.read(reinterpret_cast<char*>(l.mb.data()), l.mb.size() * sizeof(float));
    is.read(reinterpret_cast<char*>(l.vb.data()), l.vb.size() * sizeof(float));
    return static_cast<bool>(is);
}

} // namespace

bool TrainingHarness::saveTrainerState(const std::string& path) const {
    const std::string tmp = path + ".part"; // atomic write (iteration 27)
    std::ofstream os(tmp, std::ios::binary);
    if (!os) return false;
    const char magic[8] = {'C', 'H', 'K', 'T', 'R', 'N', '0', '1'};
    os.write(magic, 8);
    uint32_t version = 1;
    os.write(reinterpret_cast<const char*>(&version), sizeof(version));
    int32_t t = net->adamT;
    os.write(reinterpret_cast<const char*>(&t), sizeof(t));
    int32_t gp = gamesPlayed, da = discardedAbortedGames;
    os.write(reinterpret_cast<const char*>(&gp), sizeof(gp));
    os.write(reinterpret_cast<const char*>(&da), sizeof(da));
    os.write(reinterpret_cast<const char*>(&lastCheckpointAvgLoss), sizeof(lastCheckpointAvgLoss));
    uint32_t lh = static_cast<uint32_t>(lossHistory.size());
    os.write(reinterpret_cast<const char*>(&lh), sizeof(lh));
    if (lh) os.write(reinterpret_cast<const char*>(lossHistory.data()), lh * sizeof(float));
    writeString(os, rngToString(rng));
    writeString(os, rngToString(buffer.rng));
    uint32_t bn = static_cast<uint32_t>(buffer.buffer.size());
    os.write(reinterpret_cast<const char*>(&bn), sizeof(bn));
    for (const auto& ex : buffer.buffer) writeExample(os, ex);
    writeMomentsSparse(os, net->accInput);
    for (const DenseLayer* l : net->denseLayers()) writeMoments(os, *l);
    os.write(reinterpret_cast<const char*>(&cfg.baselineOpponentFraction), sizeof(cfg.baselineOpponentFraction));
    os.write(reinterpret_cast<const char*>(&cfg.checkpointEveryGames), sizeof(cfg.checkpointEveryGames));
    os.write(reinterpret_cast<const char*>(&cfg.trainStepsPerCheckpoint), sizeof(cfg.trainStepsPerCheckpoint));
    os.write(reinterpret_cast<const char*>(&cfg.batchSize), sizeof(cfg.batchSize));
    os.write(reinterpret_cast<const char*>(&cfg.learningRate), sizeof(cfg.learningRate));
    uint64_t rbs = static_cast<uint64_t>(cfg.replayBufferSize);
    os.write(reinterpret_cast<const char*>(&rbs), sizeof(rbs));
    os.close();
    if (!os) return false;
    return std::rename(tmp.c_str(), path.c_str()) == 0;
}

bool TrainingHarness::loadTrainerState(const std::string& path) {
    std::ifstream is(path, std::ios::binary);
    if (!is) return false;
    char magic[8];
    is.read(magic, 8);
    if (std::memcmp(magic, "CHKTRN01", 8) != 0) return false;
    uint32_t version = 0;
    is.read(reinterpret_cast<char*>(&version), sizeof(version));
    if (version != 1) return false;
    int32_t t = 0;
    is.read(reinterpret_cast<char*>(&t), sizeof(t));
    if (t != net->adamT) return false; // sidecar must match the already-loaded checkpoint
    int32_t gp = 0, da = 0;
    is.read(reinterpret_cast<char*>(&gp), sizeof(gp));
    is.read(reinterpret_cast<char*>(&da), sizeof(da));
    gamesPlayed = gp;
    discardedAbortedGames = da;
    is.read(reinterpret_cast<char*>(&lastCheckpointAvgLoss), sizeof(lastCheckpointAvgLoss));
    uint32_t lh = 0;
    is.read(reinterpret_cast<char*>(&lh), sizeof(lh));
    if (!is || lh > (1u << 22)) return false;
    lossHistory.resize(lh);
    if (lh) is.read(reinterpret_cast<char*>(lossHistory.data()), lh * sizeof(float));
    std::string rngState, bufRngState;
    if (!readString(is, rngState) || !readString(is, bufRngState)) return false;
    if (!stringToRng(rngState, rng) || !stringToRng(bufRngState, buffer.rng)) return false;
    uint32_t bn = 0;
    is.read(reinterpret_cast<char*>(&bn), sizeof(bn));
    if (!is || bn > buffer.maxSize) return false;
    buffer.buffer.resize(bn);
    for (auto& ex : buffer.buffer)
        if (!readExample(is, ex)) return false;
    if (!readMomentsSparse(is, net->accInput)) return false;
    for (DenseLayer* l : net->denseLayers())
        if (!readMoments(is, *l)) return false;
    double bof;
    int ceg, tspc, bs;
    float lrate;
    uint64_t rbs;
    is.read(reinterpret_cast<char*>(&bof), sizeof(bof));
    is.read(reinterpret_cast<char*>(&ceg), sizeof(ceg));
    is.read(reinterpret_cast<char*>(&tspc), sizeof(tspc));
    is.read(reinterpret_cast<char*>(&bs), sizeof(bs));
    is.read(reinterpret_cast<char*>(&lrate), sizeof(lrate));
    is.read(reinterpret_cast<char*>(&rbs), sizeof(rbs));
    if (!is) return false;
    // Config echo is validated, not silently overridden: resuming with a
    // different training config than the run was saved under is a user error
    // we surface, not a mismatch we "fix".
    if (bof != cfg.baselineOpponentFraction || ceg != cfg.checkpointEveryGames ||
        tspc != cfg.trainStepsPerCheckpoint || bs != cfg.batchSize ||
        lrate != cfg.learningRate || rbs != cfg.replayBufferSize) return false;
    return true;
}

} // namespace checards
