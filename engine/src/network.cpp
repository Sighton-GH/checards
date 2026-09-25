#include <cstdio>
#include "checards/network.hpp"
#include <cmath>
#include <cstring>

#if defined(__AVX2__)
#include <immintrin.h>
#endif

namespace checards {

Network::Network(std::mt19937& rng)
    : accInput(kNumPieceSquareFeatures, kAccHidden, rng),
      globalBranch(kNumGlobalFeatures, kGlobalHidden, rng),
      trunk(kAccHidden + kGlobalHidden, kSharedTrunk, rng),
      valueHidden(kSharedTrunk, kValueHidden, rng), valueOut(kValueHidden, 3, rng),
      tacticalHidden(kSharedTrunk, kPolicyHidden, rng), tacticalOut(kPolicyHidden, kNumAtomicActions, rng),
      strategicHidden(kSharedTrunk, kPolicyHidden, rng), strategicOut(kPolicyHidden, kNumAtomicActions, rng),
      gateOut(kSharedTrunk, 1, rng),
      auxHidden(kSharedTrunk, kAuxHidden, rng),
      materialOut(kAuxHidden, 1, rng), territoryOut(kAuxHidden, 1, rng), phaseOut(kAuxHidden, 3, rng),
      selectorHidden(kSharedTrunk, kSelectorHidden, rng), selectorOut(kSelectorHidden, kNumSelectorActions, rng) {
    // Fresh networks start with an exact uniform conditional selector (zero
    // output layer), the same starting point migrated v1 checkpoints get:
    // non-uniform card preferences should be learned from data, not baked
    // into initialization.
    std::fill(selectorOut.W.begin(), selectorOut.W.end(), 0.f);
    std::fill(selectorOut.b.begin(), selectorOut.b.end(), 0.f);
}

Network::Output Network::forwardCommon(const std::vector<float>& h1Act, const std::array<float, kNumGlobalFeatures>& global,
                                        ForwardCache* cache) const {
    Output out;
    std::vector<float> globalVec(global.begin(), global.end());
    std::vector<float> g1Preact, g1Act;
    globalBranch.forward(globalVec, g1Preact);
    g1Act = g1Preact; reluInplace(g1Act);

    std::vector<float> concatAct;
    concatAct.reserve(kAccHidden + kGlobalHidden);
    concatAct.insert(concatAct.end(), h1Act.begin(), h1Act.end());
    concatAct.insert(concatAct.end(), g1Act.begin(), g1Act.end());

    std::vector<float> trunkPreact, trunkAct;
    trunk.forward(concatAct, trunkPreact);
    trunkAct = trunkPreact; reluInplace(trunkAct);

    // value
    std::vector<float> vHPre, vHAct, vOutPre;
    valueHidden.forward(trunkAct, vHPre); vHAct = vHPre; reluInplace(vHAct);
    valueOut.forward(vHAct, vOutPre);
    out.wdl = softmaxArr(std::array<float, 3>{vOutPre[0], vOutPre[1], vOutPre[2]});

    // tactical policy
    std::vector<float> tHPre, tHAct, tOutPre;
    tacticalHidden.forward(trunkAct, tHPre); tHAct = tHPre; reluInplace(tHAct);
    tacticalOut.forward(tHAct, tOutPre);
    for (int i = 0; i < kNumAtomicActions; i++) out.tacticalLogits[i] = tOutPre[i];

    // strategic policy
    std::vector<float> sHPre, sHAct, sOutPre;
    strategicHidden.forward(trunkAct, sHPre); sHAct = sHPre; reluInplace(sHAct);
    strategicOut.forward(sHAct, sOutPre);
    for (int i = 0; i < kNumAtomicActions; i++) out.strategicLogits[i] = sOutPre[i];

    // gate
    std::vector<float> gatePre;
    gateOut.forward(trunkAct, gatePre);
    out.tacticalityGate = sigmoidScalar(gatePre[0]);

    // aux
    std::vector<float> auxHPre, auxHAct, matPre, terrPre, phasePre;
    auxHidden.forward(trunkAct, auxHPre); auxHAct = auxHPre; reluInplace(auxHAct);
    materialOut.forward(auxHAct, matPre);
    territoryOut.forward(auxHAct, terrPre);
    phaseOut.forward(auxHAct, phasePre);
    out.materialEval = std::tanh(matPre[0]);
    out.territoryEval = sigmoidScalar(terrPre[0]);
    out.phase = softmaxArr(std::array<float, 3>{phasePre[0], phasePre[1], phasePre[2]});

    // selector (conditional which-card head; see network.hpp)
    std::vector<float> selHPre, selHAct, selOutPre;
    selectorHidden.forward(trunkAct, selHPre); selHAct = selHPre; reluInplace(selHAct);
    selectorOut.forward(selHAct, selOutPre);
    for (int i = 0; i < kNumSelectorActions; i++) out.selectorLogits[i] = selOutPre[i];

    if (cache) {
        cache->g1Preact = g1Preact; cache->g1Act = g1Act;
        cache->concatAct = concatAct;
        cache->trunkPreact = trunkPreact; cache->trunkAct = trunkAct;
        cache->valueHPre = vHPre; cache->valueHAct = vHAct; cache->valueOutPre = vOutPre;
        cache->tactHPre = tHPre; cache->tactHAct = tHAct; cache->tactOutPre = tOutPre;
        cache->stratHPre = sHPre; cache->stratHAct = sHAct; cache->stratOutPre = sOutPre;
        cache->gatePre = gatePre;
        cache->auxHPre = auxHPre; cache->auxHAct = auxHAct;
        cache->matPre = matPre; cache->terrPre = terrPre; cache->phasePre = phasePre;
        cache->selHPre = selHPre; cache->selHAct = selHAct; cache->selOutPre = selOutPre;
        cache->globalInput = global;
    }
    return out;
}

Network::Output Network::forward(const std::vector<WeightedFeature>& sparse,
                                  const std::array<float, kNumGlobalFeatures>& global, ForwardCache* cache) const {
    std::vector<float> h1Preact, h1Act;
    accInput.forward(sparse, h1Preact);
    h1Act = h1Preact; reluInplace(h1Act);
    Output out = forwardCommon(h1Act, global, cache);
    if (cache) { cache->h1Preact = h1Preact; cache->h1Act = h1Act; cache->sparseInput = sparse; }
    return out;
}

Network::Output Network::forwardFromAccumulator(const std::vector<float>& hiddenPreact,
                                                  const std::array<float, kNumGlobalFeatures>& global) const {
    std::vector<float> h1Act = hiddenPreact;
    reluInplace(h1Act);
    return forwardCommon(h1Act, global, nullptr);
}

float Network::accumulateGradients(const std::vector<WeightedFeature>& sparse,
                                    const std::array<float, kNumGlobalFeatures>& global,
                                    const Targets& targets, const LossWeights& w) {
    ForwardCache c;
    Output out = forward(sparse, global, &c);
    float loss = 0.f;
    std::vector<float> dTrunkAct(kSharedTrunk, 0.f);
    auto addTo = [](std::vector<float>& dst, const std::vector<float>& src) {
        for (size_t i = 0; i < dst.size(); i++) dst[i] += src[i];
    };

    // ---- value: softmax + cross-entropy (shortcut: dPre = softmax - target) ----
    {
        std::vector<float> dPre(3);
        for (int i = 0; i < 3; i++) {
            dPre[i] = (out.wdl[i] - targets.wdl[i]) * w.value;
            loss += -w.value * targets.wdl[i] * std::log(std::max(1e-8f, out.wdl[i]));
        }
        std::vector<float> dHAct;
        valueOut.backward(c.valueHAct, dPre, &dHAct);
        std::vector<float> dHPre(dHAct.size());
        for (size_t i = 0; i < dHAct.size(); i++) dHPre[i] = (c.valueHPre[i] > 0.f) ? dHAct[i] : 0.f;
        std::vector<float> dTrunkContrib;
        valueHidden.backward(c.trunkAct, dHPre, &dTrunkContrib);
        addTo(dTrunkAct, dTrunkContrib);
    }

    // ---- tactical policy: softmax + cross-entropy ----
    {
        auto sm = softmaxArr(out.tacticalLogits);
        std::vector<float> dPre(kNumAtomicActions);
        float tSumtactical = 0.f; for (int i = 0; i < kNumAtomicActions; i++) tSumtactical += targets.tacticalPolicy[i];
        const float pwtactical = tSumtactical > 0.f ? 1.f : 0.f; // all-zero target = masked (draw-pred deploy games)
        float headLoss = 0.f;
        for (int i = 0; i < kNumAtomicActions; i++) {
            dPre[i] = (sm[i] - targets.tacticalPolicy[i]) * w.tacticalPolicy * pwtactical;
            if (targets.tacticalPolicy[i] > 0.f) headLoss += -targets.tacticalPolicy[i] * std::log(std::max(1e-8f, sm[i]));
        }
        loss += w.tacticalPolicy * headLoss;
        std::vector<float> dHAct;
        tacticalOut.backward(c.tactHAct, dPre, &dHAct);
        std::vector<float> dHPre(dHAct.size());
        for (size_t i = 0; i < dHAct.size(); i++) dHPre[i] = (c.tactHPre[i] > 0.f) ? dHAct[i] : 0.f;
        std::vector<float> dTrunkContrib;
        tacticalHidden.backward(c.trunkAct, dHPre, &dTrunkContrib);
        addTo(dTrunkAct, dTrunkContrib);
    }

    // ---- strategic policy: same pattern ----
    {
        auto sm = softmaxArr(out.strategicLogits);
        std::vector<float> dPre(kNumAtomicActions);
        float tSumstrategic = 0.f; for (int i = 0; i < kNumAtomicActions; i++) tSumstrategic += targets.strategicPolicy[i];
        const float pwstrategic = tSumstrategic > 0.f ? 1.f : 0.f; // all-zero target = masked (draw-pred deploy games)
        float headLoss = 0.f;
        for (int i = 0; i < kNumAtomicActions; i++) {
            dPre[i] = (sm[i] - targets.strategicPolicy[i]) * w.strategicPolicy * pwstrategic;
            if (targets.strategicPolicy[i] > 0.f) headLoss += -targets.strategicPolicy[i] * std::log(std::max(1e-8f, sm[i]));
        }
        loss += w.strategicPolicy * headLoss;
        std::vector<float> dHAct;
        strategicOut.backward(c.stratHAct, dPre, &dHAct);
        std::vector<float> dHPre(dHAct.size());
        for (size_t i = 0; i < dHAct.size(); i++) dHPre[i] = (c.stratHPre[i] > 0.f) ? dHAct[i] : 0.f;
        std::vector<float> dTrunkContrib;
        strategicHidden.backward(c.trunkAct, dHPre, &dTrunkContrib);
        addTo(dTrunkAct, dTrunkContrib);
    }

    // ---- gate: sigmoid + binary cross-entropy (shortcut: dPre = pred - target) ----
    {
        float pred = out.tacticalityGate, target = targets.gate;
        loss += -w.gate * (target * std::log(std::max(1e-8f, pred)) + (1 - target) * std::log(std::max(1e-8f, 1 - pred)));
        std::vector<float> dPre{(pred - target) * w.gate};
        std::vector<float> dTrunkContrib;
        gateOut.backward(c.trunkAct, dPre, &dTrunkContrib);
        addTo(dTrunkAct, dTrunkContrib);
    }

    // ---- aux heads: material (tanh+MSE), territory (sigmoid+BCE), phase (softmax+CE) ----
    // all three read off auxHidden, so their dL/d(auxAct) contributions must
    // be summed before backpropagating through auxHidden once.
    {
        std::vector<float> dAuxAct(kAuxHidden, 0.f);
        {
            float pred = out.materialEval, diff = pred - targets.material;
            loss += w.material * diff * diff;
            float dPreScalar = 2.f * diff * (1.f - pred * pred) * w.material; // tanh'(z)=1-tanh(z)^2
            std::vector<float> dPre{dPreScalar}, dContrib;
            materialOut.backward(c.auxHAct, dPre, &dContrib);
            addTo(dAuxAct, dContrib);
        }
        {
            float pred = out.territoryEval, target = targets.territory;
            loss += -w.territory * (target * std::log(std::max(1e-8f, pred)) + (1 - target) * std::log(std::max(1e-8f, 1 - pred)));
            std::vector<float> dPre{(pred - target) * w.territory}, dContrib;
            territoryOut.backward(c.auxHAct, dPre, &dContrib);
            addTo(dAuxAct, dContrib);
        }
        {
            auto sm = softmaxArr(std::array<float, 3>{c.phasePre[0], c.phasePre[1], c.phasePre[2]});
            std::vector<float> dPre(3);
            float headLoss = 0.f;
            for (int i = 0; i < 3; i++) {
                dPre[i] = (sm[i] - targets.phase[i]) * w.phase;
                headLoss += -targets.phase[i] * std::log(std::max(1e-8f, sm[i]));
            }
            loss += w.phase * headLoss;
            std::vector<float> dContrib;
            phaseOut.backward(c.auxHAct, dPre, &dContrib);
            addTo(dAuxAct, dContrib);
        }
        std::vector<float> dAuxPre(kAuxHidden);
        for (int i = 0; i < kAuxHidden; i++) dAuxPre[i] = (c.auxHPre[i] > 0.f) ? dAuxAct[i] : 0.f;
        std::vector<float> dTrunkContrib;
        auxHidden.backward(c.trunkAct, dAuxPre, &dTrunkContrib);
        addTo(dTrunkAct, dTrunkContrib);
    }

    // ---- selector: per-tile masked softmax + cross-entropy ----
    // Only tiles with a non-zero target mass (i.e. tiles the search actually
    // visited children from) produce loss or gradient. Every other tile is
    // fully masked out — we have no signal about which card should move from
    // a tile the search never touched, and training it toward anything would
    // be fabricating supervision.
    {
        std::vector<float> dSelOut(kNumSelectorActions, 0.f);
        for (int tile = 0; tile < kNumSquares; tile++) {
            float mass = 0.f;
            for (int s = 0; s < kMaxStack; s++) mass += targets.selector[tile * kMaxStack + s];
            if (mass <= 0.f) continue;
            std::array<float, kMaxStack> tileLogits;
            for (int s = 0; s < kMaxStack; s++) tileLogits[s] = c.selOutPre[tile * kMaxStack + s];
            auto sm = softmaxArr(tileLogits);
            for (int s = 0; s < kMaxStack; s++) {
                float target = targets.selector[tile * kMaxStack + s];
                dSelOut[tile * kMaxStack + s] = (sm[s] - target) * w.selector;
                if (target > 0.f) loss += -w.selector * target * std::log(std::max(1e-8f, sm[s]));
            }
        }
        std::vector<float> dHAct;
        selectorOut.backward(c.selHAct, dSelOut, &dHAct);
        std::vector<float> dHPre(dHAct.size());
        for (size_t i = 0; i < dHAct.size(); i++) dHPre[i] = (c.selHPre[i] > 0.f) ? dHAct[i] : 0.f;
        std::vector<float> dTrunkContrib;
        selectorHidden.backward(c.trunkAct, dHPre, &dTrunkContrib);
        addTo(dTrunkAct, dTrunkContrib);
    }

    // ---- backprop the summed trunk gradient down to the two branches ----
    std::vector<float> dTrunkPre(kSharedTrunk);
    for (int i = 0; i < kSharedTrunk; i++) dTrunkPre[i] = (c.trunkPreact[i] > 0.f) ? dTrunkAct[i] : 0.f;
    std::vector<float> dConcat;
    trunk.backward(c.concatAct, dTrunkPre, &dConcat);

    std::vector<float> dH1Act(dConcat.begin(), dConcat.begin() + kAccHidden);
    std::vector<float> dG1Act(dConcat.begin() + kAccHidden, dConcat.end());

    std::vector<float> dH1Pre(kAccHidden);
    for (int i = 0; i < kAccHidden; i++) dH1Pre[i] = (c.h1Preact[i] > 0.f) ? dH1Act[i] : 0.f;
    accInput.backward(c.sparseInput, dH1Pre);

    std::vector<float> dG1Pre(kGlobalHidden);
    for (int i = 0; i < kGlobalHidden; i++) dG1Pre[i] = (c.g1Preact[i] > 0.f) ? dG1Act[i] : 0.f;
    std::vector<float> globalVec(global.begin(), global.end());
    globalBranch.backward(globalVec, dG1Pre, nullptr);

    return loss;
}

void Network::applyGradients(float lr, int batchSize, float beta1, float beta2, float eps) {
    adamT++;
    float scale = 1.0f / static_cast<float>(std::max(1, batchSize));
    auto scaleGrad = [&](std::vector<float>& g) { for (auto& x : g) x *= scale; };

    scaleGrad(accInput.gradW); scaleGrad(accInput.gradB);
    scaleGrad(globalBranch.gradW); scaleGrad(globalBranch.gradB);
    scaleGrad(trunk.gradW); scaleGrad(trunk.gradB);
    scaleGrad(valueHidden.gradW); scaleGrad(valueHidden.gradB);
    scaleGrad(valueOut.gradW); scaleGrad(valueOut.gradB);
    scaleGrad(tacticalHidden.gradW); scaleGrad(tacticalHidden.gradB);
    scaleGrad(tacticalOut.gradW); scaleGrad(tacticalOut.gradB);
    scaleGrad(strategicHidden.gradW); scaleGrad(strategicHidden.gradB);
    scaleGrad(strategicOut.gradW); scaleGrad(strategicOut.gradB);
    scaleGrad(gateOut.gradW); scaleGrad(gateOut.gradB);
    scaleGrad(auxHidden.gradW); scaleGrad(auxHidden.gradB);
    scaleGrad(materialOut.gradW); scaleGrad(materialOut.gradB);
    scaleGrad(territoryOut.gradW); scaleGrad(territoryOut.gradB);
    scaleGrad(phaseOut.gradW); scaleGrad(phaseOut.gradB);
    scaleGrad(selectorHidden.gradW); scaleGrad(selectorHidden.gradB);
    scaleGrad(selectorOut.gradW); scaleGrad(selectorOut.gradB);

    accInput.adamStep(lr, beta1, beta2, eps, adamT);
    globalBranch.adamStep(lr, beta1, beta2, eps, adamT);
    trunk.adamStep(lr, beta1, beta2, eps, adamT);
    valueHidden.adamStep(lr, beta1, beta2, eps, adamT);
    valueOut.adamStep(lr, beta1, beta2, eps, adamT);
    tacticalHidden.adamStep(lr, beta1, beta2, eps, adamT);
    tacticalOut.adamStep(lr, beta1, beta2, eps, adamT);
    strategicHidden.adamStep(lr, beta1, beta2, eps, adamT);
    strategicOut.adamStep(lr, beta1, beta2, eps, adamT);
    gateOut.adamStep(lr, beta1, beta2, eps, adamT);
    auxHidden.adamStep(lr, beta1, beta2, eps, adamT);
    materialOut.adamStep(lr, beta1, beta2, eps, adamT);
    territoryOut.adamStep(lr, beta1, beta2, eps, adamT);
    phaseOut.adamStep(lr, beta1, beta2, eps, adamT);
    selectorHidden.adamStep(lr, beta1, beta2, eps, adamT);
    selectorOut.adamStep(lr, beta1, beta2, eps, adamT);
}

void Network::applySelectorGradients(float lr, int batchSize, float beta1, float beta2, float eps) {
    adamT++;
    float scale = 1.0f / static_cast<float>(std::max(1, batchSize));
    auto clearDense = [](DenseLayer& l) {
        std::fill(l.gradW.begin(), l.gradW.end(), 0.f);
        std::fill(l.gradB.begin(), l.gradB.end(), 0.f);
    };
    std::fill(accInput.gradW.begin(), accInput.gradW.end(), 0.f);
    std::fill(accInput.gradB.begin(), accInput.gradB.end(), 0.f);
    for (DenseLayer* l : denseLayers()) {
        if (l == &selectorHidden || l == &selectorOut) {
            for (float& g : l->gradW) g *= scale;
            for (float& g : l->gradB) g *= scale;
        } else clearDense(*l);
    }
    selectorHidden.adamStep(lr, beta1, beta2, eps, adamT);
    selectorOut.adamStep(lr, beta1, beta2, eps, adamT);
}

bool Network::save(const std::string& path) const {
    // Atomic write (iteration 27): write <path>.part, then rename, so a kill mid-save never corrupts a checkpoint.
    const std::string tmp = path + ".part";
    std::ofstream out(tmp, std::ios::binary);
    if (!out) return false;
    out.write(kMagicV2, 8);
    int32_t t = adamT;
    out.write(reinterpret_cast<const char*>(&t), sizeof(t));
    accInput.save(out); globalBranch.save(out); trunk.save(out);
    valueHidden.save(out); valueOut.save(out);
    tacticalHidden.save(out); tacticalOut.save(out);
    strategicHidden.save(out); strategicOut.save(out);
    gateOut.save(out);
    auxHidden.save(out); materialOut.save(out); territoryOut.save(out); phaseOut.save(out);
    selectorHidden.save(out); selectorOut.save(out);
    out.close();
    if (!out) return false;
    return std::rename(tmp.c_str(), path.c_str()) == 0;
}

namespace {
// (Re)allocates a layer's parameter/optimizer/gradient buffers to the
// expected dimensions if they don't already match — this is what lets
// load() work on a default-constructed Network, not only on one built by
// the seeded constructor. Existing correctly-sized buffers are kept.
void ensureDense(DenseLayer& l, int in, int out) {
    if (l.inSize == in && l.outSize == out &&
        l.W.size() == static_cast<size_t>(in) * out && l.b.size() == static_cast<size_t>(out)) return;
    l.inSize = in; l.outSize = out;
    l.W.assign(static_cast<size_t>(in) * out, 0.f); l.b.assign(out, 0.f);
    l.mW.assign(l.W.size(), 0.f); l.vW.assign(l.W.size(), 0.f);
    l.mb.assign(out, 0.f); l.vb.assign(out, 0.f);
    l.gradW.assign(l.W.size(), 0.f); l.gradB.assign(out, 0.f);
}
void ensureSparse(SparseInputLayer& l, int nf, int out) {
    if (l.numFeatures == nf && l.outSize == out &&
        l.W.size() == static_cast<size_t>(nf) * out && l.b.size() == static_cast<size_t>(out)) return;
    l.numFeatures = nf; l.outSize = out;
    l.W.assign(static_cast<size_t>(nf) * out, 0.f); l.b.assign(out, 0.f);
    l.mW.assign(l.W.size(), 0.f); l.vW.assign(l.W.size(), 0.f);
    l.mb.assign(out, 0.f); l.vb.assign(out, 0.f);
    l.gradW.assign(l.W.size(), 0.f); l.gradB.assign(out, 0.f);
}
} // namespace

void Network::initializeMigratedSelector() {
    std::mt19937 migRng(kMigrationSeed);
    selectorHidden = DenseLayer(kSharedTrunk, kSelectorHidden, migRng);
    selectorOut = DenseLayer(kSelectorHidden, kNumSelectorActions, migRng);
    // Zero output layer == softmax over any tile's slots is exactly uniform
    // == the hard-coded conditional v1 search used. Deterministic given
    // kMigrationSeed, so every migration of the same file is identical.
    std::fill(selectorOut.W.begin(), selectorOut.W.end(), 0.f);
    std::fill(selectorOut.b.begin(), selectorOut.b.end(), 0.f);
    wasMigratedFromV1 = true;
}

std::vector<DenseLayer*> Network::denseLayers() {
    return {&globalBranch, &trunk, &valueHidden, &valueOut,
            &tacticalHidden, &tacticalOut, &strategicHidden, &strategicOut,
            &gateOut, &auxHidden, &materialOut, &territoryOut, &phaseOut,
            &selectorHidden, &selectorOut};
}
std::vector<const DenseLayer*> Network::denseLayers() const {
    return {&globalBranch, &trunk, &valueHidden, &valueOut,
            &tacticalHidden, &tacticalOut, &strategicHidden, &strategicOut,
            &gateOut, &auxHidden, &materialOut, &territoryOut, &phaseOut,
            &selectorHidden, &selectorOut};
}

bool Network::load(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) return false;
    char magic[8];
    in.read(magic, 8);
    bool isV1 = std::memcmp(magic, kMagicV1, 8) == 0;
    bool isV2 = std::memcmp(magic, kMagicV2, 8) == 0;
    if (!isV1 && !isV2) return false;
    int32_t t = 0;
    in.read(reinterpret_cast<char*>(&t), sizeof(t));
    adamT = t;
    // Make every layer the right shape before reading into it (see
    // ensureDense's comment for why this matters on default-constructed nets).
    ensureSparse(accInput, kNumPieceSquareFeatures, kAccHidden);
    ensureDense(globalBranch, kNumGlobalFeatures, kGlobalHidden);
    ensureDense(trunk, kAccHidden + kGlobalHidden, kSharedTrunk);
    ensureDense(valueHidden, kSharedTrunk, kValueHidden); ensureDense(valueOut, kValueHidden, 3);
    ensureDense(tacticalHidden, kSharedTrunk, kPolicyHidden); ensureDense(tacticalOut, kPolicyHidden, kNumAtomicActions);
    ensureDense(strategicHidden, kSharedTrunk, kPolicyHidden); ensureDense(strategicOut, kPolicyHidden, kNumAtomicActions);
    ensureDense(gateOut, kSharedTrunk, 1);
    ensureDense(auxHidden, kSharedTrunk, kAuxHidden);
    ensureDense(materialOut, kAuxHidden, 1); ensureDense(territoryOut, kAuxHidden, 1); ensureDense(phaseOut, kAuxHidden, 3);
    accInput.load(in); globalBranch.load(in); trunk.load(in);
    valueHidden.load(in); valueOut.load(in);
    tacticalHidden.load(in); tacticalOut.load(in);
    strategicHidden.load(in); strategicOut.load(in);
    gateOut.load(in);
    auxHidden.load(in); materialOut.load(in); territoryOut.load(in); phaseOut.load(in);
    if (!static_cast<bool>(in)) return false;
    if (isV2) {
        ensureDense(selectorHidden, kSharedTrunk, kSelectorHidden);
        ensureDense(selectorOut, kSelectorHidden, kNumSelectorActions);
        selectorHidden.load(in); selectorOut.load(in);
        wasMigratedFromV1 = false;
    } else {
        initializeMigratedSelector();
    }
    return static_cast<bool>(in);
}

