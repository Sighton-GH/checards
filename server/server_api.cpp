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
};
Game* G = nullptr;
std::string out;
const int kMaxPlies = 4000;
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
std::string boardJ(Faction viewer, bool showAll) {
    const Board& b = G->board;
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
void logEv(const std::string& redJ, const std::string& blackJ, const std::string& specJ) {
    G->logRed.push_back(redJ); G->logBlack.push_back(blackJ); G->logSpec.push_back(specJ);
}
// Same event for all views (nothing side-specific).
void logEvBoth(const std::string& j) { logEv(j, j, j); }

void finishIfOver();

void startPlay() {
    Board& b = G->board;
    b.recomputeAcesAlive();
    for (int f = 0; f < 2; f++) {
        G->realDeck[f] = computeRemainingDrawPile(b, f == 0 ? Faction::Red : Faction::Black);
        std::shuffle(G->realDeck[f].begin(), G->realDeck[f].end(), G->rng);
        b.drawPileSize[f] = (int)G->realDeck[f].size();
    }
    G->ctx.resetForNewTurn(Faction::Red);
    G->phase = "play";
    logEv("{\"ev\":\"setup_done\",\"board\":" + boardJ(Faction::Red, false) + "}",
          "{\"ev\":\"setup_done\",\"board\":" + boardJ(Faction::Black, false) + "}",
          "{\"ev\":\"setup_done\",\"board\":" + boardJ(Faction::None, false) + "}");
}

void nextSetupCard(int side) {
    SideSetup& s = G->setup[side];
    if (!s.queue.empty()) { s.pending = s.queue.front(); s.queue.erase(s.queue.begin()); s.hasPending = true; s.phase = "setup_place"; return; }
    if (s.drafted < 5) { s.hasPending = false; s.phase = "setup_draft"; return; }
    s.hasPending = false; s.phase = "done";
    if (G->setup[0].phase == "done" && G->setup[1].phase == "done") startPlay();
}

void finishIfOver() {
    if (G->board.endCondition == EndCondition::Ongoing && G->plies >= kMaxPlies) G->board.endCondition = EndCondition::AbortedPlyLimit;
    if (G->board.endCondition != EndCondition::Ongoing && G->phase != "over") {
        G->phase = "over";
        std::string j = std::string("{\"ev\":\"end\",\"result\":") + std::to_string((int)G->board.endCondition) +
                        ",\"finalBoard\":" + boardJ(Faction::Red, true) + "}";
        logEvBoth(j);
    }
}

// One atomic step for the current mover; Action{} = pass. Mirrors play_api.cpp's step().
void step(Action action) {
    Board& board = G->board; TurnContext& ctx = G->ctx; Faction mover = ctx.mover;
    std::vector<CombatEvent> events;
    if (!action.isSpawn && !action.from.valid()) {
        events = resolveAllCombats(board, mover);
        if (!board.isTerminal()) { if (mover == Faction::Black) board.currentTurnNumber++; ctx.resetForNewTurn(otherFaction(mover)); }
        G->plies++; board.totalPlies++;
        logEvBoth(std::string("{\"ev\":\"pass\",\"mover\":") + std::to_string((int)mover) + ",\"combat\":" + eventsJ(events) + "}");
        G->lastEvents = eventsJ(events);
        finishIfOver(); return;
    }
    Rank sr = RankVal::Joker; Suit ss = SuitVal::JokerSuit;
    std::string spawned;
    if (action.isSpawn) { auto& pile = G->realDeck[fi(mover)]; if (!pile.empty()) { sr = pile.back().rank; ss = pile.back().suit; pile.pop_back(); spawned = rankName(sr) + std::string(1, suitChar(ss)); } }
    ApplyOutcome outcome = applyAction(board, ctx, action, sr, ss);
    board.drawPileSize[fi(mover)] = (int)G->realDeck[fi(mover)].size();
    board.totalPlies++;
    bool ended = outcome.turnEnded;
    if (ended) {
        events = resolveAllCombats(board, mover);
        if (!board.isTerminal()) { if (mover == Faction::Black) board.currentTurnNumber++; ctx.resetForNewTurn(otherFaction(mover)); }
    }
    G->plies++;
    G->lastEvents = eventsJ(events);
    std::string pre = std::string("{\"ev\":\"act\",\"mover\":") + std::to_string((int)mover) + ",\"a\":";
    std::string post = std::string(",\"turnEnded\":") + (ended ? "1" : "0") + ",\"combat\":" + eventsJ(events) + "}";
    // spawned card name + moving card name are visible only to the mover
    std::string moverJ = pre + actJ(action, true)  + ",\"spawned\":\"" + spawned + "\"" + post;
    std::string otherJ = pre + actJ(action, false) + ",\"spawned\":\"\"" + post;
    if (mover == Faction::Red) logEv(moverJ, otherJ, otherJ);
    else                       logEv(otherJ, moverJ, otherJ);
    finishIfOver();
}
} // namespace

