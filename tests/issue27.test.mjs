import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createSessionDelivery} from '../lib/session-delivery.js'
import {watchOptions} from '../tools/lib/watch-options.mjs'

function fixture(t,cfg={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-27-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  let time=10*86400000,block='PERSONA-A',busy=false,fail=false,createFail=false
  const sent=[],created=[]
  const args={dshHome:dir,cwd:dir,sessionId:'bili-whale',config:()=>cfg,persona:()=>block,now:()=>time,isBusy:()=>busy,
    controller:{async create(r){if(createFail)throw Error('create failed');created.push(r)},async prompt(r){if(fail)throw Error('send failed');sent.push(r)}}}
  const request={content:[{type:'text',text:'TASK'}]}
  return {dir,args,sent,created,request,make:()=>createSessionDelivery(args),advance:n=>time+=n,persona:s=>block=s,busy:b=>busy=b,fail:b=>fail=b,createFail:b=>createFail=b}
}
test('defaults repeat persona and do not create session state',async t=>{
  const f=fixture(t),d=f.make();await d.send(f.request);await d.send(f.request)
  assert.equal(f.sent.length,2);assert.ok(f.sent.every(r=>r.content[0].text.includes('PERSONA-A')))
  assert.equal(fs.existsSync(path.join(f.dir,'whale-session.json')),false)
})
test('failed delivery retries persona; concurrent channels inject only once; edits reinject',async t=>{
  const f=fixture(t,{personaOncePerSession:true}),d=f.make();f.fail(true)
  await assert.rejects(d.send(f.request),/send failed/);f.fail(false)
  await Promise.all([d.send(f.request),d.send(f.request),d.send(f.request)])
  assert.equal(f.sent.filter(r=>r.content[0].text.includes('PERSONA-A')).length,1)
  f.persona('PERSONA-B');await d.send(f.request);assert.match(f.sent.at(-1).content[0].text,/PERSONA-B/)
  // 2026-10-24 改（审查报告第 3 条）：重启后【第一次投递】现在会重新注入人设 ✓
  //   原因：DSH 的 create() 分不出"新建会话"还是"复用"，接口里没有那个信息 ✗
  //   与其赌"宿主会话还在"→ 她重启后失忆 ✗，不如每次重启多重注入一次（~1000 字）✓
  await f.make().send(f.request);assert.match(f.sent.at(-1).content[0].text,/PERSONA-B/)
})
test('rotation waits for idle, preserves old session and restores persona/diary',async t=>{
  const f=fixture(t,{sessionRotateDays:1,personaOncePerSession:true}),d=f.make()
  // ⚠️ 2026-11-04 更新（配合 lib/session-delivery.js 的新轮换规则）：
  //   旧逻辑：忙（isBusy）就不切 —— 实测 11-03 两趟醒来都撞上她在干活，一整天没切 ✗
  //   新逻辑：超期 + **没有待确认投递** + 距上次投递满 8 分钟 → 就切（忙不忙不再作为条件）
  //   所以这条测试改成守「有待确认投递时**不许**切」这个新保护点 ✓
  const req1={...f.request,requestId:'r1'}
  await d.send(req1,undefined,{retainUntilAck:true})   // 留下 pendingRequest → 不轮换
  f.advance(86400001)                                   // 超期了
  const req2={...f.request,requestId:'r2'}
  await d.send(req2,undefined,{retainUntilAck:true})
  assert.equal(f.sent.at(-1).sessionId,'bili-whale', '还有待确认投递时不该切')
  // 待确认清掉（模拟已确认）后，再满足 8 分钟空闲 → 才切
  const stateFile=path.join(f.dir,'whale-session.json')
  const st=JSON.parse(fs.readFileSync(stateFile))
  delete st.pendingRequest
  fs.writeFileSync(stateFile,JSON.stringify(st))
  const d2=f.make()                                     // 重新建一个 delivery（读回没有 pending 的状态）
  f.advance(8*60000)
  await d2.send(f.request)
  const r=f.sent.at(-1);assert.match(r.sessionId,/^[0-9a-f-]{36}$/);assert.match(r.content[0].text,/PERSONA-A/);assert.match(r.content[0].text,/whale-diary-private.md/)
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).rotatedFrom,'bili-whale')
  await f.make().send(f.request);assert.equal(f.sent.at(-1).sessionId,r.sessionId)
})
test('restart rotates once when due, and re-injects persona instead of silently reusing memory',async t=>{
  const cfg={sessionRotateDays:0,personaOncePerSession:true},f=fixture(t,cfg)
  await f.make().send(f.request)                        // 首次投递，会话=bili-whale
  f.advance(86400001)                                   // 过了一天
  cfg.sessionRotateDays=1                               // 现在算超期
  // ⚠️ 2026-11-04 更新：新规则下 booted=false 时**跳过 8 分钟空闲检查**（第 46 行），
  //   所以重启后第一次投递如果已经超期，会**直接轮换**一次 —— 这是有意的：
  //   重启时她刚醒，换一个新会话正好配合「重新注入人设 + 日记指引」防止失忆 ✓
  //   旧断言（重启后当次不切）已经不成立，改成守真正要保证的两件事：
  await f.make().send(f.request)
  const r=f.sent.at(-1)
  assert.match(r.sessionId,/^[0-9a-f-]{36}$/, '超期后重启，应当轮换到新会话')
  assert.notEqual(r.sessionId,'bili-whale')
  // ① 切换后必须重新注入人设，不能静默复用记忆
  assert.match(r.content[0].text,/PERSONA-A/, '轮换后必须重新注入人设')
  assert.match(r.content[0].text,/whale-diary-private\.md/, '轮换后必须给日记恢复指引')
  // ② 旧会话要保留（不删），下次还能找回来
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'whale-session.json'))).rotatedFrom,'bili-whale')
})
test('rotation creation failure does not commit a new session; aborted queue does not send',async t=>{
  const f=fixture(t,{sessionRotateDays:1}),d=f.make();await d.send(f.request);f.advance(86400001);f.createFail(true)
  await assert.rejects(d.send(f.request),/create failed/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'whale-session.json'))).id,'bili-whale')
  const abort=new AbortController();abort.abort();await assert.rejects(d.send(f.request,abort.signal));assert.equal(f.sent.length,1)
})
test('invalid state is reported without overwriting it',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.dir,'whale-session.json'),'broken')
  assert.throws(f.make,/会话状态损坏/);assert.equal(fs.readFileSync(path.join(f.dir,'whale-session.json'),'utf8'),'broken')
})
test('tile options do not consume positional output directory; invalid widths rejected',()=>{
  assert.deepEqual(watchOptions(['BVtest','--tile','800','4x4','out'],'default'),{bvid:'BVtest',grid:'4x4',outDir:'out',tile:800})
  assert.equal(watchOptions(['BVtest','--tile=1280'],'default').tile,1280)
  assert.equal(watchOptions(['BVtest'],'default').tile,720)
  for(const v of ['','NaN','239','1281','720.5'])assert.throws(()=>watchOptions(['BVtest','--tile='+v],'default'))
})
test('custom DSH_HOME is used by deps, notify and selftest without touching default .dsh',t=>{
  const f=fixture(t),dsh=path.join(f.dir,'custom-dsh');fs.mkdirSync(dsh)
  const env={...process.env,USERPROFILE:f.dir,HOME:f.dir,DSH_HOME:dsh,DSH_NODE:process.execPath,BILI_WHALE_CONFIG:'',NODE_OPTIONS:''}
  fs.writeFileSync(path.join(dsh,'bili-whale.config.json'),JSON.stringify({night:{windows:[{start:'20:00',end:'24:00'}]},notify:{type:'file'}}))
  fs.writeFileSync(path.join(dsh,'whale-night.json'),JSON.stringify({action:'wake',atMs:Date.now()+3600000}))
  const cli=fileURLToPath(new URL('../tools/bili.mjs',import.meta.url))
  const run=(...args)=>spawnSync(process.execPath,[cli,...args],{env,encoding:'utf8',timeout:30000})
  const deps=run('deps','--json');assert.equal(deps.error,undefined)
  assert.equal(JSON.parse(deps.stdout).items.find(i=>i.name==='生物钟').ok,true)
  const notice=run('notify','local path test');assert.equal(notice.status,0,notice.stderr)
  assert.match(fs.readFileSync(path.join(dsh,'whale-notify.log'),'utf8'),/local path test/)
  const self=run('selftest');assert.equal(self.error,undefined)
  assert.ok(self.stdout.split('\n').some(line=>line.includes('目录 DSH_HOME')&&line.includes(dsh)&&line.includes('✓')),self.stdout)
  assert.equal(fs.existsSync(path.join(f.dir,'.dsh')),false)
})
