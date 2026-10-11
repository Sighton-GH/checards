# Spec: accurate evaluation bar

## 1. Goal and definition

Show, at all times during a solo game, how the game stands **from the human
player's point of view, using only what the human can see**.

- **Displayed value:** expected score for the human,
  `E = P(win) + 0.5 * P(draw)`, as a percentage (0-100%).
- **Breakdown on demand:** `W / D / L` percentages (tap or hover the bar).
- **"Accurate" means calibrated:** across many real games, positions shown as
  70% end in a win (+ half the draws) about 70% of the time. §5 defines the
  test and the pass threshold. A good-looking bar that is not calibrated fails
  this spec.
- **"Honest" means no leak:** the estimate must be computable from the human's
  view alone. Two games that look identical to the human must produce the same
  evaluation (for the same seed), whatever the bot's hidden cards are.

## 2. Engine API (C++, `web/play_api.cpp` or a new `web/eval_api.cpp`)

Add the new file to the `em++` line in `web/build.sh` and its functions to
`-sEXPORTED_FUNCTIONS`.

### 2.1 `const char* cg_eval_snapshot()` (called on the main game instance)

Serialises the **human's information set** into a compact string that a second
engine instance can load. Produced in C++ so redaction lives in one place.
Contents:

- Every board card: position, stack order, owner, `revealed`, `isInitial`
  (whether it was placed at setup, which is public), and rank/suit **only if**
  `owner == human || revealed`. Use `obfuscate()` from `belief.hpp` as the
  basis.
- `TurnContext` fields the search needs (mover, movesRemaining, plus any
  per-turn state such as the `frozen` bitset in `rules.hpp`; check
  `TurnContext` and copy all of it).
- `drawPileSize[2]`, `currentTurnNumber`, `inactivityPlies`, `totalPlies`,
  `acesAlive` (or let the loader call `recomputeAcesAlive()`).
- **The human's belief about the bot's deck:** the set of bot card identities
  that the human has seen (revealed on board now, or revealed in any combat so
  far, including cards that have since died).

The engine does not track this belief for the human today (only the AI's own
`BeliefState` inside `AIPlayer`). Add `BeliefState humanBelief` to `struct Game`:
reset it in `cg_new`, and after every `step()` call `onReveal` for every
revealed opponent card on the board and for every card in each
`CombatEvent`'s `attackerCards`/`defenderCards` that belongs to the bot.
For the human's *own* deck pool, mirror what `AIPlayer` does for its own side
(the cards not on board are the human's draw pile, order unknown).

Format: versioned, line-based or JSON, your choice, but it must start with a
version tag (e.g. `v1|...`) and the loader must reject unknown versions.

### 2.2 `int cg_eval_load(const char* snapshot)` (called in the worker instance)

Builds a `Board`, `TurnContext` and `BeliefState` for perspective = human from
the snapshot. Unknown opponent cards become placeholder cards (like
`obfuscate()` produces) with the correct `isInitial` flag, so `determinize()`
deals Aces only into initial slots. Returns 1 on success, 0 on a malformed
snapshot. Also loads a network (reuse `cg_new`'s model loading;
add `int cg_eval_init(const char* modelPath)` called once per worker).

### 2.3 `const char* cg_eval_run(int iters, unsigned seed)`

Runs `iters` more search iterations from perspective = human on the loaded
position, **reusing the same `SearchTree`** across calls so repeated calls
refine one estimate (check `search.cpp`: if `search()` cannot continue a tree,
run independent searches and combine them weighted by iterations). Returns JSON:

```json
{"w":0.52,"d":0.07,"l":0.41,"e":0.555,"sims":512,"quick":false,
 "best":[{"from":[2,0],"to":[3,0],"spawn":0,"card":"KH","share":0.41}]}
```

- `w/d/l`: averaged root value converted to win/draw/loss. The tree stores a
  scalar value in [-1, 1]; also average the network's `wdl` head at visited
  leaves, or at least at the root's children, so the draw probability is real
  and not invented. Document which one you used.
- `best`: top 3 root actions by visit share, for the human only when the human
  is the mover (used later for review, not shown live; see §6).
- `iters = 0` returns `quickFogEval()` (instant network read, `"quick":true`).
- The root mover may be the bot: `SearchTree::resetRoot` already sets
  `toMoveAfter = ctx.mover`, so evaluating during the bot's turn is supported.

### 2.4 Honesty test (node, `web/test-eval-honesty.cjs`)

1. Play a game to move 10 with fixed seeds. Take `cg_eval_snapshot()`.
2. Assert the snapshot contains no rank/suit for unrevealed bot cards (parse it).
3. Start a second game whose human-visible history is identical but whose bot
   hidden cards differ. The easiest route is `cg_ai_setup` with two formations
   that occupy the same squares with different cards, then replay the same
   action indices. Assert the two snapshots are byte-identical, and that
   `cg_eval_run(200, 7)` returns identical numbers for both.

## 3. Web Worker (`web/eval-worker.js`)

- Loads its own copy of the engine. For the single-file build the engine source
  is already inlined. Build the worker from a Blob URL that contains the engine
  script plus the worker code, so it works from `file://` (no separate fetch).
  The hosted build may use `new Worker('./eval-worker.js')`. `build.sh` must
  produce both.
- Model: `/models/champion-it32.bin` (the strongest net), regardless of the
  opponent chosen.
- Protocol (postMessage):
  - main → worker `{type:'eval', gen, snapshot}`: a new position. `gen` is a
    monotonically increasing integer.
  - worker → main `{type:'result', gen, w, d, l, e, sims, quick, final}`.
- Schedule per position: send a quick result (`iters=0`) immediately, then run
  chunks of ~64 iterations, posting after each chunk, until **800 sims or
  2500 ms**, whichever comes first (`final:true` on the last post). Tune the
  numbers on a mid-range phone; document the final values.
- **Cancellation:** WASM is synchronous, so between chunks the worker yields
  (`await new Promise(r => setTimeout(r))`) and drops the job if a newer `gen`
  has arrived. The main thread ignores any result whose `gen` is stale.
- The main thread posts a new snapshot after every state change it renders
  (each human action, each bot action, game start) **during solo play only**.
- If Worker creation fails (old browser, CSP), fall back to quick evals on the
  main thread only (no search) and show a small "approximate" label.

## 4. Bar UI (in `web/index.html`)

### 4.1 Placement

- **Desktop (>920 px):** a vertical bar 14-18 px wide hugging the board's left
  edge, full board height. The human's colour fills from the bottom (the board is
  already oriented with the human at the bottom), the bot's colour from the top.
