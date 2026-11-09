import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as gate from '../scripts/check-plan.mjs';
const {validatePlan}=gate;
const nextActions=p=>{assert.equal(typeof gate.nextActions,'function','gate must expose the next action contract');return gate.nextActions(p);};

const fixture=()=>({
  version:1,wish_id:'W-01',acceptance:[{id:'AC-01',text:'保存后刷新可读取'}],
  research:{status:'complete',checked_at:'2026-10-26',decision:'沿用现有服务',rationale:'符合既有约束',candidates:[{
    url:'https://github.com/github/spec-kit',revision:'67e0f7294e6e728ab60bf7b4590deb470448bc2d',
    code_refs:['https://github.com/github/spec-kit/blob/67e0f7294e6e728ab60bf7b4590deb470448bc2d/templates/commands/plan.md?plain=1#L1'],
    fit:'流程参考',limits:'不是产品实现证据'}]},
  architecture:{approach:'现有模块',simplification:'唯一状态来源',concurrency:{applicable:true,assumptions:'多人同时保存',controls:'事务与幂等',verification:'并发保存检查'},load_balancing:{applicable:false,reason:'目前单实例',scale_trigger:'需要多实例时'}},
  budget:{max_fix_attempts:3},
  stories:[{id:'WP-01',title:'保存功能',status:'pending',attempts:0,allowed_files:['src/**'],accept_refs:['AC-01'],verify:[{kind:'command',run:'npm test'}]}]
});
const done=p=>{Object.assign(p.stories[0],{status:'done',context_id:'actual-run-01',evidence:['evidence/save.json'],review:{context_id:'actual-review-02',spec:'pass',quality:'pass'}});return p;};
const reject=(name,change)=>test(name,()=>{const p=fixture();change(p);assert.ok(validatePlan(p).length>0);});
test('dynamic package count has no implicit ceiling',()=>{const p=fixture();p.stories=Array.from({length:20},(_,i)=>({...structuredClone(p.stories[0]),id:`WP-${String(i+1).padStart(2,'0')}`}));assert.deepEqual(validatePlan(p),[]);});
test('independent real host context identifiers need not be subagent sessions',()=>assert.deepEqual(validatePlan(done(fixture())),[]));
test('legacy S ids and distinct session ids remain readable',()=>{const p=done(fixture());p.stories[0].id='S-01';delete p.stories[0].context_id;delete p.stories[0].review.context_id;p.stories[0].sessionId='ses_impl';p.stories[0].review.sessionId='ses_review';assert.deepEqual(validatePlan(p),[]);});
reject('explicit task budget still limits scope',p=>{p.budget.max_tasks=1;p.stories.push({...p.stories[0],id:'WP-02'});});
reject('invalid task budget is rejected',p=>p.budget.max_tasks=0);
reject('repair budget cannot be exceeded',p=>p.stories[0].attempts=4);
reject('duplicate acceptance id',p=>p.acceptance.push({...p.acceptance[0]}));
reject('uncovered acceptance',p=>p.acceptance.push({id:'AC-02',text:'导出'}));
test('uncovered criterion error names the id',()=>{const p=fixture();p.acceptance.push({id:'AC-02',text:'导出'});assert.ok(validatePlan(p).some(e=>e==='uncovered acceptance criterion: AC-02'));});
reject('duplicate package id',p=>p.stories.push({...p.stories[0]}));
reject('array is not an id',p=>p.stories[0].id=['WP-01']);
reject('research cannot be uninspected',p=>p.research.status='pending');
reject('README alone is insufficient',p=>p.research.candidates[0].code_refs=[p.research.candidates[0].code_refs[0].replace('templates/commands/plan.md?plain=1#L1','README.md')]);
reject('encoded README alone is insufficient',p=>p.research.candidates[0].code_refs=[p.research.candidates[0].code_refs[0].replace('templates/commands/plan.md?plain=1#L1','%52EADME.md')]);
reject('different revision is rejected',p=>p.research.candidates[0].revision='a'.repeat(40));
reject('array is not a source link',p=>p.research.candidates[0].code_refs=[p.research.candidates[0].code_refs]);
reject('source URLs cannot carry credentials',p=>p.research.candidates[0].url='https://user:secret@github.com/github/spec-kit');
reject('unsupported source URL query',p=>p.research.candidates[0].code_refs[0]=p.research.candidates[0].code_refs[0].replace('?plain=1','?plain=1&x=1'));
reject('architecture cannot omit concurrency',p=>delete p.architecture.concurrency);
reject('load balancing needs a scale trigger when inapplicable',p=>delete p.architecture.load_balancing.scale_trigger);
reject('unknown dependency',p=>p.stories[0].depends_on=['WP-99']);
reject('cyclic dependency',p=>{p.stories[0].depends_on=['WP-02'];p.stories.push({...p.stories[0],id:'WP-02',depends_on:['WP-01']});});
reject('dependent writer cannot start before prerequisites pass',p=>{p.stories.push({...p.stories[0],id:'WP-02',depends_on:['WP-01'],status:'running'});});
reject('done needs actual evidence references',p=>{done(p);p.stories[0].evidence=[];});
reject('same context is not independent review',p=>{done(p);p.stories[0].review.context_id='actual-run-01';});
reject('review cannot reuse the implementation session under another field',p=>{done(p);p.stories[0].sessionId='ses_same';p.stories[0].review.context_id='ses_same';});
reject('any review identifier matching the implementation is rejected',p=>{done(p);p.stories[0].review.sessionId='actual-run-01';});
reject('review identifier matching the implementation by case is the same context',p=>{done(p);p.stories[0].review.context_id='ACTUAL-RUN-01';});
reject('missing quality review',p=>{done(p);p.stories[0].review.quality='fail';});
reject('evidence cannot escape its root',p=>{done(p);p.stories[0].evidence=['evidence/../data'];});
reject('absolute evidence paths are rejected',p=>{done(p);p.stories[0].evidence=['C:/secret'];});
test('next action starts the ready package without asking to continue',()=>assert.deepEqual(nextActions(fixture()),[{action:'execute',task_id:'WP-01'}]));
test('running tasks are observed, never redispatched',()=>{const p=fixture();p.stories[0].status='running';assert.deepEqual(nextActions(p),[{action:'observe',task_id:'WP-01'}]);});
test('returned implementation advances to review',()=>{const p=fixture();p.stories[0].status='verifying';assert.deepEqual(nextActions(p),[{action:'review',task_id:'WP-01'}]);});
test('one blocked package does not stop an independent package',()=>{const p=fixture();p.stories.push({...p.stories[0],id:'WP-02',status:'blocked'});assert.deepEqual(nextActions(p),[{action:'execute',task_id:'WP-01'}]);});
test('all packages done requests final acceptance rather than declaring delivery',()=>assert.deepEqual(nextActions(done(fixture())),[{action:'final_acceptance'}]));
test('only blocked work requests blocker investigation',()=>{const p=fixture();p.stories[0].status='blocked';assert.deepEqual(nextActions(p),[{action:'resolve_blockers',task_ids:['WP-01']}]);});

