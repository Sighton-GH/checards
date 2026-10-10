# Spec: UI/UX overhaul

Scope: `web/index.html` (markup, CSS, game script), plus the help guide and the
multiplayer lobby styling where noted. Plain HTML/CSS/JS, no framework.

## 1. Problems observed in the current build (Oct 2026)

Screenshots were taken at 390x844 (phone) and 1440x900 (desktop) with
Playwright against `web/dist/checards-play.html`.

1. **Mobile: the turn status is below the fold.** "Your turn - 3 of 3 moves
   left" sits under the "Cards lost" panel, about one screen below the board.
   The most important information in the game is the hardest to find.
2. **Mobile: during setup the hand is pushed down** by the empty "Cards lost"
   panel, so placing cards means scrolling between hand and board.
3. **Cards lost shows "None yet" twice** for most of the game: high cost, low
   value.
4. **Move log is hard to scan.** It has one row per atomic move with raw
   coordinates (`AI (1,4) → (2,4)` three times in a row), mixed card images
   that change row heights, and no turn grouping.
5. **Moves left in a turn is text only.** Players lose track mid-turn.
6. **Nothing animates on the board.** Cards teleport, combat has no visual
   beat, and the bot's 3 moves land at once after a delay, so it is hard to see
   what happened.
7. **Header chrome** ("Music: off", "How to play", "Multiplayer", "New game")
   takes two rows on mobile.
8. **No sound effects**, only music.
9. **Game end** is a status line; there is no result moment and no clear next
   action.

## 2. Layout

### 2.1 Mobile (< 920 px wide, portrait). Target: one screen during play.

Top to bottom, with nothing between the opponent bar and the action bar except
the board:

```
┌ app bar: logo · [?] [♪] [☰ menu]          (44 px, icons with labels in menu)
├ opponent bar: avatar · name · ●●○ moves · pile ×N · lost: mini cards
├ eval bar (horizontal, 8-10 px)  64%
├ BOARD (full width minus 16 px gutters, square)
├ player bar: avatar · You · YOUR TURN · ●●○ moves left · pile ×N · lost
├ action strip (thumb zone): context hint + primary button(s)
│   setup: the hand (horizontal scroll of cards) replaces the strip
└ below the fold: tabs [Moves | Game | Settings]
```

- The status message moves **into the action strip** directly under the board
  (one line, 15-16 px). The long status card is removed.
- "Cards lost" moves into each player bar as a compact row of mini card faces
  (or a count badge `−3` that opens a popover when space is tight). The panel
  is removed.
- Header: "New game", "Multiplayer", "How to play", "Music", theme go into
  a menu sheet (bottom sheet on mobile). Keep "?" and music as icon buttons with
  `aria-label`s.
- Board must fit: `--board = min(100vw - 32px, 100dvh - <chrome>)`. Verify at
  360x640, 390x844 and 430x932 that the board, both bars and the action strip
  are visible without scrolling, in both setup and play.
- Landscape phones (height <= 540): board on the left, bars and strip in a
  column on the right (the existing breakpoint, re-checked).

### 2.2 Desktop (>= 920 px)

Keep the current three-zone feel, tightened:

- Left: opponent bar (top-aligned with the board top) and the vertical eval
  bar hugging the board.
- Centre: board, max 760 px or `100dvh - 120px`, whichever is smaller.
- Right panel (sticky): player bar at the top (status, moves-left pips, lost
  cards), then tabs [Moves | New game | Settings], then the eval graph
  (post-game).
- Your own player bar sits by the board's bottom edge, the opponent's by its top
  edge, so "you are at the bottom" reads spatially.

### 2.3 Tokens

Define all colours, radii, spacing and durations as CSS custom properties on
`:root`, with dark-mode overrides in the existing theme mechanism. New ones:
`--dur-fast: 120ms; --dur-med: 220ms; --dur-slow: 380ms;
--ease-out: cubic-bezier(.2,.8,.2,1);` plus faction colours `--red`, `--black`
if not already present.