- **Mobile:** a horizontal bar 8-10 px tall directly above the board, between
  the opponent bar and the board. The human's colour fills from the left.
  The percentage label sits at the human's end.
- Colours: use the existing faction colours (Red = hearts red, Black = the dark
  navy used for the opponent avatar) with a thin centre tick at 50%. Must pass
  3:1 contrast against the page background in light and dark themes.

### 4.2 Label and states

- Label: human expected score, rounded to whole percent: `64%`. Put a tiny
  icon/text "you" on the human side for clarity.
- **Thinking state:** while `final` is false, show a subtle animated shimmer on
  the bar's fill edge (static dotted edge under reduced motion). Show sims
  in the tooltip: `Thinking... 320 sims`.
- **Quick-only state** (no worker): label suffixed with `~` and the tooltip says
  "Approximate (no background analysis available)".
- **Game over:** bar snaps to 100/0 or 50/50 for draws, with the result text.
- Tap/hover reveals a small popover: `Win 52% · Draw 7% · Loss 41%`, sims count,
  and one sentence: "Estimated from what you can see; hidden enemy cards are
  sampled."

### 4.3 Motion

- Animate fill changes with a 300 ms ease-out transition (CSS
  `transition: flex-basis` or a transform scale). Never animate under
  `prefers-reduced-motion`.
- Don't jitter: during refinement, only re-render when E moves by >= 0.5
  percentage points or `final` arrives.

### 4.4 Accessibility

- The bar is a `role="meter"` with `aria-valuemin=0 aria-valuemax=100
  aria-valuenow` and `aria-valuetext="Your winning chances about 64 percent"`.
  Update `aria-valuenow` only on final results to avoid screen-reader spam.
- Information never by colour alone: the percentage text is always visible.

## 5. Calibration (`web/calibrate-eval.mjs`, run manually, not in CI)

1. Generate at least **200 games** of Grandmaster-vs-Grandmaster in node, using
   the search bot (`web/dist/bot.js`) for the AI seat and the same bot through a
   human-seat shim for the other seat. `web/tools/bot-match.cjs` already does
   this (it maps `_cg_ai_state` to `_cg_state` and `_cg_ai_act` to
   `_cg_human_act`, and places the human formation via `cg_place`/`cg_draft`
   using `setupSpec`). Extend it rather than starting over.
   **Calibrate on equal-strength games only.** The bar estimates the outcome
   between evenly matched strong players. In mismatched games (e.g. it32 vs the
   search bot, where the bot wins ~98%) the outcome is decided by the
   mismatch, not the position, so they must not be used for fitting or for the
   pass/fail ECE. (Revision 2: the first 300-game run mixed 100 such games in
   and its ECE and temperature fit were invalid for that reason.)
