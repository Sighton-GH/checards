import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
// Exercise real GameRoom methods with a deterministic DO state and clock.
let now = 10000;
const source = fs.readFileSync('server/worker/src/index.js','utf8')
 .replace(/^import .*;$/mg,'').replace('export default {','const worker = {')
 .replace('export class GameRoom','class GameRoom').replace('export class Lobby','class Lobby')
 + '\nglobalThis.GameRoom=GameRoom;';
const context = vm.createContext({console, Request, Response, URL, WebAssembly, crypto:globalThis.crypto,
 Date:class extends Date {static now(){return now;}}, Map, JSON});
vm.runInContext(source,context);
const data = new Map(); let alarm = null, unregister = 0, closed = 0;
const storage = {async get(k){return structuredClone(data.get(k));}, async put(k,v){if(typeof k==='object')for(const [a,b] of Object.entries(k))data.set(a,structuredClone(b));else data.set(k,structuredClone(v));},
 async setAlarm(t){alarm=t;},async getAlarm(){return alarm;},async deleteAlarm(){alarm=null;},async deleteAll(){data.clear();}};
const ws={deserializeAttachment:()=>({role:'red',token:'secret'}),close(code){assert.equal(code,4000);closed++;},send(){}};
storage.transaction = fn => fn(storage);
const state={storage,getWebSockets:()=>[ws],waitUntil:p=>p,blockConcurrencyWhile:fn=>fn()};
const env={LOBBY:{idFromName:x=>x,get:()=>({async fetch(){unregister++;return new Response('{}');}})}};
data.set('meta',{code:'ABCDEF',visibility:'public',createdAt:now,lastActionAt:now,creatorSide:'red',tokens:{red:'secret'}});
let room=new context.GameRoom(state,env);
assert.equal(room.sessions.get(ws).role,'red');
await room.loadMeta();room.replay={seed:1,actions:[]};
now+=100;await room.record({t:'act',idx:0,side:0});assert.equal(alarm,now+3600000);
const deadline=alarm;now+=1000;room.engine=async()=>({});await room.webSocketMessage(ws,'{"t":"ping"}');assert.equal(alarm,deadline,'presence/ping must not extend TTL');
// Cold reconstruction restores the socket role and stored action timestamp.
room=new context.GameRoom(state,env);assert.equal(room.sessions.get(ws).token,'secret');
now=deadline-1;await room.alarm();assert.equal(alarm,deadline);assert.equal(closed,0);
now=deadline;await room.alarm();assert.equal(closed,1);assert.equal(unregister,1);assert.equal(data.size,0);assert.equal(alarm,null);
// Ended room grace has priority over inactivity deadline.
data.set('meta',{code:'ABCDEF',visibility:'private',createdAt:now,lastActionAt:now,endAt:now+30000,tokens:{red:'secret'},creatorSide:'red'});
room=new context.GameRoom(state,env);now+=30000;await room.alarm();assert.equal(closed,2);assert.equal(data.size,0);
// Errors are bounded and don't store supplied secrets; creator-only diagnostics.
data.set('meta',{createdAt:now,lastActionAt:now,creatorSide:'red',tokens:{red:'secret'}});
room=new context.GameRoom(state,env);for(let i=0;i<12;i++)await room.captureError('engine');assert.equal(data.get('errors').length,10);
assert.equal((await room.fetch(new Request('https://room/errors'))).status,403);
assert.equal((await room.fetch(new Request('https://room/errors',{headers:{Authorization:'Bearer secret'}}))).status,200);
room.engine=async()=>{throw Error('sensitive-token');};assert.equal((await room.fetch(new Request('https://room/info'))).status,500);
assert(!JSON.stringify(data.get('errors')).includes('sensitive-token'));
console.log('LIFECYCLE PASS: socket restore, accepted-action TTL, ping no extension, early alarm, expiry, terminal grace, bounded private errors');
