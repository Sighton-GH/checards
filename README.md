# Checards

A chess-like card game with a neural-net engine (C++17, compiled to WebAssembly).

## Play

Open `web/dist/checards-play.html` directly in a browser. No build, no server needed.
Default opponent is the Grandmaster search bot (`web/bot`), a turn-planning search that
plays the AI seat through the engine; the it32 champion net (250 sims/move by default) and
historical opponents (it28-it31, older checkpoints) are selectable in the page.

## Build from source

Requires [Emscripten](https://emscripten.org/) (`emsdk`) and Node.js (the bot is bundled with `npx esbuild`):

```sh
web/build.sh
```

Run from anywhere; it compiles `engine/src` + `web/play_api.cpp` with `em++`,
embeds `web/models`, and regenerates the single-file `web/dist/checards-play.html`.

## Layout

- `engine/include/checards`, `engine/src` - game rules, search (MCTS), network, selfplay
- `web/play_api.cpp` - WASM bindings (`cg_new`, `cg_place`, `cg_draft`, `cg_human_act`, `cg_ai_step`, `cg_state`, `cg_log`,
  plus the AI-seat API `cg_ai_state`, `cg_ai_act`, `cg_ai_setup` used by the search bot)
- `web/bot` - Grandmaster search bot (TypeScript, bundled to `web/dist/bot.js`)
- `web/index.html` - play page shell
- `web/models` - trained network weights (it32 is the released champion; the experimental wideX line is not released)
- `web/dist/checards-play.html` - prebuilt single-file playable
