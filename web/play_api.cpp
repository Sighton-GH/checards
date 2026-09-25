// Iteration 28 browser play bridge. Mirrors selfplay.cpp playGame() exactly
// (setup order Red then Black, shuffled real draw piles, no-legal-action pass,
// combat at turn end, both observers synced) with one side driven by the human.
// Built with emscripten into a single-file page (web/build.sh).
#include <random>
#include <sstream>
#include <string>
#include <vector>
#include "checards/selfplay.hpp"
#include "checards/patient_bot.hpp"
#include "checards/network.hpp"
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
struct Game {
  std::unique_ptr<Network> net;
  AIPlayer* ai = nullptr;               // it30: points into aiOwn or pat->inner.player
  std::unique_ptr<AIPlayer> aiOwn;
  std::unique_ptr<PatientActor> pat;     // it30 patient hybrid when model is "patient:<path>"
  Faction human = Faction::Red, aiF = Faction::Black;
  Board board;
  TurnContext ctx;
  std::mt19937 rng;
  std::vector<Card> realDeck[2];
  // setup
  std::string phase = "none"; // setup_place, setup_draft, play, over
  std::vector<Card> setupQueue; // aces first
  std::vector<Card> draftPool;
  int drafted = 0;
  Card pending;
  bool hasPending = false;
  std::vector<Action> legal;
  std::string lastEvents;
  std::ostringstream log;
  bool logFirst = true;
  std::string model;
  int iters = 60;
  uint64_t seed = 0;
  int plies = 0;
};
Game* G = nullptr;
std::string out;
const int kMaxPlies = 4000;

std::string cardJ(const Card& c, bool show) {
  std::ostringstream o;
  o << "{\"owner\":" << (int)c.owner << ",\"revealed\":" << (c.revealed ? 1 : 0);
  if (show) o << ",\"name\":\"" << c.name() << "\",\"rank\":" << (int)c.rank << ",\"suit\":" << (int)c.suit;
  o << "}";
  return o.str();
}
void logEv(const std::string& j) { G->log << (G->logFirst ? "" : ",\n") << j; G->logFirst = false; }
std::string actJ(const Action& a) {
  std::ostringstream o;
  o << "{\"spawn\":" << (a.isSpawn ? 1 : 0) << ",\"from\":[" << (int)a.from.x << "," << (int)a.from.y << "],\"to\":["
    << (int)a.to.x << "," << (int)a.to.y << "],\"ord\":" << (int)a.ownerOrdinal << ",\"card\":\""
    << (a.isSpawn ? std::string("") : rankName(a.cardRank) + std::string(1, suitChar(a.cardSuit))) << "\"}";
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
  std::ostringstream o; o << "{\"ev\":\"setup_done\",\"board\":[";
  bool first = true;
  for (int x = 0; x < kBoardSize; x++) for (int y = 0; y < kBoardSize; y++) for (int i = 0; i < b.grid[x][y].count; i++) {
    o << (first ? "" : ",") << "{\"x\":" << x << ",\"y\":" << y << ",\"c\":" << cardJ(b.grid[x][y].cards[i], true) << "}"; first = false; }
  o << "]}"; logEv(o.str());
}

void nextSetupCard() {
  if (!G->setupQueue.empty()) { G->pending = G->setupQueue.front(); G->setupQueue.erase(G->setupQueue.begin()); G->hasPending = true; G->phase = "setup_place"; return; }
  if (G->drafted < 5) { G->hasPending = false; G->phase = "setup_draft"; return; }
  // human setup finished
  G->hasPending = false;
  if (G->human == Faction::Red) G->ai->performSetup(G->board);
  startPlay();
}

