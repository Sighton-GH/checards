// Authoritative human-vs-human server binding for Checards.
// Mirrors play_api.cpp's game flow (setup order Red then Black, shuffled real
// draw piles, no-legal-action pass, combat at turn end) with BOTH sides driven
// by remote humans. No network/AI: rules only. Every view is per-perspective:
// a player never receives an opponent card name unless that card is revealed
// or the game is over. Built with emscripten (server/build.sh) for the
// Cloudflare Worker, and natively for tests.
#include <algorithm>
#include <random>
#include <sstream>
#include <string>
#include <vector>
#include "checards/selfplay.hpp"   // AIPlayer::fullPersonalDeck + common types
#include "checards/combat.hpp"     // resolveAllCombats
#include "checards/rules.hpp"      // applyAction, generateLegalActions, legalSetupSquare
using namespace checards;

namespace {
// Verbatim copy of selfplay.cpp's (file-local) computeRemainingDrawPile.
std::vector<Card> computeRemainingDrawPile(const Board& board, Faction f) {
    std::vector<Card> full = AIPlayer::fullPersonalDeck(f);
    std::vector<Card> remaining;
    int yStart = (f == Faction::Red) ? 0 : kBoardSize - kSetupBandRows;
    for (auto& c : full) {
        bool placed = false;
        for (int y = yStart; y < yStart + kSetupBandRows && !placed; y++)
            for (int x = 0; x < kBoardSize && !placed; x++)
                for (int i = 0; i < board.grid[x][y].count && !placed; i++) {
                    const Card& bc = board.grid[x][y].cards[i];
                    if (bc.rank == c.rank && bc.suit == c.suit && bc.owner == f) placed = true;
                }
        if (!placed) remaining.push_back(c);
    }
    return remaining;
}

struct SideSetup {
    std::vector<Card> queue;   // aces first, then drafted cards awaiting placement
    std::vector<Card> pool;    // draft candidates (non-ace)
    int drafted = 0;
    Card pending{};
    bool hasPending = false;
    std::string phase = "setup_place"; // setup_place | setup_draft | done
};

struct Game {
    Board board;
    TurnContext ctx;
    std::mt19937 rng;
    std::vector<Card> realDeck[2];
    SideSetup setup[2];
    std::string phase = "setup"; // setup | play | over
    int plies = 0;
    uint64_t seed = 0;
    std::string lastEvents = "[]";
    // event log, serialized once per perspective so no hidden info ever leaves
    std::vector<std::string> logRed, logBlack, logSpec;
    std::string out; // per-game return buffer for cs_state/cs_log
};
// Per-game handles: one emscripten module serves MANY rooms in the same
// isolate, so no game state may live in module globals. cs_new returns an
// opaque handle; every other call takes it. (Audit C1.)
const int kMaxPlies = 4000;
inline Game* game(uintptr_t h) { return reinterpret_cast<Game*>(h); }
int fi(Faction f) { return factionIndex(f); }
Faction sideF(int side) { return side == 0 ? Faction::Red : Faction::Black; }

std::string cardJ(const Card& c, bool show) {
    std::ostringstream o;
    o << "{\"owner\":" << (int)c.owner << ",\"revealed\":" << (c.revealed ? 1 : 0);
    if (show) o << ",\"name\":\"" << c.name() << "\"";
    o << "}";
    return o.str();
}
// showCard: include the moving card's name (only for the mover's own view).
std::string actJ(const Action& a, bool showCard) {
    std::ostringstream o;
    o << "{\"spawn\":" << (a.isSpawn ? 1 : 0) << ",\"from\":[" << (int)a.from.x << "," << (int)a.from.y << "],\"to\":["
      << (int)a.to.x << "," << (int)a.to.y << "],\"ord\":" << (int)a.ownerOrdinal << ",\"card\":\""
      << ((!a.isSpawn && showCard) ? rankName(a.cardRank) + std::string(1, suitChar(a.cardSuit)) : std::string()) << "\"}";
    return o.str();
}
std::string eventsJ(const std::vector<CombatEvent>& ev) {
    std::ostringstream o; o << "[";
    for (size_t i = 0; i < ev.size(); i++) {
        const auto& e = ev[i];
        o << (i ? "," : "") << "{\"at\":[" << (int)e.at.x << "," << (int)e.at.y << "],\"attacker\":" << (int)e.attacker
          << ",\"attackerDied\":" << e.attackerDied << ",\"defenderDied\":" << e.defenderDied << ",\"att\":[";
        for (size_t k = 0; k < e.attackerCards.size(); k++) o << (k ? "," : "") << "\"" << e.attackerCards[k].name() << "\"";
        o << "],\"def\":[";
        for (size_t k = 0; k < e.defenderCards.size(); k++) o << (k ? "," : "") << "\"" << e.defenderCards[k].name() << "\"";
        o << "]}";
    }
    o << "]"; return o.str();
}
std::string boardJ(Game* g, Faction viewer, bool showAll) {
    const Board& b = g->board;
    std::ostringstream o; o << "[";
    bool first = true;
    for (int x = 0; x < kBoardSize; x++) for (int y = 0; y < kBoardSize; y++) {
        o << (first ? "" : ",") << "["; first = false;
        for (int i = 0; i < b.grid[x][y].count; i++) {
            const Card& c = b.grid[x][y].cards[i];
            o << (i ? "," : "") << cardJ(c, showAll || c.owner == viewer || c.revealed);
        }
        o << "]";
    }
    o << "]"; return o.str();
}
void logEv(Game* g, const std::string& redJ, const std::string& blackJ, const std::string& specJ) {
    g->logRed.push_back(redJ); g->logBlack.push_back(blackJ); g->logSpec.push_back(specJ);
}
// Same event for all views (nothing side-specific).
void logEvBoth(Game* g, const std::string& j) { logEv(g, j, j, j); }

void finishIfOver(Game* g);

void startPlay(Game* g) {
    Board& b = g->board;
    b.recomputeAcesAlive();
    for (int f = 0; f < 2; f++) {
        g->realDeck[f] = computeRemainingDrawPile(b, f == 0 ? Faction::Red : Faction::Black);
        std::shuffle(g->realDeck[f].begin(), g->realDeck[f].end(), g->rng);
        b.drawPileSize[f] = (int)g->realDeck[f].size();
    }
    g->ctx.resetForNewTurn(Faction::Red);
    g->phase = "play";
    logEv(g, "{\"ev\":\"setup_done\",\"board\":" + boardJ(g, Faction::Red, false) + "}",
          "{\"ev\":\"setup_done\",\"board\":" + boardJ(g, Faction::Black, false) + "}",
          "{\"ev\":\"setup_done\",\"board\":" + boardJ(g, Faction::None, false) + "}");
}

void nextSetupCard(Game* g, int side) {
    SideSetup& s = g->setup[side];
    if (!s.queue.empty()) { s.pending = s.queue.front(); s.queue.erase(s.queue.begin()); s.hasPending = true; s.phase = "setup_place"; return; }
    if (s.drafted < 5) { s.hasPending = false; s.phase = "setup_draft"; return; }
    s.hasPending = false; s.phase = "done";
    if (g->setup[0].phase == "done" && g->setup[1].phase == "done") startPlay(g);
}

void finishIfOver(Game* g) {
    if (g->board.endCondition == EndCondition::Ongoing && g->plies >= kMaxPlies) g->board.endCondition = EndCondition::AbortedPlyLimit;
    if (g->board.endCondition != EndCondition::Ongoing && g->phase != "over") {
        g->phase = "over";
        std::string j = std::string("{\"ev\":\"end\",\"result\":") + std::to_string((int)g->board.endCondition) +
                        ",\"finalBoard\":" + boardJ(g, Faction::Red, true) + "}";
        logEvBoth(g, j);
    }
}

// One atomic step for the current mover; Action{} = pass. Mirrors play_api.cpp's step().
void step(Game* g, Action action) {
    Board& board = g->board; TurnContext& ctx = g->ctx; Faction mover = ctx.mover;
    std::vector<CombatEvent> events;
    if (!action.isSpawn && !action.from.valid()) {
        events = resolveAllCombats(board, mover);
        if (!board.isTerminal()) { if (mover == Faction::Black) board.currentTurnNumber++; ctx.resetForNewTurn(otherFaction(mover)); }
        g->plies++; board.totalPlies++;
        logEvBoth(g, std::string("{\"ev\":\"pass\",\"mover\":") + std::to_string((int)mover) + ",\"combat\":" + eventsJ(events) + "}");
        g->lastEvents = eventsJ(events);
        finishIfOver(g); return;
    }
    Rank sr = RankVal::Joker; Suit ss = SuitVal::JokerSuit;
    std::string spawned;
    if (action.isSpawn) { auto& pile = g->realDeck[fi(mover)]; if (!pile.empty()) { sr = pile.back().rank; ss = pile.back().suit; pile.pop_back(); spawned = rankName(sr) + std::string(1, suitChar(ss)); } }
    ApplyOutcome outcome = applyAction(board, ctx, action, sr, ss);
    board.drawPileSize[fi(mover)] = (int)g->realDeck[fi(mover)].size();
    board.totalPlies++;
    bool ended = outcome.turnEnded;
    if (ended) {
        events = resolveAllCombats(board, mover);
        if (!board.isTerminal()) { if (mover == Faction::Black) board.currentTurnNumber++; ctx.resetForNewTurn(otherFaction(mover)); }
    }
    g->plies++;
    g->lastEvents = eventsJ(events);
    std::string pre = std::string("{\"ev\":\"act\",\"mover\":") + std::to_string((int)mover) + ",\"a\":";
    std::string post = std::string(",\"turnEnded\":") + (ended ? "1" : "0") + ",\"combat\":" + eventsJ(events) + "}";
    // spawned card name + moving card name are visible only to the mover
    std::string moverJ = pre + actJ(action, true)  + ",\"spawned\":\"" + spawned + "\"" + post;
    std::string otherJ = pre + actJ(action, false) + ",\"spawned\":\"\"" + post;
    if (mover == Faction::Red) logEv(g, moverJ, otherJ, otherJ);
    else                       logEv(g, otherJ, moverJ, otherJ);
    finishIfOver(g);
}
} // namespace