void Network::refreshAccumulator(const Board& board, Faction perspective, const BeliefState& belief, bool concreteKnown,
                                  std::vector<float>& hiddenPreactOut) const {
    auto sparse = fullPieceSquareFeatures(board, perspective, belief, concreteKnown);
    accInput.forward(sparse, hiddenPreactOut);
}

void Network::updateAccumulatorForSquare(std::vector<float>& hiddenPreact, const std::array<float, kPlanesPerSquare>& oldPlanes,
                                          const std::array<float, kPlanesPerSquare>& newPlanes, Coordinate sq) const {
    int base = squareIndex(sq) * kPlanesPerSquare;
    for (int p = 0; p < kPlanesPerSquare; p++) {
        float delta = newPlanes[p] - oldPlanes[p];
        if (delta == 0.f) continue;
        const float* row = &accInput.W[static_cast<size_t>(base + p) * kAccHidden];
        for (int h = 0; h < kAccHidden; h++) hiddenPreact[h] += delta * row[h];
    }
}

void Network::quantizeAccumulator(QuantizedAccumulator& q) const {
    q.numFeatures = accInput.numFeatures;
    q.outSize = accInput.outSize;
    q.W.resize(accInput.W.size());
    for (size_t i = 0; i < accInput.W.size(); i++) {
        float v = accInput.W[i] * QuantizedAccumulator::kScale;
        v = std::max(-32000.f, std::min(32000.f, v));
        q.W[i] = static_cast<int16_t>(std::lround(v));
    }
    q.b.resize(accInput.b.size());
    for (size_t i = 0; i < accInput.b.size(); i++) {
        float v = accInput.b[i] * QuantizedAccumulator::kScale;
        v = std::max(-32000.f, std::min(32000.f, v));
        q.b[i] = static_cast<int16_t>(std::lround(v));
    }
}