const ledgerHeader=({blocker=true}={})=>[
  '# progress',
  '- wish-id: W-01',
  '- acceptance: AC-01 保存后刷新可读取',
  '- current-package: WP-01',
  '- next-action: 派发 WP-01',
  ...(blocker?['- blocker: 无']:[])
].join('\n')+'\n';
const ledgerChinese=()=>[
  '# 进展',
  '- 愿望 ID：W-01',
  '## AC 清单：AC-01 保存后刷新可读取',
  '- 当前包：WP-01',
  '- 下一步：派发 WP-01',
  '- 阻塞项：无'
].join('\n')+'\n';

const ledgers={
  full:()=>ledgerHeader(),
  partial:()=>ledgerHeader({blocker:false}),
  empty:()=>'',
  zh:()=>ledgerChinese(),
  late:()=>Array.from({length:60},(_,i)=>`备注${i+1}: 无`).join('\n')+'\n'+ledgerHeader(),
  bold:()=>ledgerHeader().replace(/^- ([\w-]+)/gm,(line,key)=>`- **${key}**`),
  table:()=>['| 字段 | 值 |','|---|---|',...['wish-id: W-01','acceptance: AC-01 保存后刷新可读取','current-package: WP-01','next-action: 派发 WP-01','blocker: 无']
    .map(row=>{const [key,...rest]=row.split(': ');return `| ${key} | ${rest.join(': ')} |`;})].join('\n')+'\n'
};

