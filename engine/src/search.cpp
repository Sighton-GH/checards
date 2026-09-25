#include <unordered_map>
#include "checards/search.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include "checards/features.hpp"

namespace checards {

// -----------------------------------------------------------------------------
// WHY NODES DON'T CACHE A BOARD:
// Combat outcomes that involve a still-hidden card depend on that card's
// (guessed) identity, which differs across determinizations. So the concrete
// board reachable via a given sequence of actions is not single-valued in
// this game — it's an information set. Each iteration below therefore
// re-determinizes the hidden cards from the current belief, then replays the
// path from root to the selected node on a fresh working board, exactly as
// PIMC/ISMCTS requires. What nodes *do* cache (mover, prior, visit stats,
// and — approximately, for display only — moves-remaining/attack status) is
// all public information that never depends on the determinization, so it's
// safe to share across every iteration and thread.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// SIGN CONVENTION FOR valueSum (the bug this fixes, and why):
//
// Every node's valueSum accumulates leafValue *in the perspective of that
// node's own moverAtNode* — i.e. positive means "good for whoever took the
// action this node represents," not "good for the root player." This is
// necessary for PUCT selection to be correct: selectChild() always picks
// the MAXIMUM q+u among a node's children, and children are only ever
// compared against their own siblings, which by construction all share the
// same mover (whoever generateLegalActions() was called for at that
// expansion). Maximizing is only correct if q is expressed in *that
// mover's* own interest — comparing raw root-relative values across an
// opponent's own children would silently model the opponent as trying to
// help the root player win, rather than beat them.
//
// A prior version of this file stored every node's valueSum as a raw,
// unflipped root-relative leafValue and always maximized. That is wrong in
// exactly the way just described for any node where moverAtNode is the
// opponent — which is roughly half the tree. It doesn't crash or fail an
// assert (every test in this suite still passes with it), it just quietly
// makes the search treat the opponent as cooperative instead of
// adversarial. hybrid_engine_3.hpp's original runISMCTS got this right
// (`perspectiveValue = (node->parent->turnToMove == faction) ? leafValue :
// -leafValue`) — re-deriving that convention carefully while porting it
// for legacy_hybrid.hpp is what surfaced the same bug here.
//
// Root is treated as if its own moverAtNode is `perspective_` by
// convention (it has no real incoming action) — see resetRoot()/
// advanceRoot() below. valueFromMoverPerspective() (search.hpp) converts
// any node's value into an arbitrary player's perspective by exploiting
// that this is a two-player zero-sum game: same mover -> unchanged,
// opposite mover -> negate.
// -----------------------------------------------------------------------------

SearchTree::SearchTree(Faction perspective, Network* network, SearchConfig cfg)
    : perspective_(perspective), network_(network), cfg_(cfg), masterRng_(std::random_device{}()) {
    root_ = std::make_unique<MCTSNode>();
    root_->moverAtNode = perspective_;
}

void SearchTree::resetRoot(const Board& trueBoard, const TurnContext& ctx, const BeliefState& belief) {
    root_ = std::make_unique<MCTSNode>();
    root_->moverAtNode = perspective_;
    root_->toMoveAfter = ctx.mover;
    root_->movesRemainingAfter = ctx.movesRemaining;
    trueBoard_ = trueBoard;
    rootCtx_ = ctx;
    belief_ = belief;
    allowedRootChildren_.clear();
}

void SearchTree::advanceRoot(const Action& realAction, const Board& newTrueBoard, const TurnContext& newCtx,
                              const BeliefState& newBelief) {
    std::unique_ptr<MCTSNode> newRoot;
    if (root_ && root_->expanded.load(std::memory_order_acquire)) {
        for (auto& c : root_->children) {
            bool match = (c->action.isSpawn && realAction.isSpawn && c->action.to == realAction.to) ||
                         (!c->action.isSpawn && !realAction.isSpawn && c->action.from == realAction.from &&
                          c->action.to == realAction.to && c->action.ownerOrdinal == realAction.ownerOrdinal);
            if (match) { newRoot = std::move(c); break; }
        }
    }
    if (newRoot) {
        // Promoted from a real non-root node: its moverAtNode is already
        // correctly set from when it was expanded, and its existing
        // valueSum was accumulated in that same (possibly opponent's)
        // perspective — leave both alone. valueFromMoverPerspective()
        // handles converting for reporting/FPU regardless of which mover
        // it turns out to be.
        newRoot->parent = nullptr;
        root_ = std::move(newRoot);
    } else {
        root_ = std::make_unique<MCTSNode>();
        root_->moverAtNode = perspective_;
    }
    trueBoard_ = newTrueBoard;
    rootCtx_ = newCtx;
    belief_ = newBelief;
    allowedRootChildren_.clear();
}

Network::Output SearchTree::quickFogEval() const {
    auto sparse = fullPieceSquareFeatures(trueBoard_, perspective_, belief_, false);
    auto glob = globalFeatures(trueBoard_, perspective_, rootCtx_.movesRemaining, rootCtx_.mover, belief_, false);
    return network_->forward(sparse, glob, nullptr);
}


bool SearchTree::rootChildAllowed(const MCTSNode* child) const {
    if (allowedRootChildren_.empty()) return true;
    return std::find(allowedRootChildren_.begin(), allowedRootChildren_.end(), child) != allowedRootChildren_.end();
}

void SearchTree::initializeSequentialHalvingCandidates() {
    allowedRootChildren_.clear();
    if (cfg_.rootStrategy != RootSearchStrategy::SequentialHalving || root_->children.size() <= 1) return;
    std::vector<const MCTSNode*> ranked;
    ranked.reserve(root_->children.size());
    for (const auto& c : root_->children) ranked.push_back(c.get());
    std::stable_sort(ranked.begin(), ranked.end(), [](const MCTSNode* a, const MCTSNode* b) {
        if (a->prior != b->prior) return a->prior > b->prior;
        return a->action.atomicIndex() < b->action.atomicIndex();
    });
    const int cap = std::max(2, cfg_.sequentialHalving.maxRootCandidates);
    if (static_cast<int>(ranked.size()) > cap) ranked.resize(cap);
    allowedRootChildren_ = std::move(ranked);
}

void SearchTree::halveSequentialCandidates() {
    if (allowedRootChildren_.size() <= 1) return;
    const double priorWeight = cfg_.sequentialHalving.priorScoreWeight;
    std::stable_sort(allowedRootChildren_.begin(), allowedRootChildren_.end(),
        [priorWeight](const MCTSNode* a, const MCTSNode* b) {
            const double as = a->q() + priorWeight * std::log(std::max(1e-12f, a->prior));
            const double bs = b->q() + priorWeight * std::log(std::max(1e-12f, b->prior));
            if (as != bs) return as > bs;
            const int av = a->visits.load(std::memory_order_relaxed);
            const int bv = b->visits.load(std::memory_order_relaxed);
            if (av != bv) return av > bv;
            return a->action.atomicIndex() < b->action.atomicIndex();
        });
    allowedRootChildren_.resize((allowedRootChildren_.size() + 1) / 2);
}

MCTSNode* SearchTree::selectChild(MCTSNode* node) const {
    if (node->children.empty()) return nullptr;
    int parentVisits = node->visits.load(std::memory_order_relaxed);
    // Every child shares moverAtNode == node->toMoveAfter by construction
    // (expand() sets it from sim.ctx.mover at that point), so a visited
    // child's raw q() is already in the correct shared frame for direct
    // comparison. The FPU baseline borrows the *parent's* q(), which is in
    // the parent's own moverAtNode's frame — only the same frame if the
    // turn didn't pass between them, so it needs the explicit conversion.
    double fpuBase = valueFromMoverPerspective(node, node->toMoveAfter) - cfg_.fpuReduction;
    double best = -1e18;
    MCTSNode* bestChild = nullptr;
    double sqrtParent = std::sqrt(static_cast<double>(std::max(1, parentVisits)));
    for (auto& c : node->children) {
        if (node == root_.get() && forcedRootChild_ != nullptr && c.get() != forcedRootChild_) continue;
        if (node == root_.get() && !rootChildAllowed(c.get())) continue;
        int cv = c->visits.load(std::memory_order_relaxed);
        double q = (cv > 0) ? c->q() : fpuBase;
        double u = cfg_.cpuct * c->prior * sqrtParent / (1.0 + cv);
        double score = q + u;
        if (score > best) { best = score; bestChild = c.get(); }
    }
    return bestChild;
}

void SearchTree::expand(MCTSNode* node, SimContext& sim, const Network::Output& netOut, std::mt19937& rng) {
    if (node->expanded.load(std::memory_order_acquire)) return;
    std::lock_guard<std::mutex> lock(node->expandMutex);
    if (node->expanded.load(std::memory_order_acquire)) return; // double-checked

    std::vector<Action> rawActions = generateLegalActions(sim.board, sim.ctx);
    if (rawActions.empty()) {
        node->expanded.store(true, std::memory_order_release);
        return;
    }

    // netOut is passed in by the caller — see the note in runOneIteration
    // about the redundant-network-call bug this signature change fixes.
    auto tacticalSm = softmaxArr(netOut.tacticalLogits);
    auto strategicSm = softmaxArr(netOut.strategicLogits);
    float gate = cfg_.fixedTacticalPolicyWeight >= 0.0 ? static_cast<float>(std::clamp(cfg_.fixedTacticalPolicyWeight, 0.0, 1.0)) : netOut.tacticalityGate;

    std::vector<int> idxOf(rawActions.size());
    for (size_t i = 0; i < rawActions.size(); i++) idxOf[i] = rawActions[i].atomicIndex();

    std::array<float, kNumAtomicActions> combinedByIdx;
    combinedByIdx.fill(-1.f);
    for (size_t i = 0; i < rawActions.size(); i++) {
        int idx = idxOf[i];
        if (combinedByIdx[idx] < 0.f) {
            combinedByIdx[idx] = gate * tacticalSm[idx] + (1.f - gate) * strategicSm[idx];
            if (node == root_.get() && cfg_.linearBeliefAdapterEnabled) {
                const auto gf = globalFeatures(sim.board, perspective_, sim.ctx.movesRemaining, sim.ctx.mover, belief_, false);
                double correction = 0.0;
                for (int j = 0; j < kNumGlobalFeatures; j++) correction += cfg_.linearBeliefWeights[idx][j] * gf[j];
                combinedByIdx[idx] *= std::exp(std::clamp(correction, -0.75, 0.75));
            }
            if (node == root_.get() && cfg_.nonlinearBeliefAdapterEnabled) {
                const auto gf = globalFeatures(sim.board, perspective_, sim.ctx.movesRemaining, sim.ctx.mover, belief_, false);
                double correction = 0.0;
                for (int h = 0; h < SearchConfig::kBeliefAdapterHidden; h++) {
                    double z = cfg_.nonlinearBias[h];
                    for (int j = 0; j < kNumGlobalFeatures; j++) z += cfg_.nonlinearProjection[h][j] * gf[j];
                    correction += cfg_.nonlinearOutput[idx][h] * std::tanh(z);
                }
                combinedByIdx[idx] *= std::exp(std::clamp(correction, -0.75, 0.75));
            }
        }
    }

    std::vector<int> presentIdx;
    presentIdx.reserve(rawActions.size());
    for (int i = 0; i < kNumAtomicActions; i++) if (combinedByIdx[i] >= 0.f) presentIdx.push_back(i);

    // Root-only Dirichlet noise for self-play exploration diversity.
    if (node == root_.get()) {
        std::gamma_distribution<double> gamma(cfg_.dirichletAlpha, 1.0);
        std::vector<double> noise(presentIdx.size());
        double sum = 0;
        for (auto& n : noise) { n = std::max(1e-6, gamma(rng)); sum += n; }
        for (size_t k = 0; k < presentIdx.size(); k++) {
            double nn = noise[k] / sum;
            combinedByIdx[presentIdx[k]] = static_cast<float>(
                (1.0 - cfg_.dirichletEpsilon) * combinedByIdx[presentIdx[k]] + cfg_.dirichletEpsilon * nn);
        }
    }

    // Opponent-model blend when simulating the opponent's own decision.
    if (opponentModel != nullptr && sim.ctx.mover != perspective_ && cfg_.opponentModelBlend > 0.0) {
        std::array<float, kNumAtomicActions> empirical{};
        if (opponentModel->empiricalDistributionOver(presentIdx, empirical)) {
            for (int idx : presentIdx) {
                combinedByIdx[idx] = static_cast<float>(
                    (1.0 - cfg_.opponentModelBlend) * combinedByIdx[idx] + cfg_.opponentModelBlend * empirical[idx]);
            }
        }
    }

    // Factorized prior: P(exact action) = P_geometry(atomicIndex) *
    // P_selector(ordinal | tile). The selector head (schema v2) learns the
    // conditional; for v1-migrated checkpoints its logits are all zero and
    // selectorMultipliers() degenerates to exactly the old uniform split
    // (1/groupSize per geometric group), so migrated models behave
    // identically to the cycle-1 engine here. Visit targets aggregate back
    // to both factors: the geometric heads get per-atomicIndex visit mass,
    // the selector gets per-tile ordinal distributions (see search()).
    std::vector<float> selMult = selectorMultipliers(netOut.selectorLogits, rawActions);
    const double selectorWeight = std::clamp(cfg_.selectorResidualWeight, 0.0, 1.0);
    if (selectorWeight < 1.0) {
        std::array<int, kNumAtomicActions> exactChoices{};
        exactChoices.fill(0);
        for (const auto& a : rawActions) if (!a.isSpawn) exactChoices[a.atomicIndex()]++;
        for (size_t i = 0; i < rawActions.size(); i++) {
            const auto& a = rawActions[i];
            if (a.isSpawn) continue;
            const float uniform = 1.0f / std::max(1, exactChoices[a.atomicIndex()]);
            selMult[i] = static_cast<float>((1.0 - selectorWeight) * uniform + selectorWeight * selMult[i]);
        }
    }

    node->children.reserve(rawActions.size());
    for (size_t i = 0; i < rawActions.size(); i++) {
        auto child = std::make_unique<MCTSNode>();
        child->action = rawActions[i];
        child->moverAtNode = sim.ctx.mover;
        child->parent = node;
        int idx = idxOf[i];
        child->prior = combinedByIdx[idx] * selMult[i];
        child->wasAttackWhenGenerated =
            !child->action.isSpawn && sim.board.at(child->action.to).hasFaction(otherFaction(sim.ctx.mover));
        // Approximate, display-only turn bookkeeping — applyChildAction()
        // always recomputes the real outcome via applyAction()/
        // resolveAllCombats() during replay, so this cache is never load-bearing.
        int movesAfterGuess = child->action.isSpawn ? 0 : std::max(0, sim.ctx.movesRemaining - 1);
        bool turnEndsGuess = child->action.isSpawn || movesAfterGuess == 0;
        child->movesRemainingAfter = turnEndsGuess ? kMovesPerTurn : movesAfterGuess;
        child->toMoveAfter = turnEndsGuess ? otherFaction(sim.ctx.mover) : sim.ctx.mover;
        node->children.push_back(std::move(child));
    }
    node->expanded.store(true, std::memory_order_release);
}

float SearchTree::terminalValue(const Board& b) const {
    if (b.endCondition == EndCondition::RedWins) return perspective_ == Faction::Red ? 1.f : -1.f;
    if (b.endCondition == EndCondition::BlackWins) return perspective_ == Faction::Black ? 1.f : -1.f;
    return 0.f; // both flavors of draw
}

void SearchTree::finishTurnIncremental(SimContext& sim, Faction mover) const {
    std::vector<std::pair<Coordinate, std::array<float, kPlanesPerSquare>>> before;
    for (int x = 0; x < kBoardSize; x++) {
        for (int y = 0; y < kBoardSize; y++) {
            Coordinate c{static_cast<int8_t>(x), static_cast<int8_t>(y)};
            if (sim.board.at(c).hasFaction(Faction::Red) && sim.board.at(c).hasFaction(Faction::Black)) {
                before.push_back({c, squarePlaneVector(sim.board, c, perspective_, belief_, true)});
            }
        }
    }
    resolveAllCombats(sim.board, mover);
    for (auto& pr : before) {
        auto newP = squarePlaneVector(sim.board, pr.first, perspective_, belief_, true);
        network_->updateAccumulatorForSquare(sim.accPreact, pr.second, newP, pr.first);
    }
    if (!sim.board.isTerminal()) sim.ctx.resetForNewTurn(otherFaction(mover));
}

void SearchTree::applyChildAction(SimContext& sim, MCTSNode* child) const {
    Faction mover = sim.ctx.mover;
    if (child->action.isSpawn) {
        Rank spawnRank = RankVal::Joker;
        Suit spawnSuit = SuitVal::JokerSuit;
        int fi = factionIndex(mover);
        if (sim.futureCursor[fi] < sim.det.futureDraws[fi].size()) {
            spawnRank = sim.det.futureDraws[fi][sim.futureCursor[fi]].first;
            spawnSuit = sim.det.futureDraws[fi][sim.futureCursor[fi]].second;
            sim.futureCursor[fi]++;
        }
        auto oldP = squarePlaneVector(sim.board, child->action.to, perspective_, belief_, true);
        ApplyOutcome out = applyAction(sim.board, sim.ctx, child->action, spawnRank, spawnSuit);
        if (!out.legal) return;
        auto newP = squarePlaneVector(sim.board, child->action.to, perspective_, belief_, true);
        network_->updateAccumulatorForSquare(sim.accPreact, oldP, newP, child->action.to);
        if (out.turnEnded) finishTurnIncremental(sim, mover);
    } else {
        auto oldFrom = squarePlaneVector(sim.board, child->action.from, perspective_, belief_, true);
        auto oldTo = squarePlaneVector(sim.board, child->action.to, perspective_, belief_, true);
        ApplyOutcome out = applyAction(sim.board, sim.ctx, child->action);
        if (!out.legal) return;
        auto newFrom = squarePlaneVector(sim.board, child->action.from, perspective_, belief_, true);
        auto newTo = squarePlaneVector(sim.board, child->action.to, perspective_, belief_, true);
        network_->updateAccumulatorForSquare(sim.accPreact, oldFrom, newFrom, child->action.from);
        network_->updateAccumulatorForSquare(sim.accPreact, oldTo, newTo, child->action.to);
        if (out.turnEnded) finishTurnIncremental(sim, mover);
    }
}

void SearchTree::runOneIteration(std::mt19937& rng, std::atomic<int>& iterCounter, TranspositionTable& localTT) {
    SimContext sim;
    sim.det = determinize(trueBoard_, perspective_, belief_, rng);
    sim.board = sim.det.board;
    sim.ctx = rootCtx_;
    network_->refreshAccumulator(sim.board, perspective_, belief_, true, sim.accPreact);

    root_->visits.fetch_add(1, std::memory_order_relaxed);
    std::vector<MCTSNode*> path;
    path.push_back(root_.get());
    MCTSNode* node = root_.get();

    while (true) {
        if (sim.board.isTerminal()) break;
        if (!node->expanded.load(std::memory_order_acquire) || node->children.empty()) break;

        MCTSNode* chosen = selectChild(node);
        if (!chosen) break;

        chosen->visits.fetch_add(1, std::memory_order_relaxed);
        atomicAddDouble(chosen->valueSum, -cfg_.virtualLoss);

        applyChildAction(sim, chosen);
        path.push_back(chosen);
        node = chosen;
    }

    float leafValue;
    if (sim.board.isTerminal()) {
        leafValue = terminalValue(sim.board);
    } else if (node->expanded.load(std::memory_order_acquire)) {
        // Reached a node that's already expanded with zero children (a
        // legitimate dead end — see rules.hpp — which the selection loop
        // above can't walk past) or lost a narrow race where another
        // thread expanded it between the loop's check and here. Either
        // way, no priors are needed, only a value — exactly the case a
        // thread-local value cache helps with, since without one this
        // dead-end case would otherwise re-run a full forward pass every
        // single time any iteration reaches it.
        uint64_t hash = zobrist_.hash(sim.board, sim.ctx);
        float cached;
        if (localTT.probe(hash, cached, 0)) {
            leafValue = cached;
        } else {
            auto glob = globalFeatures(sim.board, perspective_, sim.ctx.movesRemaining, sim.ctx.mover, belief_, true);
            Network::Output netOut = network_->forwardFromAccumulator(sim.accPreact, glob);
            leafValue = netOut.wdl[0] - netOut.wdl[2];
            localTT.store(hash, leafValue, 0);
        }
    } else {
        // The common case: a genuinely new leaf. ONE forward pass serves
        // both expand()'s priors and the backprop value — a prior version
        // of this function called the network a second time via a since-
        // removed evaluateLeaf(), silently doubling every expansion's cost
        // for no behavioral difference (both calls were deterministic
        // given the same input, so it was pure waste, not a correctness bug).
        auto glob = globalFeatures(sim.board, perspective_, sim.ctx.movesRemaining, sim.ctx.mover, belief_, true);
        Network::Output netOut = network_->forwardFromAccumulator(sim.accPreact, glob);
        expand(node, sim, netOut, rng);
        leafValue = netOut.wdl[0] - netOut.wdl[2];
        uint64_t hash = zobrist_.hash(sim.board, sim.ctx);
        localTT.store(hash, leafValue, 0);
    }

    double rootContribution = (path[0]->moverAtNode == perspective_) ? leafValue : -leafValue;
    atomicAddDouble(path[0]->valueSum, rootContribution);
    for (size_t i = 1; i < path.size(); i++) {
        double contribution = (path[i]->moverAtNode == perspective_) ? leafValue : -leafValue;
        atomicAddDouble(path[i]->valueSum, contribution + cfg_.virtualLoss);
    }

    iterCounter.fetch_add(1, std::memory_order_relaxed);
}

void SearchTree::workerLoop(uint64_t seed, std::atomic<bool>& stop, std::atomic<int>& iterCounter) {
    std::mt19937 rng(seed);
    // Thread-local: never shared, so it needs no locking at all. Small
    // (1MB) since each thread gets its own — see the header comment on
    // runOneIteration's localTT parameter for what it caches and why.
    TranspositionTable localTT(1);
    while (!stop.load(std::memory_order_relaxed)) {
        runOneIteration(rng, iterCounter, localTT);
    }
}

void SearchTree::expandRootWithDirichletIfNeeded() {
    if (!root_->expanded.load(std::memory_order_acquire)) {
        SimContext sim;
        sim.ctx = rootCtx_;
        if (cfg_.beliefConsistentRoot) {
            sim.board = obfuscate(trueBoard_, perspective_);
            network_->refreshAccumulator(sim.board, perspective_, belief_, false, sim.accPreact);
            auto glob = globalFeatures(sim.board, perspective_, sim.ctx.movesRemaining, sim.ctx.mover, belief_, false);
            Network::Output netOut = network_->forwardFromAccumulator(sim.accPreact, glob);
            expand(root_.get(), sim, netOut, masterRng_);
        } else {
            sim.det = determinize(trueBoard_, perspective_, belief_, masterRng_);
            sim.board = sim.det.board;
            network_->refreshAccumulator(sim.board, perspective_, belief_, true, sim.accPreact);
            auto glob = globalFeatures(sim.board, perspective_, sim.ctx.movesRemaining, sim.ctx.mover, belief_, true);
            Network::Output netOut = network_->forwardFromAccumulator(sim.accPreact, glob);
            expand(root_.get(), sim, netOut, masterRng_);
        }
        return;
    }
    if (root_->children.empty()) return;
    // Root was promoted from a previously-expanded non-root node via
    // advanceRoot() (subtree reuse): its children's priors were set without
    // root-level noise back when they were created. Mix noise in once now,
    // so this move's search still benefits from exploration diversity.
    std::gamma_distribution<double> gamma(cfg_.dirichletAlpha, 1.0);
    std::vector<double> noise(root_->children.size());
    double sum = 0;
    for (auto& n : noise) { n = std::max(1e-6, gamma(masterRng_)); sum += n; }
    for (size_t i = 0; i < root_->children.size(); i++) {
        double nn = noise[i] / sum;
        auto& c = root_->children[i];
        c->prior = static_cast<float>((1.0 - cfg_.dirichletEpsilon) * c->prior + cfg_.dirichletEpsilon * nn);
    }
}

SearchTree::SearchResult SearchTree::search() {
    // Immediate forced-win shortcut, matching hybrid_engine_3.hpp's
    // moveCreatesImmediateWin(): if any legal action right now ends the game
    // in the root player's favor, take it without spending any search
    // budget. A real gap in this engine before this fix — it relied on MCTS
    // *discovering* forced wins via exact terminal-value backup, which is
    // reliable given enough iterations but, unlike an explicit check, isn't
    // guaranteed with a small budget or unhelpful priors.
    {
        auto legalNow = generateLegalActions(trueBoard_, rootCtx_);
        for (auto& a : legalNow) {
            Board trial = trueBoard_;
            TurnContext trialCtx = rootCtx_;
            Rank sr = RankVal::Nine;
            Suit ss = suitsOf(rootCtx_.mover)[0];
            ApplyOutcome outcome = applyAction(trial, trialCtx, a, sr, ss);
            if (outcome.turnEnded) resolveAllCombats(trial, rootCtx_.mover);
            bool weWin = (trial.endCondition == EndCondition::RedWins && perspective_ == Faction::Red) ||
                         (trial.endCondition == EndCondition::BlackWins && perspective_ == Faction::Black);
            if (weWin) {
                SearchResult forced;
                forced.bestAction = a;
                forced.visitPolicy[a.atomicIndex()] = 1.0f;
                forced.tacticalVisitPolicy[a.atomicIndex()] = 1.0f;
                if (!a.isSpawn) forced.selectorVisitPolicy[selectorIndex(a.from, a.ownerOrdinal)] = 1.0f;
                forced.rootValueEstimate = 1.0f;
                forced.rootTacticalityGate = 1.0f;
                forced.tacticalVisitFraction = 1.0f;
                forced.totalIterations = 0;
                return forced;
            }
        }
    }

    expandRootWithDirichletIfNeeded();

    std::atomic<bool> stop{false};
    std::atomic<int> iterCounter{0};
    auto startTime = std::chrono::steady_clock::now();

    // Single-threaded fixed-iteration mode: run synchronously on this
    // thread. A worker-plus-waiter pair would race the stop flag and
    // overshoot the budget by one iteration depending on scheduling,
    // which would quietly reintroduce run-to-run nondeterminism into
    // training targets and paired evaluations.
    if (cfg_.fixedIterations > 0 && cfg_.numThreads == 1) {
        std::mt19937 rng(masterRng_());
        TranspositionTable localTT(1);
        initializeSequentialHalvingCandidates();
        if ((cfg_.rootStrategy == RootSearchStrategy::GumbelSequentialHalving ||
             cfg_.rootStrategy == RootSearchStrategy::GumbelCompletedQ ||
             cfg_.rootStrategy == RootSearchStrategy::GumbelVisitAwareQ ||
             cfg_.rootStrategy == RootSearchStrategy::GumbelPairedDeterminization) && !root_->children.empty()) {
            // Gumbel top-k candidate set followed by balanced sequential halving.
            // One fixed Gumbel sample creates without-replacement root exploration;
            // rounds then compare completed value estimates at equal allocation.
            std::vector<MCTSNode*> active;
            struct Ranked { double score; MCTSNode* node; };
            std::vector<Ranked> rank;
            std::unordered_map<const MCTSNode*,double> gumbelScore;
            std::uniform_real_distribution<double> unif(1e-9,1.0-1e-9);
            for(auto& c:root_->children){double g=-std::log(-std::log(unif(rng)));
                double s=std::log(std::max(1e-12f,c->prior))+g;
                rank.push_back({s,c.get()}); gumbelScore[c.get()]=s;}
            std::stable_sort(rank.begin(),rank.end(),[](const Ranked&a,const Ranked&b){return a.score>b.score;});
            int cap=std::min<int>(8,rank.size()); for(int i=0;i<cap;i++)active.push_back(rank[i].node);
            int spent=0;
            while(active.size()>1 && spent<cfg_.fixedIterations){
                int roundsLeft=0;for(size_t n=active.size();n>1;n=(n+1)/2)roundsLeft++;
                int budget=std::max<int>(active.size(),(cfg_.fixedIterations-spent)/std::max(1,roundsLeft));
                budget=std::min(budget,cfg_.fixedIterations-spent);
                if (cfg_.rootStrategy == RootSearchStrategy::GumbelPairedDeterminization) {
                    // Common-random-number allocation: every active root action in a
                    // batch is evaluated under the same determinization seed. This
                    // reduces hidden-deal variance in pairwise ranking without adding
                    // iterations or network evaluations.
                    int j=0;
                    while(j<budget){uint32_t commonSeed=rng();
                        for(size_t k=0;k<active.size() && j<budget;k++,j++){
                            std::mt19937 paired(commonSeed); forcedRootChild_=active[k];
                            runOneIteration(paired,iterCounter,localTT);spent++;}}
                } else {
                    for(int j=0;j<budget;j++){forcedRootChild_=active[j%active.size()];runOneIteration(rng,iterCounter,localTT);spent++;}
                }
                if (cfg_.rootStrategy == RootSearchStrategy::GumbelVisitAwareQ) {
                    // Visit-aware completed Q: shrink low-visit child values toward
                    // the root estimate, then let direct evidence dominate smoothly.
                    // This changes elimination ranking only; allocation and compute
                    // remain identical to the iteration-20 branch.
                    const double rootQ = valueFromMoverPerspective(root_.get(), perspective_);
                    std::stable_sort(active.begin(),active.end(),[rootQ](const MCTSNode*a,const MCTSNode*b){
                        auto cq=[rootQ](const MCTSNode*c){int n=c->visits.load(std::memory_order_relaxed);
                            constexpr double pseudo=3.0; return (n*c->q()+pseudo*rootQ)/(n+pseudo);};
                        double as=cq(a),bs=cq(b);if(as!=bs)return as>bs;return a->visits.load()>b->visits.load();});
                } else if (cfg_.rootStrategy == RootSearchStrategy::GumbelCompletedQ) {
                    // Completed-Q ranking retains the one-time Gumbel perturbation
                    // during elimination instead of discarding it after top-k. Normalize
                    // within the active set, then combine with bounded Q so neither term
                    // dominates by raw scale.
                    double lo=1e100,hi=-1e100;
                    for(auto*c:active){lo=std::min(lo,gumbelScore[c]);hi=std::max(hi,gumbelScore[c]);}
                    std::stable_sort(active.begin(),active.end(),[&](const MCTSNode*a,const MCTSNode*b){
                        double den=std::max(1e-9,hi-lo);
                        double as=a->q()+0.25*((gumbelScore[a]-lo)/den-0.5);
                        double bs=b->q()+0.25*((gumbelScore[b]-lo)/den-0.5);
                        if(as!=bs)return as>bs;return a->visits.load()>b->visits.load();});
                } else {
                    std::stable_sort(active.begin(),active.end(),[](const MCTSNode*a,const MCTSNode*b){
                        if(a->q()!=b->q())return a->q()>b->q();return a->visits.load()>b->visits.load();});
                }
                active.resize((active.size()+1)/2);
            }
            while(spent<cfg_.fixedIterations){forcedRootChild_=active.front();runOneIteration(rng,iterCounter,localTT);spent++;}
            forcedRootChild_=nullptr;
        } else if (cfg_.rootStrategy == RootSearchStrategy::RootUcbBestArm && !root_->children.empty()) {
            // Best-arm identification at root. First visit each action once in
            // model-prior order, then allocate to the action with the largest
            // uncertainty-aware upper confidence bound. PUCT remains below root.
            std::vector<MCTSNode*> roots;
            for(auto& c:root_->children) roots.push_back(c.get());
            std::stable_sort(roots.begin(),roots.end(),[](const MCTSNode*a,const MCTSNode*b){
                if(a->prior!=b->prior)return a->prior>b->prior;
                return a->action.atomicIndex()<b->action.atomicIndex();});
            for(int i=0;i<cfg_.fixedIterations;i++){
                MCTSNode* pick=nullptr;
                if(i<(int)roots.size()) pick=roots[i];
                else {
                    double best=-1e100;
                    for(auto*c:roots){int v=c->visits.load(std::memory_order_relaxed);double q=c->q();
                        double u=std::sqrt(2.0*std::log(std::max(2,i+1))/std::max(1,v));
                        double score=q+u;
                        if(score>best){best=score;pick=c;}}
                }
                forcedRootChild_=pick; runOneIteration(rng,iterCounter,localTT);
            }
            forcedRootChild_=nullptr;
        } else if (cfg_.rootStrategy == RootSearchStrategy::RootRoundRobin && !root_->children.empty()) {
            // Pure root allocation: every legal action receives one iteration in
            // deterministic prior order before the next cycle. PUCT only acts below
            // the forced root child. This tests whether root starvation, not the
            // evaluator, is the small-budget bottleneck.
            std::vector<MCTSNode*> roots;
            for (auto& c : root_->children) roots.push_back(c.get());
            std::stable_sort(roots.begin(), roots.end(), [](const MCTSNode* a,const MCTSNode* b){
                if(a->prior!=b->prior)return a->prior>b->prior;
                return a->action.atomicIndex()<b->action.atomicIndex();});
            for(int i=0;i<cfg_.fixedIterations;i++){
                forcedRootChild_=roots[i%roots.size()];
                runOneIteration(rng,iterCounter,localTT);
            }
            forcedRootChild_=nullptr;
        } else if (cfg_.rootStrategy == RootSearchStrategy::SequentialHalving && allowedRootChildren_.size() > 1) {
            int spent = 0;
            int rounds = 0;
            for (size_t n = allowedRootChildren_.size(); n > 1; n = (n + 1) / 2) rounds++;
            for (int round = 0; round < rounds && spent < cfg_.fixedIterations; round++) {
                const int remainingRounds = rounds - round;
                const int roundBudget = std::max(
                    static_cast<int>(allowedRootChildren_.size()) * cfg_.sequentialHalving.minVisitsPerRound,
                    (cfg_.fixedIterations - spent) / remainingRounds);
                const int target = std::min(cfg_.fixedIterations, spent + roundBudget);
                while (spent < target) { runOneIteration(rng, iterCounter, localTT); spent++; }
                halveSequentialCandidates();
            }
            while (spent < cfg_.fixedIterations) { runOneIteration(rng, iterCounter, localTT); spent++; }
        } else {
            for (int i = 0; i < cfg_.fixedIterations; i++) runOneIteration(rng, iterCounter, localTT);
        }
        SearchResult result;
        result.totalIterations = iterCounter.load();
        result.rootValueEstimate = static_cast<float>(valueFromMoverPerspective(root_.get(), perspective_));
        finalizeResult(result);
        return result;
    }

    std::vector<std::thread> workers;
    int nThreads = std::max(1, cfg_.numThreads);
    workers.reserve(nThreads);
    for (int t = 0; t < nThreads; t++) {
        uint64_t seed = masterRng_(); // drawn on this (single) thread before spawning — no data race
        workers.emplace_back([this, &stop, &iterCounter, seed]() { workerLoop(seed, stop, iterCounter); });
    }

    // Dynamic time management ("budget searching"): keep sampling the root's
    // visit margin between the two best children. A clear leader well before
    // the base budget is spent lets us stop early; a close race at the base
    // budget's edge earns extra time, up to a hard cap.
    // In fixed-iterations mode none of this applies: the loop below runs to
    // the exact iteration count, deterministically.
    while (cfg_.fixedIterations <= 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        int elapsedMs = static_cast<int>(
            std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - startTime).count());
        int iters = iterCounter.load(std::memory_order_relaxed);

        if (elapsedMs >= cfg_.hardCapMs) break;
        if (iters < cfg_.minIterationsBeforeTimeCheck) continue;

        int top = 0, second = 0;
        for (auto& c : root_->children) {
            int v = c->visits.load(std::memory_order_relaxed);
            if (v > top) { second = top; top = v; } else if (v > second) second = v;
        }
        int totalRootVisits = std::max(1, root_->visits.load(std::memory_order_relaxed));
        double margin = static_cast<double>(top - second) / totalRootVisits;

        if (elapsedMs >= cfg_.baseTimeMs) {
            if (margin < cfg_.extendIfMarginBelow) continue; // uncertain: keep going toward hardCapMs
            break;
        }
        if (elapsedMs >= cfg_.baseTimeMs * cfg_.stopEarlyMinFractionOfBase && margin > cfg_.stopEarlyIfMarginAbove) {
            break; // clearly settled: don't burn the rest of the budget
        }
    }
    stop.store(true, std::memory_order_relaxed);
    for (auto& th : workers) th.join();

