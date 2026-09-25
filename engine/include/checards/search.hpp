#pragma once
// =============================================================================
// search.hpp — persistent, multithreaded SO-ISMCTS (single-observer
// information-set MCTS) with PUCT, virtual loss, and dynamic time management.
//
// PERSISTENT TREE / SUBTREE REUSE: unlike the old engine (which called
// runISMCTS() from scratch for every single micro-move, discarding all
// accumulated statistics), the tree here survives across an entire game.
// advanceRoot() re-roots at whichever child matches a real action just taken
// — by either player — keeping that child's subtree; only a genuinely novel
// action rebuilds from empty. Nodes are keyed by ATOMIC ACTIONS (action.hpp),
// so both a player's own micro-moves within a turn and the opponent's later
// moves all advance the same tree.
//
// EACH ITERATION redeterminizes the hidden cards from the current belief
// (belief.hpp) and replays the path from root to the selected leaf on a
// fresh working board, exactly as PIMC/ISMCTS requires — see the long
// comment above runOneIteration() in search.cpp for why nodes can't just
// cache a concrete board.
// =============================================================================

#include <array>
#include <atomic>
#include <memory>
#include <mutex>
#include <random>
#include <thread>
#include <vector>
#include "checards/belief.hpp"
#include "checards/board.hpp"
#include "checards/combat.hpp"
#include "checards/mcts_node.hpp"
#include "checards/network.hpp"
#include "checards/opponent_model.hpp"
#include "checards/rules.hpp"
#include "checards/search_strategy.hpp"
#include "checards/zobrist.hpp"

namespace checards {

struct SearchConfig {
    double cpuct = 1.6;
    double dirichletAlpha = 0.3;
    double dirichletEpsilon = 0.25;
    double virtualLoss = 1.0;
    double fpuReduction = 0.0; // first-play-urgency: unvisited children start at parentQ - fpuReduction
    int numThreads = 1;
    int baseTimeMs = 400;
    int hardCapMs = 1500;
    // When > 0, every search runs exactly this many iterations with NO
    // wall-clock stopping and no dynamic early-stop/extend decisions. Time
    // budgets make visit counts (and therefore training targets and paired
    // evaluations) depend on machine load; a fixed iteration budget makes a
    // run bit-for-bit reproducible and gives paired A/B games an identical
    // thinking budget by construction. Use numThreads=1 with this for full
    // determinism (multithreaded virtual-loss interleaving is inherently
    // schedule-dependent). 0 = the normal time-managed mode.
    int fixedIterations = 0;
    int minIterationsBeforeTimeCheck = 32;
    // Dynamic time management thresholds (see search.cpp::shouldExtend/shouldStopEarly).
    double extendIfMarginBelow = 0.15;
    double stopEarlyIfMarginAbove = 0.6;
    double stopEarlyMinFractionOfBase = 0.4;
    // Opponent-model blending weight for the OPPONENT's simulated move priors
    // (see search.cpp expansion code); 0 disables it entirely.
    double opponentModelBlend = 0.25;
    // Cycle-4 isolated selector residual: blend the learned exact-card
    // conditional with the proven uniform conditional. 0 exactly reproduces
    // the cycle-1 champion; 1 uses the learned selector fully. Kept separate
    // from network weights so influence can be capped and swept safely.
    double selectorResidualWeight = 1.0;
    // Iteration 27: training-target mode. false = raw visit counts (legacy).
    // true = Gumbel completed-Q improved policy: softmax(log prior + sigma(q)),
    // unvisited children use the root value; sigma = (cqVisit + maxN) * cqScale * minmax(q).
    bool completedQPolicyTarget = false;
    double cqVisit = 50.0;
    double cqScale = 0.1;
    // Search-policy strategy hook. Negative keeps the learned tacticality
    // gate; [0,1] selects a fixed tactical-head weight. This isolates search
    // engineering from immutable network/checkpoint state.
    double fixedTacticalPolicyWeight = -1.0;
    bool beliefConsistentRoot = false;
    bool linearBeliefAdapterEnabled = false;
    std::array<std::array<float, kNumGlobalFeatures>, kNumAtomicActions> linearBeliefWeights{};
    static constexpr int kBeliefAdapterHidden = 16;
    bool nonlinearBeliefAdapterEnabled = false;
    std::array<std::array<float, kNumGlobalFeatures>, kBeliefAdapterHidden> nonlinearProjection{};
    std::array<float, kBeliefAdapterHidden> nonlinearBias{};
    std::array<std::array<float, kBeliefAdapterHidden>, kNumAtomicActions> nonlinearOutput{};
    RootSearchStrategy rootStrategy = RootSearchStrategy::Puct;
    SequentialHalvingConfig sequentialHalving{};
};

class SearchTree {
public:
    SearchTree(Faction perspective, Network* network, SearchConfig cfg = SearchConfig());

    // Seeds the master RNG (root Dirichlet noise, root determinization).
    // AIPlayer calls this from its own seeded RNG so training/evaluation
    // runs are reproducible; without it the tree seeds from
    // std::random_device and identical configs produce different games.
    void setMasterSeed(uint64_t seed) { masterRng_.seed(seed); }

