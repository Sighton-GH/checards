// Regression: legacy saves must be redacted even if created before the WASM fix.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/index.html','utf8');
const code=source.slice(source.indexOf('function publicLog(log)'),source.indexOf('function download(name,obj)'));
const old=[{ev:'start',humanSide:'red',seed:123},{ev:'setup_done',board:[
  {c:{owner:0,name:'AD',rank:1,suit:1,revealed:0}},
  {c:{owner:1,name:'AC',rank:1,suit:0,revealed:0}},
  {c:{owner:1,name:'KS',rank:13,suit:3,revealed:1}}]},
  {ev:'act',mover:1,a:{card:'AC',spawn:0},spawned:'AC'},
  {ev:'act',mover:0,a:{card:'AD',spawn:0},spawned:'AD'},
  {ev:'act',mover:1,combat:[{att:['AC'],def:['AD']}]}];
let stored=JSON.stringify({game:old});
const localStorage={getItem:()=>stored,setItem:(k,v)=>{stored=v}};
const ctx={localStorage,gameId:'game',M:{UTF8ToString:()=>JSON.stringify(old),_cg_log:()=>0},$:()=>({textContent:''})};
vm.createContext(ctx);
vm.runInContext(code,ctx);
const got=JSON.parse(stored).game;
assert(!('seed' in got[0]));
assert.equal(got[1].board[0].c.name,'AD');
assert.equal(got[1].board[1].c.name,undefined);
assert.equal(got[1].board[1].c.rank,undefined);
assert.equal(got[1].board[1].c.suit,undefined);
assert.equal(got[1].board[2].c.name,'KS');
assert.equal(got[2].a.card,'');assert.equal(got[2].spawned,'');
assert.equal(got[3].a.card,'AD');assert.equal(got[4].combat[0].att[0],'AC');
assert.equal(ctx.publicLog(got)[1].board[1].c.name,undefined);
assert.equal(old[1].board[1].c.name,'AC');
console.log('legacy save redaction PASS');
