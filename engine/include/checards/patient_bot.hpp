// Iteration 28 patient-attacker baseline (parent-approved 13:20). Plays the way the user beat
// the champion: BUILD - deploy the whole deck and keep everything inside its own setup band,
// aces covered; ATTACK - once fully deployed and ahead on cards (or from turn 14), march
// non-ace cards forward together and take every favourable fight against revealed targets,
// otherwise defer to the full search (same net, same budget). Rules untouched: it only
// chooses among generateLegalActions(). Deterministic given its seed.
#pragma once
#include <random>
#include "checards/selfplay.hpp"
#include "checards/combat.hpp"
namespace checards {
class PatientActor : public GameActor {
public:
    AIActor inner; std::mt19937 rng; bool attacking = false; int attackFromTurn = 14;
    bool recordData = false; bool searchedThisMove = false; // it31 hybrid-learner training only; default off = it30 behavior unchanged
    PatientActor(Faction f, Network* net, SearchConfig cfg, uint64_t seed) : inner(f, net, cfg, seed * 6364136223846793005ULL + 1), rng(seed) {}
    Faction faction() const override { return inner.faction(); }
    void performSetup(Board& b) override { inner.performSetup(b); }
    bool wantsTrainingData() const override { return recordData; }
    void recordDecision(std::vector<TrainingExample>& out, const Board& b, const TurnContext& c) override { if (recordData && searchedThisMove) inner.recordDecision(out, b, c); }
    void observe(const Action& a, bool w, Faction m, const Board& b, const TurnContext& c, const std::vector<CombatEvent>* e) override { inner.observe(a, w, m, b, c, e); }

    int fwd(Faction f, int y) const { return f == Faction::Red ? y : kBoardSize - 1 - y; }
    int count(const Board& b, Faction f) const { int n = 0; for (int x = 0; x < kBoardSize; x++) for (int y = 0; y < kBoardSize; y++) n += b.grid[x][y].countOwner(f); return n; }
    bool isAce(const Action& a) const { return !a.isSpawn && a.cardRank == RankVal::Ace; }
    // Favourable = every defender card on the target is revealed and the fight kills them without losing ours.
    bool favourable(const Board& b, const TurnContext& ctx, const Action& a) const {
        Faction me = faction(), op = otherFaction(me);
        const Tile& t = b.at(a.to);
        if (!t.hasFaction(op)) return false;
        for (int i = 0; i < t.count; i++) if (t.cards[i].owner == op && !t.cards[i].revealed) return false;
        Board trial = b; TurnContext c2 = ctx; applyAction(trial, c2, a, RankVal::Joker, SuitVal::JokerSuit);
        CombatResult r = resolveCombat(trial.at(a.to), me, op);
        return r.occurred && r.defenderDies && !r.attackerDies;
    }
    template <class V> const Action& pick(const V& v) { return v[rng() % v.size()]; }

    Action chooseAction(const Board& b, const TurnContext& ctx) override {
        searchedThisMove = false;
        auto legal = generateLegalActions(b, ctx);
        if (legal.empty()) return Action{};
        Faction me = faction(), op = otherFaction(me);
        if (!attacking && ((b.drawPileSize[factionIndex(me)] == 0 && count(b, me) >= count(b, op) + 2) || b.currentTurnNumber >= attackFromTurn)) attacking = true;
        std::vector<Action> good;
        for (auto& a : legal) if (!a.isSpawn && favourable(b, ctx, a) && !(isAce(a) && !attacking)) good.push_back(a);
        if (!good.empty()) return pick(good);                       // any sure win against a known target (aces only once attacking)
        if (!attacking) {
            std::vector<Action> spawns, cover, stay;
            for (auto& a : legal) {
                if (a.isSpawn) { spawns.push_back(a); continue; }
                if (b.at(a.to).hasFaction(op) || fwd(me, a.to.y) >= kSetupBandRows) continue; // no attacks, stay in band
                const Tile& d = b.at(a.to); bool destHasLoneAce = d.countOwner(me) == 1 && d.cards[0].rank == RankVal::Ace;
                if (!isAce(a) && destHasLoneAce) cover.push_back(a); else if (!isAce(a)) stay.push_back(a);
            }
            if (!spawns.empty()) return pick(spawns);
            if (!cover.empty()) return pick(cover);
            if (!stay.empty()) return pick(stay);
            searchedThisMove = true; return inner.chooseAction(b, ctx);
        }
        searchedThisMove = true; Action s = inner.chooseAction(b, ctx);
        bool sAttack = !s.isSpawn && s.from.valid() && b.at(s.to).hasFaction(op);
        bool sForward = !s.isSpawn && s.from.valid() && fwd(me, s.to.y) > fwd(me, s.from.y) && !isAce(s);
        if (sAttack || sForward) return s;
        std::vector<Action> march;
        for (auto& a : legal) if (!a.isSpawn && !isAce(a) && !b.at(a.to).hasFaction(op) && fwd(me, a.to.y) > fwd(me, a.from.y)) march.push_back(a);
        if (!march.empty()) return pick(march);
        return s;
    }
};
}
