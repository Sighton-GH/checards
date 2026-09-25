#include "checards/combat.hpp"

namespace checards {

std::vector<CombatEvent> resolveAllCombats(Board& board, Faction mover) {
    Faction defender = otherFaction(mover);
    std::vector<CombatEvent> events;
    bool anyCombat = false;

    for (int x = 0; x < kBoardSize; x++) {
        for (int y = 0; y < kBoardSize; y++) {
            Tile& tile = board.grid[x][y];
            StackSummary att = summarize(tile, mover);
            StackSummary def = summarize(tile, defender);
            if (att.count == 0 || def.count == 0) continue;

            tile.revealAll();
            CombatResult res = resolveCombat(att, def);

            CombatEvent ev;
            ev.at = Coordinate{static_cast<int8_t>(x), static_cast<int8_t>(y)};
            ev.attacker = mover;
            ev.defender = defender;
            ev.attackerDied = res.attackerDies;
            ev.defenderDied = res.defenderDies;
            for (int i = 0; i < tile.count; i++) {
                if (tile.cards[i].owner == mover) ev.attackerCards.push_back(tile.cards[i]);
                else ev.defenderCards.push_back(tile.cards[i]);
            }
            events.push_back(ev);
            anyCombat = true;

            if (res.attackerDies) {
                board.acesAlive[factionIndex(mover)] -= att.aces;
                tile.removeFaction(mover);
            }
            if (res.defenderDies) {
                board.acesAlive[factionIndex(defender)] -= def.aces;
                tile.removeFaction(defender);
            }
        }
    }

    if (anyCombat) board.inactivityPlies = 0;
    else board.inactivityPlies++;

    board.checkWinCondition();
    return events;
}

} // namespace checards