function cli(source, check, {ledger='full'}={}){
  const root=process.env.WISH_DEV_RUNTIME_ROOT??path.join(os.tmpdir(),'wish-dev');
  fs.mkdirSync(root,{recursive:true});
  const run=fs.mkdtempSync(path.join(root,'plan-test-'));
  try{
    const input=path.join(run,'中文 计划.json');
    fs.writeFileSync(input,typeof source==='function'?source(run):source);
    if(ledger!==false)fs.writeFileSync(path.join(run,'progress.md'),ledgers[ledger]());
    const script=fileURLToPath(new URL('../scripts/check-plan.mjs',import.meta.url));
    const result=spawnSync(process.execPath,[script,input],{encoding:'utf8',timeout:10000});
    assert.equal(result.error,undefined);
    check(result,run);
  }finally{fs.rmSync(run,{recursive:true,force:true});}
}
test('CLI reads BOM plans and never executes verify commands',()=>{
  cli(run=>{
    const p=fixture(),marker=path.join(run,'must-not-exist.txt').replaceAll('\\','/');
    p.stories[0].verify=[{kind:'command',run:`"${process.execPath}" -e "require('node:fs').writeFileSync('${marker}', 'ran')"`}];
    return '\uFEFF'+JSON.stringify(p);
  },(result,run)=>{assert.equal(result.status,0);const data=JSON.parse(result.stdout);assert.equal(data.ledger,true);assert.deepEqual(data.next_actions,[{action:'execute',task_id:'WP-01'}]);assert.equal(result.stderr,'');assert.equal(fs.existsSync(path.join(run,'must-not-exist.txt')),false);});
});
test('valid plan without progress.md is rejected as not_started',()=>{
  cli(JSON.stringify(fixture()),result=>{
    assert.equal(result.status,2);
    const data=JSON.parse(result.stdout);
    assert.equal(data.ledger,false);
    assert.equal(data.ok,false);
    assert.deepEqual(data.next_actions,[]);
    assert.ok(data.errors.some(e=>e.includes('ledger missing')));
  },{ledger:false});
});
test('empty ledger cannot satisfy the gate',()=>{
  cli(JSON.stringify(fixture()),result=>{
    assert.equal(result.status,2);
    const data=JSON.parse(result.stdout);
    assert.equal(data.ok,false);
    assert.equal(data.ledger,false);
    assert.equal(data.errors.length,1);
    for(const field of ['wish-id','acceptance','current-package','next-action','blocker'])assert.ok(data.errors[0].includes(field),field);
  },{ledger:'empty'});
});
test('ledger missing one header field is rejected',()=>{
  cli(JSON.stringify(fixture()),result=>{
    assert.equal(result.status,2);
    const data=JSON.parse(result.stdout);
    assert.equal(data.ledger,false);
    assert.ok(data.errors.some(e=>e.startsWith('ledger field missing: blocker')));
    assert.equal(data.errors.some(e=>e.includes('wish-id')),false);
  },{ledger:'partial'});
});
test('documented Chinese ledger aliases and heading forms pass the gate',()=>{
  cli(JSON.stringify(fixture()),result=>{
    assert.equal(result.status,0);
    const data=JSON.parse(result.stdout);
    assert.equal(data.ok,true);
    assert.equal(data.ledger,true);
    assert.deepEqual(data.next_actions,[{action:'execute',task_id:'WP-01'}]);
  },{ledger:'zh'});
});
test('emphasised and table header forms pass the gate',()=>{
  for(const ledger of ['bold','table'])cli(JSON.stringify(fixture()),result=>{
    const data=JSON.parse(result.stdout);
    assert.equal(data.ok,true,ledger);
    assert.equal(data.ledger,true,ledger);
  },{ledger});
});
test('a header appended far down the log is rejected',()=>{
  cli(JSON.stringify(fixture()),result=>{
    assert.equal(result.status,2);
    const data=JSON.parse(result.stdout);
    assert.equal(data.ledger,false);
    assert.ok(data.errors[0].startsWith('ledger field missing: wish-id'));
    assert.ok(data.errors[0].includes('first 40 lines'));
  },{ledger:'late'});
});
test('canonical T ids carry dependencies without a second numbering scheme',()=>{
  const p=fixture();
  p.stories[0].id='T-1-01';
  p.stories.push({...structuredClone(p.stories[0]),id:'T-2-01',depends_on:['T-1-01']});
  assert.deepEqual(validatePlan(p),[]);
});
test('malformed T ids are rejected',()=>{
  const p=fixture();p.stories[0].id='T-1-1';
  assert.ok(validatePlan(p).some(e=>e.includes('must be a string matching T-2-01')));
});
test('malformed CLI input exposes no next action or supplied content',()=>{
  cli('{"secret-marker":',result=>{assert.equal(result.status,2);const data=JSON.parse(result.stdout);assert.equal(data.ok,false);assert.deepEqual(data.next_actions,[]);assert.ok(data.errors[0].startsWith('Plan is not valid JSON:'));assert.equal(result.stdout.includes('secret-marker'),false);});
});
test('a directory plan path is reported as unreadable, not as invalid JSON',()=>{
  const script=fileURLToPath(new URL('../scripts/check-plan.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[script,os.tmpdir()],{encoding:'utf8'});
  assert.equal(result.status,2);
  assert.ok(JSON.parse(result.stdout).errors[0].startsWith('Plan path is not a readable file:'));
});
test('usage and missing plan failures are reported distinctly from invalid JSON',()=>{
  const script=fileURLToPath(new URL('../scripts/check-plan.mjs',import.meta.url));
  const noArgs=spawnSync(process.execPath,[script],{encoding:'utf8'});
  assert.equal(noArgs.status,2);
  const usage=JSON.parse(noArgs.stdout);
  assert.deepEqual(usage.errors,['usage: node check-plan.mjs <prd.json>']);
  const absent=path.join(os.tmpdir(),'wish-dev-plan-that-does-not-exist.json');
  const missing=spawnSync(process.execPath,[script,absent],{encoding:'utf8'});
  assert.equal(missing.status,2);
  assert.ok(JSON.parse(missing.stdout).errors[0].startsWith('Plan file not found:'));
});
