#pragma once
// =============================================================================
// board.hpp — the physical board. Deliberately allocation-free: MCTS will
// copy Board objects on the order of 10^5-10^6 times per second across
// threads, so every tile uses a fixed-capacity inline array instead of
// std::vector<Card> (the old engine's Tile held a vector per square, meaning
// a single Board copy could trigger dozens of heap allocations).
// =============================================================================

#include <array>
#include <cstdint>
#include <string>
#include "checards/types.hpp"

namespace checards {

class Tile {
public:
    std::array<Card, kMaxStack> cards{};
    uint8_t count = 0;

    bool empty() const { return count == 0; }
    int size() const { return count; }

    int countOwner(Faction f) const {
        int n = 0;
        for (int i = 0; i < count; i++) if (cards[i].owner == f) n++;
        return n;
    }

    bool hasFaction(Faction f) const {
        for (int i = 0; i < count; i++) if (cards[i].owner == f) return true;
        return false;
    }

    // Returns false if the tile is already at kMaxStack capacity.
    bool push(const Card& c) {
        if (count >= kMaxStack) return false;
        cards[count++] = c;
        return true;
    }

    // Removes the first card matching (rank,suit,owner). Returns true if removed.
    bool removeIdentity(Rank r, Suit s, Faction owner) {
        for (int i = 0; i < count; i++) {
            if (cards[i].rank == r && cards[i].suit == s && cards[i].owner == owner) {
                for (int j = i; j + 1 < count; j++) cards[j] = cards[j + 1];
                count--;
                return true;
            }
        }
        return false;
    }

    void removeFaction(Faction f) {
        uint8_t w = 0;
        for (int i = 0; i < count; i++) {
            if (cards[i].owner != f) cards[w++] = cards[i];
        }
        count = w;
    }

    void revealAll() {
        for (int i = 0; i < count; i++) cards[i].revealed = true;
    }

    // Sum of combat values for one faction's cards on this tile.
    int factionSum(Faction f) const {
        int s = 0;
        for (int i = 0; i < count; i++) if (cards[i].owner == f) s += cards[i].value();
        return s;
    }
    int countAces(Faction f) const {
        int n = 0;
        for (int i = 0; i < count; i++) if (cards[i].owner == f && cards[i].rank == RankVal::Ace) n++;
        return n;
    }
    int countJokers(Faction f) const {
        int n = 0;
        for (int i = 0; i < count; i++) if (cards[i].owner == f && cards[i].rank == RankVal::Joker) n++;
        return n;
    }
};

enum class EndCondition : int8_t {
    Ongoing = 0,
    RedWins = 1,
    BlackWins = 2,
    DrawMutual = 3,
    DrawInactivity = 4,
    // An engineering safety-net cutoff (selfplay.hpp::playGame's maxPlies),
    // NOT a rules-based outcome. If a game reaches this many total atomic
    // actions withOUT the real inactivity counter below already having
    // triggered, that by definition means combat kept happening periodically
    // (each occurrence resets inactivityPlies to 0) — so labeling it
    // "inactivity" would be backwards. See TrainingHarness::runGames, which
    // discards (does not train on) games that end this way, since neither
    // "draw" nor either side "winning" is a claim this case actually supports.
    AbortedPlyLimit = 5
};

class Board {
public:
    std::array<std::array<Tile, kBoardSize>, kBoardSize> grid{}; // grid[x][y]

    int acesAlive[2] = {2, 2};     // indexed by factionIndex()
    int drawPileSize[2] = {6, 6};  // cards remaining in each player's personal deck (13 - 7 starting hand)
    EndCondition endCondition = EndCondition::Ongoing;

    // NOTE ON UNITS: this counts TURNS without combat (incremented once per
    // resolveAllCombats() call, i.e. once per completed turn), NOT atomic
    // actions/micro-moves the way totalPlies below does — "60" here means
    // 60 turns (30 full rounds), not 60 micro-moves. Not in the original
    // rules text; an engineering addition to guarantee termination, since
    // ace-capture alone doesn't bound game length. Trivially disabled by
    // setting maxInactivityPlies very high.
    int inactivityPlies = 0;
    int maxInactivityPlies = 60;     // ceiling: with lots of material still on the board, allow up to this many quiet turns
    int minInactivityPlies = 16;     // floor: even a bare endgame gets at least this many turns of maneuvering first
    int perPieceInactivityBonus = 4; // scales the effective threshold with how much is still on the board — see rationale below
    int totalPlies = 0;
    int currentTurnNumber = 1;

    Tile& at(Coordinate c) { return grid[c.x][c.y]; }
    const Tile& at(Coordinate c) const { return grid[c.x][c.y]; }