## 3. Turn flow and status

- **Moves-left pips:** three dots in the active player's bar. Filled = moves
  remaining, hollow = used. They animate as they are spent. Also show as text
  for screen readers: `aria-label="2 of 3 moves left"`.
- **Whose turn:** the active player's bar gets an accent border and a
  "YOUR TURN" or "THINKING..." chip. On the bot's turn the opponent avatar
  shows a subtle pulsing ring (static under reduced motion).
- **Action strip copy** (short, imperative, changes with context):
  - nothing selected: "Tap a card to move it, or tap a glowing back-row square
    to draw."
  - card selected: "Tap a highlighted square. Tap the card again to cancel."
  - chooser open: handled by the chooser.
  - bot's turn: "Opponent is thinking..." with a spinner.
  - setup: "Place your Ace (card 1 of 7)", and so on.
- **End-of-turn beat:** when the human's 3rd move ends the turn, show a brief
  "Turn over" toast in the action strip (600 ms) before the bot starts, so
  the human sees their last move land.
- **Bot pacing:** play the bot's actions **one at a time** with
  ~450 ms between them (each animated, §5), instead of all at once. The
  engine call can stay synchronous; queue the resulting log events and replay
  them visually. Add a "Bot speed: Normal / Fast / Instant" setting (§8).

## 4. Input

- Keep tap-select then tap-destination as the primary method (works for mouse,
  touch and keyboard). Keep drag-to-place in setup. **Add drag-to-move in
  play:** pointerdown on a movable stack, drag shows the stack following the
  pointer and highlights legal targets; drop on a legal target acts. A drag that
  ends where it started counts as a tap (selects). Under 6 px of movement is a
  tap.
- **Legal targets:** empty-square dots and an attack ring on enemy-occupied
  targets (ring, not colour alone; add a small crossed-swords glyph on the
  ring).
- **Touch targets:** every interactive control is at least 44x44 CSS px,
  including chooser cards and the stack count badge (expand its hit area with a
  pseudo-element; the visual size can stay small).
- **Misclick undo:** allow undoing the human's last atomic move **only if** it
  revealed no hidden information (no combat, no draw) and the turn is not over.
  This needs an engine call. If that is too invasive, skip it and document why;
  BGA's policy is the reference.
- **Keyboard:** keep the existing arrow/Enter/Escape model. Add `U` for undo
  (if implemented), `N` for a new game (with confirm if a game is in progress),
  and `?` for help. Show shortcuts in the help dialog.
- **Stack inspector** (already shipped): keep it. Make it open on long-press
  (500 ms) on touch as well as right-click.

## 5. Feedback and animation

All motion uses transform/opacity only (no layout thrash), respects
`prefers-reduced-motion` (replace movement with a 120 ms cross-fade), and is
skippable: any click during a bot animation fast-forwards to the end state.

| Event | Animation | Duration |
|-------|-----------|----------|
| Card move | FLIP from source square to target, slight lift (scale 1.04) mid-flight | 220 ms ease-out |
| Draw/spawn | card slides in from the player's pile icon, flips face-up (own) | 300 ms |
| Select | stack lifts 4 px with shadow | 120 ms |
| Combat | both stacks reveal (flip), 120 ms hit-stop, loser shakes 2px and fades/crumbles, winner settles | ~700 ms total |
| Ace destroyed | brief screen-edge pulse in the loser's colour (one pulse, no flashing) | 400 ms |
| Moves-left pip spent | pip shrinks to hollow | 150 ms |
| Game end | result sheet rises (§5.2), confetti-free; winner's remaining cards gently lift | 500 ms |

### 5.1 Sound (off by default, separate from music)

Short (<200 ms), quiet UI sounds: select, move, draw, combat hit, Ace lost,
win/lose sting (reuse the existing win/lose music if no separate sting).
Generate them with WebAudio oscillators/noise (no new asset files needed) or
add tiny OGG/MP3 files inlined by `build.sh` like the music. A "Sound effects"
toggle sits next to the music toggle. Never play sounds before the first user
gesture.

