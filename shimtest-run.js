// Exercises the hardened shim: independence, shared cookies, no-clobber, and
// targetId robustness (externally close a room's tab, then reuse it).
const WebSocket = require('ws');
const SHIM = process.env.SHIM || 'http://127.0.0.1:8961';
const CDP  = process.env.CDP  || 'http://127.0.0.1:9241';

function parseSSE(t){ let o=null; for(const l of t.split('\n')){ const m=l.match(/^data: (.*)$/); if(m){ try{o=JSON.parse(m[1]);}catch{} } } return o; }
function mkRoom(room){
  let sid=null;
  const url=`${SHIM}/mcp/${room}`;
  async function post(body){
    const h={'Content-Type':'application/json','Accept':'application/json, text/event-stream'};
    if(sid) h['Mcp-Session-Id']=sid;
    const r=await fetch(url,{method:'POST',headers:h,body:JSON.stringify(body)});
    const s=r.headers.get('mcp-session-id'); if(s) sid=s;
    return parseSSE(await r.text());
  }
  return {
    async init(){ await post({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:room,version:'1'}}}); await post({jsonrpc:'2.0',method:'notifications/initialized'}); },
    call(name,args){ return post({jsonrpc:'2.0',id:Math.floor(Math.random()*1e6),method:'tools/call',params:{name,arguments:args||{}}}); },
  };
}
const txt=r=>((r&&r.result&&r.result.content)||[]).map(x=>x.text).join('\n');
// MCP browser_evaluate wraps the raw value in a "### Result\n<json>\n### Ran..." block.
const val=r=>{ const t=txt(r); const m=t.match(/### Result\n([\s\S]*?)\n### Ran/); const s=m?m[1]:t; try{return JSON.parse(s);}catch{return s.replace(/^"|"$/g,'');} };
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function currentUrl(room){ return val(await room.call('browser_evaluate',{function:'() => location.href'})); }

// Raw CDP: close the page target whose url matches (simulates human closing a tab).
async function cdpCloseByUrl(frag){
  const list=await (await fetch(`${CDP}/json/list`)).json();
  const t=list.find(x=>x.type==='page' && (x.url||'').includes(frag));
  if(!t) throw new Error('no target for '+frag);
  const ver=await (await fetch(`${CDP}/json/version`)).json();
  const ws=new WebSocket(ver.webSocketDebuggerUrl,{perMessageDeflate:false});
  await new Promise(r=>ws.on('open',r));
  await new Promise(r=>{ ws.on('message',d=>{ const m=JSON.parse(d); if(m.id===99) r(); }); ws.send(JSON.stringify({id:99,method:'Target.closeTarget',params:{targetId:t.id}})); });
  ws.close();
  return t.id;
}

(async()=>{
  const P=process.env.ROOM_PREFIX || ('r'+Date.now());
  const A=mkRoom(P+'A'), B=mkRoom(P+'B');
  console.log('rooms:', P+'A', P+'B');
  await A.init(); await B.init();

  await A.call('browser_navigate',{url:'https://example.com/'});
  await A.call('browser_evaluate',{function:'() => { document.cookie="shim_probe=fromA; path=/"; return document.cookie; }'});
  await B.call('browser_navigate',{url:'https://www.iana.org/'});

  const a1=await currentUrl(A), b1=await currentUrl(B);
  console.log('1) A url:', a1, '| B url:', b1);
  console.log('   independent:', a1.includes('example.com') && b1.includes('iana.org') ? 'PASS' : 'FAIL');

  // A keeps moving; B must stay put.
  await A.call('browser_navigate',{url:'https://example.com/?again'});
  const b2=await currentUrl(B);
  console.log('2) B after A moved:', b2, '->', b2.includes('iana.org') ? 'PASS (no clobber)' : 'FAIL');

  // Shared login: B reads a cookie A set on example.com (same browser context).
  await B.call('browser_navigate',{url:'https://example.com/'});
  const ck=val(await B.call('browser_evaluate',{function:'() => document.cookie'}));
  console.log('3) B reads cookie:', JSON.stringify(ck), '->', String(ck).includes('shim_probe=fromA') ? 'PASS (shared login)' : 'FAIL');

  // Robustness: externally close B's tab (CDP), then B reuses -> shim re-opens.
  await B.call('browser_navigate',{url:'https://example.net/'});   // unique marker
  await sleep(1500);
  const closed=await cdpCloseByUrl('example.net');
  console.log('4) externally closed B target', closed);
  await sleep(600);   // let shim observe targetDestroyed
  const r4=await B.call('browser_navigate',{url:'https://example.org/'});
  const b4=await currentUrl(B);
  const err = r4 && r4.error ? JSON.stringify(r4.error) : 'none';
  console.log('   B after re-open:', b4, '(err:',err,') ->', b4.includes('example.org') ? 'PASS (recovered)' : 'FAIL');

  // A still independent after all that.
  const a5=await currentUrl(A);
  console.log('5) A still:', a5, '->', a5.includes('example.com') ? 'PASS' : 'FAIL');

  // ---- browser_tabs scoping (fresh rooms, distinct markers) ----
  const S1=mkRoom(P+'S1'), S2=mkRoom(P+'S2');
  await S1.init(); await S2.init();
  await S1.call('browser_navigate',{url:'https://example.com/?S1'});
  await S2.call('browser_navigate',{url:'https://example.org/?S2'});
  const lines=t=>t.split('\n').filter(l=>/^- \d+:/.test(l));
  let l1=txt(await S1.call('browser_tabs',{action:'list'}));
  let l2=txt(await S2.call('browser_tabs',{action:'list'}));
  console.log('6) S1 list lines:', lines(l1).length, '| S2:', lines(l2).length,
    '->', (lines(l1).length===1 && lines(l2).length===1) ? 'PASS (each sees only own tab)' : 'FAIL');
  console.log('   S1 sees S2 tab?', l1.includes('?S2')?'LEAK -> FAIL':'no', '| S2 sees S1 tab?', l2.includes('?S1')?'LEAK -> FAIL':'no');

  // S1 opens a second tab of its own; S2 must still see only 1.
  await S1.call('browser_tabs',{action:'new'});
  await S1.call('browser_navigate',{url:'https://example.com/?S1b'});
  l1=txt(await S1.call('browser_tabs',{action:'list'}));
  l2=txt(await S2.call('browser_tabs',{action:'list'}));
  console.log('7) after S1 opens 2nd tab — S1 lines:', lines(l1).length, '(expect 2) | S2 lines:', lines(l2).length, '(expect 1) ->',
    (lines(l1).length===2 && lines(l2).length===1) ? 'PASS' : 'FAIL');

  // S1 tries to select an out-of-room index — must NOT jump to another room's tab.
  const badSel=await S1.call('browser_tabs',{action:'select',index:9});
  const s1url=await currentUrl(S1);
  console.log('8) S1 select index 9 ->', (badSel.result&&badSel.result.isError)||JSON.stringify(badSel).includes('no tab')?'rejected':'accepted',
    '| S1 url still own?', s1url.includes('example.com')?'PASS':'FAIL');
  process.exit(0);
})().catch(e=>{ console.error('TEST ERROR', e); process.exit(1); });
