#!/bin/bash
# Builds server/dist/checards-server.js - the rules engine (no AI/models) as a
# single-file ES module for the Cloudflare Worker (also runs in Node for tests).
set -e
cd "$(dirname "$0")/.."
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
mkdir -p server/dist
em++ -std=c++17 -O3 -DNDEBUG -Iengine/include engine/src/board.cpp engine/src/combat.cpp engine/src/features.cpp engine/src/network.cpp engine/src/search.cpp engine/src/selfplay.cpp server/server_api.cpp \
  -o server/dist/checards-server.js -sMODULARIZE=1 -sEXPORT_NAME=ChecardsServer -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=16MB -sINITIAL_MEMORY=32MB -sENVIRONMENT=web,worker,node \
  -sEXPORTED_FUNCTIONS=_cs_new,_cs_free,_cs_place,_cs_draft,_cs_act,_cs_resign,_cs_state,_cs_state_spec,_cs_log -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString
ls -la server/dist/checards-server.js server/dist/checards-server.wasm
