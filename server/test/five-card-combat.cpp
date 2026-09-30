// Regression: each faction has a four-card stack limit, not a four-card
// contested-tile limit. A fifth card in the tile must be counted in combat.
#include <cassert>
#include <cstdio>
#include "checards/rules.hpp"
#include "checards/combat.hpp"
using namespace checards;
int main() {
    Board b;
    Coordinate target{3, 3}, from{4, 3};
    auto& t = b.at(target);
    assert(t.push(Card(RankVal::Queen, SuitVal::Clubs, Faction::Black)));
    assert(t.push(Card(RankVal::Queen, SuitVal::Spades, Faction::Black)));
    assert(t.push(Card(RankVal::Queen, SuitVal::Diamonds, Faction::Red)));
    assert(t.push(Card(RankVal::Nine, SuitVal::Diamonds, Faction::Red)));
    assert(b.at(from).push(Card(RankVal::Ten, SuitVal::Diamonds, Faction::Red)));
    TurnContext ctx; ctx.resetForNewTurn(Faction::Red); ctx.movesRemaining = 1;
    const auto legal = generateLegalActions(b, ctx);
    bool moved = false;
    for (const auto& action : legal) {
        if (action.from == from && action.to == target && action.cardRank == RankVal::Ten) {
            const auto out = applyAction(b, ctx, action);
            assert(out.legal && out.wasAttack && out.turnEnded);
            moved = true; break;
        }
    }
    assert(moved && t.size() == 5 && b.at(from).empty());
    assert(t.factionSum(Faction::Red) == 31 && t.factionSum(Faction::Black) == 24);
    const auto events = resolveAllCombats(b, Faction::Red);
    assert(events.size() == 1 && !events[0].attackerDied && events[0].defenderDied);
    assert(events[0].attackerCards.size() == 3 && events[0].defenderCards.size() == 2);
    assert(t.size() == 3 && t.factionSum(Faction::Red) == 31);
    // Physical capacity accommodates two full friendly stacks while contested.
    Tile full;
    for (int i=0; i<4; i++) {
        assert(full.push(Card(RankVal::Nine, SuitVal::Diamonds, Faction::Red)));
        assert(full.push(Card(RankVal::Nine, SuitVal::Clubs, Faction::Black)));
    }
    assert(full.size() == 8 && !full.push(Card(RankVal::Ten, SuitVal::Diamonds, Faction::Red)));
    Board blocked;
    blocked.at(target) = full;
    assert(blocked.at(from).push(Card(RankVal::Ten, SuitVal::Diamonds, Faction::Red)));
    assert(!blocked.moveCardPreserving(from, target, RankVal::Ten, SuitVal::Diamonds, Faction::Red));
    assert(blocked.at(from).size() == 1 && blocked.at(target).size() == 8);
    puts("FIVE-CARD COMBAT PASS");
}