void finishIfOver() {
  if (G->board.endCondition == EndCondition::Ongoing && G->plies >= kMaxPlies) G->board.endCondition = EndCondition::AbortedPlyLimit;
  if (G->board.endCondition != EndCondition::Ongoing && G->phase != "over") {
    G->phase = "over";
    std::ostringstream o; o << "{\"ev\":\"end\",\"result\":" << (int)G->board.endCondition << ",\"finalBoard\":[";
    bool first = true; const Board& b = G->board;
    for (int x = 0; x < kBoardSize; x++) for (int y = 0; y < kBoardSize; y++) for (int i = 0; i < b.grid[x][y].count; i++) {
      o << (first ? "" : ",") << "{\"x\":" << x << ",\"y\":" << y << ",\"c\":" << cardJ(b.grid[x][y].cards[i], true) << "}"; first = false; }
    o << "]}"; logEv(o.str());
  }
}

// One atomic step for `mover` with `action` (Action{} = pass), exactly as playGame.
void step(Action action) {
  Board& board = G->board; TurnContext& ctx = G->ctx; Faction mover = ctx.mover;
  std::vector<CombatEvent> events;
  if (!action.isSpawn && !action.from.valid()) {
    events = resolveAllCombats(board, mover);
    if (!board.isTerminal()) { if (mover == Faction::Black) board.currentTurnNumber++; ctx.resetForNewTurn(otherFaction(mover)); }
    G->ai->observeExternalAction(action, false, mover, board, ctx, &events);
    G->plies++; board.totalPlies++;
    logEv(std::string("{\"ev\":\"pass\",\"mover\":") + std::to_string((int)mover) + ",\"combat\":" + eventsJ(events) + "}");
    G->lastEvents = eventsJ(events);
    finishIfOver(); return;
  }
  Rank sr = RankVal::Joker; Suit ss = SuitVal::JokerSuit;
  std::string spawned;
  if (action.isSpawn) { auto& pile = G->realDeck[factionIndex(mover)]; if (!pile.empty()) { sr = pile.back().rank; ss = pile.back().suit; pile.pop_back(); spawned = rankName(sr) + std::string(1, suitChar(ss)); } }
  bool wasAttack = !action.isSpawn && board.at(action.to).hasFaction(otherFaction(mover));
  ApplyOutcome outcome = applyAction(board, ctx, action, sr, ss);
  board.drawPileSize[factionIndex(mover)] = (int)G->realDeck[factionIndex(mover)].size();
  board.totalPlies++;
  bool ended = outcome.turnEnded;
  if (ended) {
    events = resolveAllCombats(board, mover);
    if (!board.isTerminal()) { if (mover == Faction::Black) board.currentTurnNumber++; ctx.resetForNewTurn(otherFaction(mover)); }
  }
  G->ai->observeExternalAction(action, wasAttack, mover, board, ctx, ended ? &events : nullptr);
  G->plies++;
  G->lastEvents = eventsJ(events);
  logEv(std::string("{\"ev\":\"act\",\"mover\":") + std::to_string((int)mover) + ",\"a\":" + actJ(action) + ",\"spawned\":\"" + spawned +
        "\",\"turnEnded\":" + (ended ? "1" : "0") + ",\"combat\":" + eventsJ(events) + "}");
  finishIfOver();
}
Action aiChoose() { return G->pat ? G->pat->chooseAction(G->board, G->ctx) : G->ai->chooseTurnAction(G->board, G->ctx); }
} // namespace