extern "C" {
// seed drives setup-independent randomness (draw pile shuffles). Returns 1.
int cs_new(unsigned seed) {
    delete G; G = new Game();
    G->seed = seed; G->rng.seed(seed);
    for (int s = 0; s < 2; s++) {
        Faction f = sideF(s);
        for (auto& cd : AIPlayer::fullPersonalDeck(f))
            (cd.rank == RankVal::Ace ? G->setup[s].queue : G->setup[s].pool).push_back(cd);
        nextSetupCard(s);
    }
    logEvBoth(std::string("{\"ev\":\"start\",\"mode\":\"versus\",\"seed\":") + std::to_string(seed) + "}");
    return 1;
}
int cs_place(int side, int x, int y) {
    if (!G || G->phase != "setup") return 0;
    SideSetup& s = G->setup[side];
    if (s.phase != "setup_place") return 0;
    Coordinate p{(int8_t)x, (int8_t)y};
    if (!legalSetupSquare(G->board, sideF(side), p)) return 0;
    Card c = s.pending; c.isInitial = true; c.owner = sideF(side); G->board.at(p).push(c);
    nextSetupCard(side); return 1;
}
int cs_draft(int side, int idx) {
    if (!G || G->phase != "setup") return 0;
    SideSetup& s = G->setup[side];
    if (s.phase != "setup_draft" || idx < 0 || idx >= (int)s.pool.size()) return 0;
    s.queue.push_back(s.pool[idx]); s.pool.erase(s.pool.begin() + idx); s.drafted++;
    nextSetupCard(side); return 1;
}
int cs_act(int side, int idx) {
    if (!G || G->phase != "play" || (int)G->ctx.mover != side) return 0;
    auto legal = generateLegalActions(G->board, G->ctx);
    if (legal.empty()) { step(Action{}); return 1; }
    if (idx < 0 || idx >= (int)legal.size()) return 0;
    step(legal[idx]); return 1;
}
// Perspective-filtered state for `side` (0 = Red, 1 = Black).
const char* cs_state(int side) {
    std::ostringstream o;
    if (!G) { out = "{}"; return out.c_str(); }
    Faction viewer = sideF(side);
    const SideSetup& s = G->setup[side];
    bool over = G->phase == "over";
    o << "{\"phase\":\"" << (G->phase == "setup" ? s.phase : G->phase) << "\",\"gamePhase\":\"" << G->phase
      << "\",\"you\":" << side << ",\"mover\":" << (int)G->ctx.mover
      << ",\"movesRemaining\":" << G->ctx.movesRemaining << ",\"turn\":" << G->board.currentTurnNumber
      << ",\"draw\":[" << G->board.drawPileSize[0] << "," << G->board.drawPileSize[1] << "]"
      << ",\"result\":" << (int)G->board.endCondition << ",\"inactivity\":" << G->board.inactivityPlies
      << ",\"board\":" << boardJ(viewer, over)
      << ",\"pending\":" << ((G->phase == "setup" && s.hasPending) ? "\"" + s.pending.name() + "\"" : std::string("null"))
      << ",\"pool\":[";
    if (G->phase == "setup" && s.phase == "setup_draft")
        for (size_t i = 0; i < s.pool.size(); i++) o << (i ? "," : "") << "\"" << s.pool[i].name() << "\"";
    o << "],\"legal\":[";
    if (G->phase == "play" && (int)G->ctx.mover == side) {
        auto legal = generateLegalActions(G->board, G->ctx);
        for (size_t i = 0; i < legal.size(); i++) o << (i ? "," : "") << actJ(legal[i], true);
    }
    o << "],\"events\":" << G->lastEvents << "}";
    out = o.str(); return out.c_str();
}
// Spectator state: neutral view - only revealed cards (and everything once over).
const char* cs_state_spec() {
    std::ostringstream o;
    if (!G) { out = "{}"; return out.c_str(); }
    bool over = G->phase == "over";
    o << "{\"phase\":\"" << G->phase << "\",\"gamePhase\":\"" << G->phase
      << "\",\"you\":-1,\"mover\":" << (int)G->ctx.mover
      << ",\"movesRemaining\":" << G->ctx.movesRemaining << ",\"turn\":" << G->board.currentTurnNumber
      << ",\"draw\":[" << G->board.drawPileSize[0] << "," << G->board.drawPileSize[1] << "]"
      << ",\"result\":" << (int)G->board.endCondition << ",\"inactivity\":" << G->board.inactivityPlies
      << ",\"board\":" << boardJ(Faction::None, over)
      << ",\"pending\":null,\"pool\":[],\"legal\":[],\"events\":" << G->lastEvents << "}";
    out = o.str(); return out.c_str();
}
// Perspective-filtered event log for `side`.
const char* cs_log(int side) {
    out = "[\n";
    const auto& v = (side == 0) ? G->logRed : (side == 1) ? G->logBlack : G->logSpec;
    for (size_t i = 0; i < v.size(); i++) out += (i ? ",\n" : "") + v[i];
    out += "\n]";
    return out.c_str();
}
}