// Only valid for one-hot (weight==1.0) active features — i.e. concreteKnown
// evaluation, the hot path inside MCTS rollouts. Fog-aware belief-weighted
// evaluation always goes through the float accInput.forward() path instead.
void Network::quantizedAccumulate(const QuantizedAccumulator& q, const std::vector<WeightedFeature>& active,
                                   std::vector<float>& hiddenOut) {
    thread_local std::vector<int32_t> acc;
    acc.assign(q.outSize, 0);
    for (int h = 0; h < q.outSize; h++) acc[h] = q.b[h];

#if defined(__AVX2__)
    for (const auto& f : active) {
        const int16_t* row = &q.W[static_cast<size_t>(f.index) * q.outSize];
        int h = 0;
        for (; h + 16 <= q.outSize; h += 16) {
            __m256i wv = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(row + h));
            __m256i lo = _mm256_cvtepi16_epi32(_mm256_castsi256_si128(wv));
            __m256i hi = _mm256_cvtepi16_epi32(_mm256_extracti128_si256(wv, 1));
            __m256i accLo = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(&acc[h]));
            __m256i accHi = _mm256_loadu_si256(reinterpret_cast<const __m256i*>(&acc[h + 8]));
            accLo = _mm256_add_epi32(accLo, lo);
            accHi = _mm256_add_epi32(accHi, hi);
            _mm256_storeu_si256(reinterpret_cast<__m256i*>(&acc[h]), accLo);
            _mm256_storeu_si256(reinterpret_cast<__m256i*>(&acc[h + 8]), accHi);
        }
        for (; h < q.outSize; h++) acc[h] += row[h];
    }
#else
    for (const auto& f : active) {
        const int16_t* row = &q.W[static_cast<size_t>(f.index) * q.outSize];
        for (int h = 0; h < q.outSize; h++) acc[h] += row[h];
    }
#endif

    hiddenOut.resize(q.outSize);
    for (int h = 0; h < q.outSize; h++) {
        float v = static_cast<float>(acc[h]) / QuantizedAccumulator::kScale;
        hiddenOut[h] = v; // pre-activation; caller applies ReLU (see header note)
    }
}

} // namespace checards
