#!/usr/bin/env node
// [TASK646] stub `claude`: speaks minimal stream-json. Chat turns (argv has
// --input-format) count + obey STUB_MODE_FILE (complete|hang). -p probes just reply.
const fs=require('fs');
const isChat=process.argv.includes('--input-format');
if(isChat && process.env.STUB_COUNT_FILE){try{const n=(parseInt(fs.readFileSync(process.env.STUB_COUNT_FILE,'utf8').trim()||'0',10)||0)+1;fs.writeFileSync(process.env.STUB_COUNT_FILE,String(n));}catch{}}
let mode='complete';try{mode=fs.readFileSync(process.env.STUB_MODE_FILE,'utf8').trim();}catch{}
try{process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('error',()=>{});}catch{}
const _ri=process.argv.indexOf('--resume');const sid=(_ri>=0&&process.argv[_ri+1])?process.argv[_ri+1]:('sess-'+Date.now()+'-'+Math.floor(Math.random()*1e6));
const w=o=>{try{process.stdout.write(JSON.stringify(o)+'\n');}catch{}};
w({type:'system',subtype:'init',session_id:sid,cwd:process.cwd(),tools:[]});
if(isChat && mode==='hang'){ setTimeout(()=>process.exit(0),60000); }
else { w({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'ok'}]},session_id:sid});
       w({type:'result',subtype:'success',result:'ok',session_id:sid,is_error:false,duration_ms:5,num_turns:1});
       setTimeout(()=>process.exit(0),300); }
