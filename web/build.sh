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
import re, base64, json
h=open('web/index.html').read();e=open('web/dist/engine.js').read()
audio={}
for key in ('menu','game','win','lose'):
    audio[key]=['data:audio/'+mime+';base64,'+base64.b64encode(open('web/audio/checards-'+key+'.'+ext,'rb').read()).decode('ascii')
                for ext,mime in (('ogg','ogg'),('mp3','mpeg'))]
astart=h.index('/*AUDIO_FILES*/');aend=h.index(';',astart)
h=h[:astart]+json.dumps(audio,separators=(',',':'))+h[aend:]
h=h.replace('/*ENGINE*/',e,1)
# Inline the multiplayer assets so the single-file dist stays self-contained.
css=open('web/lobby.css').read()
h=h.replace('<link rel="stylesheet" href="./lobby.css">','<style>\n'+css+'\n</style>',1)
net=open('web/net.js').read()
net=net.replace('export async function','async function').replace('export function','function').replace('export class','class')
net=re.sub(r'^export default facade;\s*$','',net,flags=re.M)
assert 'export ' not in net, 'unstripped export remains in net.js'
lobby=open('web/lobby.js').read()
lobby=lobby.replace("import * as net from './net.js';",'')
for fn in ['listRooms','createRoom','joinRoom','spectate']:
    lobby=lobby.replace('net.'+fn+'(',fn+'(')
lobby=lobby.replace('net[method](',"({'joinRoom':joinRoom,'spectate':spectate}[method])(")
import re as _re
assert not _re.search(r'[^./]net[.[]', lobby), 'unresolved net reference remains in lobby.js'
h=h.replace('<script type="module" src="./lobby.js"></script>','<script type="module">\n'+net+'\n'+lobby+'\n</script>',1)
assert './lobby.js' not in h and './lobby.css' not in h, 'external mp asset reference remains'
open('web/dist/checards-play.html','w').write(h)
PY
# The hosted build also serves the multiplayer assets as separate files;
# its index.html loads engine.js from the same folder instead of inlining it.
cp web/lobby.js web/lobby.css web/net.js web/dist/
rm -rf web/dist/audio && cp -r web/audio web/dist/audio
python3 - <<'PY'
h=open('web/index.html').read()
h=h.replace('<script>/*ENGINE*/</script>','<script src="./engine.js"></script>',1)
assert '/*ENGINE*/' not in h
open('web/dist/index.html','w').write(h)
PY
ls -la web/dist/checards-play.html
