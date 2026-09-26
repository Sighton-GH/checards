# Checards

A chess-like card game with a neural-net engine (C++17, compiled to WebAssembly).

## Play

Open `web/dist/checards-play.html` directly in a browser. No build, no server needed.
Default opponent is the it32 champion at 250 sims/move; historical opponents (it28-it31,
older checkpoints) are selectable in the page.

## Build from source

Requires [Emscripten](https://emscripten.org/) (`emsdk`):

```sh
web/build.sh
```

Run from anywhere; it compiles `engine/src` + `web/play_api.cpp` with `em++`,
embeds `web/models`, and regenerates the single-file `web/dist/checards-play.html`.

## Layout

- `engine/include/checards`, `engine/src` - game rules, search (MCTS), network, selfplay
- `web/play_api.cpp` - WASM bindings (`cg_new`, `cg_place`, `cg_draft`, `cg_human_act`, `cg_ai_step`, `cg_state`, `cg_log`)
- `web/index.html` - play page shell
- `web/models` - trained network weights (it32 is the released champion; the experimental wideX line is not released)
- `web/dist/checards-play.html` - prebuilt single-file playable

## Music

Four original game-show-style instrumental cues live under `web/audio/` in Ogg Vorbis and MP3:
`checards-menu` for setup, `checards-game` for play, and short `checards-win` /
`checards-lose` endings. The Music button starts muted (browser autoplay rules),
and turning it off stops every cue. A draw or aborted game stays silent. The build embeds both audio formats in the
single-file play page, so it still works when opened directly from `file://`.
When serving `web/index.html` instead, keep `web/audio/` beside it. The source
page resolves audio relative to `web/`.
