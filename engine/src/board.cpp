#include "checards/board.hpp"
#include <sstream>
#include <iomanip>

namespace checards {

std::string Board::render(Faction viewer) const {
    std::ostringstream out;
    out << "    ";
    for (int x = 0; x < kBoardSize; x++) out << " col" << x << " ";
    out << "\n";
    for (int y = 0; y < kBoardSize; y++) {
        out << "row" << y << " ";
        for (int x = 0; x < kBoardSize; x++) {
            const Tile& t = grid[x][y];
            std::ostringstream cell;
            if (t.empty()) {
                cell << ".";
            } else {
                for (int i = 0; i < t.count; i++) {
                    const Card& c = t.cards[i];
                    bool canSee = c.revealed || c.owner == viewer || viewer == Faction::None;
                    if (i) cell << "+";
                    cell << (canSee ? c.name() : std::string("??"));
                }
            }
            out << std::left << std::setw(7) << cell.str();
        }
        out << "\n";
    }
    out << "Red aces: " << acesAlive[factionIndex(Faction::Red)]
        << "  Black aces: " << acesAlive[factionIndex(Faction::Black)]
        << "  Red deck: " << drawPileSize[factionIndex(Faction::Red)]
        << "  Black deck: " << drawPileSize[factionIndex(Faction::Black)] << "\n";
    return out.str();
}

} // namespace checards
