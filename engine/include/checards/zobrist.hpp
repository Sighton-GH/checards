#pragma once
// Complete, ordered state hashing for the per-thread leaf-value cache.
// Ordered mixing (rather than XORing rank keys) prevents duplicate cards on
// one square from cancelling. All fields read by rules or value features are
// included; changing any one of them must change the hash.

#include <algorithm>
#include <cstdint>
#include <vector>
#include "checards/board.hpp"
#include "checards/rules.hpp"

namespace checards {

class Zobrist {
    static void mix(uint64_t& h, uint64_t v) {
        v += 0x9e3779b97f4a7c15ULL;
        v = (v ^ (v >> 30)) * 0xbf58476d1ce4e5b9ULL;
        v = (v ^ (v >> 27)) * 0x94d049bb133111ebULL;
        v ^= v >> 31;
        h ^= v + 0x9e3779b97f4a7c15ULL + (h << 6) + (h >> 2);
    }
public:
    explicit Zobrist(uint64_t seed = 1337ULL) : seed_(seed) {}
    uint64_t hash(const Board& b, const TurnContext& ctx) const {
        uint64_t h = seed_;
        for (int y = 0; y < kBoardSize; y++) for (int x = 0; x < kBoardSize; x++) {
            const Tile& t = b.grid[x][y];
            mix(h, static_cast<uint64_t>(x + 17 * y));
            mix(h, t.count);
            for (int slot = 0; slot < t.count; slot++) {
                const Card& c = t.cards[slot];
                uint64_t packed = static_cast<uint64_t>(slot)
                    | (static_cast<uint64_t>(static_cast<int>(c.rank)) << 3)
                    | (static_cast<uint64_t>(static_cast<int>(c.suit)) << 8)
                    | (static_cast<uint64_t>(factionIndex(c.owner)) << 12)
                    | (static_cast<uint64_t>(c.revealed) << 13)
                    | (static_cast<uint64_t>(c.isInitial) << 14);
                mix(h, packed);
            }
        }
        for (int f = 0; f < 2; f++) {
            mix(h, b.acesAlive[f]); mix(h, b.drawPileSize[f]);
        }
        mix(h, static_cast<int>(b.endCondition));
        mix(h, b.inactivityPlies); mix(h, b.maxInactivityPlies);
        mix(h, b.minInactivityPlies); mix(h, b.perPieceInactivityBonus);
        mix(h, b.totalPlies); mix(h, b.currentTurnNumber);
        mix(h, ctx.frozen.to_ullong());
        mix(h, factionIndex(ctx.mover)); mix(h, ctx.movesRemaining);
        return h;
    }
private:
    uint64_t seed_;
};

struct TTEntry { uint64_t hash = 0; float value = 0.f; int depth = -1; };
class TranspositionTable {
public:
    explicit TranspositionTable(size_t sizeMb = 32) {
        size_t n = (sizeMb * 1024ULL * 1024ULL) / sizeof(TTEntry), p2 = 1;
        while (p2 * 2 <= n) p2 <<= 1;
        table_.assign(std::max<size_t>(p2, 1), TTEntry{}); mask_ = table_.size() - 1;
    }
    void store(uint64_t h, float value, int depth) { TTEntry& e=table_[h&mask_]; if(e.hash!=h||depth>=e.depth)e={h,value,depth}; }
    bool probe(uint64_t h, float& out, int depth) const { const TTEntry&e=table_[h&mask_]; if(e.hash==h&&e.depth>=depth){out=e.value;return true;}return false; }
    void clear(){std::fill(table_.begin(),table_.end(),TTEntry{});}
private: std::vector<TTEntry> table_; size_t mask_=0;
};
} // namespace checards
