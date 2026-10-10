# Checards UI/UX + evaluation bar: spec index

Status: ready to implement. Owner decisions are recorded in "Decisions" below;
do not re-open them without asking.

## Documents

| File | What it covers |
|------|----------------|
| [eval-bar.md](eval-bar.md) | Accurate, honest evaluation bar: engine API, Web Worker, calibration, UI |
| [ui-ux.md](ui-ux.md) | Layout, turn flow, input, feedback/animation, move log, accessibility, settings |
| [implementer-prompt.md](implementer-prompt.md) | The prompt to hand to the implementing agent |

## Decisions (made by the owner)

1. **Eval bar is always on during solo play.** It is not a toggle that defaults
   off. (A user setting to hide it is still allowed, see ui-ux.md §8.)
2. **Accuracy over speed:** the evaluation runs the it32 network plus search in a
   Web Worker and refines over ~1-3 s per position without blocking the board.
3. **Mobile and desktop are equal priority:** mobile-first CSS that scales up.
4. **No build-step change for the UI:** plain HTML/CSS/JS in `web/index.html`.
   `web/build.sh` must still produce the single file `web/dist/checards-play.html`
   that opens from `file://`, plus the hosted `web/dist/index.html`.
   (The bot in `web/bot/*.ts` is already bundled by build.sh with esbuild; new
   TS/JS modules may be bundled the same way.)

## Decisions made by the spec author (flag if you disagree)

- **Multiplayer:** the bar is hidden for the two players in a live human-vs-human
  room (it would be engine assistance) and shown to spectators and in finished
  games. Owner chose "always on during play" in the context of games vs the bot.
- **Honesty:** the bar only ever uses information the human player can see.
  It must never read the AI seat's view (`cg_ai_state`) or the true board.

## Research summary (what other web games do, and what we take from it)

- **Lichess / chess.com eval bar.** Both convert an engine score into a win
  chance with a logistic curve fitted to real games (Lichess:
  `Win% = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)`), and move quality
  in review is judged by *win-chance lost*, not raw score. Chess.com's
  thresholds on expected points lost: best 0, excellent <= .02, good <= .05,
  inaccuracy <= .10, mistake <= .20, blunder > .20.
  **Take:** our network already outputs win/draw/loss probabilities, so we skip
  the centipawn step and show expected score directly, then *verify the
  calibration on real games* (eval-bar.md §5). Reuse the expected-points idea
  for post-game move labels.
  Sources: [Lichess accuracy](https://lichess.org/page/accuracy),
  [chess.com Game Review](https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-move).
- **Lichess advantage chart.** A per-move eval graph under the move list makes
  the game's story readable at a glance and doubles as navigation.
  **Take:** eval sparkline in the side panel, clickable in post-game review.
- **Hidden-information games.** Estimates built by sampling hidden cards
  ("determinization") are estimates under a belief, not ground truth.
  **Take:** show uncertainty honestly (thinking indicator, sample count, W/D/L
  breakdown) instead of false precision; never claim "forced win".
  Source: [determinization / strategy fusion](https://arxiv.org/html/2405.14346v1).
- **Board Game Arena.** Avoid confirmation dialogs for ordinary moves (they slow
  play); allow undo only for a misclick before hidden info/randomness is
  revealed; make whose-turn-it-is impossible to miss.
  Sources: [BGA undo policy](https://en.doc.boardgamearena.com/BGA_Undo_policy),
  [BGA studio guidelines](https://en.doc.boardgamearena.com/BGA_Studio_Guidelines).
- **Marvel Snap / Hearthstone.** Praised for feedback on every action (cards
  animate on drag/drop, impacts land with weight); criticized for cluttered
  menus. **Take:** juicy, fast in-game feedback; calm, minimal chrome.
  Source: [Marvel Snap review](https://www.gamesradar.com/marvel-snap-review/).
- **Touch ergonomics.** Minimum touch target 44x44 pt (Apple); primary actions
  in the bottom third of the screen; every drag must have a tap alternative.
  Source: [Smashing: finger-friendly targets](https://www.smashingmagazine.com/2012/02/finger-friendly-design-ideal-mobile-touchscreen-target-sizes/).
- **Motion and accessibility.** Honour `prefers-reduced-motion` (keep fades and
  colour, drop movement); nothing flashes more than 3 times per second; never
  convey information by colour alone; readable default text size and contrast.
  Sources: [Game Accessibility Guidelines](https://gameaccessibilityguidelines.com/),
  [Yale: animated content and timing](https://usability.yale.edu/digital-accessibility/accessibility-resources/accessibility-articles/animated-content-and-timing).

## Phasing (ship in this order; each phase is releasable on its own)

1. **Eval engine + worker** (eval-bar.md §2-4) with a minimal bar.
2. **Calibration harness** (eval-bar.md §5); adjust if out of tolerance.
3. **Layout + turn flow** (ui-ux.md §2-4).
4. **Feedback and animation** (ui-ux.md §5).
5. **Move log, eval graph, post-game review** (ui-ux.md §6, eval-bar.md §7).
6. **Accessibility + settings polish** (ui-ux.md §7-8).

## Ground rules for every phase

- Do not change game rules, the engine's search for the AI, the bot in
  `web/bot`, or the multiplayer protocol (`web/net.js`, `server/`).
- Keep the existing tests green: `node web/test-log-redaction.cjs`,
  `node web/test-public-log.cjs`, `node web/test-net-lifecycle.mjs` (run from
  the repo root after `web/build.sh`).
- Rebuild `web/dist/*` with `web/build.sh` and commit the result with each phase.
- Every new behaviour gets a test (node test for logic, Playwright script for UI).
