import assert from 'node:assert/strict';
const BASE='http://localhost:8787';
const room=await (await fetch(BASE+'/api/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({visibility:'private',side:'red'})})).json();
const messages=[];let close;
const ws=new WebSocket(`ws://localhost:8787/ws/rooms/${room.room}?token=${room.token}`);
const closed=new Promise(resolve=>ws.onclose=e=>{close=e;resolve(e);});
ws.onmessage=e=>messages.push(JSON.parse(e.data));
async function wait(fn,limit=5000){let end=Date.now()+limit;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('timeout');}
await wait(()=>messages.some(m=>m.t==='state'));
const before=JSON.stringify(messages.findLast(m=>m.t==='state').view);
await new Promise(r=>setTimeout(r,14000));
ws.send(JSON.stringify({t:'ping'}));await wait(()=>messages.some(m=>m.t==='pong'));
assert.equal(JSON.stringify(messages.findLast(m=>m.t==='state').view),before);
ws.send(JSON.stringify({t:'resign'}));await wait(()=>messages.findLast(m=>m.t==='state')?.view.gamePhase==='over');
await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('end grace did not close socket')),40000))]);
assert.equal(close.code,4000);
assert.equal((await fetch(BASE+'/api/rooms/'+room.room)).status,404);
console.log('IDLE WORKER PASS: idle-connected ping resumes, terminal closes after grace and room storage gone');
