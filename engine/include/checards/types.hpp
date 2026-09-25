#pragma once
// =============================================================================
// types.hpp — fundamental game types shared by every module.
//
// GAME FACTS confirmed by cross-referencing monster.cpp + hybrid_engine_3.hpp
// + the rules text (see README.md "Game facts" section for the full derivation):
//   - Board is 7x7. Rows 0-2 are Red's setup zone, rows 4-6 are Black's,
//     row 3 is neutral no-man's-land.
//   - Each player's personal deck has exactly 13 cards: 1 Joker + 2 Aces
//     (one per their two suits) + 10 "high" cards (ranks 9,10,J,Q,K, one of
//     each per suit). Ranks 2-8 do not exist in this game by design.
//   - Red = Diamonds + Hearts. Black = Clubs + Spades. Red always sets up
//     first and always moves first.
//   - Max stack height is 4. A turn spends exactly 3 move-points (unless a
//     spawn is chosen, which consumes the whole turn as a single action, or
//     the player is completely out of legal moves).
// =============================================================================

#include <array>
#include <cstdint>
#include <string>

namespace checards {

// ---------------------------------------------------------------------------
// Board / turn constants
// ---------------------------------------------------------------------------
constexpr int kBoardSize      = 7;
constexpr int kMaxStack       = 4;
constexpr int kMovesPerTurn   = 3;
constexpr int kStartingHand   = 7;   // 2 mandatory aces + 5 drafted cards
constexpr int kPersonalDeck   = 13;  // Joker + 2 Aces + 10 high cards
constexpr int kSetupBandRows  = 3;   // rows closest to a player during setup

// ---------------------------------------------------------------------------
// Faction
// ---------------------------------------------------------------------------
enum class Faction : int8_t { Red = 0, Black = 1, None = 2 };

inline Faction otherFaction(Faction f) {
    if (f == Faction::Red) return Faction::Black;
    if (f == Faction::Black) return Faction::Red;
    return Faction::None;
}
inline int factionIndex(Faction f) { return static_cast<int>(f); } // 0 or 1 (None must never be indexed)

// ---------------------------------------------------------------------------
// Suit  (0=Clubs,1=Diamonds,2=Hearts,3=Spades,4=JokerSuit — matches old code)
// ---------------------------------------------------------------------------
namespace SuitVal {
constexpr int8_t Clubs = 0, Diamonds = 1, Hearts = 2, Spades = 3, JokerSuit = 4;
}
using Suit = int8_t;

inline std::array<Suit, 2> suitsOf(Faction f) {
    // Fixed, canonical ordering used everywhere a "suitA/suitB" split is needed
    // (e.g. local card indexing). Ascending suit value within the faction.
    if (f == Faction::Red)   return {SuitVal::Diamonds, SuitVal::Hearts}; // 1,2
    return {SuitVal::Clubs, SuitVal::Spades};                             // 0,3
}

inline char suitChar(Suit s) {
    switch (s) {
        case SuitVal::Clubs: return 'C';
        case SuitVal::Diamonds: return 'D';
        case SuitVal::Hearts: return 'H';
        case SuitVal::Spades: return 'S';
        default: return '*';
    }
}

// ---------------------------------------------------------------------------
// Rank — deliberately NOT contiguous. Only these 7 values ever occur.
// ---------------------------------------------------------------------------
namespace RankVal {
constexpr int8_t Joker = 0, Ace = 1, Nine = 9, Ten = 10, Jack = 11, Queen = 12, King = 13;
}
using Rank = int8_t;

// The 7 possible ranks, in a fixed canonical order used for feature planes,
// belief-vector indexing, etc. Index into this array == "rank-plane index".
constexpr std::array<Rank, 7> kAllRanks = {
    RankVal::Joker, RankVal::Ace, RankVal::Nine, RankVal::Ten,
    RankVal::Jack, RankVal::Queen, RankVal::King
};
constexpr int kNumRankPlanes = 7;

inline int rankPlaneIndex(Rank r) {
    switch (r) {
        case RankVal::Joker: return 0;
        case RankVal::Ace:   return 1;
        case RankVal::Nine:  return 2;
        case RankVal::Ten:   return 3;
        case RankVal::Jack:  return 4;
        case RankVal::Queen: return 5;
        case RankVal::King:  return 6;
        default: return -1; // programmer error if this ever fires
    }
}

// Value used for combat-sum purposes: Ace and Joker both count as 1.
inline int combatValue(Rank r) {
    if (r == RankVal::Ace || r == RankVal::Joker) return 1;
    return static_cast<int>(r);
}

inline std::string rankName(Rank r) {
    switch (r) {
        case RankVal::Joker: return "Jkr";
        case RankVal::Ace:   return "A";
        case RankVal::Jack:  return "J";
        case RankVal::Queen: return "Q";
        case RankVal::King:  return "K";
        default: return std::to_string(static_cast<int>(r));
    }
}

// ---------------------------------------------------------------------------
// Stable "local card index" (0..12) per player.
//
// Every card a player owns has exactly one identity for the whole game, so
// we can address it with a small dense index instead of a (rank,suit) pair.
// This backs frozen-piece bitsets, belief-state arrays, and training feature
// bookkeeping without ever touching the heap.
//
//   0       -> Joker
//   1       -> Ace of suitA
//   2       -> Ace of suitB
//   3..7    -> {9,10,J,Q,K} of suitA
//   8..12   -> {9,10,J,Q,K} of suitB
// ---------------------------------------------------------------------------
inline int localCardIndex(Rank r, Suit s, Faction owner) {
    auto suits = suitsOf(owner);
    if (r == RankVal::Joker) return 0;
    if (r == RankVal::Ace) return (s == suits[0]) ? 1 : 2;
    // high card: 9,10,J,Q,K -> 0..4
    int hi = (r == RankVal::Nine) ? 0 : (r == RankVal::Ten) ? 1 : (r == RankVal::Jack) ? 2
             : (r == RankVal::Queen) ? 3 : 4; // King
    return (s == suits[0]) ? (3 + hi) : (8 + hi);
}

inline void cardFromLocalIndex(int idx, Faction owner, Rank& outRank, Suit& outSuit) {
    auto suits = suitsOf(owner);
    if (idx == 0) { outRank = RankVal::Joker; outSuit = SuitVal::JokerSuit; return; }
    if (idx == 1) { outRank = RankVal::Ace; outSuit = suits[0]; return; }
    if (idx == 2) { outRank = RankVal::Ace; outSuit = suits[1]; return; }
    static constexpr Rank kHi[5] = {RankVal::Nine, RankVal::Ten, RankVal::Jack, RankVal::Queen, RankVal::King};
    if (idx >= 3 && idx <= 7)  { outRank = kHi[idx - 3]; outSuit = suits[0]; return; }
    /* 8..12 */                 outRank = kHi[idx - 8]; outSuit = suits[1];
}

// ---------------------------------------------------------------------------
// Coordinate
// ---------------------------------------------------------------------------
struct Coordinate {
    int8_t x = -1, y = -1;
    bool operator==(const Coordinate& o) const { return x == o.x && y == o.y; }
    bool operator!=(const Coordinate& o) const { return !(*this == o); }
    bool valid() const { return x >= 0 && x < kBoardSize && y >= 0 && y < kBoardSize; }
};

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
struct Card {
    Rank rank = RankVal::Joker;
    Suit suit = SuitVal::JokerSuit;
    Faction owner = Faction::None;
    bool revealed = false;
    bool isInitial = false; // placed during the 7-card setup draft, vs a later random spawn

    Card() = default;
    Card(Rank r, Suit s, Faction o, bool initial = false)
        : rank(r), suit(s), owner(o), revealed(false), isInitial(initial) {}

    bool sameIdentity(const Card& o) const {
        return rank == o.rank && suit == o.suit && owner == o.owner;
    }
    int localIndex() const { return localCardIndex(rank, suit, owner); }
    int value() const { return combatValue(rank); }

    std::string name() const {
        return rankName(rank) + std::string(1, suitChar(suit));
    }
};

} // namespace checards