    // (Re)initializes the tree for a brand-new game / position with no
    // reusable history (e.g. right after setup).
    void resetRoot(const Board& trueBoard, const TurnContext& ctx, const BeliefState& belief);

    // Advances the persistent tree by one real atomic action (taken by
    // either player). Reuses the matching child subtree when found.
    void advanceRoot(const Action& realAction, const Board& newTrueBoard, const TurnContext& newCtx,
                      const BeliefState& newBelief);

    struct SearchResult {
        Action bestAction{};
        std::array<float, kNumAtomicActions> visitPolicy{};         // strategic policy training target
        std::array<float, kNumAtomicActions> tacticalVisitPolicy{}; // tactical policy training target
        // Selector-head training target: per-tile distribution over stack
        // ordinals, built from the root children's exact-card visit counts
        // (summed across directions, normalized per tile). Tiles with no
        // visits stay all-zero, which masks them out of the selector loss
        // entirely (see network.cpp's masked selector head).
        std::array<float, kNumSelectorActions> selectorVisitPolicy{};
        std::array<float, kNumAtomicActions> rootActionValues{};
        std::array<uint8_t, kNumAtomicActions> rootActionValueMask{};
        std::array<int, kNumAtomicActions> rootActionVisits{};
        float rootValueEstimate = 0.f;
        float rootTacticalityGate = 0.5f;
        // Fraction of ALL root visits that went to a forcing/attacking action.
        // This is the gate-head training target (selfplay.cpp), and it's
        // deliberately NOT "did a legal attack merely exist" (see the long
        // comment in AIActor::recordDecision in selfplay.cpp for why that
        // earlier version of the target was miscalibrated).
        float tacticalVisitFraction = 0.f;
        int totalIterations = 0;
    };
    SearchResult search();

    // Fast, no-search evaluation of the true (fog-aware) current position —
    // used for dynamic time management seeding, opponent-model context, and
    // any UI/logging that wants "how are things right now" without paying
    // for a full search.
    Network::Output quickFogEval() const;

    OpponentModel* opponentModel = nullptr; // non-owning; null disables blending

private:
    Faction perspective_;
    Network* network_;
    SearchConfig cfg_;
    std::unique_ptr<MCTSNode> root_;
    Board trueBoard_;
    TurnContext rootCtx_;
    BeliefState belief_;
    std::mt19937 masterRng_;
    Zobrist zobrist_; // immutable after construction, safe to share read-only across search threads
    std::vector<const MCTSNode*> allowedRootChildren_; // empty means all root actions
    const MCTSNode* forcedRootChild_ = nullptr;

    struct SimContext {
        Board board;
        TurnContext ctx;
        Determinization det;
        size_t futureCursor[2] = {0, 0};
        std::vector<float> accPreact; // incremental NNUE accumulator, perspective-relative
    };

    void expandRootWithDirichletIfNeeded();
    // Shared tail of search(): visit-policy aggregation (both geometric
    // heads + the selector target) and best-action pick from the root's
    // children. Used by both the threaded and synchronous fixed-iteration
    // paths so they can't drift apart.
    void finalizeResult(SearchResult& result);
    MCTSNode* selectChild(MCTSNode* node) const;
    // Populates node's children using an ALREADY-COMPUTED network output
    // (the caller gets this from the same forward pass it uses for the leaf
    // value — see the note in search.cpp about the redundant-call bug this
    // fixes). Does nothing if node is already expanded.
    void expand(MCTSNode* node, SimContext& sim, const Network::Output& netOut, std::mt19937& rng);
    float terminalValue(const Board& b) const;
    void applyChildAction(SimContext& sim, MCTSNode* child) const;
    void finishTurnIncremental(SimContext& sim, Faction mover) const;
    // `localTT` is a per-WORKER-THREAD cache (see workerLoop) — never shared
    // across threads, so it needs no locking. It caches leaf VALUES only
    // (not policy, to keep memory small); see search.cpp for exactly which
    // cases this avoids a redundant network call for.
    void runOneIteration(std::mt19937& rng, std::atomic<int>& iterCounter, TranspositionTable& localTT);
    void workerLoop(uint64_t seed, std::atomic<bool>& stop, std::atomic<int>& iterCounter);
    void initializeSequentialHalvingCandidates();
    void halveSequentialCandidates();
    bool rootChildAllowed(const MCTSNode* child) const;

    // A node's valueSum accumulates in ITS OWN moverAtNode's perspective
    // (see the long comment in search.cpp above this function's
    // implementation for the full derivation of why). This converts to the
    // perspective of an arbitrary player: same mover -> value as-is,
    // opposite mover -> negate (this is a zero-sum, two-player game, so a
    // perspective flip is always just a sign flip).
    static double valueFromMoverPerspective(const MCTSNode* n, Faction mover) {
        return (n->moverAtNode == mover) ? n->q() : -n->q();
    }
};

} // namespace checards
