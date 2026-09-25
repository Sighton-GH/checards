// Conformance test for the versus server binding:
//  - plays a full game with both sides random to a terminal result
//  - asserts no hidden-info leaks in per-side or spectator state/log at every step
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <regex>
#include <string>
extern "C" {
uintptr_t cs_new(unsigned seed);
void cs_free(uintptr_t h);
int cs_place(uintptr_t h, int side, int x, int y);
int cs_draft(uintptr_t h, int side, int idx);
int cs_act(uintptr_t h, int side, int idx);
int cs_resign(uintptr_t h, int side);
const char* cs_state(uintptr_t h, int side);
const char* cs_state_spec(uintptr_t h);
const char* cs_log(uintptr_t h, int side);
}
static int failures = 0;
#define CHECK(cond, msg) do { if (!(cond)) { printf("FAIL: %s\n", msg); failures++; } } while (0)

// Scan a perspective JSON blob for card entries that name an opponent-hidden card.
// Card objects look like {"owner":O,"revealed":R,"name":"XX"} (name only when shown).
void leakCheckState(const std::string& j, int viewerSide, const char* what) {
    static const std::regex cardRe(R"(\{"owner":(\d+),"revealed":([01])(,"name":"[^"]+")?\})");
    for (std::sregex_iterator it(j.begin(), j.end(), cardRe), end; it != end; ++it) {
        int owner = std::stoi((*it)[1]);
        int revealed = std::stoi((*it)[2]);
        bool named = (*it)[3].matched;
        if (viewerSide >= 0 && owner == 1 - viewerSide && !revealed && named) {
            printf("FAIL: %s leaks opponent card: %s\n", what, (*it)[0].str().c_str()); failures++;
        }
        if (viewerSide == -1 && !revealed && named) {
            printf("FAIL: %s leaks hidden card to spectator: %s\n", what, (*it)[0].str().c_str()); failures++;
        }
    }
}
void leakCheckLog(const std::string& j, int viewerSide, const char* what) {
    // act events: "mover":M ... "card":"XX" and "spawned":"XX" must be empty when M != viewer
    static const std::regex actRe(R"RX(\{"ev":"act","mover":(\d+).*?"card":"([^"]*)".*?"spawned":"([^"]*)")RX");
    for (std::sregex_iterator it(j.begin(), j.end(), actRe), end; it != end; ++it) {
        int mover = std::stoi((*it)[1]);
        std::string card = (*it)[2], spawned = (*it)[3];
        if (mover != viewerSide && (!card.empty() || !spawned.empty())) {
            printf("FAIL: %s log leaks mover card/spawn: %s\n", what, (*it)[0].str().substr(0, 120).c_str()); failures++;
        }
    }
}
// Extract mover / legal count / phase with simple string finds (test-only).
std::string field(const std::string& j, const std::string& k) {
    auto p = j.find("\"" + k + "\":");
    if (p == std::string::npos) return "";
    p += k.size() + 3;
    auto e = j.find_first_of(",}", p);
    return j.substr(p, e - p);
}
int countLegal(const std::string& j) {
    auto p = j.find("\"legal\":[");
    if (p == std::string::npos) return 0;
    auto e = j.find(']', p);
    std::string s = j.substr(p, e - p);
    int n = 0; for (char c : s) if (c == '{') n++;
    return n;
}