    SearchResult result;
    result.totalIterations = iterCounter.load();
    result.rootValueEstimate = static_cast<float>(valueFromMoverPerspective(root_.get(), perspective_));
    finalizeResult(result);
    return result;
}

void SearchTree::finalizeResult(SearchResult& result) {
    int totalVisits = 0;
    for (auto& c : root_->children) totalVisits += c->visits.load(std::memory_order_relaxed);

    std::array<int, kNumAtomicActions> tacticalVisitSum{};
    tacticalVisitSum.fill(0);
    std::array<float, kNumSelectorActions> selectorVisitSum{};
    selectorVisitSum.fill(0.f);
    int tacticalTotal = 0;
    int maxVisits = -1;

    for (auto& c : root_->children) {
        int v = c->visits.load(std::memory_order_relaxed);
        int idx = c->action.atomicIndex();
        result.visitPolicy[idx] += static_cast<float>(v);
        if (v > 0) { result.rootActionValues[idx] += static_cast<float>(v * c->q()); result.rootActionValueMask[idx] = 1; result.rootActionVisits[idx] += v; }
        if (c->wasAttackWhenGenerated) { tacticalVisitSum[idx] += v; tacticalTotal += v; }
        if (!c->action.isSpawn)
            selectorVisitSum[selectorIndex(c->action.from, c->action.ownerOrdinal)] += static_cast<float>(v);
        if (rootChildAllowed(c.get()) && v > maxVisits) { maxVisits = v; result.bestAction = c->action; }
    }
    if (totalVisits > 0) for (auto& x : result.visitPolicy) x /= static_cast<float>(totalVisits);
    for (int i = 0; i < kNumAtomicActions; i++) if (result.rootActionValueMask[i] && result.visitPolicy[i] > 0.f)
        result.rootActionValues[i] /= std::max(1.f, result.visitPolicy[i] * totalVisits);
    // Normalize the selector target per tile; untouched tiles stay all-zero
    // and are masked out of the selector loss (network.cpp).
    for (int tile = 0; tile < kNumSquares; tile++) {
        float mass = 0.f;
        for (int sl = 0; sl < kMaxStack; sl++) mass += selectorVisitSum[tile * kMaxStack + sl];
        if (mass <= 0.f) continue;
        for (int sl = 0; sl < kMaxStack; sl++)
            result.selectorVisitPolicy[tile * kMaxStack + sl] = selectorVisitSum[tile * kMaxStack + sl] / mass;
    }
    if (tacticalTotal > 0) {
        for (int i = 0; i < kNumAtomicActions; i++)
            result.tacticalVisitPolicy[i] = static_cast<float>(tacticalVisitSum[i]) / tacticalTotal;
    } else {
        result.tacticalVisitPolicy = result.visitPolicy; // no forcing moves were visited: fall back to the full policy
    }
    if (cfg_.completedQPolicyTarget && !root_->children.empty()) {
        const double vroot = result.rootValueEstimate;
        double lo = 1e9, hi = -1e9; int mx = 0;
        for (auto& c : root_->children) { int v = c->visits.load(std::memory_order_relaxed); double q = v > 0 ? c->q() : vroot; lo = std::min(lo, q); hi = std::max(hi, q); mx = std::max(mx, v); }
        const double den = hi - lo > 1e-9 ? hi - lo : 1.0;
        std::vector<double> lg(root_->children.size());
        double m = -1e300;
        for (size_t k = 0; k < root_->children.size(); k++) { auto& c = root_->children[k]; int v = c->visits.load(std::memory_order_relaxed); double q = v > 0 ? c->q() : vroot;
            lg[k] = std::log(std::max(1e-12f, c->prior)) + (cfg_.cqVisit + mx) * cfg_.cqScale * ((q - lo) / den); m = std::max(m, lg[k]); }
        std::array<double, kNumAtomicActions> all{}, tac{}; double sa = 0, st = 0;
        for (size_t k = 0; k < root_->children.size(); k++) { auto& c = root_->children[k]; double e = std::exp(lg[k] - m); int idx = c->action.atomicIndex();
            all[idx] += e; sa += e; if (c->wasAttackWhenGenerated) { tac[idx] += e; st += e; } }
        for (int i = 0; i < kNumAtomicActions; i++) result.visitPolicy[i] = sa > 0 ? static_cast<float>(all[i] / sa) : 0.f;
        if (st > 0) { for (int i = 0; i < kNumAtomicActions; i++) result.tacticalVisitPolicy[i] = static_cast<float>(tac[i] / st); }
        else result.tacticalVisitPolicy = result.visitPolicy;
    }
    result.tacticalVisitFraction = totalVisits > 0 ? static_cast<float>(tacticalTotal) / totalVisits : 0.f;
    result.rootTacticalityGate = quickFogEval().tacticalityGate;
}

} // namespace checards
