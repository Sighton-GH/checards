#!/bin/bash
# Builds web/dist/checards-play.html (single file, opens from file:// - no server needed).
set -e
cd "$(dirname "$0")/.."
source ~/emsdk/emsdk_env.sh >/dev/null 2>&1
mkdir -p web/dist
em++ -std=c++17 -O3 -DNDEBUG -Iengine/include engine/src/board.cpp engine/src/combat.cpp engine/src/features.cpp engine/src/network.cpp engine/src/search.cpp engine/src/selfplay.cpp web/play_api.cpp \
  -o web/dist/engine.js -sMODULARIZE=1 -sEXPORT_NAME=CheckardsEngine -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=16MB -sINITIAL_MEMORY=64MB -sSINGLE_FILE=1 -sENVIRONMENT=web,worker,node \
  -sEXPORTED_FUNCTIONS=_cg_new,_cg_place,_cg_draft,_cg_human_act,_cg_ai_step,_cg_state,_cg_log -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString \
  --embed-file web/models@/models
python3 - <<'PY'
import base64, json
from pathlib import Path
h=Path('web/index.html').read_text(); e=Path('web/dist/engine.js').read_text()
audio={}
for key in ('menu','game','win','lose'):
    audio[key]=[f'data:audio/{mime};base64,'+base64.b64encode(Path(f'web/audio/checards-{key}.{ext}').read_bytes()).decode('ascii')
                for ext,mime in (('ogg','ogg'),('mp3','mpeg'))]
start=h.index('/*AUDIO_FILES*/'); end=h.index(';',start)
h=h[:start]+json.dumps(audio,separators=(',',':'))+h[end:]
Path('web/dist/checards-play.html').write_text(h.replace('/*ENGINE*/',e,1))
PY
ls -la web/dist/checards-play.html