int main(int argc, char** argv) {
    unsigned seed = argc > 1 ? (unsigned)atoi(argv[1]) : 20260925;
    std::mt19937 rng(7);
    uintptr_t h1 = cs_new(seed);
    CHECK(h1 != 0, "cs_new returns a handle");
    // C1 regression: a second concurrent game must not disturb the first
    uintptr_t h2 = cs_new(seed + 1);
    CHECK(h2 != 0 && h2 != h1, "second game gets its own handle");
    // drive game 2 deep into setup+play, then verify game 1 is untouched
    for (int guard = 0; guard < 200; guard++) {
        std::string st = cs_state(h2, 0);
        std::string ph = field(st, "phase");
        if (ph == "\"setup_place\"") {
            bool placed = false;
            for (int x = 0; x < 7 && !placed; x++) for (int y = 0; y < 7 && !placed; y++)
                placed = cs_place(h2, 0, x, y) == 1;
            CHECK(placed, "h2 setup place");
        } else if (ph == "\"setup_draft\"") { CHECK(cs_draft(h2, 0, 0) == 1, "h2 draft"); }
        if (field(st, "gamePhase") == "\"play\"") break;
    }
    for (int i = 0; i < 12; i++) {  // h2 black setup + some play
        std::string st = cs_state(h2, 1);
        std::string ph = field(st, "phase");
        if (ph == "\"setup_place\"") {
            bool placed = false;
            for (int x = 0; x < 7 && !placed; x++) for (int y = 0; y < 7 && !placed; y++)
                placed = cs_place(h2, 1, x, y) == 1;
        } else if (ph == "\"setup_draft\"") { cs_draft(h2, 1, 0); }
    }
    for (int i = 0; i < 20; i++) {
        std::string st = cs_state(h2, 0);
        if (field(st, "result") != "0" || field(st, "gamePhase") != "\"play\"") break;
        int mover = std::stoi(field(st, "mover"));
        int n = countLegal(mover == 0 ? st : cs_state(h2, 1));
        cs_act(h2, mover, n > 0 ? (int)(rng() % n) : 0);
    }
    // game 1 must still be at its very first setup prompt, Red to place AD
    {
        std::string s0 = cs_state(h1, 0);
        CHECK(field(s0, "gamePhase") == "\"setup\"", "C1: game 1 still in setup after game 2 activity");
        CHECK(field(s0, "phase") == "\"setup_place\"", "C1: game 1 red still placing first card");
        CHECK(field(s0, "pending") == "\"AD\"" || field(s0, "pending") == "\"AH\"", "C1: game 1 pending is an ace");
        CHECK(std::string(cs_state(h1, 0)).find("\"name\"") == std::string::npos, "C1: game 1 board empty of named cards");
    }
    // setup: both sides place aces + draft/place 5
    for (int guard = 0; guard < 200; guard++) {
        bool anySetup = false;
        for (int s = 0; s < 2; s++) {
            std::string st = cs_state(h1, s);
            std::string phase = field(st, "phase");
            if (phase == "\"setup_place\"") {
                bool placed = false;
                for (int x = 0; x < 7 && !placed; x++) for (int y = 0; y < 7 && !placed; y++)
                    placed = cs_place(h1, s, x, y) == 1;
                CHECK(placed, "setup place always succeeds");
                anySetup = true;
            } else if (phase == "\"setup_draft\"") {
                CHECK(cs_draft(h1, s, 0) == 1, "draft succeeds");
                anySetup = true;
            }
        }
        std::string gp = field(cs_state(h1, 0), "gamePhase");
        if (gp == "\"play\"") break;
        CHECK(anySetup || guard < 199, "setup progresses");
    }
    CHECK(field(cs_state(h1, 0), "gamePhase") == "\"play\"", "game reaches play phase");
    // play to completion
    int moves = 0;
    for (int guard = 0; guard < 4000; guard++) {
        std::string st0 = cs_state(h1, 0), st1 = cs_state(h1, 1), spec = cs_state_spec(h1);
        if (field(st0, "result") != "0") break; // terminal state legitimately reveals all cards
        leakCheckState(st0, 0, "state(red)"); leakCheckState(st1, 1, "state(black)"); leakCheckState(spec, -1, "state(spec)");
        int mover = std::stoi(field(st0, "mover"));
        std::string sm = mover == 0 ? st0 : st1;
        int n = countLegal(sm);
        int idx = n > 0 ? (int)(rng() % n) : 0;
        CHECK(cs_act(h1, mover, idx) == 1, "legal act accepted");
        moves++;
        if (moves % 25 == 0) {
            leakCheckLog(cs_log(h1, 0), 0, "log(red)"); leakCheckLog(cs_log(h1, 1), 1, "log(black)"); leakCheckLog(cs_log(h1, -1), -1, "log(spec)");
        }
    }
    leakCheckLog(cs_log(h1, 0), 0, "final log(red)"); leakCheckLog(cs_log(h1, 1), 1, "final log(black)"); leakCheckLog(cs_log(h1, -1), -1, "final log(spec)");
    std::string res = field(cs_state(h1, 0), "result");
    printf("game over: result=%s moves=%d\n", res.c_str(), moves);
    CHECK(res != "0", "game terminates");
    CHECK(moves > 5, "game had real moves");
    // resign: Red resigns -> Black wins (EndCondition 2); resign after over rejected
    uintptr_t hr = cs_new(55);
    CHECK(cs_resign(hr, 0) == 1, "resign accepted");
    CHECK(field(cs_state(hr, 0), "result") == "2", "resign -> Black wins");
    CHECK(field(cs_state(hr, -1), "result") == "2", "spectator sees resign result");
    CHECK(cs_resign(hr, 1) == 0, "resign after over rejected");
    cs_free(hr);

    if (failures == 0) printf("ALL CHECKS PASS\n");
    return failures ? 1 : 0;
}
