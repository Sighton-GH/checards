#pragma once
// =============================================================================
// layers.hpp — small, generic, reusable feed-forward building blocks.
//
// Deliberately dense (not hash-map-sparse) gradient buffers throughout: the
// entire network here is on the order of ~10^5-10^6 parameters (this game's
// state is far smaller than chess/shogi NNUE), so a full dense Adam step
// every minibatch is sub-millisecond and there is no need for the
// engineering complexity of truly sparse gradient bookkeeping.
// =============================================================================

#include <algorithm>
#include <cmath>
#include <fstream>
#include <random>
#include <vector>
#include "checards/features.hpp"

namespace checards {

// A single fully-connected layer: y_preact = W*x + b, W is [outSize x inSize].
class DenseLayer {
public:
    int inSize = 0, outSize = 0;
    std::vector<float> W, b;
    std::vector<float> mW, vW, mb, vb;
    std::vector<float> gradW, gradB;

    DenseLayer() = default;
    DenseLayer(int in, int out, std::mt19937& rng) : inSize(in), outSize(out) {
        W.assign(static_cast<size_t>(in) * out, 0.f);
        b.assign(out, 0.f);
        mW.assign(W.size(), 0.f); vW.assign(W.size(), 0.f);
        mb.assign(out, 0.f); vb.assign(out, 0.f);
        gradW.assign(W.size(), 0.f); gradB.assign(out, 0.f);
        float scale = std::sqrt(2.0f / std::max(1, in)); // He init, matches ReLU usage throughout
        std::normal_distribution<float> dist(0.f, scale);
        for (auto& w : W) w = dist(rng);
    }

    void forward(const std::vector<float>& x, std::vector<float>& yPreact) const {
        yPreact.assign(outSize, 0.f);
        for (int o = 0; o < outSize; o++) {
            float sum = b[o];
            const float* row = &W[static_cast<size_t>(o) * inSize];
            for (int i = 0; i < inSize; i++) sum += row[i] * x[i];
            yPreact[o] = sum;
        }
    }

    // Accumulates gradW/gradB; if dX is non-null, fills it with dL/dx.
    void backward(const std::vector<float>& x, const std::vector<float>& dOut, std::vector<float>* dX) {
        for (int o = 0; o < outSize; o++) {
            float go = dOut[o];
            gradB[o] += go;
            const size_t base = static_cast<size_t>(o) * inSize;
            for (int i = 0; i < inSize; i++) gradW[base + i] += go * x[i];
        }
        if (dX) {
            dX->assign(inSize, 0.f);
            for (int o = 0; o < outSize; o++) {
                float go = dOut[o];
                const size_t base = static_cast<size_t>(o) * inSize;
                for (int i = 0; i < inSize; i++) (*dX)[i] += go * W[base + i];
            }
        }
    }

    void adamStep(float lr, float beta1, float beta2, float eps, int t) {
        float bc1 = 1.f - std::pow(beta1, static_cast<float>(t));
        float bc2 = 1.f - std::pow(beta2, static_cast<float>(t));
        for (size_t i = 0; i < W.size(); i++) {
            mW[i] = beta1 * mW[i] + (1 - beta1) * gradW[i];
            vW[i] = beta2 * vW[i] + (1 - beta2) * gradW[i] * gradW[i];
            W[i] -= lr * (mW[i] / bc1) / (std::sqrt(vW[i] / bc2) + eps);
            gradW[i] = 0.f;
        }
        for (size_t i = 0; i < b.size(); i++) {
            mb[i] = beta1 * mb[i] + (1 - beta1) * gradB[i];
            vb[i] = beta2 * vb[i] + (1 - beta2) * gradB[i] * gradB[i];
            b[i] -= lr * (mb[i] / bc1) / (std::sqrt(vb[i] / bc2) + eps);
            gradB[i] = 0.f;
        }
    }

    void save(std::ostream& os) const {
        os.write(reinterpret_cast<const char*>(W.data()), W.size() * sizeof(float));
        os.write(reinterpret_cast<const char*>(b.data()), b.size() * sizeof(float));
    }
    void load(std::istream& is) {
        is.read(reinterpret_cast<char*>(W.data()), W.size() * sizeof(float));
        is.read(reinterpret_cast<char*>(b.data()), b.size() * sizeof(float));
    }
};

// The accumulator's input layer: sparse (possibly fractionally-weighted)
// active features in, dense hidden layer out. See features.hpp for what
// produces the WeightedFeature list.
class SparseInputLayer {
public:
    int numFeatures = 0, outSize = 0;
    std::vector<float> W, b;
    std::vector<float> mW, vW, mb, vb;
    std::vector<float> gradW, gradB;

