// [TASK646] Retained self-test — runs the EXACT deployed durable-send/replay source
// lines (sliced verbatim from bridge-server.js) in an isolated scope against a
// throwaway HOME. Tests A-F = logic; Test G = REAL reaper.sh-produced marker
// (passed via env REAL_MARKER) consumed by the REAL replayPending across a
// process boundary. Non-destructive: temp HOME only, no server, no ports.
const fs=require('fs'), path=require('path'), os=require('os');
const SRC='/var/www/castle-container/claude-code-bridge-standalone/bridge-server.js';
const src=fs.readFileSync(SRC,'utf8');
const A='const PENDING_DIR = path.join(process.env.HOME';
const B='// [TASK646] Forward-progress stall watchdog.';
const i=src.indexOf(A), j=src.indexOf(B);
if(i<0||j<0||j<i){console.error('anchor fail');process.exit(2);}
const slice=src.substring(i,j);
const staticGuards={
  hasSidecarGuard: slice.includes("!f.endsWith('.done.json') && !f.endsWith('.failed.json')"),
  hasDoneGuard: slice.includes("if (recordDone(j.key"),
  hasRetain: slice.includes('if (_cleared && _S)'),
};
const PD=path.join(process.env.HOME,'.claude','bridge-pending');
const clean=()=>{fs.rmSync(PD,{recursive:true,force:true});fs.mkdirSync(PD,{recursive:true});};
const REAL_MARKER=process.env.REAL_MARKER||'';
const driver=`
  let R={};
  const _ok=(n,c)=>{try{R[n]=c()?'PASS':'FAIL';}catch(e){R[n]='ERR:'+e.message;}};
  const exists=p=>{try{fs.statSync(p);return true;}catch{return false;}};
  const rd=p=>JSON.parse(fs.readFileSync(p,'utf8'));

  __clean();
  fs.writeFileSync(pendingFile('roomA'), JSON.stringify({key:'roomA',sessionId:'SESS-A',turns:['hello'],reqIds:['rA'],ts:Date.now()}));
  fs.writeFileSync(path.join(PENDING_DIR,'mk-a.reaped'), JSON.stringify({session:'SESS-A',room:'roomA',killTs:Date.now(),reason:'runaway-keeper'}));
  replayPending();
  _ok('A_journal_marked_failed',()=>exists(pendingFile('roomA'))&&rd(pendingFile('roomA')).status==='failed');
  _ok('A_failed_record_written',()=>{const l=rd(pendingFailedFile('roomA'));return l[0].items[0].text==='hello'&&l[0].reason.startsWith('reaped:');});
  _ok('A_marker_consumed',()=>!exists(path.join(PENDING_DIR,'mk-a.reaped')));
  _ok('A_not_respawned',()=>SPAWNED.length===0);

  __clean();
  fs.writeFileSync(pendingFile('roomB'), JSON.stringify({key:'roomB',turns:['x'],reqIds:['rB'],status:'done',doneReqIds:['rB']}));
  replayPending();
  _ok('B_journal_unlinked',()=>!exists(pendingFile('roomB')));
  _ok('B_done_ring_written',()=>{const l=rd(pendingDoneFile('roomB'));return l.some(e=>e.id==='rB');});
  _ok('B_not_respawned',()=>SPAWNED.length===0);

  __clean();
  fs.writeFileSync(pendingDoneFile('roomC'), JSON.stringify([{id:'rC',ts:Date.now()}]));
  fs.writeFileSync(pendingFailedFile('roomC'), JSON.stringify([{id:'f1',items:[{reqId:'rC2',text:'q'}],ts:Date.now()}]));
  replayPending();
  _ok('C_done_sidecar_survives',()=>exists(pendingDoneFile('roomC')));
  _ok('C_failed_sidecar_survives',()=>exists(pendingFailedFile('roomC')));

  __clean();
  recordDone('roomD',['r1']);
  _ok('D_known_reqId_deduped',()=>isReqDone('roomD','r1')===true);
  _ok('D_unknown_reqId_not',()=>isReqDone('roomD','nope')===false);

  __clean();
  recordFailed('roomE',{items:[{reqId:'a',text:'m1'},{reqId:'b',text:'m2'}],reason:'hang'});
  _ok('E_both_queued_turns_preserved',()=>{const l=rd(pendingFailedFile('roomE'));return l[0].items.length===2 && l[0].items[1].text==='m2';});
  const _id=rd(pendingFailedFile('roomE'))[0].id;
  ackFailed('roomE',[_id]);
  _ok('E_ack_removes_record',()=>!exists(pendingFailedFile('roomE')));

  _ok('F_orphan_ppid1_matches',()=>{const o=_findOrphanFor({sessionId:'SORPH'},[{pid:999,ppid:1,args:'claude --resume SORPH'}]);return o&&o.pid===999;});
  _ok('F_live_child_ppid_not1_ignored',()=>_findOrphanFor({sessionId:'SORPH'},[{pid:999,ppid:1234,args:'claude --resume SORPH'}])===null);

  // ---- Test G: REAL reaper-produced marker consumed by REAL replayPending (cross-process) ----
  if (__REAL_MARKER) {
    __clean();
    const mk=JSON.parse(fs.readFileSync(__REAL_MARKER,'utf8'));
    _ok('G_real_marker_schema',()=>mk.reaped===true && mk.session==='SELFTEST-REAPER-SESS' && mk.reason==='runaway-keeper' && Number.isFinite(+mk.killTs));
    fs.copyFileSync(__REAL_MARKER, path.join(PENDING_DIR,'real.reaped'));
    fs.writeFileSync(pendingFile('roomG'), JSON.stringify({key:'roomG',sessionId:'SELFTEST-REAPER-SESS',turns:['real producer path'],reqIds:['rG'],ts:Date.now()}));
    replayPending();
    _ok('G_real_marker_poisons_turn',()=>exists(pendingFile('roomG'))&&rd(pendingFile('roomG')).status==='failed'&&rd(pendingFile('roomG')).failReason.startsWith('reaped:'));
    _ok('G_real_marker_consumed',()=>!exists(path.join(PENDING_DIR,'real.reaped')));
    _ok('G_not_respawned',()=>SPAWNED.length===0);
  }
  return R;
`;
const SPAWNED=[];
const runner=new Function('fs','path','os','timerEnv','RESUME_TURNS','DURABLE_SEND','FAIL_TTL_MS','REAP_FRESH_MS','clientSessions','WebSocket','confExistsRunning','makeSession','restoreRoom','sessionFileExists','codexRolloutExists','_instrNormTurn','SPAWNED','__clean','__REAL_MARKER','console','require','process',
  slice+'\n'+driver);
const R=runner(fs,path,os,(n,d)=>d,true,true,10*60*1000,60*60*1000,new Map(),{OPEN:1},
  ()=>false,(k)=>({key:k,sockets:new Set(),_inflightReqIds:[],sendToEngine:(...a)=>SPAWNED.push(a)}),
  ()=>{},()=>false,()=>false,(t)=>({text:(typeof t==='string'?t:(t&&t.text))||'',meta:{}}),SPAWNED,clean,REAL_MARKER,console,require,process);
const out={ts:new Date().toISOString?undefined:null,staticGuards,results:R};
const fails=Object.entries(R).filter(([k,v])=>v!=='PASS');
out.summary=fails.length?('FAILURES: '+JSON.stringify(fails)):('ALL '+Object.keys(R).length+' TESTS PASSED');
console.log(JSON.stringify(out,null,2));
process.exit(fails.length?1:0);
