import { clone, equal, diff, applyChanges, readAt, normalizeState, parseTable } from './lib/state-core.mjs';
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => crypto.randomUUID();
const money = n => Number(n || 0).toLocaleString('ko-KR') + '원';
const nowDate = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Seoul'}).format(new Date());
function readLocal(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function writeLocal(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { showToast('기기 저장 공간이 부족합니다. 백업을 내려받아 주세요.'); return false; } }
function element(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function button(text, action, cls = 'cm-button') { const b = element('button', cls, text); b.type = 'button'; b.onclick = action; return b; }
function field(label, type = 'text', value = '') { const wrap = element('label','cm-field'); wrap.append(element('span','',label)); const i = element(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') i.type = type; i.value = value ?? ''; wrap.append(i); return {wrap,input:i}; }
function showToast(message, undo) {
  $('#cm-toast')?.remove(); const t = element('div','cm-toast',message); t.id='cm-toast'; t.setAttribute('role','status');
  if (undo) t.append(button('되돌리기',()=>{undo();t.remove();})); t.append(button('닫기',()=>t.remove())); document.body.append(t);
  if (!undo) setTimeout(()=>t.remove(),6000);
}
function dialog(title, build) {
  const d = element('dialog','cm-dialog'); const header=element('div','cm-row');header.append(element('h2','',title),button('닫기',()=>d.close())); d.append(header);
  d.addEventListener('close',()=>d.remove()); document.body.append(d); build(d); d.showModal(); return d;
}
function section(title) { const s=element('section','cm-section'); s.append(element('h3','',title)); return s; }
function empty(text) { return element('p','cm-muted',text); }
let extra = {presets:[],trips:{},recipes:[],favorites:[],...readLocal('campmap_extra_v2',{})};
function collect() { return clone(normalizeState({food:foodData,foodPresets,records:recordsData,gear:gearData,extra})); }
function persistExtra() { writeLocal('campmap_extra_v2',extra); debouncedSync(); }
function installState(state) {
  const s = normalizeState(state); foodData=s.food;foodPresets=s.foodPresets;recordsData=s.records;gearData=s.gear;extra=s.extra;
  saveFoodData(foodData,true);saveFoodPresets(foodPresets,true);saveRecordsData(recordsData,true);saveGearData(gearData,true);writeLocal('campmap_extra_v2',extra);
}
const bootSnapshot=collect();
let base = readLocal('campmap_sync_base_v2', null);
let ready=false, syncing=false, retryTimer, conflictState=null, backupLabel='', retryCount=0;
let pendingBackup=readLocal('campmap_backup_pending_v2','');
const statusButton=button('연결 중…',()=>conflictState?showConflict():pushStateToServer(),'cm-sync');
statusButton.id='cm-sync-status';statusButton.setAttribute('aria-live','polite');document.body.append(statusButton);
function status(text, kind='') { statusButton.textContent=text;statusButton.dataset.kind=kind; }
function refreshAll() { refreshActiveView(); if($('#view-prep.active')) renderPrep(); if($('#view-favorites.active'))renderFavorites(); }
function storeBase(s) { base=clone(s);writeLocal('campmap_sync_base_v2',base); }
function scheduleRetry() { clearTimeout(retryTimer); if(navigator.onLine)retryTimer=setTimeout(()=>pushStateToServer(),Math.min(30000,1500*2**Math.min(retryCount++,5))); }
debouncedSync = function() {
  status(navigator.onLine?'저장 대기…':'오프라인 · 기기에 저장','pending');
  clearTimeout(syncTimer);syncTimer=setTimeout(()=>pushStateToServer(),600);
};
async function requestJSON(url, options={}) {
  const r=await fetch(url,{cache:'no-store',...options,signal:AbortSignal.timeout(10000)});
  const data=await r.json(); return {r,data};
}
initialSync = async function() {
  if(syncing)return;syncing=true;
  try {
    const {r,data}=await requestJSON('/api/sync');if(!r.ok)throw Error(data.error||'연결 실패');
    const remote=normalizeState(data.state||{});
    const changes=diff(base||bootSnapshot,collect());
    const merged=applyChanges(remote,changes);
    if(merged.conflicts.length){conflictState={remote,changes};status('동시 수정 · 확인 필요','error');}
    else { installState(merged.state);storeBase(remote);status(changes.length?'저장 대기…':'저장 완료'); }
    ready=true;retryCount=0;refreshAll();
  } catch { status(navigator.onLine?'연결 실패 · 변경사항 보관 중':'오프라인 · 기기에 저장','pending');scheduleRetry(); }
  finally {syncing=false;}
  if(ready&&!conflictState&&diff(base,collect()).length)debouncedSync();
};
pushStateToServer = async function() {
  if(syncing||conflictState)return;
  if(!navigator.onLine){status('오프라인 · 기기에 저장','pending');return;}
  if(!ready){await initialSync();return;}
  const sent=collect(),changes=diff(base,sent);
  if(!changes.length){status('저장 완료');return;}
  syncing=true;status('저장 중…','pending');
  try {
    const {r,data}=await requestJSON('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocol:2,changes,backupLabel:pendingBackup||backupLabel})});
    if(r.status===409&&data.state){conflictState={remote:normalizeState(data.state),changes:diff(base,collect())};status('동시 수정 · 확인 필요','error');return;}
    if(!r.ok)throw Error(data.error||'저장 실패');
    const during=diff(sent,collect());const merged=applyChanges(normalizeState(data.state),during);
    if(merged.conflicts.length){conflictState={remote:normalizeState(data.state),changes:during};status('동시 수정 · 확인 필요','error');return;}
    storeBase(normalizeState(data.state));installState(merged.state);backupLabel='';pendingBackup='';writeLocal('campmap_backup_pending_v2','');
    retryCount=0;status('저장 완료');refreshAll();
    if(during.length)debouncedSync();
  } catch(e){status('저장 재시도 필요 · 누르면 재시도','error');scheduleRetry();}
  finally{syncing=false;}
};
function showConflict() {
  const c=conflictState;if(!c)return;
  dialog('동시 수정 확인',d=>{
    d.append(empty('같은 항목이 다른 기기에서 바뀌었습니다. 이 기기의 변경사항은 보관되어 있습니다.'));
    const conflicts=applyChanges(c.remote,c.changes).conflicts;
    const ul=element('ul');conflicts.forEach(p=>ul.append(element('li','',p.join(' / '))));d.append(ul);
    d.append(button('서버 변경 유지',()=>{
      const merged=applyChanges(c.remote,c.changes);storeBase(c.remote);installState(merged.state);conflictState=null;d.close();refreshAll();debouncedSync();
    }));
    d.append(button('충돌 항목은 이 기기 값 사용',()=>{
      const merged=applyChanges(c.remote,c.changes,true);
      if(merged.conflicts.length){showToast('다른 기기에서 부모 항목을 삭제했습니다. 서버 변경을 유지한 뒤 항목을 다시 추가해 주세요.');return;}
      storeBase(c.remote);installState(merged.state);conflictState=null;d.close();refreshAll();debouncedSync();
    }));
    d.append(button('내 변경사항 백업 다운로드',()=>downloadJSON('camping-local-changes.json',collect())));
  });
}
async function pullRemote() {
  if(!ready||syncing||conflictState||document.hidden||!navigator.onLine||diff(base,collect()).length)return;
  try {const {r,data}=await requestJSON('/api/sync');if(r.ok&&data.state&&!diff(base,collect()).length){storeBase(normalizeState(data.state));installState(base);refreshAll();status('저장 완료');}}catch{}
}
window.addEventListener('online',()=>pushStateToServer());
window.addEventListener('offline',()=>status('오프라인 · 기기에 저장','pending'));
window.addEventListener('focus',()=>{pushStateToServer();pullRemote();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){pushStateToServer();pullRemote();}});
setInterval(pullRemote,20000);
window.addEventListener('beforeunload',e=>{if(diff(base||bootSnapshot,collect()).length){e.preventDefault();e.returnValue='';}});
function markBackup(label) { pendingBackup=label;writeLocal('campmap_backup_pending_v2',label); }
function rememberGear(label) {
  const snapshots=readLocal('campmap_gear_undo_v2',[]);
  snapshots.unshift({at:new Date().toISOString(),label,gear:clone(gearData)});writeLocal('campmap_gear_undo_v2',snapshots.slice(0,10));markBackup(label);
  return ()=>{gearData=clone(snapshots[0].gear);saveGearData(gearData);renderGearView();};
}
function downloadJSON(name,data) {
  const a=element('a');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
let searchGear='',categoryFilter='';
const oldRenderGear=renderGearView;
renderGearView = function() {
  const checklistSelect=$('#checklist-select');const selected=activeChecklistName;checklistSelect.replaceChildren(new Option('체크리스트 선택...',''));Object.keys(gearData.checklists).forEach(name=>checklistSelect.append(new Option(name,name)));checklistSelect.value=selected&&gearData.checklists[selected]?selected:'';renderChecklistDetail();
  const root=$('#gear-master-list');root.replaceChildren();
  const controls=element('div','cm-section');const row=element('div','cm-row');
  const search=field('장비 검색','search',searchGear);search.input.placeholder='이름 · 제조사 · 분류';search.input.oninput=()=>{searchGear=search.input.value;renderGearResults(root,results);};
  const select=element('select');select.setAttribute('aria-label','장비 분류');select.append(new Option('모든 분류',''));
  [...new Set(gearData.items.map(x=>x.category||'미분류'))].sort().forEach(x=>select.append(new Option(x,x)));select.value=categoryFilter;
  select.onchange=()=>{categoryFilter=select.value;renderGearResults(root,results);};
  row.append(search.wrap,select);controls.append(row);
  const totals=element('p','cm-metric');
  const sum=gearData.items.reduce((s,x)=>s+Number(x.price||0)*(x.quantity||1),0);
  const used=gearData.items.reduce((s,x)=>s+Number(x.usedPrice||0),0);
  totals.textContent=gearData.items.length+'종 · '+gearData.items.reduce((s,x)=>s+(x.quantity||1),0)+'개 · 구입 합계 '+money(sum);
  controls.append(totals,empty('입력된 중고가 합계 '+money(used)+' · 중고가는 각 행의 총액 기준입니다.'));
  controls.append(button('시트 가져오기',showImport),button('백업 · 복원',showBackups),button('내보내기',exportGear),button('장비 프리셋',showPresets));
  root.append(controls);const results=element('div');root.append(results);renderGearResults(root,results);
};
function renderGearResults(root,results) {
  results.replaceChildren();const term=searchGear.trim().toLowerCase();
  const items=gearData.items.filter(x=>(!categoryFilter||(x.category||'미분류')===categoryFilter)&&(!term||[x.name,x.manufacturer,x.category].join(' ').toLowerCase().includes(term)));
  if(!items.length){results.append(empty('일치하는 장비가 없습니다.'));return;}
  const groups=Map.groupBy?Map.groupBy(items,x=>x.category||'미분류'):items.reduce((m,x)=>{const k=x.category||'미분류';m.set(k,[...(m.get(k)||[]),x]);return m;},new Map());
  [...groups].sort(([a],[b])=>a.localeCompare(b,'ko')).forEach(([cat,list])=>{
    const group=element('div','gear-category-group');
    const open=term||categoryFilter||expandedGearCategories.has(cat);
    const head=button(cat+' · '+list.length+'종 · '+money(list.reduce((s,x)=>s+Number(x.price||0)*(x.quantity||1),0))+' '+(open?'▲':'▼'),()=>{if(expandedGearCategories.has(cat))expandedGearCategories.delete(cat);else expandedGearCategories.add(cat);renderGearView();},'gear-category-header');
    group.append(head);
    if(open)list.forEach(item=>{
      const card=element('div','item-card gear-card');const info=element('div','gear-card-info');
      info.append(element('div','cm-muted',item.manufacturer),element('div','gear-name',item.name));
      info.append(element('div','gear-price',money(item.price)+' × '+(item.quantity||1)+' = '+money(Number(item.price||0)*(item.quantity||1))));
      if(item.usedPrice!=null)info.append(element('div','cm-muted','중고가 '+money(item.usedPrice)));
      const actions=element('div','cm-row');actions.append(button('−',()=>changeGearQty(item.id,-1)),element('span','',(item.quantity||1)+'개'),button('+',()=>changeGearQty(item.id,1)),button('수정',()=>editGear(item)),button('삭제',()=>deleteGearItem(item.id)));
      info.append(actions);card.append(info);group.append(card);
    });results.append(group);
  });
}
deleteGearItem=function(id){
  const item=gearData.items.find(x=>x.id===id);if(!item)return;
  const undo=rememberGear('장비 삭제 전');gearData.items=gearData.items.filter(x=>x.id!==id);
  Object.values(gearData.checklists).forEach(c=>delete c[id]);saveGearData(gearData);renderGearView();showToast(item.name+' 삭제됨',undo);
};
function editGear(item) {
  dialog('장비 수정',d=>{
    const fields=[field('분류','text',item.category),field('제조사','text',item.manufacturer),field('모델명','text',item.name),field('단가 (원)','number',item.price),field('보유 수량','number',item.quantity||1),field('중고가 (해당 장비 전체, 원)','number',item.usedPrice)];
    fields.forEach(f=>d.append(f.wrap));fields[3].input.min=0;fields[4].input.min=1;fields[5].input.min=0;
    d.append(button('변경 저장',()=>{
      const v=fields.map(f=>f.input.value.trim());if(!v[2]||!Number.isInteger(Number(v[4]))||Number(v[4])<1||[3,5].some(i=>v[i]&&(!Number.isFinite(Number(v[i]))||Number(v[i])<0))){showToast('모델명과 올바른 가격·수량을 입력해 주세요.');return;}
      const target=gearData.items.find(x=>x.id===item.id);if(!target){showToast('장비가 삭제되었습니다.');return;}
      Object.assign(target,{category:v[0],manufacturer:v[1],name:v[2],price:v[3]?Number(v[3]):null,quantity:Number(v[4]),usedPrice:v[5]?Number(v[5]):null});saveGearData(gearData);d.close();renderGearView();
    }));
  });
}
function exportGear() {
  const rows=[['항목','제조사','모델명','가격','수량','합계','중고가'],...gearData.items.map(x=>[x.category,x.manufacturer,x.name,x.price,x.quantity,Number(x.price||0)*(x.quantity||1),x.usedPrice])];
  const quote=x=>'"'+String(x??'').replaceAll('"','""')+'"';
  const a=element('a'),url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r=>r.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));a.href=url;a.download='camping-gear.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function showImport() {
  dialog('시트 장비 가져오기',d=>{
    d.append(empty('Google Sheets에서 제목 행을 포함해 복사한 표를 붙여넣으세요. 항목·제조사 빈칸은 위 행의 값을 이어받습니다. 합계 행은 제외됩니다.'));
    const source=field('Google Sheets 주소 (선택)','url',readLocal('campmap_sheet_url',''));d.append(source.wrap);
    d.append(button('시트 열기',()=>{try{const u=new URL(source.input.value);if(u.protocol!=='https:'||u.hostname!=='docs.google.com')throw Error();writeLocal('campmap_sheet_url',u.href);window.open(u.href,'_blank','noopener');}catch{showToast('Google Sheets 주소를 입력해 주세요.');}}));
    const paste=field('표 붙여넣기','textarea');paste.input.rows=8;d.append(paste.wrap);const preview=element('div');d.append(preview);
    d.append(button('변경 미리보기',()=>{
      try{
        const rows=parseTable(paste.input.value);if(!rows.length)throw Error('가져올 장비가 없습니다.');
        const identity=x=>JSON.stringify([x.category,x.manufacturer,x.name]);const existing=new Map(gearData.items.map(x=>[identity(x),x]));
        const previewBase=clone(gearData.items);const next=rows.map(x=>({...x,id:existing.get(identity(x))?.id||uid()}));
        const added=next.filter(x=>!existing.has(identity(x))),changed=next.filter(x=>{const old=existing.get(identity(x));return old&&(old.price!==x.price||(old.quantity||1)!==x.quantity||(old.usedPrice??null)!==x.usedPrice);});
        const keys=new Set(next.map(identity));const removed=gearData.items.filter(x=>!keys.has(identity(x)));
        preview.replaceChildren(element('p','cm-metric','추가 '+added.length+'종 · 변경 '+changed.length+'종 · 제거 '+removed.length+'종'));
        for(const [title,arr] of [['추가',added],['변경',changed],['제거',removed]]) {const details=element('details');details.append(element('summary','',title+' '+arr.length+'종'));arr.forEach(x=>details.append(element('p','',x.category+' · '+x.manufacturer+' · '+x.name+' · '+x.quantity+'개 · '+money(x.price))));preview.append(details);}
        const check=field('기존 목록을 이 미리보기로 교체합니다.','checkbox');check.input.checked=false;preview.append(check.wrap);
        preview.append(button('이 목록으로 교체',()=>{
          if(!check.input.checked){showToast('교체 확인란을 선택해 주세요.');return;}if(!equal(previewBase,gearData.items)){showToast('장비 목록이 변경되었습니다. 미리보기를 다시 확인해 주세요.');return;}
          const undo=rememberGear('시트 교체 전');gearData.items=next;const ids=new Set(next.map(x=>x.id));Object.values(gearData.checklists).forEach(c=>Object.keys(c).forEach(id=>{if(!ids.has(id))delete c[id];}));
          saveGearData(gearData);d.close();renderGearView();showToast(next.length+'종으로 교체했습니다.',undo);
        }));
      }catch(e){showToast(e.message);}
    }));
  });
}
function showBackups() {
  dialog('백업 · 복원',d=>{
    d.append(button('전체 데이터 백업 다운로드',()=>downloadJSON('camping-backup-'+nowDate()+'.json',{format:'campmap-v2',at:new Date().toISOString(),state:collect()})));
    const file=field('백업 파일에서 복원','file');file.input.accept='.json,application/json';d.append(file.wrap);
    file.input.onchange=async()=>{try{const f=file.input.files[0];if(!f||f.size>1500000)throw Error('백업 파일 크기를 확인해 주세요.');const parsed=JSON.parse(await f.text());if(parsed.format!=='campmap-v2'||!Array.isArray(parsed.state?.gear?.items)||!parsed.state.records)throw Error('캠핑앱 백업 파일이 아닙니다.');confirmRestore(d,normalizeState(parsed.state),'파일 백업');}catch(e){showToast(e.message);}};
    const local=section('이 기기의 장비 복원본');readLocal('campmap_gear_undo_v2',[]).forEach(s=>local.append(button(new Date(s.at).toLocaleString('ko-KR')+' · '+s.label,()=>{if(!confirm('장비를 이 복원본으로 되돌릴까요? 현재 목록도 복원본으로 남깁니다.'))return;rememberGear('장비 복원 전');gearData=clone(s.gear);saveGearData(gearData);d.close();renderGearView();})));d.append(local);
    d.append(button('서버 복원본 불러오기',async()=>{
      try{const {r,data}=await requestJSON('/api/sync?action=backups');if(!r.ok)throw Error();const list=section('서버 복원본 (최대 20개)');if(!data.backups.length)list.append(empty('첫 저장 이후 자동 복원본이 만들어집니다.'));data.backups.forEach(s=>list.append(button(new Date(s.at).toLocaleString('ko-KR')+' · '+s.label,()=>confirmRestore(d,normalizeState(s.state),s.label))));d.append(list);}catch{showToast('서버 복원본을 불러오지 못했습니다.');}
    }));
  });
}
function confirmRestore(parent,state,label) {
  dialog('복원 내용 확인',d=>{
    d.append(empty(label+' · 장비 '+state.gear.items.length+'종 · 지난 기록 '+state.records.history.length+'건. 전체 데이터를 이 시점으로 되돌립니다.'));
    d.append(button('전체 데이터 복원',()=>{if(!confirm('전체 데이터를 선택한 복원본으로 교체할까요? 현재 데이터도 백업합니다.'))return;downloadJSON('camping-before-restore.json',{format:'campmap-v2',state:collect()});markBackup('전체 복원 전');installState(state);debouncedSync();d.close();parent.close();refreshAll();}));
  });
}

let selectedPrepTrip='';
const prepPanel=element('div','app-view');prepPanel.id='view-prep';
const favPanel=element('div','app-view');favPanel.id='view-favorites';
for(const [id,title,icon,panel] of [['prep','캠핑 준비','🧳',prepPanel],['favorites','즐겨찾기','⭐',favPanel]]){
  const head=element('div','view-header');head.append(element('h2','',icon+' '+title),button('✕',()=>switchView('map'),'view-close-btn'));
  panel.append(head,element('div','view-body'));document.body.append(panel);
  const b=button('',()=>switchView(id),'sidebar-btn');b.id='sidebar-btn-'+id;b.innerHTML='<span class="sidebar-icon">'+icon+'</span><span>'+title+'</span>';$('#sidebar').append(b);
}
const originalSwitch=switchView;
switchView=function(view){
  for(const id of ['prep','favorites']){$('#view-'+id).classList.remove('active');$('#sidebar-btn-'+id).classList.remove('active');}
  if(!['prep','favorites'].includes(view)){originalSwitch(view);return;}
  originalSwitch('gear');$$('.app-view').forEach(p=>p.classList.remove('active'));$$('.sidebar-btn').forEach(b=>b.classList.remove('active'));
  $('#view-'+view).classList.add('active');$('#sidebar-btn-'+view).classList.add('active');
  if(view==='prep')renderPrep();else renderFavorites();
};
function allTrips(){return [...recordsData.upcoming,...recordsData.history].sort((a,b)=>(b.startDate||'').localeCompare(a.startDate||''));}
function tripPrep(id,create=false){
  if(!extra.trips[id]&&create)extra.trips[id]={gear:{},shopping:[]};
  return extra.trips[id]||{gear:{},shopping:[]};
}
function showPresets(){
  dialog('장비 구성 프리셋',d=>{
    d.append(empty('사용할 장비와 수량을 묶어 두세요. 일정에 적용해도 보유 수량은 바뀌지 않습니다.'));
    const list=element('div');d.append(list);
    const render=()=>{list.replaceChildren();if(!extra.presets.length)list.append(empty('저장된 프리셋이 없습니다. 아틀라스 구성·스프링바 구성·동계 구성 등을 만들어 보세요.'));
      extra.presets.forEach(p=>{const row=element('div','cm-section');row.append(element('strong','',p.name+' · '+Object.keys(p.entries).length+'종'),button('수정',()=>editPreset(p,render)),button('삭제',()=>{const previous=clone(extra.presets);extra.presets=extra.presets.filter(x=>x.id!==p.id);persistExtra();render();showToast('프리셋 삭제됨',()=>{extra.presets=previous;persistExtra();render();});}));list.append(row);});};
    d.append(button('새 프리셋 만들기',()=>editPreset(null,render)));render();
  });
}
function gearPicker(title,entries,onSave,{name=null}={}){
  dialog(title,d=>{
    let nameField;if(name!==null){nameField=field('구성 이름','text',name);d.append(nameField.wrap);}
    const search=field('장비 찾기','search');d.append(search.wrap,empty('가져갈 수량을 입력하세요. 0은 제외하며 보유 수량을 초과할 수 없습니다.'));
    const chosen={...entries};const list=element('div','cm-picker');d.append(list);
    function render(){list.replaceChildren();const q=search.input.value.toLowerCase();gearData.items.filter(x=>(x.name+' '+x.manufacturer+' '+x.category).toLowerCase().includes(q)).forEach(item=>{
      const row=element('label','cm-pick-row');row.append(element('span','',item.manufacturer+' '+item.name+' · 보유 '+(item.quantity||1)));
      const n=element('input');n.type='number';n.min=0;n.max=item.quantity||1;n.step=1;n.value=chosen[item.id]||0;n.setAttribute('aria-label',item.name+' 가져갈 수량');
      n.oninput=()=>{const v=Number(n.value);if(!Number.isInteger(v)||v<0||v>(item.quantity||1)){n.value=chosen[item.id]||0;showToast('보유 수량 이내의 정수를 입력해 주세요.');return;}if(v)chosen[item.id]=v;else delete chosen[item.id];};row.append(n);list.append(row);
    });}
    search.input.oninput=render;render();
    d.append(button('구성 저장',()=>{if(nameField&&!nameField.input.value.trim()){showToast('구성 이름을 입력해 주세요.');return;}for(const [id,q]of Object.entries(chosen)){const item=gearData.items.find(x=>x.id===id);if(!item||q>(item.quantity||1)){showToast('삭제되었거나 수량이 줄어든 장비를 다시 확인해 주세요.');return;}}onSave(chosen,nameField?.input.value.trim());d.close();}));
  });
}
function editPreset(p,after){
  gearPicker(p?'프리셋 수정':'새 프리셋',p?.entries||{},(entries,name)=>{
    if(p){const target=extra.presets.find(x=>x.id===p.id);if(target)Object.assign(target,{entries,name});}
    else extra.presets.push({id:uid(),name,entries});
    persistExtra();after?.();},{name:p?.name||''});
}
function applyPreset(tripId){
  dialog('프리셋 적용',d=>{
    if(!extra.presets.length)d.append(empty('장비 프리셋을 먼저 만들어 주세요.'),button('프리셋 관리',()=>{d.close();showPresets();}));
    extra.presets.forEach(p=>d.append(button(p.name+' 적용',()=>{
      const old=tripPrep(tripId).gear;
      if(Object.keys(old).length&&!confirm('이번 일정의 장비 구성을 선택한 프리셋으로 교체할까요?'))return;
      const next={};let adjusted=0;for(const[id,q]of Object.entries(p.entries)){const g=gearData.items.find(x=>x.id===id);if(!g){adjusted++;continue;}const quantity=Math.min(q,g.quantity||1);if(quantity!==q)adjusted++;next[id]={quantity,packed:old[id]?.quantity===quantity&&!!old[id]?.packed};}
      tripPrep(tripId,true).gear=next;persistExtra();d.close();renderPrep();if(adjusted)showToast('삭제된 장비와 보유 수량 변경을 반영했습니다.');
    })));
  });
}
function renderPrep(){
  const root=$('.view-body',prepPanel);root.replaceChildren();
  const trips=allTrips();const upcoming=[...recordsData.upcoming].sort((a,b)=>(a.startDate||'').localeCompare(b.startDate||''));
  if(!trips.some(t=>t.id===selectedPrepTrip))selectedPrepTrip=upcoming[0]?.id||trips[0]?.id||'';
  const select=element('select');select.setAttribute('aria-label','준비할 캠핑 일정');
  trips.forEach(t=>select.append(new Option((recordsData.upcoming.some(x=>x.id===t.id)?'예정 · ':'지난 · ')+(t.title||t.campName)+' · '+(t.startDate||'날짜 미정'),t.id)));
  select.value=selectedPrepTrip;select.onchange=()=>{selectedPrepTrip=select.value;renderPrep();};
  root.append(select);if(!trips.length){root.append(empty('캠핑 일정을 먼저 추가해 주세요.'),button('일정 추가',()=>switchView('records')));return;}
  const trip=trips.find(t=>t.id===selectedPrepTrip),prep=tripPrep(trip.id);
  const hero=section(trip.title||trip.campName);hero.append(element('p','',recordDateRangeLabel(trip)));
  const gearEntries=Object.entries(prep.gear||{}),packed=gearEntries.filter(([,v])=>v.packed).length;
  const needs=(prep.shopping||[]).filter(x=>!x.owned),bought=needs.filter(x=>x.bought).length;
  hero.append(element('p','cm-metric','장비 '+packed+'/'+gearEntries.length+'종 준비 · 장보기 '+bought+'/'+needs.length+'건 완료'));
  const weather=element('div','cm-weather');hero.append(weather);loadPrepWeather(trip,weather);root.append(hero);
  const gear=section('이번 캠핑에 가져갈 장비');gear.append(button('장비 · 가져갈 수량 선택',()=>{
    const quantities=Object.fromEntries(gearEntries.map(([id,v])=>[id,v.quantity]));
    gearPicker('이번 일정 장비 선택',quantities,entries=>{const next={};for(const[id,quantity]of Object.entries(entries))next[id]={quantity,packed:prep.gear[id]?.quantity===quantity&&!!prep.gear[id]?.packed};tripPrep(trip.id,true).gear=next;persistExtra();renderPrep();});
  }),button('프리셋 적용',()=>applyPreset(trip.id)),button('프리셋 관리',showPresets));
  if(!gearEntries.length)gear.append(empty('필요한 장비만 선택하세요. 보유 목록은 그대로 유지됩니다.'));
  for(const[id,entry]of gearEntries){const item=gearData.items.find(x=>x.id===id);
    const row=element('div','cm-check-row'),label=element('label');const check=element('input');check.type='checkbox';check.checked=!!entry.packed;check.disabled=!item;
    check.onchange=()=>{tripPrep(trip.id,true).gear[id].packed=check.checked;persistExtra();renderPrep();};
    label.append(check,document.createTextNode((item?item.name:'삭제된 장비')+' × '+entry.quantity));
    row.append(label);if(!item||entry.quantity>(item.quantity||1))row.append(element('span','cm-warning',item?'보유 수량 확인':'목록에서 제거 필요'));
    row.append(button('빼기',()=>{delete tripPrep(trip.id,true).gear[id];persistExtra();renderPrep();}));gear.append(row);
  }
  root.append(gear);
  const meals=section('식단');const days=foodData.trips[trip.id]?.days||{};let mealCount=0;
  for(const[date,day]of Object.entries(days))for(const meal of FOOD_MEALS){const entry=day[meal.key];if(!entry||entry.included===false)continue;for(const item of entry.items||[]){mealCount++;meals.append(element('p','',date.slice(5)+' '+meal.label+' · '+item.name));}}
  if(!mealCount)meals.append(empty('등록된 메뉴가 없습니다.'));
  meals.append(button('식단 보기 · 편집',()=>{switchView('food');activeFoodTripId=trip.id;renderFoodView();const select=$('#food-trip-select');if(select){select.value=trip.id;onFoodTripChange();}}),button('메뉴별 재료 관리',showRecipes));
  root.append(meals);root.append(renderShopping(trip));
  const note=section('캠핑장 메모');note.append(element('p','',trip.note||'일정에 저장된 메모가 없습니다.'),button('즐겨찾기에 저장 · 메모',()=>editFavorite({name:trip.title||trip.campName,address:trip.note||'',lat:trip.lat,lng:trip.lng})));root.append(note);
}
const forecastOriginal=fetchTripForecast;
fetchTripForecast=async function(lat,lng,start,end){
  const key=[lat,lng,start,end].join('|'),cache=readLocal('campmap_trip_weather_v2',{});
  if(cache[key]&&Date.now()-cache[key].at<30*60*1000)return cache[key].days;
  try{const days=await forecastOriginal(lat,lng,start,end);cache[key]={days,at:Date.now()};const keys=Object.keys(cache);while(keys.length>20)delete cache[keys.shift()];writeLocal('campmap_trip_weather_v2',cache);return days;}
  catch(e){if(cache[key])return cache[key].days;throw e;}
};
async function loadPrepWeather(trip,node){
  if(!trip.lat||!trip.lng||!trip.startDate){node.append(empty('예보를 보려면 캠핑장을 검색해 선택하고 날짜를 지정해 주세요.'));return;}
  node.textContent='날씨 확인 중…';
  try{
    const days=await fetchTripForecast(trip.lat,trip.lng,trip.startDate,trip.endDate||trip.startDate);if(!node.isConnected)return;
    node.replaceChildren();if(!days.length){node.append(empty('아직 이 기간의 예보가 제공되지 않습니다.'));return;}
    days.forEach(d=>node.append(element('p','',d.date.slice(5)+' '+(WEATHER_CODE_MAP[d.weatherCode]||'날씨')+' '+d.tempMin+'~'+d.tempMax+'°C · 강수 '+(d.precipitationProbability??'?')+'%')));
    const cache=readLocal('campmap_trip_weather_v2',{});const saved=cache[[trip.lat,trip.lng,trip.startDate,trip.endDate||trip.startDate].join('|')];
    if(saved)node.append(empty('예보 확인: '+new Date(saved.at).toLocaleString('ko-KR')+(navigator.onLine?'':' · 저장된 예보')));
  }catch{if(node.isConnected)node.textContent='예보를 불러오지 못했습니다. 연결 후 다시 확인해 주세요.';}
}
function parseIngredients(text){
  const rows=text.split('\n').map(x=>x.trim()).filter(Boolean).map((line,i)=>{const[name,q,unit]=line.split('|').map(x=>x.trim());const quantity=Number(q||1);if(!name||!Number.isFinite(quantity)||quantity<=0)throw Error(String(i+1)+'번째 재료의 수량을 확인해 주세요.');return {name,quantity,unit:unit||'개'};});
  if(!rows.length)throw Error('재료를 입력해 주세요.');return rows;
}
function showRecipes(){
  dialog('메뉴별 재료 관리',d=>{
    d.append(empty('식단과 같은 메뉴명으로 저장하면 장보기 생성 시 재료를 합칩니다. 재료가 없는 메뉴는 메뉴 자체를 구매 항목으로 넣습니다.'));
    const list=element('div');d.append(list);
    const render=()=>{list.replaceChildren();extra.recipes.forEach(r=>{const card=element('div','cm-section');card.append(element('strong','',r.name),empty(r.ingredients.map(x=>x.name+' '+x.quantity+x.unit).join(', ')),button('수정',()=>editRecipe(r,render)),button('삭제',()=>{const snapshot=clone(extra.recipes);extra.recipes=extra.recipes.filter(x=>x.id!==r.id);persistExtra();render();showToast('재료 구성 삭제됨',()=>{extra.recipes=snapshot;persistExtra();render();});}));list.append(card);});};
    d.append(button('메뉴 재료 추가',()=>editRecipe(null,render)));render();
  });
}
function editRecipe(recipe,after){
  dialog('메뉴 재료 편집',d=>{
    const name=field('메뉴명 (식단과 동일하게)','text',recipe?.name||'');const ingredients=field('한 줄에 재료명 | 수량 | 단위','textarea',recipe?.ingredients.map(x=>[x.name,x.quantity,x.unit].join(' | ')).join('\n')||'');
    ingredients.input.placeholder='목살 | 600 | g\n양파 | 1 | 개';ingredients.input.rows=6;d.append(name.wrap,ingredients.wrap);
    d.append(button('재료 저장',()=>{try{const n=name.input.value.trim();if(!n)throw Error('메뉴명을 입력해 주세요.');if(extra.recipes.some(x=>x.id!==recipe?.id&&x.name===n))throw Error('같은 메뉴명이 있습니다. 기존 메뉴를 수정해 주세요.');const values=parseIngredients(ingredients.input.value);
      if(recipe){const r=extra.recipes.find(x=>x.id===recipe.id);if(r)Object.assign(r,{name:n,ingredients:values});}else extra.recipes.push({id:uid(),name:n,ingredients:values});persistExtra();d.close();after();}catch(e){showToast(e.message);}}));
  });
}
function generateShopping(trip){
  const p=tripPrep(trip.id,true),generated=new Map(),days=foodData.trips[trip.id]?.days||{};
  const add=(ingredient,source)=>{const key=JSON.stringify([ingredient.name,ingredient.unit]);let item=generated.get(key);if(!item){item={id:uid(),...ingredient,quantity:0,owned:false,bought:false,generated:true,sources:[]};generated.set(key,item);}item.quantity+=ingredient.quantity;item.sources.push(source);};
  for(const[date,day]of Object.entries(days))for(const meal of FOOD_MEALS){const entry=day[meal.key];if(!entry||entry.included===false)continue;for(const item of entry.items||[]){const recipe=extra.recipes.find(x=>x.name===item.name);const ingredients=recipe?.ingredients||[{name:item.name,quantity:1,unit:'개'}];ingredients.forEach(i=>add(i,date.slice(5)+' '+meal.label+' '+item.name));}}
  const old=new Map((p.shopping||[]).filter(x=>x.generated).map(x=>[JSON.stringify([x.name,x.unit]),x]));
  const next=[...generated.entries()].map(([key,x])=>{const previous=old.get(key);return {...x,id:previous?.id||x.id,owned:!!previous?.owned,bought:previous?.quantity===x.quantity&&!!previous?.bought};});
  const count=next.length;p.shopping=[...(p.shopping||[]).filter(x=>!x.generated),...next];persistExtra();renderPrep();showToast(count+'개 구매 항목을 식단에서 생성했습니다. 같은 재료·단위는 합산했습니다.');
}
function renderShopping(trip){
  const p=tripPrep(trip.id),s=section('장보기');s.append(button('식단에서 장보기 생성 · 갱신',()=>generateShopping(trip)),button('구매 항목 직접 추가',()=>dialog('구매 항목 추가',d=>{
    const name=field('구매할 항목'),q=field('수량','number',1),unit=field('단위','text','개');q.input.min='0.001';q.input.step='any';d.append(name.wrap,q.wrap,unit.wrap);
    d.append(button('추가',()=>{if(!name.input.value.trim()||!Number.isFinite(Number(q.input.value))||Number(q.input.value)<=0){showToast('항목과 수량을 확인해 주세요.');return;}tripPrep(trip.id,true).shopping.push({id:uid(),name:name.input.value.trim(),quantity:Number(q.input.value),unit:unit.input.value.trim(),owned:false,bought:false,generated:false});persistExtra();d.close();renderPrep();}));
  })));
  if(!p.shopping?.length)s.append(empty('식단을 정한 뒤 생성하거나 직접 추가하세요.'));
  for(const item of p.shopping||[]){
    const row=element('div','cm-section');row.append(element('strong','',item.name+' · '+Number(item.quantity.toFixed(3))+(item.unit||'')));
    if(item.sources?.length)row.append(empty(item.sources.join(' / ')));
    for(const[key,label]of [['owned','이미 보유'],['bought','구매 완료']]){const f=field(label,'checkbox');f.input.checked=!!item[key];f.input.onchange=()=>{const target=tripPrep(trip.id,true).shopping.find(x=>x.id===item.id);if(target)target[key]=f.input.checked;persistExtra();renderPrep();};row.append(f.wrap);}
    row.append(button('제거',()=>{const list=tripPrep(trip.id,true).shopping;const old=clone(list);tripPrep(trip.id,true).shopping=list.filter(x=>x.id!==item.id);persistExtra();renderPrep();showToast('구매 항목 제거됨',()=>{tripPrep(trip.id,true).shopping=old;persistExtra();renderPrep();});}));s.append(row);
  }return s;
}
function findFavorite(camp){return extra.favorites.find(x=>x.name===camp.name&&x.address===(camp.address||''));}
function editFavorite(camp){
  const existing=findFavorite(camp);dialog(existing?'캠핑장 메모 수정':'즐겨찾기 저장',d=>{
    const specs=[['name','캠핑장 이름',existing?.name||camp.name],['address','주소',existing?.address||camp.address],['preferredSite','선호 사이트',existing?.preferredSite],['shade','그늘',existing?.shade],['ground','바닥 상태',existing?.ground],['parking','주차 위치 · 진입 메모',existing?.parking],['revisit','재방문 의사',existing?.revisit],['note','기타 메모',existing?.note]];
    const fields=specs.map(([key,label,value])=>({key,...field(label,key==='note'?'textarea':'text',value||'')}));fields.forEach(f=>d.append(f.wrap));
    d.append(button('저장',()=>{const values=Object.fromEntries(fields.map(f=>[f.key,f.input.value.trim()]));if(!values.name){showToast('캠핑장 이름을 입력해 주세요.');return;}if(existing){const target=extra.favorites.find(x=>x.id===existing.id);if(target)Object.assign(target,values);}else extra.favorites.push({id:uid(),...values,lat:camp.lat||null,lng:camp.lng||null,site:pickSiteUrl(camp)||''});persistExtra();d.close();if($('#view-favorites.active'))renderFavorites();showToast('캠핑장 메모를 저장했습니다.');}));
  });
}
function renderFavorites(){
  const root=$('.view-body',favPanel);root.replaceChildren();root.append(button('캠핑장 직접 추가',()=>editFavorite({name:'',address:''})));
  if(!extra.favorites.length)root.append(empty('지도에서 캠핑장을 선택해 즐겨찾기에 저장해 보세요.'));
  for(const camp of extra.favorites){
    const card=section(camp.name);for(const [key,label]of [['address','주소'],['preferredSite','선호 사이트'],['shade','그늘'],['ground','바닥'],['parking','주차'],['revisit','재방문'],['note','메모']])if(camp[key])card.append(element('p','',label+' · '+camp[key]));
    card.append(button('메모 수정',()=>editFavorite(camp)),button('일정 추가',()=>openScheduleFormForCamp(camp)));
    if(camp.lat&&camp.lng)card.append(button('지도에서 보기',()=>{switchView('map');if(map&&typeof naver!=='undefined'){map.setCenter(new naver.maps.LatLng(camp.lat,camp.lng));map.setZoom(15);openSheet(camp);}}));
    card.append(button('즐겨찾기 제거',()=>{const prev=clone(extra.favorites);extra.favorites=extra.favorites.filter(x=>x.id!==camp.id);persistExtra();renderFavorites();showToast('즐겨찾기 제거됨',()=>{extra.favorites=prev;persistExtra();renderFavorites();});}));root.append(card);
  }
}
const originalOpenSheet=openSheet;
openSheet=function(item){originalOpenSheet(item);const b=button(findFavorite(item)?'⭐ 캠핑장 메모 보기 · 수정':'☆ 즐겨찾기 · 메모 저장',()=>editFavorite(item),'reserve-btn secondary');$('#reserve-btn-row').append(b);};
const oldRenderRecords=renderRecordsView;
renderRecordsView=function(){
  oldRenderRecords();
  const sorted=[...recordsData.upcoming].sort((a,b)=>(a.startDate||'').localeCompare(b.startDate||''));
  $$('#upcoming-list .record-card').forEach((card,i)=>{const t=sorted[i];if(t)card.append(button('🧳 이 일정 준비하기',()=>{selectedPrepTrip=t.id;switchView('prep');}));});
};

const markerPool=new Map();
function markerKey(item){return String(item.source||'official')+':'+String(item.id||[item.name,item.lat,item.lng].join('|'));}
function reconcileMarkers(items,icon,type){
  const keep=new Set(items.map(markerKey));
  for(const[key,entry]of markerPool)if(entry.type===type&&!keep.has(key)){naver.maps.Event.clearInstanceListeners(entry.marker);entry.marker.setMap(null);markerPool.delete(key);}
  for(const item of items){
    const key=markerKey(item);let entry=markerPool.get(key);
    if(entry){if(entry.data.lat!==item.lat||entry.data.lng!==item.lng)entry.marker.setPosition(new naver.maps.LatLng(item.lat,item.lng));entry.data=item;entry.marker.setIcon(icon);}
    else{entry={marker:new naver.maps.Marker({position:new naver.maps.LatLng(item.lat,item.lng),map,icon}),data:item,type};naver.maps.Event.addListener(entry.marker,'click',()=>{hideResults();openSheet(entry.data);});markerPool.set(key,entry);}
  }
  currentMarkers=[...markerPool.values()];
}
renderCamps=function(items){reconcileMarkers(filterGlamping(items),GREEN_ICON,'official');};
addMarkers=function(items,icon){reconcileMarkers(items,icon,icon===ORANGE_ICON?'naver':'official');};
let manualSearch=readLocal('campmap_manual_search_v2',false),forcedSearch=false,hasSearched=false;
const mapSearch=button('이 지역 검색',()=>{forcedSearch=true;fetchCampsInView();},'cm-map-search');mapSearch.id='cm-map-search';
const modeLabel=element('label','cm-map-mode');const modeCheck=element('input');modeCheck.type='checkbox';modeCheck.checked=manualSearch;modeCheck.onchange=()=>{manualSearch=modeCheck.checked;writeLocal('campmap_manual_search_v2',manualSearch);};modeLabel.append(modeCheck,document.createTextNode('지도 이동 후 직접 검색'));document.body.append(mapSearch,modeLabel);
const baseSwitch=switchView;
switchView=function(view){baseSwitch(view);mapSearch.hidden=modeLabel.hidden=view!=='map';};
fetchCampsInView=async function(){
  if(!map)return;
  if(manualSearch&&hasSearched&&!forcedSearch){mapSearch.textContent='이 지역 검색';return;}
  forcedSearch=false;hasSearched=true;
  currentFetchController?.abort();currentFetchController=new AbortController();const signal=currentFetchController.signal;
  const center=map.getCenter(),lat=center.lat(),lng=center.lng(),idealRadius=calcViewRadiusMeters(),radius=Math.min(idealRadius,GRID_TILE_RADIUS_M),grid=idealRadius>GRID_TILE_RADIUS_M;
  showStatus('주변 캠핑장 불러오는 중…');mapSearch.textContent='검색 중…';
  let failed=0;
  try{
    let camps=[],points=null;
    if(grid){
      points=buildSearchGrid(map.getBounds());const merged=new Map();let cursor=0;
      async function worker(){
        while(cursor<points.length){const p=points[cursor++];
          try{const data=await fetchCampsData(p.lat,p.lng,GRID_TILE_RADIUS_M,signal);if(signal.aborted)return;(data.camps||[]).forEach(c=>merged.set(c.id,c));renderCamps([...merged.values()]);showStatus('검색 중 · '+merged.size+'곳 표시');}
          catch(e){if(e.name==='AbortError')throw e;failed++;}
        }
      }
      await Promise.all(Array.from({length:Math.min(3,points.length)},worker));camps=[...merged.values()];
    }else{const data=await fetchCampsData(lat,lng,radius,signal);camps=data.camps||[];}
    if(signal.aborted)return;
    renderCamps(camps);if(grid)updateSearchGridCircles(points,GRID_TILE_RADIUS_M);else updateSearchRadiusCircle(lat,lng,radius);
    const visible=filterGlamping(camps);showStatus('캠핑장 '+visible.length+'곳 표시'+(failed?' · '+failed+'개 구역 검색 실패 · 다시 검색 가능':''),!!failed,failed?6000:2000);
    const extraCamps=await fetchNaverSupplementaryCamps(camps,lat,lng,signal);if(!signal.aborted)addMarkers(filterGlamping(extraCamps),ORANGE_ICON);
  }catch(e){if(e.name!=='AbortError')showStatus(e.message||'캠핑장을 불러오지 못했습니다.',true);}
  finally{if(!signal.aborted)mapSearch.textContent='이 지역 검색';}
};
const originalForecastCard=loadTripWeatherIntoCard;
// Existing checklist UI remains available; remove references to deleted gear and avoid HTML interpolation.
renderChecklistDetail=function(){
  activeChecklistName=$('#checklist-select').value||null;
  const progress=$('#checklist-progress'),list=$('#checklist-item-list');list.replaceChildren();
  const checklist=gearData.checklists[activeChecklistName];
  if(!checklist){progress.textContent='';return;}
  const items=gearData.items.filter(x=>Object.hasOwn(checklist,x.id));
  progress.textContent=items.filter(x=>checklist[x.id]).length+' / '+items.length+' 준비완료';
  items.forEach(item=>{const row=element('label','cm-check-row');const check=element('input');check.type='checkbox';check.checked=!!checklist[item.id];check.onchange=()=>{checklist[item.id]=check.checked;saveGearData(gearData);renderChecklistDetail();};row.append(check,document.createTextNode(item.name+' × '+(item.quantity||1)));list.append(row);});
};
let mapInitialized=false;
window.cmMapReady=function(){
  if(mapInitialized||typeof naver==='undefined'||!naver.maps)return;
  mapInitialized=true;initMap();
};
window.cmMapReady();
initialSync();
if(!navigator.onLine)switchView('prep');
const offlineHint=element('p','cm-muted','장비·일정·준비 목록은 이 기기에 보관됩니다. 지도와 새 검색은 인터넷 연결이 필요합니다.');
$('.view-body',prepPanel).append(offlineHint);
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(()=>{document.documentElement.dataset.offlineReady='true';}).catch(()=>{console.warn('오프라인 화면 준비에 실패했습니다.');});
}