extern "C" {
// Opaque game handle (pointer-sized). 0 = invalid.
// seed drives all game randomness (draw pile shuffles). It is NEVER exposed
// in any client-visible state or log (audit M1).
uintptr_t cs_new(unsigned seed) {
    Game* g = new Game();
    g->seed = seed; g->rng.seed(seed);
    for (int s = 0; s < 2; s++) {
        Faction f = sideF(s);
        for (auto& cd : AIPlayer::fullPersonalDeck(f))
            (cd.rank == RankVal::Ace ? g->setup[s].queue : g->setup[s].pool).push_back(cd);
        nextSetupCard(g, s);
    }
    logEvBoth(g, "{\"ev\":\"start\",\"mode\":\"versus\"}");
    return reinterpret_cast<uintptr_t>(g);
}
void cs_free(uintptr_t h) { delete game(h); }

int cs_place(uintptr_t h, int side, int x, int y) {
    Game* g = game(h);
    if (!g || g->phase != "setup") return 0;
    SideSetup& s = g->setup[side];
    if (s.phase != "setup_place") return 0;
    Coordinate p{(int8_t)x, (int8_t)y};
    if (!legalSetupSquare(g->board, sideF(side), p)) return 0;
    Card c = s.pending; c.isInitial = true; c.owner = sideF(side); g->board.at(p).push(c);
    nextSetupCard(g, side); return 1;
}
int cs_draft(uintptr_t h, int side, int idx) {
    Game* g = game(h);
    if (!g || g->phase != "setup") return 0;
    SideSetup& s = g->setup[side];
    if (s.phase != "setup_draft" || idx < 0 || idx >= (int)s.pool.size()) return 0;
    s.queue.push_back(s.pool[idx]); s.pool.erase(s.pool.begin() + idx); s.drafted++;
    nextSetupCard(g, side); return 1;
}
int cs_act(uintptr_t h, int side, int idx) {
    Game* g = game(h);
    if (!g || g->phase != "play" || (int)g->ctx.mover != side) return 0;
    auto legal = generateLegalActions(g->board, g->ctx);
    if (legal.empty()) { step(g, Action{}); return 1; }
    if (idx < 0 || idx >= (int)legal.size()) return 0;
    step(g, legal[idx]); return 1;
}
// Perspective-filtered state for `side` (0 = Red, 1 = Black).
const char* cs_state(uintptr_t h, int side) {
    Game* g = game(h);
    std::ostringstream o;
    if (!g) { static std::string empty = "{}"; return empty.c_str(); }
    Faction viewer = sideF(side);
    const SideSetup& s = g->setup[side];
    bool over = g->phase == "over";
    o << "{\"phase\":\"" << (g->phase == "setup" ? s.phase : g->phase) << "\",\"gamePhase\":\"" << g->phase
      << "\",\"you\":" << side << ",\"mover\":" << (int)g->ctx.mover
      << ",\"movesRemaining\":" << g->ctx.movesRemaining << ",\"turn\":" << g->board.currentTurnNumber
      << ",\"draw\":[" << g->board.drawPileSize[0] << "," << g->board.drawPileSize[1] << "]"
      << ",\"result\":" << (int)g->board.endCondition << ",\"inactivity\":" << g->board.inactivityPlies
      << ",\"board\":" << boardJ(g, viewer, over)
      << ",\"pending\":" << ((g->phase == "setup" && s.hasPending) ? "\"" + s.pending.name() + "\"" : std::string("null"))
      << ",\"pool\":[";
    if (g->phase == "setup" && s.phase == "setup_draft")
        for (size_t i = 0; i < s.pool.size(); i++) o << (i ? "," : "") << "\"" << s.pool[i].name() << "\"";
    o << "],\"legal\":[";
    if (g->phase == "play" && (int)g->ctx.mover == side) {
        auto legal = generateLegalActions(g->board, g->ctx);
        for (size_t i = 0; i < legal.size(); i++) o << (i ? "," : "") << actJ(legal[i], true);
    }
    o << "],\"events\":" << g->lastEvents << "}";
    g->out = o.str(); return g->out.c_str();
}
// Spectator state: neutral view - only revealed cards (and everything once over).
const char* cs_state_spec(uintptr_t h) {
    Game* g = game(h);
    std::ostringstream o;
    if (!g) { static std::string empty = "{}"; return empty.c_str(); }
    bool over = g->phase == "over";
    o << "{\"phase\":\"" << g->phase << "\",\"gamePhase\":\"" << g->phase
      << "\",\"you\":-1,\"mover\":" << (int)g->ctx.mover
      << ",\"movesRemaining\":" << g->ctx.movesRemaining << ",\"turn\":" << g->board.currentTurnNumber
      << ",\"draw\":[" << g->board.drawPileSize[0] << "," << g->board.drawPileSize[1] << "]"
      << ",\"result\":" << (int)g->board.endCondition << ",\"inactivity\":" << g->board.inactivityPlies
      << ",\"board\":" << boardJ(g, Faction::None, over)
      << ",\"pending\":null,\"pool\":[],\"legal\":[],\"events\":" << g->lastEvents << "}";
    g->out = o.str(); return g->out.c_str();
}
// Perspective-filtered event log for `side` (-1 = spectator). Never contains
// the game seed or any unrevealed opponent card name.
const char* cs_log(uintptr_t h, int side) {
    Game* g = game(h);
    if (!g) { static std::string empty = "[]"; return empty.c_str(); }
    g->out = "[\n";
    const auto& v = (side == 0) ? g->logRed : (side == 1) ? g->logBlack : g->logSpec;
    for (size_t i = 0; i < v.size(); i++) g->out += (i ? ",\n" : "") + v[i];
    g->out += "\n]";
    return g->out.c_str();
}
}
