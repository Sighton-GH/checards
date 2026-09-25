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
int cs_new(unsigned seed);
int cs_place(int side, int x, int y);
int cs_draft(int side, int idx);
int cs_act(int side, int idx);
const char* cs_state(int side);
const char* cs_state_spec();
const char* cs_log(int side);
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
    cs_new(seed);
    std::mt19937 rng(7);
    // setup: both sides place aces + draft/place 5
    for (int guard = 0; guard < 200; guard++) {
        bool anySetup = false;
        for (int s = 0; s < 2; s++) {
            std::string st = cs_state(s);
            std::string phase = field(st, "phase");
            if (phase == "\"setup_place\"") {
                bool placed = false;
                for (int x = 0; x < 7 && !placed; x++) for (int y = 0; y < 7 && !placed; y++)
                    placed = cs_place(s, x, y) == 1;
                CHECK(placed, "setup place always succeeds");
                anySetup = true;
            } else if (phase == "\"setup_draft\"") {
                CHECK(cs_draft(s, 0) == 1, "draft succeeds");
                anySetup = true;
            }
        }
        std::string gp = field(cs_state(0), "gamePhase");
        if (gp == "\"play\"") break;
        CHECK(anySetup || guard < 199, "setup progresses");
    }
    CHECK(field(cs_state(0), "gamePhase") == "\"play\"", "game reaches play phase");
    // play to completion
    int moves = 0;
    for (int guard = 0; guard < 4000; guard++) {
        std::string st0 = cs_state(0), st1 = cs_state(1), spec = cs_state_spec();
        if (field(st0, "result") != "0") break; // terminal state legitimately reveals all cards
        leakCheckState(st0, 0, "state(red)"); leakCheckState(st1, 1, "state(black)"); leakCheckState(spec, -1, "state(spec)");
        int mover = std::stoi(field(st0, "mover"));
        std::string sm = mover == 0 ? st0 : st1;
        int n = countLegal(sm);
        int idx = n > 0 ? (int)(rng() % n) : 0;
        CHECK(cs_act(mover, idx) == 1, "legal act accepted");
        moves++;
        if (moves % 25 == 0) {
            leakCheckLog(cs_log(0), 0, "log(red)"); leakCheckLog(cs_log(1), 1, "log(black)"); leakCheckLog(cs_log(-1), -1, "log(spec)");
        }
    }
    leakCheckLog(cs_log(0), 0, "final log(red)"); leakCheckLog(cs_log(1), 1, "final log(black)"); leakCheckLog(cs_log(-1), -1, "final log(spec)");
    std::string res = field(cs_state(0), "result");
    printf("game over: result=%s moves=%d\n", res.c_str(), moves);
    CHECK(res != "0", "game terminates");
    CHECK(moves > 5, "game had real moves");
    if (failures == 0) printf("ALL CHECKS PASS\n");
    return failures ? 1 : 0;
}
