#pragma once
// =============================================================================
// network.hpp — the multi-head evaluator.
//
//   piece-square features (1029, belief-weighted) -> accInput (256)   -+
//                                                                       +-> concat(288) -> trunk(128) -> heads
//   global features (30)                          -> globalBranch(32) -+
//
// Heads read off the shared 128-wide trunk:
//   value        : 128->32->3   softmax  (Win/Draw/Loss from `perspective`)
//   tacticalPolicy   : 128->192->399 logits over the atomic action space
//   strategicPolicy  : 128->192->399 logits over the atomic action space
//   tacticalityGate  : 128->1   sigmoid, learned blend weight (see search.hpp)
//   material/territory/phase : share a 128->24 aux trunk, then three small
//                              linear read-outs (regression/regression/softmax)
//   selector     : 128->64->196 conditional head. The 399-way policy heads
//                  choose the GEOMETRY (source square + direction, or spawn
//                  column). When several of the mover's cards share one
//                  source square, this head chooses WHICH of them moves:
//                  49 tiles x 4 stack slots (owner-relative ordinal), trained
//                  as a per-tile conditional over the ordinals actually
//                  present. P(exact action) = P_geometry(from,dir) *
//                  P_selector(ordinal | tile). Before this head existed the
//                  conditional was hard-coded uniform (see search.cpp's old
//                  groupSize split); the v1->v2 checkpoint migration zeroes
//                  the output layer so a migrated model reproduces that
//                  uniform conditional exactly until training teaches it
//                  better. No selector weights are fabricated: zero output
//                  weights are the mathematically exact uniform policy, and
//                  every non-uniform weight the head ends up with is learned
//                  from real visit data.
//
// CHECKPOINT SCHEMA: v1 files carry magic CHKNNUE1 (no selector layers),
// v2 files carry CHKNNUE2 (adds selectorHidden/selectorOut at the tail).
// load() accepts both and migrates v1 deterministically; save() always
// writes v2. Optimizer moments/RNG/replay state live in the separate
// .trainer sidecar (selfplay.hpp), keeping model checkpoints lean.
//
// WHY TWO POLICY HEADS: the brainstorm asked for tactical vs strategic
// separation ("immediate danger" vs "long-term position"). They are trained
// on two different targets built from the *same* search tree — see
// selfplay.hpp for exactly how — rather than being two copies of the same
// signal, so they specialize instead of duplicating each other.
//
// WHY A LEARNED GATE INSTEAD OF A HAND-WRITTEN ONE: a hard-coded "is this
// tactical" rule (e.g. "any capture available") is brittle and ignores
// context (a capture that loses material is not really a tactical
// opportunity). The gate head is trained directly against whether the
// position actually contained a forcing move worth taking, so search.hpp's
// blend adapts instead of following a fixed heuristic.
// =============================================================================

#include <array>
#include <string>
#include <vector>
#include "checards/action.hpp"
#include "checards/features.hpp"
#include "checards/layers.hpp"

namespace checards {

class Network {
public:
    static constexpr int kAccHidden = 256;
    static constexpr int kGlobalHidden = 32;
    static constexpr int kSharedTrunk = 128;
    static constexpr int kPolicyHidden = 192;
    static constexpr int kAuxHidden = 24;
    static constexpr int kValueHidden = 32;
    static constexpr int kSelectorHidden = 64;

    // Checkpoint schema constants. kMigrationSeed makes the v1->v2
    // selector-hidden-layer init deterministic and identical on every load,
    // so a migrated checkpoint is a stable, reproducible artifact.
    static constexpr const char* kMagicV1 = "CHKNNUE1";
    static constexpr const char* kMagicV2 = "CHKNNUE2";
    static constexpr uint32_t kMigrationSeed = 0xC4E2D5E1u;

    SparseInputLayer accInput;     // 1029 -> 256
    DenseLayer globalBranch;       // 30   -> 32
    DenseLayer trunk;              // 288  -> 128

    DenseLayer valueHidden, valueOut;           // 128->32, 32->3
    DenseLayer tacticalHidden, tacticalOut;     // 128->192, 192->399
    DenseLayer strategicHidden, strategicOut;   // 128->192, 192->399
    DenseLayer gateOut;                         // 128->1
    DenseLayer auxHidden;                       // 128->24
    DenseLayer materialOut, territoryOut, phaseOut; // 24->1, 24->1, 24->3
    DenseLayer selectorHidden, selectorOut;     // 128->64, 64->196

    int adamT = 0;
    // True when this instance came from a CHKNNUE1 (pre-selector) file and
    // its selector was filled in by the deterministic migration path.
    bool wasMigratedFromV1 = false;

    Network() = default;
    explicit Network(std::mt19937& rng);

    struct Output {
        std::array<float, 3> wdl{};
        std::array<float, kNumAtomicActions> tacticalLogits{};
        std::array<float, kNumAtomicActions> strategicLogits{};
        std::array<float, kNumSelectorActions> selectorLogits{};
        float tacticalityGate = 0.5f;
        float materialEval = 0.f;
        float territoryEval = 0.5f;
        std::array<float, 3> phase{};
    };

    // Every intermediate activation needed to backprop a single example.
    struct ForwardCache {
        std::vector<float> h1Preact, h1Act;     // accumulator
        std::vector<float> g1Preact, g1Act;     // global branch
        std::vector<float> concatAct;           // [h1Act ; g1Act]
        std::vector<float> trunkPreact, trunkAct;