    static bool inSetupZone(Faction f, Coordinate c) {
        if (!c.valid()) return false;
        if (f == Faction::Red)   return c.y < kSetupBandRows;                 // rows 0,1,2
        if (f == Faction::Black) return c.y >= kBoardSize - kSetupBandRows;   // rows 4,5,6
        return false;
    }
    static int homeRow(Faction f) { return f == Faction::Red ? 0 : kBoardSize - 1; }

    // Physically relocates one card. Does NOT resolve combat or check turn-legality;
    // callers (rules.hpp) are responsible for legality. Returns false if the move
    // is out of bounds or the friendly stack cap at the destination would be exceeded.
    bool moveCard(Coordinate from, Coordinate to, Rank r, Suit s, Faction mover) {
        if (!to.valid()) return false;
        Tile& dst = at(to);
        int friendlyAtDest = dst.countOwner(mover);
        if (friendlyAtDest >= kMaxStack) return false;
        Tile& src = at(from);
        if (!src.removeIdentity(r, s, mover)) return false;
        Card moved(r, s, mover);
        // Preserve isInitial/revealed flags of the card we just removed.
        // removeIdentity already dropped them, so re-find is wasteful; instead
        // callers that need flag-preservation should use moveCardPreserving().
        dst.push(moved);
        return true;
    }

    // Same as moveCard but preserves revealed/isInitial flags of the moving card.
    bool moveCardPreserving(Coordinate from, Coordinate to, Rank r, Suit s, Faction mover) {
        if (!to.valid()) return false;
        Tile& dst = at(to);
        if (dst.countOwner(mover) >= kMaxStack) return false;
        Tile& src = at(from);
        Card found;
        bool ok = false;
        for (int i = 0; i < src.count; i++) {
            if (src.cards[i].rank == r && src.cards[i].suit == s && src.cards[i].owner == mover) {
                found = src.cards[i];
                ok = true;
                break;
            }
        }
        if (!ok) return false;
        src.removeIdentity(r, s, mover);
        dst.push(found);
        return true;
    }

    bool spawnCard(Coordinate dest, Rank r, Suit s, Faction owner) {
        if (!dest.valid()) return false;
        Tile& t = at(dest);
        if (!t.empty()) return false; // spawns require a truly blank back-row square
        Card c(r, s, owner, /*isInitial=*/false);
        return t.push(c);
    }

    // Recomputes acesAlive from scratch (used after combat resolution / as a sanity check).
    void recomputeAcesAlive() {
        int red = 0, black = 0;
        for (int x = 0; x < kBoardSize; x++)
            for (int y = 0; y < kBoardSize; y++)
                for (int i = 0; i < grid[x][y].count; i++) {
                    const Card& c = grid[x][y].cards[i];
                    if (c.rank == RankVal::Ace) {
                        if (c.owner == Faction::Red) red++; else black++;
                    }
                }
        acesAlive[factionIndex(Faction::Red)] = red;
        acesAlive[factionIndex(Faction::Black)] = black;
    }

    int totalPiecesOnBoard() const {
        int n = 0;
        for (int x = 0; x < kBoardSize; x++)
            for (int y = 0; y < kBoardSize; y++) n += grid[x][y].count;
        return n;
    }

    // "Look at it from a scale of what has to happen, not just what moves":
    // a bare 1-Ace-vs-1-Ace endgame realistically resolves (or reveals
    // itself as a genuine mutual-avoidance stall) in far fewer turns than a
    // dense midgame position with many pieces still capable of maneuvering
    // without yet making contact — a single fixed threshold either lets
    // simple endgames drag on pointlessly or risks cutting complex
    // midgames short. This scales linearly with remaining material between
    // the two configured bounds; the exact slope (perPieceInactivityBonus)
    // is a reasonable starting heuristic, not a value derived from any
    // actual game data — worth revisiting once real games exist to look at.
    int effectiveInactivityThreshold() const {
        int scaled = perPieceInactivityBonus * totalPiecesOnBoard();
        if (scaled < minInactivityPlies) return minInactivityPlies;
        if (scaled > maxInactivityPlies) return maxInactivityPlies;
        return scaled;
    }

    void checkWinCondition() {
        bool redDead = acesAlive[factionIndex(Faction::Red)] <= 0;
        bool blackDead = acesAlive[factionIndex(Faction::Black)] <= 0;
        if (redDead && blackDead) endCondition = EndCondition::DrawMutual;
        else if (blackDead) endCondition = EndCondition::RedWins;
        else if (redDead) endCondition = EndCondition::BlackWins;
        else if (inactivityPlies >= effectiveInactivityThreshold()) endCondition = EndCondition::DrawInactivity;
    }

    bool isTerminal() const { return endCondition != EndCondition::Ongoing; }

    // Simple ASCII render (fog-of-war aware). Kept minimal; see ai_player.hpp
    // for a colourized console renderer used by the human-play CLI mode.
    std::string render(Faction viewer) const;
};

} // namespace checards