2. At every 3rd ply, take `cg_eval_snapshot()` (human seat), run
   `cg_eval_run(800, seed)`, and record `(e, w, d, l, ply, mover, outcome)`.
   **Every position must be sampled.** If a position cannot be snapshotted
   (e.g. mid-turn `frozen` state), that is a snapshot bug to fix, not a sample
   to skip: the live bar would be wrong or missing at exactly those positions.
3. Report:
   - **Reliability table:** 10 bins of predicted E vs mean actual score, with
     counts.
   - **Expected calibration error (ECE)** over the bins.
   - **Brier score** for win prediction.
   - **Discrimination:** AUC of E for wins vs losses, overall and by game stage
     (plies 0-30, 30-90, 90-180, 180+).
   - **Noise:** median |change in E| between consecutive samples, and the
     same for a fixed position re-run with 5 different seeds.
4. **Pass:** ECE <= 0.05 on held-out games and no bin with >= 50 samples off by
   more than 0.10.
5. **Calibration mapping (expected to be needed):** fit `T` and bias `b` on
   `E' = sigmoid(logit(E) / T + b)` by log-loss on even game IDs; report
   held-out ECE on odd game IDs; hard-code `T` and `b` in the worker with a
   comment giving the date, game count and ECE before/after. Apply it to W/D/L
   consistently: compute E' and scale W and L so that `W' + 0.5 D = E'` with D
   unchanged. Re-run whenever the network file changes.
   Reference result from the first run's 200 equal-strength games (re-analysed):
   raw held-out ECE 0.093; with `T = 3.9, b = 0.04`, held-out ECE **0.032**
   (pass). With the 5a smoothing (`k = 0.5`): raw 0.071, `T = 3.0, b = 0.02`,
   held-out ECE **0.037** (pass). Expect similar values.
5a. **Smoothing for display:** raw readings are noisy (successive changes are
   anti-correlated, about -0.5, which is search noise rather than real swings).
   Show an exponential moving average on the logit scale across positions in
   the same game (`k = 0.5`, reset on new game), applied **before** the
   calibration mapping, and fit `T`, `b` on the smoothed values. Never smooth
   across a combat that removed an Ace (snap to the new value there).
6. Commit the report as `docs/specs/eval-calibration.md`.

## 6. What the bar must not do

- No live "best move" arrows or hints during a game vs the bot. The owner wants
  the bar, not a move oracle. `best` is only for post-game review (§7).
- No reading `cg_ai_state`, `cg_log` entries the human cannot see, or the true
  board.
- Hidden in live multiplayer for the two players (see README decisions).

## 7. Post-game review (phase 5)

After `phase == 'over'`:

- **Eval graph:** an area chart of human E per ply (x = ply, y = 0-100%, 50%
  midline), drawn as inline SVG in the side panel (no chart library). Tap/click a
  point to jump the board to that ply (replay from the log; see ui-ux.md §6).
- **Move labels** for the human's turns using expected score lost versus the
  engine's best at that position: best/excellent/good/inaccuracy/mistake/blunder
  with the chess.com thresholds (0, .02, .05, .10, .20). Compute per **turn**
  (up to 3 atomic moves) as well as per move, because Checards turns are
  multi-move. Show the label glyph next to the move-log row.
- Review analysis runs in the worker after the game, ~300 sims per human
  position, with a progress indicator. Cache results per gameId in
  localStorage (try/catch; works without storage).

## 8. Tests

- `web/test-eval-honesty.cjs` (§2.4), in CI.
- `web/test-eval-api.cjs`: snapshot/load round trip (load the snapshot then
  re-snapshot: same string); `cg_eval_run(0)` is fast (< 50 ms); W+D+L = 1 ± 1e-3;
  the final position of a game the human won reads E = 1, and of one they lost reads E = 0.
- Playwright `web/test-eval-ui.mjs`: start a game, finish setup, make a move,
  wait for a `final` result, assert the meter's `aria-valuenow` is between 0 and
  100 and the board stayed interactive (a click while thinking still selects).
- Calibration report committed (§5).
