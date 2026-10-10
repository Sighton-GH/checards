# Prompt for the implementing agent

Copy everything below the line into the implementing agent's first message.

---

You are implementing a spec in the GitHub repo `Sighton-GH/checards`, a
chess-like card game. It has a C++17 engine compiled to WebAssembly, a
single-file web page, a TypeScript search bot, and Cloudflare multiplayer.

**Read first, in this order:**
1. `README.md` (repo layout and build).
2. `docs/specs/README.md`: decisions, research summary, phasing, ground rules.
3. `docs/specs/eval-bar.md`: the evaluation bar.
4. `docs/specs/ui-ux.md`: the UI/UX overhaul.

If `docs/specs/` is not on `main`, it is on the branch
`claude/gallant-cannon-xoqn0w`. Branch from that.

**Environment setup:**
- Emscripten: `git clone --depth 1 https://github.com/emscripten-core/emsdk ~/emsdk && ~/emsdk/emsdk install latest && ~/emsdk/emsdk activate latest`.
  `web/build.sh` sources `~/emsdk/emsdk_env.sh` itself. Node 18+ is needed (the
  bot is bundled with `npx esbuild@0.25.0`).
- Build with `web/build.sh` (~25 s). It regenerates everything in `web/dist/`.
- Tests (run from the repo root after building):
  `node web/test-log-redaction.cjs && node web/test-public-log.cjs && node web/test-net-lifecycle.mjs`.
- Bot strength sanity check: `node web/tools/bot-match.cjs 4 250 1000`.
- Use Playwright with Chromium for UI tests and screenshots. Open
  `web/dist/checards-play.html` via `file://`. The game state `S` is a
  top-level `let`, not `window.S`, so wait with
  `() => typeof S !== 'undefined' && S`.

**How to work:**
- Implement the phases in the order listed in `docs/specs/README.md`, one pull
  request per phase. Each PR must: rebuild `web/dist/*`, keep all existing tests
  green, add the tests the spec asks for, and include before/after screenshots
  at 390x844 and 1440x900 in the PR description.
- Follow the existing code style in `web/index.html` (compact vanilla JS, CSS
  custom properties). Do not add a UI framework or a CSS framework. Do not add
  runtime network dependencies: the single-file build must work offline from
  `file://`.
- Do not change game rules, the AI's search, `web/bot/*`, the multiplayer
  protocol (`web/net.js`, `server/`), or the hidden-information redaction in
  logs and exports.
- The evaluation must use only the human player's information set. The
  honesty test in eval-bar.md §2.4 is mandatory and must be in place before any
  UI for the bar ships.
- Accuracy is defined by calibration (eval-bar.md §5). Run the calibration
  harness and commit the report. If the bar fails the threshold, apply the
  temperature fix described there. Do not ship an uncalibrated bar labelled as
  a win percentage.
- If something in the spec turns out to be impossible or clearly worse than an
  alternative (for example the engine cannot continue a search tree across
  calls, or misclick undo needs invasive engine changes), choose the
  documented fallback, or the simplest correct option, and explain the choice
  in the PR. Don't stall on it.
- Ask the owner before reversing an owner decision (spec README, "Decisions"),
  or before anything that changes gameplay or deletes features.

**Done means:** all six phases merged, every acceptance test in both specs
passing, a calibration report with ECE <= 0.05 committed, and screenshots
showing the phone layout fits board + both player bars + action strip on one
screen at 390x844.