    SparseInputLayer() = default;
    SparseInputLayer(int nf, int out, std::mt19937& rng) : numFeatures(nf), outSize(out) {
        W.assign(static_cast<size_t>(nf) * out, 0.f);
        b.assign(out, 0.f);
        mW.assign(W.size(), 0.f); vW.assign(W.size(), 0.f);
        mb.assign(out, 0.f); vb.assign(out, 0.f);
        gradW.assign(W.size(), 0.f); gradB.assign(out, 0.f);
        // Typical activation count per position is small (~30-90 of 1029);
        // a small fixed init std keeps the accumulator's pre-activation
        // magnitude sane regardless of how many features happen to fire.
        std::normal_distribution<float> dist(0.f, 0.05f);
        for (auto& w : W) w = dist(rng);
    }

    void forward(const std::vector<WeightedFeature>& active, std::vector<float>& out) const {
        out = b;
        for (const auto& f : active) {
            const float* row = &W[static_cast<size_t>(f.index) * outSize];
            for (int h = 0; h < outSize; h++) out[h] += f.weight * row[h];
        }
    }

    void backward(const std::vector<WeightedFeature>& active, const std::vector<float>& dOut) {
        for (int h = 0; h < outSize; h++) gradB[h] += dOut[h];
        for (const auto& f : active) {
            float* g = &gradW[static_cast<size_t>(f.index) * outSize];
            for (int h = 0; h < outSize; h++) g[h] += dOut[h] * f.weight;
        }
    }

    void adamStep(float lr, float beta1, float beta2, float eps, int t) {
        float bc1 = 1.f - std::pow(beta1, static_cast<float>(t));
        float bc2 = 1.f - std::pow(beta2, static_cast<float>(t));
        for (size_t i = 0; i < W.size(); i++) {
            mW[i] = beta1 * mW[i] + (1 - beta1) * gradW[i];
            vW[i] = beta2 * vW[i] + (1 - beta2) * gradW[i] * gradW[i];
            W[i] -= lr * (mW[i] / bc1) / (std::sqrt(vW[i] / bc2) + eps);
            gradW[i] = 0.f;
        }
        for (size_t i = 0; i < b.size(); i++) {
            mb[i] = beta1 * mb[i] + (1 - beta1) * gradB[i];
            vb[i] = beta2 * vb[i] + (1 - beta2) * gradB[i] * gradB[i];
            b[i] -= lr * (mb[i] / bc1) / (std::sqrt(vb[i] / bc2) + eps);
            gradB[i] = 0.f;
        }
    }

    void save(std::ostream& os) const {
        os.write(reinterpret_cast<const char*>(W.data()), W.size() * sizeof(float));
        os.write(reinterpret_cast<const char*>(b.data()), b.size() * sizeof(float));
    }
    void load(std::istream& is) {
        is.read(reinterpret_cast<char*>(W.data()), W.size() * sizeof(float));
        is.read(reinterpret_cast<char*>(b.data()), b.size() * sizeof(float));
    }
};

// --- Small stateless activation helpers -------------------------------------
inline void reluInplace(std::vector<float>& v) { for (auto& x : v) x = std::max(0.f, x); }

inline std::vector<float> softmaxVec(const std::vector<float>& logits) {
    float m = *std::max_element(logits.begin(), logits.end());
    std::vector<float> e(logits.size());
    float sum = 0.f;
    for (size_t i = 0; i < logits.size(); i++) { e[i] = std::exp(logits[i] - m); sum += e[i]; }
    if (sum <= 0.f) sum = 1e-8f;
    for (auto& x : e) x /= sum;
    return e;
}
template <size_t N>
inline std::array<float, N> softmaxArr(const std::array<float, N>& logits) {
    float m = *std::max_element(logits.begin(), logits.end());
    std::array<float, N> e{};
    float sum = 0.f;
    for (size_t i = 0; i < N; i++) { e[i] = std::exp(logits[i] - m); sum += e[i]; }
    if (sum <= 0.f) sum = 1e-8f;
    for (auto& x : e) x /= sum;
    return e;
}
inline float sigmoidScalar(float z) { return 1.0f / (1.0f + std::exp(-z)); }

} // namespace checards
