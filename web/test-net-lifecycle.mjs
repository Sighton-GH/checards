import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
let timers=[];const sockets=[];
class WS {static OPEN=1;constructor(){this.readyState=1;sockets.push(this);}close(){}send(){}}
const source=fs.readFileSync('web/net.js','utf8').replace(/export /g,'').replace('default facade;','')+'\nglobalThis.RoomSession=RoomSession;';
const ctx=vm.createContext({URL,Map,Set,JSON,WebSocket:WS,location:{origin:'https://checards.sighton.ca',protocol:'https:'},localStorage:{getItem:()=>null},setTimeout:f=>(timers.push(f),timers.length),clearTimeout(){},queueMicrotask});
vm.runInContext(source,ctx);
const session=new ctx.RoomSession({room:'ABCDEF'});let promise=session.connect();let ws=sockets.at(-1);ws.onmessage({data:JSON.stringify({t:'welcome',role:'red',token:'test',room:'ABCDEF'})});await promise;
ws.onclose({code:4000});assert(session.closed);assert.equal(timers.length,0);
const ended=new ctx.RoomSession({room:'ABCDEF'});promise=ended.connect();ws=sockets.at(-1);ws.onmessage({data:JSON.stringify({t:'welcome',role:'red',room:'ABCDEF'})});await promise;ended.view={gamePhase:'over'};ws.onclose({code:1006});assert(ended.closed);assert.equal(timers.length,0);
const failed=new ctx.RoomSession({room:'ABCDEF'});failed.connect().catch(()=>{});
for(let i=0;i<9;i++){ws=sockets.at(-1);ws.onclose({code:1006});if(!failed.closed){const f=timers.shift();assert(f);await new Promise(r=>setImmediate(r));f();await new Promise(r=>setImmediate(r));}}
assert(failed.closed);assert.equal(failed.retries,8);assert.equal(timers.length,0);
console.log('NET LIFECYCLE PASS: terminal/finished closes stop retries; failures capped at8');
