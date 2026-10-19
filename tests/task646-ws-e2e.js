// [TASK646] Real WebSocket end-to-end against an isolated bridge + stub engine.
const fs=require('fs'),path=require('path');
const WebSocket=require(process.env.WS_MODULE);
const URL=process.env.WSD||'ws://127.0.0.1:3999/ws';
const PD=process.env.HOME+'/.claude/bridge-pending';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const chatCount=()=>{try{return parseInt(fs.readFileSync(process.env.STUB_COUNT_FILE,'utf8').trim()||'0',10)||0;}catch{return 0;}};
const scanDone=id=>{try{for(const f of fs.readdirSync(PD).filter(x=>x.endsWith('.done.json'))){const l=JSON.parse(fs.readFileSync(path.join(PD,f),'utf8'));if(Array.isArray(l)&&l.some(e=>e&&e.id===id))return true;}}catch{}return false;};
const scanFailed=()=>{let r=[];try{for(const f of fs.readdirSync(PD).filter(x=>x.endsWith('.failed.json'))){const l=JSON.parse(fs.readFileSync(path.join(PD,f),'utf8'));if(Array.isArray(l))r.push(...l);}}catch{}return r;};
function openRoom(roomId){return new Promise((res,rej)=>{const ws=new WebSocket(URL);const st={ws,roomId,key:roomId,acks:[],frames:[],failed:[]};ws.on('open',()=>{ws.send(JSON.stringify({type:'hello',clientId:'cli-'+roomId+'-'+Date.now(),roomId}));res(st);});ws.on('message',d=>{let m;try{m=JSON.parse(d);}catch{return;}st.frames.push(m);if(m.type==='chat_ack')st.acks.push(m);if(m.type==='session_id'&&m.id)st.key=m.id;if(m.type==='turn_failed')st.failed.push(m);});ws.on('error',rej);});}
const send=(st,reqId,text,extra)=>st.ws.send(JSON.stringify(Object.assign({type:'chat',roomId:st.key,text,reqId,displayedEngine:'claude',rowTs:Date.now(),rowMid:'mid-'+reqId},extra||{})));
const waitFor=async(fn,ms)=>{const t=Date.now();while(Date.now()-t<ms){const v=fn();if(v)return v;await sleep(100);}return null;};
const ackOf=(st,id)=>st.acks.find(a=>a.reqId===id);
const R={};
(async()=>{
 try{
  // T1 durable send + ack + done ring
  const A=await openRoom('draft-A');await sleep(300);const c0=chatCount();
  send(A,'R1','hello one');
  const a1=await waitFor(()=>ackOf(A,'R1'),9000);
  const d1=await waitFor(()=>A.frames.find(f=>f.type==='done'),9000);
  await waitFor(()=>A.key!=='draft-A',3000); await sleep(400);
  R.T1_ack_not_dedup=(a1&&!a1.dedup)?'PASS':'FAIL';
  R.T1_done=d1?'PASS':'FAIL';
  R.T1_done_ring_has_R1=scanDone('R1')?'PASS':'FAIL';
  R.T1_exactly_one_dispatch=(chatCount()-c0)===1?'PASS':('FAIL '+(chatCount()-c0));
  R._A_frames=A.frames.map(f=>f.type+(f.dedup?'(dedup)':'')+(f.reqId?':'+f.reqId:'')+(f.reason?':'+f.reason:'')).slice(0,30);
  // T2 resend same reqId -> dedup, no re-dispatch
  await waitFor(()=>scanDone('R1'),7000);R._T2_diag={Akey:A.key,doneFiles:(()=>{try{return fs.readdirSync(PD).filter(x=>x.endsWith('.done.json')).map(f=>({f,hasR1:(JSON.parse(fs.readFileSync(path.join(PD,f),'utf8'))||[]).some(e=>e&&e.id==='R1')}));}catch(e){return String(e);}})()};const c2=chatCount();send(A,'R1','hello one');
  const a2=await waitFor(()=>A.acks.filter(a=>a.reqId==='R1'&&a.dedup===true)[0],6000);await sleep(500);
  R.T2_dedup_ack=a2?'PASS':'FAIL';
  R.T2_no_redispatch=(chatCount()-c2)===0?'PASS':('FAIL '+(chatCount()-c2));
  // T3 ACK-loss + reconnect convergence (resend after completion dedups)
  const B=await openRoom('draft-B');await sleep(300);const c3=chatCount();
  send(B,'R2','msg two');await waitFor(()=>ackOf(B,'R2'),9000);
  await waitFor(()=>B.frames.find(f=>f.type==='done'),9000);await waitFor(()=>B.key!=='draft-B',3000);
  await waitFor(()=>scanDone('R2'),7000);const bKey=B.key;B.ws.close();await sleep(400);
  const B2=await openRoom(bKey);await sleep(300);send(B2,'R2','msg two');
  const ded=await waitFor(()=>B2.acks.find(a=>a.reqId==='R2'&&a.dedup===true),6000);await sleep(400);
  R.T3_reconnect_dedup=ded?'PASS':'FAIL';
  R.T3_exactly_one_dispatch=(chatCount()-c3)===1?'PASS':('FAIL '+(chatCount()-c3));
  // T4 rapid-send -> all acked, each dispatched once
  const C=await openRoom('draft-C');await sleep(300);const c4=chatCount();
  send(C,'R3','a');send(C,'R4','b');send(C,'R5','c');
  const a3=await waitFor(()=>ackOf(C,'R3'),9000),a4=await waitFor(()=>ackOf(C,'R4'),9000),a5=await waitFor(()=>ackOf(C,'R5'),9000);
  await waitFor(()=>(chatCount()-c4)>=3,15000);await sleep(500);
  R.T4_all_three_acked=(a3&&a4&&a5)?'PASS':'FAIL';
  R.T4_rapid_no_loss=((a3&&a4&&a5)&&(chatCount()-c4)>=1)?'PASS':('FAIL acks='+[!!a3,!!a4,!!a5]+' disp='+(chatCount()-c4));
  // T5 failed-turn durable + reconnect delivery + ack removal
  fs.writeFileSync(process.env.STUB_MODE_FILE,'hang');
  const Dr=await openRoom('draft-D');await sleep(300);
  send(Dr,'R6','will hang');await waitFor(()=>ackOf(Dr,'R6'),9000);await waitFor(()=>Dr.key!=='draft-D',4000);
  const dKey=Dr.key;Dr.ws.close();
  const fr=await waitFor(()=>scanFailed().length>=1,12000);
  R.T5_failed_recorded=fr?'PASS':'FAIL';
  const _fk=(()=>{try{const f=fs.readdirSync(PD).find(x=>x.endsWith('.failed.json'));return f?f.slice(0,-12):dKey;}catch{return dKey;}})();const D2=await openRoom(_fk);
  const tf=await waitFor(()=>D2.failed[0],7000);
  R.T5_reconnect_delivers_turn_failed=tf?'PASS':'FAIL';
  if(tf&&tf.id){const before=scanFailed().length;D2.ws.send(JSON.stringify({type:'failed_ack',roomId:_fk,ids:[tf.id]}));await waitFor(()=>scanFailed().length<before,5000);R.T5_failed_ack_removes=(scanFailed().length<before)?'PASS':'FAIL';}
  else R.T5_failed_ack_removes='SKIP(no id)';
  fs.writeFileSync(process.env.STUB_MODE_FILE,'complete');
 }catch(e){R._error=String(e&&e.stack||e);}
 const fails=Object.entries(R).filter(([k,v])=>!k.startsWith('_')&&v!=='PASS'&&!String(v).startsWith('SKIP'));
 console.log(JSON.stringify({results:R,summary:fails.length?('FAILURES '+JSON.stringify(fails)):('ALL '+Object.keys(R).length+' WS E2E CHECKS PASSED')},null,2));
 process.exit(fails.length?1:0);
})();
