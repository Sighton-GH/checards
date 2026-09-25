#pragma once
// =============================================================================
// rules.hpp — turn bookkeeping and legal action generation/application.
//
// KEY FIX vs the old engine: a card that attacks (moves onto a square holding
// 1+ enemy cards) must stop moving for the rest of that turn ("that card may
// not continue moving during this turn, even if you have moves left" —
// rules.txt). Neither monster.cpp's manual-input path nor
// hybrid_engine_3.hpp's generateLegalMoves() tracked this at all: an already-
// attacked piece could legally be selected again for the turn's remaining
// move-points. TurnContext::frozen fixes this.
//
// ACTION-SPACE / STACK AMBIGUITY: the fixed-size policy the network
// predicts over is 399-dimensional, indexed purely by (source square,
// direction) — see action.hpp. But when 2+ of a player's own cards are
// stacked on one square, "move from this square in direction D" is
// ambiguous about *which* stacked card moves ("each of the cards acts
// separately" — rules.txt). We resolve this the same way the reference
// engine did: legal-move generation emits one Action per (card, direction)
// pair, so a stacked square can yield more than one raw action sharing the
// same atomicIndex(). search.hpp is responsible for splitting that shared
// policy prior across however many concrete cards can use it — see the
// comment in search.hpp's expansion code for the exact split rule.
// =============================================================================

#include <bitset>
#include <vector>
#include "checards/action.hpp"
#include "checards/board.hpp"
#include "checards/types.hpp"

namespace checards {

struct TurnContext {
    Faction mover = Faction::None;
    int movesRemaining = kMovesPerTurn;
    std::bitset<kPersonalDeck> frozen{}; // indexed by mover's localCardIndex()

    void resetForNewTurn(Faction newMover) {
        mover = newMover;
        movesRemaining = kMovesPerTurn;
        frozen.reset();
    }
    bool isFrozen(const Card& c) const { return frozen[c.localIndex()]; }
};

// True at the start of a turn, before any micro-move has been spent.
inline bool spawnEligible(const TurnContext& ctx) { return ctx.movesRemaining == kMovesPerTurn; }

inline std::vector<Action> generateLegalActions(const Board& board, const TurnContext& ctx) {
    std::vector<Action> actions;
    actions.reserve(48);
    Faction mover = ctx.mover;

    // --- Spawn options (only as the very first action of a turn) ---
    if (spawnEligible(ctx) && board.drawPileSize[factionIndex(mover)] > 0) {
        int row = Board::homeRow(mover);
        for (int col = 0; col < kBoardSize; col++) {
            Coordinate dest{static_cast<int8_t>(col), static_cast<int8_t>(row)};
            if (board.at(dest).empty()) {
                Action a;
                a.isSpawn = true;
                a.from = a.to = dest;
                actions.push_back(a);
            }
        }
    }

    // --- Move options: one per (unfrozen friendly card, legal direction) ---
    for (int x = 0; x < kBoardSize; x++) {
        for (int y = 0; y < kBoardSize; y++) {
            const Tile& t = board.grid[x][y];
            int ownerOrdinal = 0;
            for (int i = 0; i < t.count; i++) {
                const Card& c = t.cards[i];
                if (c.owner != mover) continue;
                if (ctx.isFrozen(c)) { ownerOrdinal++; continue; }
                for (int dir = 0; dir < 8; dir++) {
                    Coordinate to{static_cast<int8_t>(x + kDx[dir]), static_cast<int8_t>(y + kDy[dir])};
                    if (!to.valid()) continue;
                    if (board.at(to).countOwner(mover) >= kMaxStack) continue;
                    Action a;
                    a.isSpawn = false;
                    a.from = Coordinate{static_cast<int8_t>(x), static_cast<int8_t>(y)};
                    a.to = to;
                    a.direction = dir;
                    a.ownerOrdinal = static_cast<int8_t>(ownerOrdinal);
                    a.cardRank = c.rank;
                    a.cardSuit = c.suit;
                    actions.push_back(a);
                }
                ownerOrdinal++;
            }
        }
    }
    return actions;
}

struct ApplyOutcome {
    bool legal = true;
    bool wasAttack = false;
    bool turnEnded = false; // true once movesRemaining hits 0 or no further legal action exists
};

// Mutates `board` and `ctx` in place. `spawnRank`/`spawnSuit` are required
// (and only used) when action.isSpawn is true — the caller resolves that
// chance outcome beforehand (see belief.hpp DeckPool for the real-game and
// simulation-time samplers).
inline ApplyOutcome applyAction(Board& board, TurnContext& ctx, const Action& action,
                                 Rank spawnRank = RankVal::Joker, Suit spawnSuit = SuitVal::JokerSuit) {
    ApplyOutcome out;
    Faction mover = ctx.mover;

    if (action.isSpawn) {
        if (!board.spawnCard(action.to, spawnRank, spawnSuit, mover)) {
            out.legal = false;
            return out;
        }
        board.drawPileSize[factionIndex(mover)]--;
        ctx.movesRemaining = 0;
        out.wasAttack = false;
        out.turnEnded = true;
        return out;
    }

    Tile& source = board.at(action.from);
    int ordinal = 0;
    Card selected;
    bool found = false;
    for (int i = 0; i < source.count; i++) {
        if (source.cards[i].owner != mover) continue;
        if (ordinal++ == action.ownerOrdinal) { selected = source.cards[i]; found = true; break; }
    }
    if (!found || ctx.isFrozen(selected)) { out.legal = false; return out; }
    bool attacked = board.at(action.to).hasFaction(otherFaction(mover));
    if (!board.moveCardPreserving(action.from, action.to, selected.rank, selected.suit, mover)) {
        out.legal = false;
        return out;
    }
    if (attacked) {
        ctx.frozen[localCardIndex(selected.rank, selected.suit, mover)] = true;
    }
    ctx.movesRemaining = std::max(0, ctx.movesRemaining - 1);
    out.wasAttack = attacked;

    out.turnEnded = (ctx.movesRemaining == 0) || generateLegalActions(board, ctx).empty();
    return out;
}

// --- Setup-phase helpers -----------------------------------------------------
inline bool legalSetupSquare(const Board& board, Faction f, Coordinate c) {
    return Board::inSetupZone(f, c) && board.at(c).empty();
}

} // namespace checards
