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
test('independent real host context identifiers need not be OpenCode sessions',()=>assert.deepEqual(validatePlan(done(fixture())),[]));
test('legacy S ids and distinct session ids remain readable',()=>{const p=done(fixture());p.stories[0].id='S-01';delete p.stories[0].context_id;delete p.stories[0].review.context_id;p.stories[0].sessionId='ses_impl';p.stories[0].review.sessionId='ses_review';assert.deepEqual(validatePlan(p),[]);});
reject('explicit task budget still limits scope',p=>{p.budget.max_tasks=1;p.stories.push({...p.stories[0],id:'WP-02'});});
reject('invalid task budget is rejected',p=>p.budget.max_tasks=0);
reject('repair budget cannot be exceeded',p=>p.stories[0].attempts=4);
reject('duplicate acceptance id',p=>p.acceptance.push({...p.acceptance[0]}));
reject('uncovered acceptance',p=>p.acceptance.push({id:'AC-02',text:'导出'}));
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
reject('missing quality review',p=>{done(p);p.stories[0].review.quality='fail';});
reject('evidence cannot escape its root',p=>{done(p);p.stories[0].evidence=['evidence/../data'];});
reject('absolute evidence paths are rejected',p=>{done(p);p.stories[0].evidence=['C:/secret'];});
test('next action starts the ready package without asking to continue',()=>assert.deepEqual(nextActions(fixture()),[{action:'execute',task_id:'WP-01'}]));
test('running tasks are observed, never redispatched',()=>{const p=fixture();p.stories[0].status='running';assert.deepEqual(nextActions(p),[{action:'observe',task_id:'WP-01'}]);});
test('returned implementation advances to review',()=>{const p=fixture();p.stories[0].status='verifying';assert.deepEqual(nextActions(p),[{action:'review',task_id:'WP-01'}]);});
test('one blocked package does not stop an independent package',()=>{const p=fixture();p.stories.push({...p.stories[0],id:'WP-02',status:'blocked'});assert.deepEqual(nextActions(p),[{action:'execute',task_id:'WP-01'}]);});
test('all packages done requests final acceptance rather than declaring delivery',()=>assert.deepEqual(nextActions(done(fixture())),[{action:'final_acceptance'}]));
test('only blocked work requests blocker investigation',()=>{const p=fixture();p.stories[0].status='blocked';assert.deepEqual(nextActions(p),[{action:'resolve_blockers',task_ids:['WP-01']}]);});

function cli(source, check){
  const root=process.env.WISH_DEV_RUNTIME_ROOT??(process.platform==='win32'?'E:/Claude Agent/wish-dev/runtime':path.join(os.tmpdir(),'wish-dev'));
  fs.mkdirSync(root,{recursive:true});
  const run=fs.mkdtempSync(path.join(root,'plan-test-'));
  try{
    const input=path.join(run,'中文 计划.json');
    fs.writeFileSync(input,typeof source==='function'?source(run):source);
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
  },(result,run)=>{assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout).next_actions,[{action:'execute',task_id:'WP-01'}]);assert.equal(result.stderr,'');assert.equal(fs.existsSync(path.join(run,'must-not-exist.txt')),false);});
});
test('malformed CLI input exposes no next action or supplied content',()=>{
  cli('{"secret-marker":',result=>{assert.equal(result.status,2);const data=JSON.parse(result.stdout);assert.equal(data.ok,false);assert.deepEqual(data.next_actions,[]);assert.equal(result.stdout.includes('secret-marker'),false);});
});
