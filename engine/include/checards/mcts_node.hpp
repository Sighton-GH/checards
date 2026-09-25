#pragma once
// =============================================================================
// mcts_node.hpp — one node of the persistent information-set search tree.
//
// A node represents an ATOMIC ACTION (one king-step or one spawn), not a full
// turn. Nodes do NOT store a Board: because combat outcomes involving hidden
// cards depend on that iteration's determinization, no single concrete board
// belongs to a node in the imperfect-information setting — see belief.hpp
// and search.hpp's runOneIteration() for how the working board is instead
// rebuilt per-iteration by replaying actions from a freshly-determinized
// root (this is what makes it *information set* MCTS rather than plain
// MCTS). What a node stores (mover, moves-remaining-after, whether it was an
// attack) is all public information that does not depend on the
// determinization, so it is safe to cache directly on the node and share
// across iterations/threads.
// =============================================================================

#include <atomic>
#include <memory>
#include <mutex>
#include <vector>
#include "checards/action.hpp"
#include "checards/types.hpp"

namespace checards {

inline void atomicAddDouble(std::atomic<double>& target, double amount) {
    double current = target.load(std::memory_order_relaxed);
    while (!target.compare_exchange_weak(current, current + amount, std::memory_order_relaxed)) {}
}

class MCTSNode {
public:
    Action action{};
    Faction moverAtNode = Faction::None;    // whose action this was
    Faction toMoveAfter = Faction::None;    // whose turn it is once this action resolves
    int movesRemainingAfter = kMovesPerTurn;
    bool wasAttackWhenGenerated = false;    // computed at expansion time (public info — see header note)

    std::atomic<int> visits{0};
    std::atomic<double> valueSum{0.0}; // sum of perspective-relative scalar values backed up through here
    float prior = 0.f;                 // blended tactical/strategic prior, set once at expansion

    std::atomic<bool> expanded{false};
    std::mutex expandMutex;
    std::vector<std::unique_ptr<MCTSNode>> children;
    MCTSNode* parent = nullptr;

    double q() const {
        int v = visits.load(std::memory_order_relaxed);
        return v > 0 ? valueSum.load(std::memory_order_relaxed) / v : 0.0;
    }
};

} // namespace checards
