#pragma once
// =============================================================================
// belief.hpp — Bayesian tracking of hidden card identities + a determinizer
// that samples a full, jointly-consistent assignment for ISMCTS rollouts.
//
// BUG THIS FIXES: hybrid_engine_3.hpp's CardProbabilityTracker sampled each
// hidden square independently from a *marginal* distribution over remaining
// categories. Nothing stopped two, or even three, independently-sampled
// squares from all becoming "Ace" even though a faction only owns 2 — an
// impossible deal. DeckPool/determinize() below sample *without replacement*
// from one shared per-faction pool, so every determinization is a genuinely
// possible world consistent with everything that's been revealed so far.
//
// SECOND FIX: the old tracker assumed a mid-game spawn "mathematically
// cannot be an Ace or Joker". Aces are indeed always part of the mandatory
// initial 7 (never in the draw pile), but the Joker is one of the 11 cards a
// player freely chooses among for their 5 drafted slots — it absolutely can
// end up in the draw pile and be spawned later. determinize() below only
// constrains Aces to isInitial slots; the Joker is treated like any other
// non-ace identity.
//
// "EXPLICIT BELIEF, NOT JUST A SINGLE SAMPLE": in addition to sampling
// concrete determinizations for rollouts, DeckPool exposes rankDistribution()
// and entropyBits() so the belief itself — not just one guess drawn from it —
// can be fed directly into the network as belief-weighted feature
// activations and global features. See features.cpp.
// =============================================================================

#include <algorithm>
#include <array>
#include <bitset>
#include <cmath>
#include <random>
#include <utility>
#include <vector>
#include "checards/board.hpp"
#include "checards/types.hpp"

namespace checards {

class DeckPool {
public:
    Faction owner = Faction::None;
    std::bitset<kPersonalDeck> remaining; // true = this local-index card is still un-revealed

    static DeckPool fullDeck(Faction f) {
        DeckPool p;
        p.owner = f;
        p.remaining.set();
        return p;
    }

    int total() const { return static_cast<int>(remaining.count()); }

    void removeIdentity(Rank r, Suit s) { remaining[localCardIndex(r, s, owner)] = false; }
    void removeIndex(int idx) { remaining[idx] = false; }

    int countAcesRemaining() const { return (remaining[1] ? 1 : 0) + (remaining[2] ? 1 : 0); }

    // Marginal P(a still-hidden slot from this pool has rank r), aggregating
    // over whichever of the two same-rank local indices remain.
    double rankProbability(Rank r) const {
        int n = total();
        if (n <= 0) return 0.0;
        int matches = 0;
        for (int i = 0; i < kPersonalDeck; i++) {
            if (!remaining[i]) continue;
            Rank rr; Suit ss;
            cardFromLocalIndex(i, owner, rr, ss);
            if (rr == r) matches++;
        }
        return static_cast<double>(matches) / n;
    }

    std::array<double, kNumRankPlanes> rankDistribution() const {
        std::array<double, kNumRankPlanes> d{};
        int n = total();
        if (n <= 0) return d;
        for (int i = 0; i < kPersonalDeck; i++) {
            if (!remaining[i]) continue;
            Rank rr; Suit ss;
            cardFromLocalIndex(i, owner, rr, ss);
            d[rankPlaneIndex(rr)] += 1.0;
        }
        for (auto& v : d) v /= n;
        return d;
    }

    // log2(count of equally-likely remaining identities) — the proper
    // entropy of a uniform-over-consistent-permutations posterior.
    double entropyBits() const {
        int n = total();
        return n > 0 ? std::log2(static_cast<double>(n)) : 0.0;
    }

    int popRandomAceIndex(std::mt19937& rng) {
        int cand[2]; int nc = 0;
        if (remaining[1]) cand[nc++] = 1;
        if (remaining[2]) cand[nc++] = 2;
        if (nc == 0) return -1;
        int pick = cand[nc == 1 ? 0 : std::uniform_int_distribution<int>(0, 1)(rng)];
        remaining[pick] = false;
        return pick;
    }
    int popRandomNonAceIndex(std::mt19937& rng) {
        std::vector<int> cand;
        cand.reserve(kPersonalDeck);
        for (int i = 0; i < kPersonalDeck; i++) if (i != 1 && i != 2 && remaining[i]) cand.push_back(i);
        if (cand.empty()) return -1;
        int pick = cand[std::uniform_int_distribution<size_t>(0, cand.size() - 1)(rng)];
        remaining[pick] = false;
        return pick;
    }
};

class BeliefState {
public:
    DeckPool decks[2];

    void resetForNewGame() {
        decks[factionIndex(Faction::Red)] = DeckPool::fullDeck(Faction::Red);
        decks[factionIndex(Faction::Black)] = DeckPool::fullDeck(Faction::Black);
    }
    void onReveal(Rank r, Suit s, Faction owner) { decks[factionIndex(owner)].removeIdentity(r, s); }