        std::vector<float> valueHPre, valueHAct, valueOutPre;
        std::vector<float> tactHPre, tactHAct, tactOutPre;
        std::vector<float> stratHPre, stratHAct, stratOutPre;
        std::vector<float> gatePre;
        std::vector<float> auxHPre, auxHAct, matPre, terrPre, phasePre;
        std::vector<float> selHPre, selHAct, selOutPre;

        std::vector<WeightedFeature> sparseInput; // kept for backward()
        std::array<float, kNumGlobalFeatures> globalInput{};
    };

    Output forward(const std::vector<WeightedFeature>& sparse, const std::array<float, kNumGlobalFeatures>& global,
                    ForwardCache* cache = nullptr) const;

    // Shared tail of forward(), starting from an already-activated
    // accumulator output. Used directly by forwardFromAccumulator() so the
    // incremental hot path and the full recompute path can't drift apart.
    Output forwardCommon(const std::vector<float>& h1Act, const std::array<float, kNumGlobalFeatures>& global,
                          ForwardCache* cache) const;

    struct Targets {
        std::array<float, 3> wdl{};
        std::array<float, kNumAtomicActions> tacticalPolicy{}; // pre-normalized; zero on unvisited/illegal actions
        std::array<float, kNumAtomicActions> strategicPolicy{};
        // Per-tile conditional over stack ordinals: index tile*kMaxStack+ordinal.
        // Normalized per tile; tiles with no recorded visits stay all-zero and
        // contribute NEITHER loss NOR gradient (masked — we only have signal
        // for tiles the search actually visited; see network.cpp).
        std::array<float, kNumSelectorActions> selector{};
        float gate = 0.f;
        float material = 0.f;
        float territory = 0.f;
        std::array<float, 3> phase{};
    };

    // Head loss weights (aux heads deliberately weighted down: they exist to
    // shape the shared trunk's representation, not to dominate training).
    struct LossWeights {
        float value = 1.0f, tacticalPolicy = 1.0f, strategicPolicy = 1.0f;
        float gate = 0.1f, material = 0.1f, territory = 0.1f, phase = 0.1f;
        float selector = 1.0f;
    };

    // Runs forward + backward for one example and ACCUMULATES gradients into
    // every layer (does not step the optimizer). Returns the scalar loss for
    // logging. Call applyGradients() after a minibatch of these.
    // NOTE: no default argument for `weights` here — GCC/Clang both reject a
    // default member-initializer-backed type as a default *argument* value
    // referenced from within the same enclosing class body. Callers pass
    // Network::LossWeights{} explicitly (selfplay.cpp does).
    float accumulateGradients(const std::vector<WeightedFeature>& sparse,
                               const std::array<float, kNumGlobalFeatures>& global,
                               const Targets& targets, const LossWeights& weights);

    void applyGradients(float lr, int batchSize, float beta1 = 0.9f, float beta2 = 0.999f, float eps = 1e-8f);
    // Step only the selector head while clearing every accumulated gradient.
    // Used for a conservative warm-up that cannot drift the proven shared
    // trunk or the value/geometric policy heads.
    void applySelectorGradients(float lr, int batchSize, float beta1 = 0.9f, float beta2 = 0.999f, float eps = 1e-8f);

    bool save(const std::string& path) const;
    bool load(const std::string& path);

    // Deterministic v1 -> v2 selector migration: selectorHidden gets a
    // fixed-seed He init, selectorOut is zeroed (exact uniform conditional).
    // Called automatically by load() on CHKNNUE1 files; also used by tests.
    void initializeMigratedSelector();

    // Ordered views over every trainable layer, used by the trainer-state
    // sidecar (selfplay.cpp) to persist/restore Adam moments, and by tests.
    // Order is fixed and shared by both directions: accInput first, then the
    // dense layers in declaration order.
    std::vector<DenseLayer*> denseLayers();
    std::vector<const DenseLayer*> denseLayers() const;

    // --- Incremental accumulator maintenance ---
    // All three operate on the accumulator's PRE-activation values (ReLU is
    // nonlinear, so deltas can only be summed before it is applied). Call
    // reluInplace() (layers.hpp) — or just forwardFromAccumulator(), which
    // does it internally — when you need the activated vector.
    void refreshAccumulator(const Board& board, Faction perspective, const BeliefState& belief, bool concreteKnown,
                             std::vector<float>& hiddenPreactOut) const;
    void updateAccumulatorForSquare(std::vector<float>& hiddenPreact, const std::array<float, kPlanesPerSquare>& oldPlanes,
                                     const std::array<float, kPlanesPerSquare>& newPlanes, Coordinate sq) const;
    // Completes evaluation given an already-current PRE-activation accumulator
    // state (skips the accInput stage). Used by search.hpp's hot path together
    // with the incremental updates above.
    Output forwardFromAccumulator(const std::vector<float>& hiddenPreact, const std::array<float, kNumGlobalFeatures>& global) const;

    // --- Quantized inference path for the accumulator (AVX2 when available) ---
    struct QuantizedAccumulator {
        static constexpr float kScale = 64.0f;
        int numFeatures = 0, outSize = 0;
        std::vector<int16_t> W, b;
    };
    void quantizeAccumulator(QuantizedAccumulator& q) const;
    static void quantizedAccumulate(const QuantizedAccumulator& q, const std::vector<WeightedFeature>& active,
                                     std::vector<float>& hiddenOut);
};

} // namespace checards