### 5.2 Game-over sheet

A modal sheet (focus-trapped, Escape closes) with: the result ("You win - both
enemy Aces destroyed"), turns played, the final eval graph thumbnail, and
buttons **Rematch** (same settings, swap colours option), **Review game**
(opens post-game review, eval-bar.md §7), **New game settings**. The board
stays visible behind the sheet (sheet at the bottom on mobile).

## 6. Move log

- **Group by turn:** one row per turn, `T7 You: K♥ (2,0)→(3,0), Q♥ (3,0)→(3,1), drew`.
  Each atomic move is a chip in the row. The bot's chips show `?` for unknown
  cards.
- Use `file + rank` coordinates instead of `(x,y)` only if the board shows
  file/rank labels that match. Otherwise keep `(x,y)` but monospace and
  aligned.
- Combat shows as a sub-row: `⚔ (3,4): K♥ Q♥ 25 vs 23 ?♠ ?♠, defender destroyed`.
- Mini card glyphs in rows are inline-sized (text-height), so rows keep one
  height.
- Hovering/focusing a row highlights the involved squares on the board.
- **Post-game:** rows become buttons that jump the board to that ply
  (read-only replay built from the log; a "Back to final position" button
  restores it). Arrow keys step through plies.

## 7. Accessibility

- Never convey information by colour alone: faction is also shown by suit
  glyph, legal targets by shape, attack targets by ring + icon, the eval by text.
- Text: 14 px minimum body, 12 px minimum for labels; contrast 4.5:1 for text,
  3:1 for UI components, in both themes.
- All dialogs/sheets: `role="dialog"`, `aria-modal`, focus trap, Escape to
  close, focus returns to the opener.
- Live region: a single polite region announces "Opponent moved K from (2,5) to
  (2,4)", "Combat at 3,4: you lost a Queen", "Your turn, 3 moves". Throttle to
  the final message of a bot turn.
- No flashing more than 3 times per second. Reduced motion as in §5.
- Optional **high-contrast cards** setting: thicker borders and bolder rank
  text.

## 8. Settings (new "Settings" tab or menu sheet)

Persist in localStorage (try/catch; defaults when unavailable):

- Theme: System / Light / Dark.
- Evaluation bar: On (default) / Off. When off, it is also hidden from the
  game-over sheet.
- Bot speed: Normal (default) / Fast (150 ms per action) / Instant.
- Animations: Full / Reduced (default follows the OS setting).
- Sound effects: Off (default) / On. Music: as today.
- Confirm new game while a game is in progress: On (default) / Off.
- High-contrast cards: Off / On.

## 9. Performance budgets

- Interaction response (tap → visible selection): < 50 ms on a mid-range phone.
- No long task > 100 ms on the main thread during the human's turn (the eval
  runs in the worker; the bot's search runs only on its turn).
- Bot turn wall time: unchanged engine time + animation time.
- Measure with the Performance panel at 4x CPU throttling and note the results
  in the PR description.

## 10. Acceptance tests (Playwright, `web/test-ui-*.mjs`)

- **Viewports** 360x640, 390x844, 430x932, 768x1024, 1440x900, 1920x1080:
  setup and play both show board + both player bars + action strip with no
  vertical scroll on phones; no horizontal scroll anywhere. Save screenshots to
  `web/test-artifacts/` (gitignored).
- **Turn flow:** after the human's 3rd move the bot plays exactly one turn; pips
  reset; status strings match §3.
- **Animation off:** with `prefers-reduced-motion: reduce` emulated, no element
  has a running transform animation (check `document.getAnimations()`).
- **Drag-to-move** reaches the same engine state as tap-tap for the same move.
- **Keyboard-only:** a full human turn can be played with arrows + Enter.
- **Dialogs:** the game-over sheet traps focus and returns it on close.
- **Regression:** the existing node tests pass, and the multiplayer lobby still
  opens and renders (smoke test).