extern "C" {
int cg_new(const char* modelPath, int humanRed, int iters, unsigned seed) {
  delete G; G = new Game();
  G->seed = seed; G->rng.seed(seed); G->iters = iters; G->model = modelPath;
  std::mt19937 q(777); G->net = std::make_unique<Network>(q);
  std::string mp(modelPath); bool patient = mp.rfind("patient:", 0) == 0; if (patient) mp = mp.substr(8);
  bool ok = mp == "fresh" ? true : G->net->load(mp);
  SearchConfig c; c.numThreads = 1; c.fixedIterations = iters; c.dirichletEpsilon = 0; c.fpuReduction = 0; c.selectorResidualWeight = 0;
  G->human = humanRed ? Faction::Red : Faction::Black; G->aiF = otherFaction(G->human);
  if (patient) { G->pat = std::make_unique<PatientActor>(G->aiF, G->net.get(), c, (uint64_t)seed * 2654435761ULL + 11); G->ai = &G->pat->inner.player; }
  else { G->aiOwn = std::make_unique<AIPlayer>(G->aiF, G->net.get(), c, (uint64_t)seed * 2654435761ULL + 11); G->ai = G->aiOwn.get(); }
  std::ostringstream o; o << "{\"ev\":\"start\",\"model\":\"" << modelPath << "\",\"humanSide\":\"" << (humanRed ? "red" : "black")
    << "\",\"iters\":" << iters << ",\"seed\":" << seed << "}"; logEv(o.str());
  if (G->human == Faction::Black) G->ai->performSetup(G->board); // Red sets up first, as in playGame
  for (auto& cd : AIPlayer::fullPersonalDeck(G->human)) (cd.rank == RankVal::Ace ? G->setupQueue : G->draftPool).push_back(cd);
  nextSetupCard();
  return ok ? 1 : 0;
}
int cg_place(int x, int y) {
  if (!G || G->phase != "setup_place") return 0;
  Coordinate p{(int8_t)x, (int8_t)y};
  if (!legalSetupSquare(G->board, G->human, p)) return 0;
  Card c = G->pending; c.isInitial = true; c.owner = G->human; G->board.at(p).push(c);
  nextSetupCard(); return 1;
}
int cg_draft(int idx) {
  if (!G || G->phase != "setup_draft" || idx < 0 || idx >= (int)G->draftPool.size()) return 0;
  G->setupQueue.push_back(G->draftPool[idx]); G->draftPool.erase(G->draftPool.begin() + idx); G->drafted++;
  nextSetupCard(); return 1;
}
int cg_human_act(int idx) {
  if (!G || G->phase != "play" || G->ctx.mover != G->human) return 0;
  auto legal = generateLegalActions(G->board, G->ctx);
  if (legal.empty()) { step(Action{}); return 1; }
  if (idx < 0 || idx >= (int)legal.size()) return 0;
  step(legal[idx]); return 1;
}
int cg_ai_step() {
  if (!G || G->phase != "play" || G->ctx.mover != G->aiF) return 0;
  Action a = aiChoose();
  step(a); return 1;
}
const char* cg_state() {
  std::ostringstream o;
  if (!G) { out = "{}"; return out.c_str(); }
  const Board& b = G->board;
  o << "{\"phase\":\"" << G->phase << "\",\"human\":" << (int)G->human << ",\"mover\":" << (int)G->ctx.mover
    << ",\"movesRemaining\":" << G->ctx.movesRemaining << ",\"turn\":" << b.currentTurnNumber
    << ",\"draw\":[" << b.drawPileSize[0] << "," << b.drawPileSize[1] << "],\"result\":" << (int)b.endCondition
    << ",\"inactivity\":" << b.inactivityPlies << ",\"board\":[";
  bool over = G->phase == "over"; bool first = true;
  for (int x = 0; x < kBoardSize; x++) for (int y = 0; y < kBoardSize; y++) {
    o << (first ? "" : ",") << "["; first = false;
    for (int i = 0; i < b.grid[x][y].count; i++) { const Card& c = b.grid[x][y].cards[i]; o << (i ? "," : "") << cardJ(c, over || c.owner == G->human || c.revealed); }
    o << "]";
  }
  o << "],\"pending\":" << (G->hasPending ? "\"" + G->pending.name() + "\"" : std::string("null")) << ",\"pool\":[";
  for (size_t i = 0; i < G->draftPool.size(); i++) o << (i ? "," : "") << "\"" << G->draftPool[i].name() << "\"";
  o << "],\"legal\":[";
  if (G->phase == "play" && G->ctx.mover == G->human) {
    auto legal = generateLegalActions(b, G->ctx);
    for (size_t i = 0; i < legal.size(); i++) o << (i ? "," : "") << actJ(legal[i]);
  }
  o << "],\"events\":" << (G->lastEvents.empty() ? "[]" : G->lastEvents) << "}";
  out = o.str(); return out.c_str();
}
const char* cg_log() { out = "[\n" + (G ? G->log.str() : std::string()) + "\n]"; return out.c_str(); }
}
