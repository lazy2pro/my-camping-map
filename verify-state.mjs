import assert from 'node:assert/strict';
import {diff,applyChanges,normalizeState,parseTable,validChanges,clone} from './lib/state-core.mjs';
import handler from './api/sync.js';
const original=normalizeState({gear:{items:[{id:'g1',name:'tent',quantity:1,price:100},{id:'g2',name:'chair',quantity:2}],checklists:{}},records:{upcoming:[{id:'t1',title:'camp',note:''}],history:[]}});
const a=clone(original),b=clone(original);a.gear.items[0].quantity=2;b.records.upcoming[0].note='parking';
const merged=applyChanges(b,diff(original,a));assert.equal(merged.conflicts.length,0);assert.equal(merged.state.gear.items[0].quantity,2);assert.equal(merged.state.records.upcoming[0].note,'parking');
b.gear.items[0].quantity=3;assert.equal(applyChanges(b,diff(original,a)).conflicts.length,1);
const deleted=clone(original);deleted.gear.items.shift();assert.equal(applyChanges(deleted,diff(original,a)).conflicts.length,1);
const additions=clone(original);additions.gear.items.push({id:'g3',name:'lamp',quantity:1});
const other=clone(original);other.gear.items.push({id:'g4',name:'stove',quantity:1});
assert.equal(applyChanges(other,diff(original,additions)).state.gear.items.length,4);
assert.equal(applyChanges(a,diff(original,a)).conflicts.length,0);
assert.equal(validChanges([{path:['gear','__proto__'],beforeExists:false,afterExists:true,value:{}}]),false);
const table='항목\t제조사\t모델명\t가격\t수량\t합계\t중고가\n텐트\t브랜드\t"모델\n두 줄"\t₩1,000\t2\t₩2,000\t500\n\t\t다른 모델\t200\t1\t200\t\n\t\t\t\t\t2200\t';
const rows=parseTable(table);assert.equal(rows.length,2);assert.equal(rows[1].manufacturer,'브랜드');assert.equal(rows[0].price*rows[0].quantity,2000);
assert.throws(()=>parseTable('항목,제조사,모델명,가격,수량\n텐트,A,B,100,-2'));
let state=JSON.stringify(original),backups=[],writes=0;
const actualFetch=globalThis.fetch;
process.env.KV_REST_API_URL='https://test.invalid';process.env.KV_REST_API_TOKEN='mock';
globalThis.fetch=async(_url,opts)=>{
 const cmd=JSON.parse(opts.body);let result;
 if(cmd[0]==='GET')result=state;
 if(cmd[0]==='LRANGE')result=backups;
 if(cmd[0]==='EVAL'){if((state||'')!==cmd[6])result=0;else{backups.unshift(cmd[9]);state=cmd[7];writes++;result=1;}}
 return {ok:true,json:async()=>({result})};
};
async function call(method,body,query={}){let response={};const res={setHeader(){},status(n){response.status=n;return this;},json(x){response.body=x;return response;}};await handler({method,body,query},res);return response;}
let result=await call('POST',original);assert.equal(result.status,409);assert.equal(writes,0);
result=await call('POST',{protocol:2,changes:diff(original,a)});assert.equal(result.status,200);assert.equal(JSON.parse(state).gear.items[0].quantity,2);
result=await call('POST',{protocol:2,changes:diff(original,b)});assert.equal(result.status,409);assert.equal(writes,1);
const c=clone(original);c.records.upcoming[0].note='same time';
result=await call('POST',{protocol:2,changes:diff(original,c)});assert.equal(result.status,200);assert.equal(JSON.parse(state).gear.items[0].quantity,2);assert.equal(JSON.parse(state).records.upcoming[0].note,'same time');
result=await call('GET');assert.equal(result.body.protocol,2);
result=await call('GET',null,{action:'backups'});assert.equal(result.body.backups.length,2);
globalThis.fetch=actualFetch;
console.log('PASS: independent edits, conflicts, deleted parents, additions, retry idempotence, validation, sheet parser, legacy guard, API merge, backups');