    // Resynchronize from a fully-revealed-flags-accurate board (e.g. on load).
    void syncFromBoard(const Board& board) {
        resetForNewGame();
        for (int x = 0; x < kBoardSize; x++)
            for (int y = 0; y < kBoardSize; y++)
                for (int i = 0; i < board.grid[x][y].count; i++) {
                    const Card& c = board.grid[x][y].cards[i];
                    if (c.revealed) onReveal(c.rank, c.suit, c.owner);
                }
    }
    double entropyBits(Faction of) const { return decks[factionIndex(of)].entropyBits(); }
};

// Strips the *true* identity of any not-yet-revealed opponent card, replacing
// it with a placeholder. This is "the information set `perspective` can
// actually see" — the object that must never be handed the true board.
inline Board obfuscate(const Board& trueBoard, Faction perspective) {
    Board b = trueBoard;
    Faction opp = otherFaction(perspective);
    for (int x = 0; x < kBoardSize; x++)
        for (int y = 0; y < kBoardSize; y++)
            for (int i = 0; i < b.grid[x][y].count; i++) {
                Card& c = b.grid[x][y].cards[i];
                if (c.owner == opp && !c.revealed) { c.rank = RankVal::Joker; c.suit = SuitVal::JokerSuit; }
            }
    return b;
}

struct Determinization {
    Board board;
    std::vector<std::pair<Rank, Suit>> futureDraws[2]; // consumed front-to-back as spawns are simulated
};

// Produces one internally-consistent guess at the full board, from
// `perspective`'s point of view: their own cards are exactly as they truly
// are; the opponent's hidden cards are filled in by sampling *without
// replacement* from a shared pool (so e.g. two hidden squares can never both
// resolve to "the same Ace"), with Aces restricted to isInitial slots.
inline Determinization determinize(const Board& trueBoard, Faction perspective,
                                    const BeliefState& belief, std::mt19937& rng) {
    Determinization d;
    d.board = obfuscate(trueBoard, perspective);
    Faction opp = otherFaction(perspective);

    struct SlotRef { int8_t x, y, i; };

    for (int fi = 0; fi < 2; fi++) {
        Faction f = static_cast<Faction>(fi);
        DeckPool pool = belief.decks[fi];

        if (f != opp) {
            // Exclude any of `perspective`'s own cards that are already
            // placed on the board (setup or an earlier spawn) — own cards
            // are never obfuscated, so their true identity is already known
            // directly from the board. Only genuinely-not-yet-placed cards
            // belong in the future-draw queue; without this exclusion a
            // long simulated rollout could "spawn" a card that is
            // simultaneously already sitting elsewhere on the board.
            std::bitset<kPersonalDeck> onBoard;
            for (int x = 0; x < kBoardSize; x++)
                for (int y = 0; y < kBoardSize; y++)
                    for (int i = 0; i < d.board.grid[x][y].count; i++) {
                        const Card& c = d.board.grid[x][y].cards[i];
                        if (c.owner == f) onBoard[localCardIndex(c.rank, c.suit, f)] = true;
                    }
            for (int idx = 0; idx < kPersonalDeck; idx++)
                if (onBoard[idx]) pool.removeIndex(idx);

            while (pool.total() > 0) {
                int idx = pool.popRandomAceIndex(rng);
                if (idx < 0) idx = pool.popRandomNonAceIndex(rng);
                if (idx < 0) break;
                Rank r; Suit s;
                cardFromLocalIndex(idx, f, r, s);
                d.futureDraws[fi].push_back({r, s});
            }
            continue;
        }

        std::vector<SlotRef> initRefs, spawnRefs;
        for (int x = 0; x < kBoardSize; x++)
            for (int y = 0; y < kBoardSize; y++)
                for (int i = 0; i < d.board.grid[x][y].count; i++) {
                    const Card& c = d.board.grid[x][y].cards[i];
                    if (c.owner == f && !c.revealed) {
                        (c.isInitial ? initRefs : spawnRefs).push_back({(int8_t)x, (int8_t)y, (int8_t)i});
                    }
                }
        std::shuffle(initRefs.begin(), initRefs.end(), rng);
        std::shuffle(spawnRefs.begin(), spawnRefs.end(), rng);

        // Pass 1: remaining Aces can only land on isInitial slots.
        size_t initCursor = 0;
        while (true) {
            int aceIdx = pool.popRandomAceIndex(rng);
            if (aceIdx < 0) break;
            if (initCursor >= initRefs.size()) break; // defensive; bookkeeping should prevent this
            Rank r; Suit s;
            cardFromLocalIndex(aceIdx, f, r, s);
            auto& slot = initRefs[initCursor++];
            d.board.grid[slot.x][slot.y].cards[slot.i].rank = r;
            d.board.grid[slot.x][slot.y].cards[slot.i].suit = s;
        }

        // Pass 2: everything else (Joker + high cards) distributed uniformly
        // across whatever board slots remain plus the future-draw queue.
        std::vector<SlotRef> remainingSlots(initRefs.begin() + initCursor, initRefs.end());
        remainingSlots.insert(remainingSlots.end(), spawnRefs.begin(), spawnRefs.end());
        std::shuffle(remainingSlots.begin(), remainingSlots.end(), rng);

        size_t cursor = 0;
        while (pool.total() > 0) {
            int idx = pool.popRandomNonAceIndex(rng);
            if (idx < 0) break;
            Rank r; Suit s;
            cardFromLocalIndex(idx, f, r, s);
            if (cursor < remainingSlots.size()) {
                auto& slot = remainingSlots[cursor++];
                d.board.grid[slot.x][slot.y].cards[slot.i].rank = r;
                d.board.grid[slot.x][slot.y].cards[slot.i].suit = s;
            } else {
                d.futureDraws[fi].push_back({r, s});
            }
        }
    }
    return d;
}

} // namespace checards
