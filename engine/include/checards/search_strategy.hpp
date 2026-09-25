#pragma once
#include <string_view>

namespace checards {

// Search policy is configuration, never checkpoint state. New algorithms can
// be evaluated against the same immutable network and rules implementation.
enum class RootSearchStrategy {
    Puct,
    SequentialHalving,
    RootRoundRobin,
    RootUcbBestArm,
    GumbelSequentialHalving,
    GumbelCompletedQ,
    GumbelVisitAwareQ,
    GumbelPairedDeterminization};

inline std::string_view rootSearchStrategyName(RootSearchStrategy s) {
    if (s == RootSearchStrategy::SequentialHalving) return "sequential-halving";
    if (s == RootSearchStrategy::RootRoundRobin) return "root-round-robin";
    if (s == RootSearchStrategy::RootUcbBestArm) return "root-ucb-best-arm";
    if (s == RootSearchStrategy::GumbelSequentialHalving) return "gumbel-sequential-halving";
    if (s == RootSearchStrategy::GumbelCompletedQ) return "gumbel-completed-q";
    if (s == RootSearchStrategy::GumbelVisitAwareQ) return "gumbel-visit-aware-q";
    if (s == RootSearchStrategy::GumbelPairedDeterminization) return "gumbel-paired-determinization";
    return "puct";
}

struct SequentialHalvingConfig {
    int maxRootCandidates = 8;
    int minVisitsPerRound = 1;
    double priorScoreWeight = 0.15;
};

} // namespace checards
