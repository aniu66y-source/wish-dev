import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as gate from '../scripts/check-plan.mjs';
import * as review from '../scripts/review-material.mjs';
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
  stories:[{id:'T-1-01',title:'保存功能',status:'pending',attempts:0,allowed_files:['src/**'],accept_refs:['AC-01'],verify:[{kind:'command',run:'npm test'}]}]
});
const done=p=>{Object.assign(p.stories[0],{status:'done',context_id:'actual-run-01',evidence:['evidence/save.json'],review:{context_id:'actual-review-02',spec:'pass',quality:'pass'}});return p;};
const reject=(name,change)=>test(name,()=>{const p=fixture();change(p);assert.ok(validatePlan(p).length>0);});
test('dynamic package count has no implicit ceiling',()=>{const p=fixture();p.stories=Array.from({length:20},(_,i)=>({...structuredClone(p.stories[0]),id:`T-1-${String(i+1).padStart(2,'0')}`}));assert.deepEqual(validatePlan(p),[]);});
test('independent real host context identifiers need not be subagent sessions',()=>assert.deepEqual(validatePlan(done(fixture())),[]));
test('legacy WP ids remain readable',()=>{const p=done(fixture());p.stories[0].id='WP-01';assert.deepEqual(validatePlan(p),[]);});
test('legacy S ids and distinct session ids remain readable',()=>{const p=done(fixture());p.stories[0].id='S-01';delete p.stories[0].context_id;delete p.stories[0].review.context_id;p.stories[0].sessionId='ses_impl';p.stories[0].review.sessionId='ses_review';assert.deepEqual(validatePlan(p),[]);});
reject('explicit task budget still limits scope',p=>{p.budget.max_tasks=1;p.stories.push({...p.stories[0],id:'T-1-02'});});
reject('invalid task budget is rejected',p=>p.budget.max_tasks=0);
reject('repair budget cannot be exceeded',p=>p.stories[0].attempts=4);
reject('a pending package at the repair limit must be blocked or the budget raised',p=>p.stories[0].attempts=3);
test('verifying and blocked packages may sit at the repair limit',()=>{
  for(const status of ['verifying','blocked']){const p=fixture();p.stories[0].status=status;p.stories[0].attempts=3;assert.deepEqual(validatePlan(p),[],status);}
});

// Repair budget semantics: attempts counts the fixes already started. The last
// legitimately started fix may still be running at the limit; only a pending package
// is refused, and the counter never resets to buy another attempt.
test('a package with budget left can still be claimed',()=>{
  const p=fixture();p.stories[0].attempts=2;
  assert.deepEqual(validatePlan(p),[]);
  assert.deepEqual(nextActions(p),[{action:'execute',task_id:'T-1-01'}]);
});
test('the last started fix may stay running at the limit and is observed',()=>{
  const p=fixture();p.stories[0].status='running';p.stories[0].attempts=3;
  assert.deepEqual(validatePlan(p),[]);
  assert.deepEqual(nextActions(p),[{action:'observe',task_id:'T-1-01'}]);
});
test('a returned final fix waits for review instead of being rejected',()=>{
  const p=fixture();p.stories[0].status='verifying';p.stories[0].attempts=3;
  assert.deepEqual(validatePlan(p),[]);
  assert.deepEqual(nextActions(p),[{action:'review',task_id:'T-1-01'}]);
});
test('a pending package at the limit is rejected and never dispatched again',()=>{
  const p=fixture();p.stories[0].attempts=3;
  assert.ok(validatePlan(p).some(e=>e.includes('reached the repair budget')));
  assert.deepEqual(nextActions(p),[{action:'resolve_blockers',task_ids:['T-1-01']}]);
});
test('attempts above the limit stay rejected in every state',()=>{
  for(const status of ['pending','running','verifying','blocked']){
    const p=fixture();p.stories[0].status=status;p.stories[0].attempts=4;
    assert.ok(validatePlan(p).some(e=>e.includes('exceeds retry budget')),status);
  }
});
test('a running final fix does not hide an independent ready line',()=>{
  const p=fixture();
  p.stories[0].status='running';p.stories[0].attempts=3;
  p.stories.push({...structuredClone(p.stories[0]),id:'T-2-01',status:'pending',attempts:0});
  assert.deepEqual(validatePlan(p),[]);
  assert.deepEqual(nextActions(p),[{action:'observe',task_id:'T-1-01'},{action:'execute',task_id:'T-2-01'}]);
});
test('a whole repair sequence stays consistent from claim to delivery',()=>{
  const p=fixture();const s=p.stories[0];
  const at=(status,attempts,expected)=>{
    s.status=status;s.attempts=attempts;
    assert.deepEqual(validatePlan(p),[],`${status}/${attempts}`);
    assert.deepEqual(nextActions(p),expected,`${status}/${attempts}`);
  };
  at('pending',0,[{action:'execute',task_id:'T-1-01'}]);
  at('running',0,[{action:'observe',task_id:'T-1-01'}]);
  at('verifying',0,[{action:'review',task_id:'T-1-01'}]);
  at('pending',1,[{action:'execute',task_id:'T-1-01'}]);
  at('running',1,[{action:'observe',task_id:'T-1-01'}]);
  at('verifying',1,[{action:'review',task_id:'T-1-01'}]);
  at('pending',2,[{action:'execute',task_id:'T-1-01'}]);
  at('running',3,[{action:'observe',task_id:'T-1-01'}]);
  at('verifying',3,[{action:'review',task_id:'T-1-01'}]);
  Object.assign(s,{status:'done',context_id:'impl-01',evidence:['evidence/T-1-01.json'],review:{context_id:'rev-01',spec:'pass',quality:'pass'}});
  assert.deepEqual(validatePlan(p),[]);
  assert.deepEqual(nextActions(p),[{action:'final_acceptance'}]);
});
test('a failed final fix stops at blocked without dropping its count',()=>{
  const p=fixture();const s=p.stories[0];
  s.status='blocked';s.attempts=3;
  assert.deepEqual(validatePlan(p),[]);
  assert.deepEqual(nextActions(p),[{action:'resolve_blockers',task_ids:['T-1-01']}]);
  s.status='pending';
  assert.ok(validatePlan(p).some(e=>e.includes('reached the repair budget')));
});
test('allowed_files is a write scope and a read-only task declares none',()=>{
  const writable=fixture();writable.stories[0].allowed_files=['src/**'];
  assert.deepEqual(validatePlan(writable),[]);
  const readOnly=fixture();Object.assign(readOnly.stories[0],{read_only:true,allowed_files:[],read_scope:['src/**','docs/**']});
  assert.deepEqual(validatePlan(readOnly),[]);
  const claimsWrites=fixture();Object.assign(claimsWrites.stories[0],{read_only:true,allowed_files:['src/**']});
  assert.ok(validatePlan(claimsWrites).some(e=>e.includes('read_only must not declare')));
});
test('evidence prefix is case-insensitive for Windows paths',()=>{const p=done(fixture());p.stories[0].evidence=['Evidence/save.json'];assert.deepEqual(validatePlan(p),[]);});
reject('duplicate acceptance id',p=>p.acceptance.push({...p.acceptance[0]}));
reject('uncovered acceptance',p=>p.acceptance.push({id:'AC-02',text:'导出'}));
test('uncovered criterion error names the id',()=>{const p=fixture();p.acceptance.push({id:'AC-02',text:'导出'});assert.ok(validatePlan(p).some(e=>e==='uncovered acceptance criterion: AC-02'));});
reject('duplicate package id',p=>p.stories.push({...p.stories[0]}));
reject('array is not an id',p=>p.stories[0].id=['T-1-01']);
reject('research cannot be uninspected',p=>p.research.status='pending');
reject('README alone is insufficient',p=>p.research.candidates[0].code_refs=[p.research.candidates[0].code_refs[0].replace('templates/commands/plan.md?plain=1#L1','README.md')]);
reject('encoded README alone is insufficient',p=>p.research.candidates[0].code_refs=[p.research.candidates[0].code_refs[0].replace('templates/commands/plan.md?plain=1#L1','%52EADME.md')]);
reject('different revision is rejected',p=>p.research.candidates[0].revision='a'.repeat(40));
reject('array is not a source link',p=>p.research.candidates[0].code_refs=[p.research.candidates[0].code_refs]);
reject('source URLs cannot carry credentials',p=>p.research.candidates[0].url='https://user:secret@github.com/github/spec-kit');
reject('unsupported source URL query',p=>p.research.candidates[0].code_refs[0]=p.research.candidates[0].code_refs[0].replace('?plain=1','?plain=1&x=1'));
reject('architecture cannot omit concurrency',p=>delete p.architecture.concurrency);
reject('load balancing needs a scale trigger when inapplicable',p=>delete p.architecture.load_balancing.scale_trigger);
reject('unknown dependency',p=>p.stories[0].depends_on=['T-9-01']);
reject('cyclic dependency',p=>{p.stories[0].depends_on=['T-1-02'];p.stories.push({...p.stories[0],id:'T-1-02',depends_on:['T-1-01']});});
reject('dependent writer cannot start before prerequisites pass',p=>{p.stories.push({...p.stories[0],id:'T-1-02',depends_on:['T-1-01'],status:'running'});});
reject('done needs actual evidence references',p=>{done(p);p.stories[0].evidence=[];});
reject('same context is not independent review',p=>{done(p);p.stories[0].review.context_id='actual-run-01';});
reject('review cannot reuse the implementation session under another field',p=>{done(p);p.stories[0].sessionId='ses_same';p.stories[0].review.context_id='ses_same';});
reject('any review identifier matching the implementation is rejected',p=>{done(p);p.stories[0].review.sessionId='actual-run-01';});
reject('review identifier matching the implementation by case is the same context',p=>{done(p);p.stories[0].review.context_id='ACTUAL-RUN-01';});
reject('missing quality review',p=>{done(p);p.stories[0].review.quality='fail';});
reject('evidence cannot escape its root',p=>{done(p);p.stories[0].evidence=['evidence/../data'];});
reject('absolute evidence paths are rejected',p=>{done(p);p.stories[0].evidence=['C:/secret'];});
test('next action starts the ready package without asking to continue',()=>assert.deepEqual(nextActions(fixture()),[{action:'execute',task_id:'T-1-01'}]));
test('running tasks are observed, never redispatched',()=>{const p=fixture();p.stories[0].status='running';assert.deepEqual(nextActions(p),[{action:'observe',task_id:'T-1-01'}]);});
test('returned implementation advances to review',()=>{const p=fixture();p.stories[0].status='verifying';assert.deepEqual(nextActions(p),[{action:'review',task_id:'T-1-01'}]);});
test('one blocked package does not stop an independent package',()=>{const p=fixture();p.stories.push({...p.stories[0],id:'T-1-02',status:'blocked'});assert.deepEqual(nextActions(p),[{action:'execute',task_id:'T-1-01'}]);});
test('all packages done requests final acceptance rather than declaring delivery',()=>assert.deepEqual(nextActions(done(fixture())),[{action:'final_acceptance'}]));
test('only blocked work requests blocker investigation',()=>{const p=fixture();p.stories[0].status='blocked';assert.deepEqual(nextActions(p),[{action:'resolve_blockers',task_ids:['T-1-01']}]);});
test('a package at the repair limit is not dispatched again',()=>{const p=fixture();p.stories[0].attempts=3;assert.deepEqual(nextActions(p),[{action:'resolve_blockers',task_ids:['T-1-01']}]);});
test('one exhausted package does not block a ready package',()=>{const p=fixture();p.stories[0].attempts=3;const q=structuredClone(p.stories[0]);q.id='T-1-02';q.attempts=0;p.stories.push(q);assert.deepEqual(nextActions(p),[{action:'execute',task_id:'T-1-02'}]);});

const ledgerHeader=({blocker=true}={})=>[
  '# progress',
  '- wish-id: W-01',
  '- acceptance: AC-01 保存后刷新可读取',
  '- current-package: T-1-01',
  '- next-action: 派发 T-1-01',
  ...(blocker?['- blocker: 无']:[])
].join('\n')+'\n';
const ledgerChinese=()=>[
  '# 进展',
  '- 愿望 ID：W-01',
  '## AC 清单：AC-01 保存后刷新可读取',
  '- 当前包：T-1-01',
  '- 下一步：派发 T-1-01',
  '- 阻塞项：无'
].join('\n')+'\n';

const table=({bold}={})=>['| 字段 | 值 |','|---|---|',...['wish-id: W-01','acceptance: AC-01 保存后刷新可读取','current-package: T-1-01','next-action: 派发 T-1-01','blocker: 无']
  .map(row=>{const [key,...rest]=row.split(': ');const cell=bold?`**${key}**`:key;return `| ${cell} | ${rest.join(': ')} |`;})].join('\n')+'\n';
const pad=n=>Array.from({length:n},(_,i)=>`备注${i+1}: 无`).join('\n')+'\n';
const fieldLines=['- wish-id: W-01','- acceptance: AC-01 保存后刷新可读取','- current-package: T-1-01','- next-action: 派发 T-1-01','- blocker: 无'];

const ledgers={
  full:()=>ledgerHeader(),
  partial:()=>ledgerHeader({blocker:false}),
  empty:()=>'',
  zh:()=>ledgerChinese(),
  late:()=>pad(60)+ledgerHeader(),
  bold:()=>ledgerHeader().replace(/^- ([\w-]+)/gm,(line,key)=>`- **${key}**`),
  boldColon:()=>ledgerHeader().replace(/^- ([\w-]+)\s*:/gm,(line,key)=>`- **${key}:**`),
  underscore:()=>ledgerHeader().replace(/^- ([\w-]+)/gm,(line,key)=>`- __${key}__`),
  backtick:()=>ledgerHeader().replace(/^- ([\w-]+)/gm,(line,key)=>`- \`${key}\``),
  quote:()=>ledgerHeader().replace(/^- /gm,'> - '),
  bom:()=>'\uFEFF'+ledgerHeader(),
  spanIn:()=>['- wish-id: W-01',...Array.from({length:10},()=>''),...fieldLines.slice(1)].join('\n')+'\n',
  spanOut:()=>['- wish-id: W-01',...Array.from({length:11},()=>''),...fieldLines.slice(1)].join('\n')+'\n',
  ordered:()=>ledgerHeader().replace(/^- (.*)$/gm,(line,body)=>body).split('\n').map((line,i)=>line?`${i+1}. ${line}`:line).join('\n'),
  table:()=>table(),
  tableBold:()=>table({bold:true}),
  straddle:()=>pad(38)+ledgerHeader(),
  pastWindow:()=>pad(39)+ledgerHeader(),
  boundaryIn:()=>pad(39)+fieldLines.join('\n')+'\n',
  boundaryOut:()=>pad(40)+fieldLines.join('\n')+'\n',
  horizontalRule:()=>[fieldLines[0],'---',...fieldLines.slice(1)].join('\n')+'\n',
  blankSeparated:()=>ledgerHeader().split('\n').join('\n\n'),
  scattered:()=>['# progress','- wish-id: W-01','杂项说明：随便写','备注：进度还行','- acceptance: AC-01 保存后刷新可读取','- current-package: T-1-01','其他：略','- next-action: 派发 T-1-01','- blocker: 无'].join('\n')+'\n'
};

function cli(source, check, {ledger='full'}={}){
  // 无运行根环境变量时落到系统临时目录：仅为测试夹具，跑完即删。
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
  },(result,run)=>{assert.equal(result.status,0);const data=JSON.parse(result.stdout);assert.equal(data.ledger,true);assert.deepEqual(data.next_actions,[{action:'execute',task_id:'T-1-01'}]);assert.equal(result.stderr,'');assert.equal(fs.existsSync(path.join(run,'must-not-exist.txt')),false);});
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
    assert.deepEqual(data.next_actions,[{action:'execute',task_id:'T-1-01'}]);
  },{ledger:'zh'});
});
test('documented emphasis, quote and table header forms pass the gate',()=>{
  for(const ledger of ['bold','boldColon','underscore','backtick','quote','bom','ordered','table','tableBold'])cli(JSON.stringify(fixture()),result=>{
    const data=JSON.parse(result.stdout);
    assert.equal(data.ok,true,ledger);
    assert.equal(data.ledger,true,ledger);
  },{ledger});
});
test('a header straddling the 40-line boundary stays complete',()=>{
  cli(JSON.stringify(fixture()),result=>{
    const data=JSON.parse(result.stdout);
    assert.equal(data.ok,true);
    assert.equal(data.ledger,true);
  },{ledger:'straddle'});
});
test('blank lines between header fields are tolerated',()=>{
  cli(JSON.stringify(fixture()),result=>{const data=JSON.parse(result.stdout);assert.equal(data.ok,true);assert.equal(data.ledger,true);},{ledger:'blankSeparated'});
});
test('a header starting on line 40 is still accepted',()=>{cli(JSON.stringify(fixture()),result=>{const data=JSON.parse(result.stdout);assert.equal(data.ok,true);assert.equal(data.ledger,true);},{ledger:'boundaryIn'});});
test('a header starting after line 40 is rejected',()=>{cli(JSON.stringify(fixture()),result=>{const data=JSON.parse(result.stdout);assert.equal(data.ledger,false);},{ledger:'boundaryOut'});});
test('a header finishing on the 15th line from its start is accepted',()=>{
  cli(JSON.stringify(fixture()),result=>{
    const data=JSON.parse(result.stdout);
    assert.equal(data.ok,true);
    assert.equal(data.ledger,true);
  },{ledger:'spanIn'});
});
test('a header needing a 16th line from its start is rejected',()=>{
  cli(JSON.stringify(fixture()),result=>{
    const data=JSON.parse(result.stdout);
    assert.equal(data.ledger,false);
    assert.ok(data.errors[0].includes('ledger field missing: blocker'));
    assert.ok(data.errors[0].includes('finishing within 15 lines'));
  },{ledger:'spanOut'});
});
test('a markdown horizontal rule cannot bridge header fields',()=>{cli(JSON.stringify(fixture()),result=>{const data=JSON.parse(result.stdout);assert.equal(result.status,2);assert.equal(data.ledger,false);},{ledger:'horizontalRule'});});
test('fields scattered through the log are not a header block',()=>{
  cli(JSON.stringify(fixture()),result=>{
    const data=JSON.parse(result.stdout);
    assert.equal(result.status,2);
    assert.equal(data.ledger,false);
    assert.ok(data.errors[0].includes('contiguous 5-field header'));
  },{ledger:'scattered'});
});
test('a header starting past the 40-line boundary is rejected',()=>{
  cli(JSON.stringify(fixture()),result=>{
    const data=JSON.parse(result.stdout);
    assert.equal(data.ledger,false);
    assert.ok(data.errors[0].includes('contiguous 5-field header'));
  },{ledger:'pastWindow'});
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

// ---- 评审材料采集（review material） ------------------------------------------
// The material must cover committed, staged, unstaged, untracked and deleted work, and
// must not swallow changes the user made before the task started.
const reviewScript=fileURLToPath(new URL('../scripts/review-material.mjs',import.meta.url));
const hasGit=spawnSync('git',['--version'],{encoding:'utf8'}).status===0;
const workRoot=()=>{
  const root=process.env.WISH_DEV_RUNTIME_ROOT??path.join(os.tmpdir(),'wish-dev');
  fs.mkdirSync(root,{recursive:true});
  return root;
};
function makeRepo(){
  // The classic layer-coverage fixture: one file per layer the tests expect, on top of
  // the shared initRepo setup (init + config + write + base commit).
  return initRepo({
    'src/a.js':'const a=1\n',
    'src/keep.js':'const k=1\n',
    'src/unstaged.js':'const u=1\n',
    'src/userdirty.js':'const x=1\n',
    'docs/note.md':'note one\n'
  });
}
const runTool=args=>spawnSync(process.execPath,[reviewScript,...args],{encoding:'utf8'});

test('review material covers every layer of uncommitted work',t=>{
  if(!hasGit){t.skip('git unavailable');return;}
  const {dir,git,write}=makeRepo();
  const name=path.basename(dir);
  const snap=path.join(workRoot(),name+'-snap.json');
  const out=path.join(workRoot(),name+'-material.md');
  try{
    // The user's own edits exist before the task starts.
    write('src/unstaged.js','const u=2\n');
    write('src/userdirty.js','const x=2\n');
    write('docs/note.md','note two\n');
    assert.equal(runTool(['snapshot','--repo',dir,'--out',snap,'--scope','src/**']).status,0);
    // Task work after the snapshot: one of each layer.
    write('src/committed.js','const c=1\n');git('add','src/committed.js');git('commit','-q','-m','task');
    write('src/staged.js','const s=1\n');git('add','src/staged.js');
    write('src/a.js','const a=2\n');
    write('src/userdirty.js','const x=3\n');
    fs.rmSync(path.join(dir,'src','keep.js'));
    write('src/new.js','const n=1\n');
    const result=runTool(['collect','--repo',dir,'--out',out,'--snapshot',snap,'--scope','src/**','--label','T-1-01']);
    assert.equal(result.status,0,result.stdout);
    const data=JSON.parse(result.stdout);
    const files=list=>list.map(entry=>entry.file).sort();
    assert.deepEqual(data.committed,['src/committed.js']);
    assert.deepEqual(data.staged,['src/staged.js']);
    assert.ok(data.unstaged.includes('src/a.js'));
    assert.ok(data.unstaged.includes('src/keep.js'));
    assert.deepEqual(data.untracked,['src/new.js']);
    assert.deepEqual(data.deleted,['src/keep.js']);
    assert.deepEqual(files(data.task),['src/a.js','src/committed.js','src/keep.js','src/new.js','src/staged.js']);
    assert.deepEqual(files(data.pre_existing),['src/unstaged.js']);
    assert.deepEqual(files(data.pre_existing_also_modified),['src/userdirty.js']);
    assert.ok(files(data.out_of_scope).includes('docs/note.md'));
    const material=fs.readFileSync(out,'utf8');
    assert.ok(material.includes('const n=1'),'untracked content must be included');
    assert.ok(material.includes('src/keep.js（工作区，任务期间删除）'));
    assert.ok(!material.includes('note two'),'out-of-scope diff must not enter the task material');
    assert.ok(!material.includes('-const u=1'),'an untouched pre-existing edit is not task delivery');
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
    fs.rmSync(snap,{force:true});fs.rmSync(out,{force:true});
  }
});

test('review material without a snapshot flags the attribution gap',t=>{
  if(!hasGit){t.skip('git unavailable');return;}
  const {dir,write}=makeRepo();
  const out=path.join(workRoot(),path.basename(dir)+'-material.md');
  try{
    write('src/a.js','const a=2\n');
    const result=runTool(['collect','--repo',dir,'--out',out,'--scope','src/**']);
    assert.equal(result.status,0,result.stdout);
    const data=JSON.parse(result.stdout);
    assert.equal(data.snapshot_used,false);
    assert.equal(data.integrity.status,'incomplete','without a baseline the attribution cannot be verified');
    assert.ok(data.notes.some(note=>note.includes('未提供基线快照')));
    const material=fs.readFileSync(out,'utf8');
    assert.ok(material.includes('未提供'));
    assert.ok(material.includes('- 完整性：incomplete'),'the header must not claim a complete material');
  }finally{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(out,{force:true});}
});

test('without Git or a snapshot, empty states read as undeterminable instead of claiming absence',()=>{
  const dir=fs.mkdtempSync(path.join(workRoot(),'nogit-'));
  const out=path.join(workRoot(),path.basename(dir)+'-material.md');
  try{
    fs.mkdirSync(path.join(dir,'src'),{recursive:true});
    fs.writeFileSync(path.join(dir,'src','a.js'),'a\n');
    const result=runTool(['collect','--repo',dir,'--out',out,'--scope','src/**']);
    assert.equal(result.status,0,result.stdout);
    const data=JSON.parse(result.stdout);
    assert.equal(data.mode,'snapshot');
    assert.equal(data.snapshot_used,false);
    assert.equal(data.integrity.status,'incomplete');
    const material=fs.readFileSync(out,'utf8');
    assert.ok(material.includes('未提供基线快照：无 Git 模式下没有可比较的基线，无法检测任务期间的变化'),
      'the note must not promise a file listing nothing produces');
    assert.ok(!material.includes('只列出当前文件清单与指纹'),'the old inaccurate note must be gone');
    // Nothing was detectable, so no section may claim that changes are absent.
    assert.ok(!material.includes('（无修改；'),'section 3 must not claim no modifications');
    assert.ok(!material.includes('（无未跟踪文件）'),'section 4 must not claim no additions');
    assert.ok(!material.includes('（无删除）'),'section 5 must not claim no deletions');
    assert.ok(!material.includes('\n（无）'),'sections 6/7 must not claim absence');
    assert.ok(material.includes('（无基线快照：无法判断任务期间是否修改，见第 8 节）'));
    assert.ok(material.includes('（无基线快照：无法判断任务期间是否新增，见第 8 节）'));
    assert.ok(material.includes('（无基线快照：无法判断任务期间是否删除，见第 8 节）'));
    assert.ok(material.includes('（无基线快照：无法判断任务前是否已有改动，见第 8 节）'));
    assert.ok(material.includes('（无基线快照：无法判断任务期间是否发生任何变化，无从按范围归属，见第 8 节）'));
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
    fs.rmSync(out,{force:true});
  }
});

test('without Git, snapshots and fingerprints cover additions, edits and deletions',()=>{
  const dir=fs.mkdtempSync(path.join(workRoot(),'nogit-'));
  const name=path.basename(dir);
  const snap=path.join(workRoot(),name+'-snap.json');
  const out=path.join(workRoot(),name+'-material.md');
  try{
    fs.mkdirSync(path.join(dir,'src'),{recursive:true});
    fs.writeFileSync(path.join(dir,'src','keep.js'),'k\n');
    fs.writeFileSync(path.join(dir,'src','edit.js'),'v1\n');
    assert.equal(runTool(['snapshot','--repo',dir,'--out',snap,'--scope','src/**']).status,0);
    fs.writeFileSync(path.join(dir,'src','edit.js'),'v2\n');
    fs.rmSync(path.join(dir,'src','keep.js'));
    fs.writeFileSync(path.join(dir,'src','added.js'),'n\n');
    const result=runTool(['collect','--repo',dir,'--out',out,'--snapshot',snap,'--scope','src/**']);
    assert.equal(result.status,0,result.stdout);
    const data=JSON.parse(result.stdout);
    assert.equal(data.mode,'snapshot');
    assert.deepEqual(data.untracked,['src/added.js']);
    assert.deepEqual(data.unstaged,['src/edit.js']);
    assert.deepEqual(data.deleted,['src/keep.js']);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
    fs.rmSync(snap,{force:true});fs.rmSync(out,{force:true});
  }
});

test('non-Git collect keeps a bogus .git out of the manifest like snapshot does', () => {
  const dir = fs.mkdtempSync(path.join(workRoot(), 'nogit-dotgit-'));
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    // A garbage gitfile makes git reject the directory, so collect runs in non-Git mode
    // while a .git entry still exists on disk.
    fs.writeFileSync(path.join(dir, '.git'), 'garbage\n');
    fs.mkdirSync(path.join(dir, 'src'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'b\n');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.deepEqual(data.untracked, ['src/b.js']);
    const listed = [...data.untracked, ...data.unstaged, ...data.deleted,
      ...data.out_of_scope.map(entry => entry.file), ...data.unscoped.map(entry => entry.file)];
    assert.ok(!listed.some(file => file === '.git' || file.startsWith('.git/')),
      'the .git entry must stay out of the collect manifest, as it does in snapshot');
  } finally { wipe(dir, snap, out); }
});

test('resolveReal expands Windows 8.3 short-name components', t => {
  if (process.platform !== 'win32') { t.skip('Windows-specific behaviour'); return; }
  const probe = 'C:\\PROGRA~1';
  if (!fs.existsSync(probe)) { t.skip('C:\\PROGRA~1 not present on this machine'); return; }
  const expanded = review.resolveReal(probe);
  assert.ok(!/~\d/.test(expanded), 'the 8.3 alias must be expanded: ' + expanded);
  assert.equal(expanded.toLowerCase(), fs.realpathSync.native('C:\\Program Files').toLowerCase());
});

test('the output guard holds when the sandbox path carries an 8.3 short name', t => {
  if (process.platform !== 'win32') { t.skip('Windows-specific behaviour'); return; }
  if (!hasGit) { t.skip('git unavailable'); return; }
  const longBase = fs.mkdtempSync(path.join(workRoot(), 'eight-three-probe-'));
  const repo = path.join(longBase, 'repo');
  const snap = path.join(workRoot(), path.basename(longBase) + '-snap.json');
  try {
    // Ask the filesystem for the 8.3 alias of the fresh sandbox directory.
    const ps = spawnSync('powershell.exe',
      ['-NoProfile', '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${longBase.replaceAll("'", "''")}').ShortPath`],
      {encoding: 'utf8'});
    const shortBase = (ps.stdout || '').trim();
    if (!shortBase.includes('~')) {
      t.skip('no 8.3 alias generated on this volume; end-to-end short-name guard not exercised');
      return;
    }
    const git = (...args) => {
      const result = spawnSync('git', args, {cwd: repo, encoding: 'utf8'});
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
      return result;
    };
    fs.mkdirSync(repo, {recursive: true});
    git('init', '-q'); git('config', 'user.email', 'eval@example.invalid');
    git('config', 'user.name', 'eval'); git('config', 'core.autocrlf', 'false');
    fs.mkdirSync(path.join(repo, 'src'), {recursive: true});
    fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n');
    git('add', '-A'); git('commit', '-q', '-m', 'base');
    // git canonicalises the short spelling to the expanded form; the guard must still
    // recognise an in-repository --out written with the short spelling (CI runners hit
    // this via C:\Users\RUNNER~1 in TMP).
    const shortRepo = path.join(shortBase, 'repo');
    assert.equal(runTool(['snapshot', '--repo', shortRepo, '--out', snap, '--scope', 'src/**']).status, 0);
    const inside = runTool(['collect', '--repo', shortRepo, '--out', path.join(shortRepo, 'material.md'), '--snapshot', snap]);
    assert.equal(inside.status, 2, 'an in-repository --out must be refused even in 8.3 spelling');
    assert.ok(JSON.parse(inside.stdout).errors.some(message => message.includes('outside the repository')));
    assert.equal(fs.existsSync(path.join(repo, 'material.md')), false, 'no file may be created inside the repository');
  } finally { wipe(longBase, snap); }
});

test('review scope globs stay segment aware',()=>{
  assert.ok(review.globToRegExp('src/**').test('src/a/b.js'));
  assert.ok(!review.globToRegExp('src/*.js').test('src/a/b.js'));
  assert.ok(review.globToRegExp('src/*.js').test('src/a.js'));
  assert.ok(!review.globToRegExp('src/**').test('docs/a.md'));
  assert.ok(review.globToRegExp('src/').test('src/a/b.js'));
});

// ---- 评审材料边界回归（复现自复审：中文路径、分层基线、scope、无 Git、删除/重命名）----
function initRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(workRoot(), 'rm-'));
  const git = (...args) => {
    const result = spawnSync('git', args, {cwd: dir, encoding: 'utf8'});
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result;
  };
  git('init', '-q');
  git('config', 'user.email', 'eval@example.invalid');
  git('config', 'user.name', 'eval');
  git('config', 'core.autocrlf', 'false');
  const write = (name, body) => {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, body);
  };
  for (const [name, body] of Object.entries(files)) write(name, body);
  if (Object.keys(files).length) {
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
  }
  return {dir, git, write};
}
const wipe = (...paths) => { for (const target of paths) fs.rmSync(target, {recursive: true, force: true}); };
const runOk = args => {
  const result = runTool(args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
};
const materialOf = file => fs.readFileSync(file, 'utf8');
const layers = (list, file) => list.filter(entry => entry.file === file).map(entry => entry.layer);

test('committed Chinese paths stay in scope and reach the material', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/中文.js': 'const v = 1;\n', 'README.md': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/中文.js', 'const v = 2; // 中文修改标记\n');
    git('add', '-A'); git('commit', '-q', '-m', 'task');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap, '--label', 'T-1-01']);
    assert.deepEqual(data.committed, ['src/中文.js']);
    assert.deepEqual(data.out_of_scope, []);
    assert.deepEqual(data.task.map(entry => entry.file), ['src/中文.js']);
    const material = materialOf(out);
    assert.ok(material.includes('中文修改标记'), 'material must contain the real Chinese-path diff');
    assert.ok(material.includes('src/中文.js'));
    assert.ok(!/\\[0-7]{3}/.test(material), 'quoted octal escapes must not appear');
  } finally { wipe(dir, snap, out); }
});

test('paths with spaces and brackets are attributed verbatim', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/a b.js': 'const s = 1;\n', 'src/括号(1).js': 'const p = 1;\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/a b.js', 'const s = 2; // spaced\n');
    write('src/括号(1).js', 'const p = 2; // bracketed\n');
    git('add', '-A'); git('commit', '-q', '-m', 'task');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.deepEqual(data.committed.sort(), ['src/a b.js', 'src/括号(1).js'].sort());
    assert.deepEqual(data.out_of_scope, []);
    const material = materialOf(out);
    assert.ok(material.includes('// spaced'));
    assert.ok(material.includes('// bracketed'));
  } finally { wipe(dir, snap, out); }
});

test('staging task content while restoring the user worktree still shows the index change', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/a.js': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/a.js', 'USER_WORKTREE\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/a.js', 'TASK_STAGED\n');
    git('add', 'src/a.js');
    write('src/a.js', 'USER_WORKTREE\n');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.ok(data.staged.includes('src/a.js'));
    assert.ok(layers(data.pre_existing_also_modified, 'src/a.js').includes('index'),
      'the staged layer must be kept as mixed, not filtered by the unchanged worktree digest');
    assert.deepEqual(layers(data.pre_existing, 'src/a.js'), []);
    const material = materialOf(out);
    assert.ok(material.includes('TASK_STAGED'), 'material must contain the staged task content');
    assert.ok(material.includes('mixed') || material.includes('须协调者核对'));
  } finally { wipe(dir, snap, out); }
});

test('pre-existing user content is kept out of task delivery but a commit of it stays visible', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/a.js': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/a.js', 'USER_EDIT\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    git('add', '-A'); git('commit', '-q', '-m', 'commit user content');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.deepEqual(data.committed, ['src/a.js']);
    assert.deepEqual(data.task, []);
    assert.ok(layers(data.pre_existing, 'src/a.js').includes('committed'));
    const material = materialOf(out);
    assert.ok(material.includes('USER_EDIT'), 'committed user content must remain reviewable');
    assert.ok(material.includes('不计入本任务实现内容'));
  } finally { wipe(dir, snap, out); }
});

test('commit followed by further edits keeps both layers', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/a.js': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/a.js', 'TASK_COMMIT\n');
    git('add', '-A'); git('commit', '-q', '-m', 'task');
    write('src/a.js', 'TASK_WORKTREE\n');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.ok(layers(data.task, 'src/a.js').includes('committed'));
    assert.ok(layers(data.task, 'src/a.js').includes('worktree'));
    const material = materialOf(out);
    assert.ok(material.includes('TASK_COMMIT'));
    assert.ok(material.includes('TASK_WORKTREE'));
  } finally { wipe(dir, snap, out); }
});

test('staging unchanged user content is recorded as pre-existing, not as task work', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/a.js': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/a.js', 'USER_EDIT\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    git('add', 'src/a.js');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.deepEqual(data.task, []);
    assert.ok(layers(data.pre_existing, 'src/a.js').includes('index'));
    assert.ok(materialOf(out).includes('仅暂存状态变化') || materialOf(out).includes('仅位置/状态变化'));
  } finally { wipe(dir, snap, out); }
});

test('scope globs keep file boundaries and directory depth', () => {
  const match = pattern => review.globToRegExp(pattern);
  assert.ok(match('src/**/a.js').test('src/a.js'), 'zero directories');
  assert.ok(match('src/**/a.js').test('src/x/a.js'), 'one directory');
  assert.ok(match('src/**/a.js').test('src/x/y/a.js'), 'many directories');
  assert.ok(!match('src/**/a.js').test('src/not-a.js'), 'must not swallow a file prefix');
  assert.ok(!match('src/**/a.js').test('src/x/not-a.js'), 'must not match a longer file name');
  assert.ok(!match('src/*.js').test('src/x/a.js'), 'single star stays inside a segment');
  assert.ok(match('src/*.js').test('src/a.js'));
  assert.ok(match('src/**').test('src/x/y.js'));
  assert.ok(!match('src/**').test('srcx/y.js'));
});

test('an explicit empty scope claims nothing while an unspecified scope is reported', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, write} = initRepo({'src/a.js': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-empty-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-empty.md');
  const snap2 = path.join(workRoot(), path.basename(dir) + '-none-snap.json');
  const out2 = path.join(workRoot(), path.basename(dir) + '-none.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', '']);
    write('src/new.js', 'NEW_EMPTY_SCOPE\n');
    const empty = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.equal(empty.scope_mode, 'empty');
    assert.deepEqual(empty.task, []);
    assert.ok(empty.out_of_scope.some(entry => entry.file === 'src/new.js'));
    assert.ok(materialOf(out).includes('显式空范围'));

    runOk(['snapshot', '--repo', dir, '--out', snap2]);
    write('src/another.js', 'NEW_UNSPECIFIED\n');
    const unspecified = runOk(['collect', '--repo', dir, '--out', out2, '--snapshot', snap2]);
    assert.equal(unspecified.scope_mode, 'unspecified');
    assert.deepEqual(unspecified.task, []);
    assert.ok(unspecified.unscoped.length > 0);
    assert.ok(materialOf(out2).includes('未声明写入范围'));
  } finally { wipe(dir, snap, out, snap2, out2); }
});

test('an unspecified scope shows the content instead of claiming no change',t=>{
  if(!hasGit){t.skip('git unavailable');return;}
  const {dir,write}=makeRepo();
  const tag=path.basename(dir);
  const snap=path.join(workRoot(),tag+'-unspec-snap.json');
  const out=path.join(workRoot(),tag+'-unspec.md');
  try{
    runTool(['snapshot','--repo',dir,'--out',snap]);
    write('src/a.js','const a=9\n');
    const data=JSON.parse(runTool(['collect','--repo',dir,'--out',out,'--snapshot',snap]).stdout);
    assert.equal(data.scope_mode,'unspecified');
    const material=fs.readFileSync(out,'utf8');
    assert.ok(!material.includes('（无未暂存变化）'),'a layer holding unscoped work must not be reported as no change');
    assert.ok(material.includes('另有 1 项范围外/未声明范围变化'),'the layer must point at section 7');
    assert.ok(material.includes('const a=9'),'unscoped content is the only reviewable material and must be shown');
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
    fs.rmSync(snap,{force:true});fs.rmSync(out,{force:true});
  }
});

test('an out-of-scope write is flagged in its layer but stays out of the material',t=>{
  if(!hasGit){t.skip('git unavailable');return;}
  const {dir,write}=makeRepo();
  const tag=path.basename(dir);
  const snap=path.join(workRoot(),tag+'-outsnap.json');
  const out=path.join(workRoot(),tag+'-out.md');
  try{
    runTool(['snapshot','--repo',dir,'--out',snap,'--scope','src/**']);
    write('docs/note.md','OUT_OF_SCOPE_BODY\n');
    const data=JSON.parse(runTool(['collect','--repo',dir,'--out',out,'--snapshot',snap]).stdout);
    assert.ok(data.out_of_scope.some(entry=>entry.file==='docs/note.md'));
    const material=fs.readFileSync(out,'utf8');
    assert.ok(!material.includes('（无未暂存变化）'),'the worktree layer holds an excluded change');
    assert.ok(material.includes('另有 1 项范围外/未声明范围变化'));
    assert.ok(!material.includes('OUT_OF_SCOPE_BODY'),'a declared scope keeps other lines out of the material');
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
    fs.rmSync(snap,{force:true});fs.rmSync(out,{force:true});
  }
});

test('a read-only task that wrote product files exposes them as not delivered',t=>{
  if(!hasGit){t.skip('git unavailable');return;}
  const {dir,write}=makeRepo();
  const tag=path.basename(dir);
  const snap=path.join(workRoot(),tag+'-empty-snap.json');
  const out=path.join(workRoot(),tag+'-empty-readonly.md');
  try{
    runTool(['snapshot','--repo',dir,'--out',snap,'--scope','']);
    write('src/rogue.js','ROGUE_WRITE\n');
    const data=JSON.parse(runTool(['collect','--repo',dir,'--out',out,'--snapshot',snap]).stdout);
    assert.equal(data.scope_mode,'empty');
    assert.ok(data.out_of_scope.some(entry=>entry.file==='src/rogue.js'));
    const material=fs.readFileSync(out,'utf8');
    assert.ok(material.includes('显式空范围'));
    assert.ok(material.includes('ROGUE_WRITE'),'a read-only task that wrote product files must show the evidence');
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
    fs.rmSync(snap,{force:true});fs.rmSync(out,{force:true});
  }
});

test('without Git an unspecified scope still reports the change in section 3',t=>{
  const dir=fs.mkdtempSync(path.join(workRoot(),'review-nogit-'));
  const tag=path.basename(dir);
  const snap=path.join(workRoot(),tag+'-snap.json');
  const out=path.join(workRoot(),tag+'-m.md');
  try{
    fs.writeFileSync(path.join(dir,'a.txt'),'v1\n');
    runTool(['snapshot','--repo',dir,'--out',snap]);
    fs.writeFileSync(path.join(dir,'a.txt'),'v2\n');
    const data=JSON.parse(runTool(['collect','--repo',dir,'--out',out,'--snapshot',snap]).stdout);
    assert.equal(data.mode,'snapshot');
    assert.equal(data.scope_mode,'unspecified');
    const material=fs.readFileSync(out,'utf8');
    assert.ok(!material.includes('（无修改；新增见第 4 节，删除见第 5 节）'),'a changed file must not be reported as no modification');
    assert.ok(material.includes('该层另有 1 项范围外/未声明范围变化'));
    assert.ok(material.includes('v2'),'the changed body must stay visible');
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
    fs.rmSync(snap,{force:true});fs.rmSync(out,{force:true});
  }
});

test('an unspecified scope keeps task-start changes out of none and out of task content',t=>{
  if(!hasGit){t.skip('git unavailable');return;}
  const {dir,write}=makeRepo();
  const tag=path.basename(dir);
  const snap=path.join(workRoot(),tag+'-pre-snap.json');
  const out=path.join(workRoot(),tag+'-pre.md');
  try{
    write('src/userdirty.js','const dirty=1\n');
    runTool(['snapshot','--repo',dir,'--out',snap]);
    const data=JSON.parse(runTool(['collect','--repo',dir,'--out',out,'--snapshot',snap]).stdout);
    assert.equal(data.scope_mode,'unspecified');
    const material=fs.readFileSync(out,'utf8');
    const section6=material.split('## 6.')[1].split('## 7.')[0];
    assert.ok(!section6.includes('（无）'),'task-start changes exist even when the scope cannot attribute them');
    assert.ok(section6.includes('第 7 节列有'),'section 6 must point at the unscoped records');
    assert.ok(!material.includes('const dirty=1'),'an untouched task-start body is not task content');
    assert.ok(material.includes('任务开始时已是该内容，本次未变化'));
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
    fs.rmSync(snap,{force:true});fs.rmSync(out,{force:true});
  }
});

test('a rename staged before the snapshot is attributed to the user, not the task',t=>{
  if(!hasGit){t.skip('git unavailable');return;}
  const {dir,git}=makeRepo();
  const tag=path.basename(dir);
  const snap=path.join(workRoot(),tag+'-mv-snap.json');
  const out=path.join(workRoot(),tag+'-mv.md');
  try{
    // The user renamed a file and staged it before the task started.
    git('mv','src/a.js','src/a-renamed.js');
    runTool(['snapshot','--repo',dir,'--out',snap,'--scope','src/**']);
    // The task does nothing after the snapshot.
    const data=JSON.parse(runTool(['collect','--repo',dir,'--out',out,'--snapshot',snap]).stdout);
    assert.deepEqual(data.task,[],'nothing was delivered after the snapshot');
    assert.deepEqual(data.pre_existing.filter(entry=>entry.layer==='baseline').map(entry=>entry.file).sort(),
      ['src/a-renamed.js','src/a.js'],'the pre-existing rename belongs to the user');
    const material=fs.readFileSync(out,'utf8');
    assert.ok(material.includes('（无暂存变化）'),'a pre-existing rename is not a task change');
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
    fs.rmSync(snap,{force:true});fs.rmSync(out,{force:true});
  }
});

test('a read-only task that deleted and renamed files counts files, not layer records',t=>{
  if(!hasGit){t.skip('git unavailable');return;}
  const {dir,git}=makeRepo();
  const tag=path.basename(dir);
  const snap=path.join(workRoot(),tag+'-ro-snap.json');
  const out=path.join(workRoot(),tag+'-ro.md');
  try{
    runTool(['snapshot','--repo',dir,'--out',snap,'--scope','']);
    fs.rmSync(path.join(dir,'src','keep.js'));
    git('mv','src/a.js','src/a-moved.js');
    const data=JSON.parse(runTool(['collect','--repo',dir,'--out',out,'--snapshot',snap]).stdout);
    assert.equal(data.scope_mode,'empty');
    const material=fs.readFileSync(out,'utf8');
    // Two files were deleted at their old paths (a.js via rename, keep.js outright); the layer
    // records are three. The summary must not inflate the count.
    assert.ok(material.includes('另有 2 个文件的范围外/未声明范围删除'),'count distinct files, not records');
    assert.ok(material.includes('显式空范围'));
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
    fs.rmSync(snap,{force:true});fs.rmSync(out,{force:true});
  }
});

test('without Git the material shows before/after fingerprints and current content', () => {
  const dir = fs.mkdtempSync(path.join(workRoot(), 'nogit-'));
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/a.js'), 'old\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    fs.writeFileSync(path.join(dir, 'src/a.js'), 'NEW_NOGIT_MARKER\n');
    fs.writeFileSync(path.join(dir, 'src/added.js'), 'ADDED_NOGIT\n');
    fs.rmSync(path.join(dir, 'src/keep-none.js'), {force: true});
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.equal(data.mode, 'snapshot');
    assert.deepEqual(data.unstaged, ['src/a.js']);
    assert.deepEqual(data.untracked, ['src/added.js']);
    const material = materialOf(out);
    assert.ok(material.includes('NEW_NOGIT_MARKER'), 'modified content or an equivalent snapshot entry is required');
    assert.ok(material.includes('ADDED_NOGIT'));
    assert.ok(material.includes('基线指纹') && material.includes('当前指纹'));
    const digests = [...material.matchAll(/[0-9a-f]{12}…/g)].map(match => match[0]);
    assert.ok(new Set(digests).size >= 2, 'before and after digests must be distinguishable');
  } finally { wipe(dir, snap, out); }
});

test('a repository without commits still reports content and fingerprints', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, write} = initRepo();
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/a.js', 'INITIAL_USER\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/a.js', 'MODIFIED_AFTER_SNAPSHOT\n');
    write('src/b.js', 'SECOND_FILE\n');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.equal(data.base, null);
    assert.ok(data.notes.some(note => note.includes('BASE')));
    const material = materialOf(out);
    assert.ok(material.includes('SECOND_FILE'));
    assert.ok(material.includes('MODIFIED_AFTER_SNAPSHOT'));
    assert.ok(material.includes('mixed') || material.includes('须协调者核对'));
  } finally { wipe(dir, snap, out); }
});

test('a committed deletion includes the original content', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git} = initRepo({'src/delete.js': 'DELETE_ORIGINAL\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    fs.rmSync(path.join(dir, 'src/delete.js'));
    git('add', '-A'); git('commit', '-q', '-m', 'delete');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.ok(data.deleted.includes('src/delete.js'));
    const material = materialOf(out);
    assert.ok(material.includes('DELETE_ORIGINAL'), 'the deleted baseline content must be reviewable');
    assert.ok(material.includes('任务期间删除'));
  } finally { wipe(dir, snap, out); }
});

test('staged and unstaged deletions are both reported', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git} = initRepo({'src/staged.js': 'STAGED_BODY\n', 'src/worktree.js': 'WORKTREE_BODY\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    git('rm', '-q', 'src/staged.js');
    fs.rmSync(path.join(dir, 'src/worktree.js'));
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.ok(data.deleted.includes('src/staged.js'));
    assert.ok(data.deleted.includes('src/worktree.js'));
    const material = materialOf(out);
    assert.ok(material.includes('src/staged.js') && material.includes('src/worktree.js'));
    assert.ok(material.includes('STAGED_BODY'));
  } finally { wipe(dir, snap, out); }
});

test('a staged rename reports the old deletion and the new addition', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git} = initRepo({'src/old.js': 'RENAME_BODY\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    git('mv', 'src/old.js', 'src/new.js');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.deepEqual(data.renamed, [{from: 'src/old.js', file: 'src/new.js', layer: 'index'}]);
    assert.ok(data.deleted.includes('src/old.js'));
    const material = materialOf(out);
    assert.ok(material.includes('src/old.js') && material.includes('src/new.js'));
  } finally { wipe(dir, snap, out); }
});

test('a file untracked at the baseline keeps its origin when later committed', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/tracked.js': 'x\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/draft-same.js', 'USER_DRAFT_SAME\n');
    write('src/draft-edit.js', 'USER_DRAFT_OLD\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/draft-edit.js', 'TASK_EDITED_DRAFT\n');
    git('add', '-A'); git('commit', '-q', '-m', 'commit drafts');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.ok(layers(data.pre_existing, 'src/draft-same.js').includes('committed'));
    assert.ok(layers(data.pre_existing_also_modified, 'src/draft-edit.js').includes('committed'));
    const material = materialOf(out);
    assert.ok(material.includes('USER_DRAFT_SAME'));
    assert.ok(material.includes('TASK_EDITED_DRAFT'));
  } finally { wipe(dir, snap, out); }
});

test('a snapshot from another repository is refused', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const first = initRepo({'src/a.js': 'a\n'});
  const second = initRepo({'src/a.js': 'b\n'});
  const snap = path.join(workRoot(), path.basename(first.dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(second.dir) + '-material.md');
  try {
    runOk(['snapshot', '--repo', first.dir, '--out', snap, '--scope', 'src/**']);
    const result = runTool(['collect', '--repo', second.dir, '--out', out, '--snapshot', snap]);
    assert.equal(result.status, 2);
    assert.ok(JSON.parse(result.stdout).errors.some(message => message.includes('another repository')));
    assert.equal(fs.existsSync(out), false);
  } finally { wipe(first.dir, second.dir, snap, out); }
});

test('collect refuses a widened scope, a conflicting base and unsafe outputs', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir} = initRepo({'src/a.js': 'a\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    const widened = runTool(['collect', '--repo', dir, '--out', out, '--snapshot', snap, '--scope', '**']);
    assert.equal(widened.status, 2);
    assert.ok(JSON.parse(widened.stdout).errors.some(message => message.includes('scope differs')));

    const conflicting = runTool(['collect', '--repo', dir, '--out', out, '--snapshot', snap, '--base', 'b'.repeat(40)]);
    assert.equal(conflicting.status, 2);
    assert.ok(JSON.parse(conflicting.stdout).errors.some(message => message.includes('conflicts')));

    const inside = runTool(['collect', '--repo', dir, '--out', path.join(dir, 'material.md'), '--snapshot', snap]);
    assert.equal(inside.status, 2);
    assert.ok(JSON.parse(inside.stdout).errors.some(message => message.includes('outside the repository')));

    const snapshotBytes = fs.readFileSync(snap);
    const overwrite = runTool(['collect', '--repo', dir, '--out', snap, '--snapshot', snap]);
    assert.equal(overwrite.status, 2);
    assert.ok(JSON.parse(overwrite.stdout).errors.some(message => message.includes('overwrite the baseline')));
    assert.deepEqual(fs.readFileSync(snap), snapshotBytes, 'the baseline bytes must not change');
  } finally { wipe(dir, snap, out); }
});

test('snapshot refuses to overwrite an existing baseline', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir} = initRepo({'src/a.js': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    const bytes = fs.readFileSync(snap);
    const second = runTool(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    assert.equal(second.status, 2, 're-snapshotting onto the same file must be refused');
    assert.ok(JSON.parse(second.stdout).errors.some(message => message.includes('already exists')));
    assert.deepEqual(fs.readFileSync(snap), bytes, 'the original baseline bytes must not change');
  } finally { wipe(dir, snap); }
});

// ---- 复审第三轮回归：撤销用户改动、首次提交、输出越界、跨范围重命名、完整性 ----
test('reverting a user edit to HEAD is reported, not marked unchanged', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/a.js': 'HEAD_CONTENT\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/a.js', 'USER_CHANGE\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/a.js', 'HEAD_CONTENT\n');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.deepEqual(layers(data.pre_existing_also_modified, 'src/a.js'), ['worktree']);
    assert.deepEqual(layers(data.pre_existing, 'src/a.js'), []);
    const material = materialOf(out);
    assert.ok(material.includes('任务开始时已有改动'), 'the change must be flagged as mixed');
    assert.ok(/基线指纹：[0-9a-f]{12}…/.test(material), 'the baseline digest must be shown');
    assert.ok(material.includes('HEAD_CONTENT'), 'the current content must be shown');
    assert.ok(!/- src\/a\.js（任务开始时）/.test(material), 'must not claim it was unchanged');
    assert.ok(!material.includes('（任务开始时）：任务开始时已改动，本次未变化'));
  } finally { wipe(dir, snap, out); }
});

test('reverting a staged user edit reports both layers', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/a.js': 'HEAD_CONTENT\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/a.js', 'USER_STAGED\n');
    git('add', 'src/a.js');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/a.js', 'HEAD_CONTENT\n');
    git('add', 'src/a.js');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    // Index and worktree were both restored to HEAD, so the index layer carries the change
    // and the worktree no longer has an independent difference.
    assert.ok(layers(data.pre_existing_also_modified, 'src/a.js').includes('index'));
    const material = materialOf(out);
    assert.ok(material.includes('基线指纹') && material.includes('HEAD_CONTENT'));
    assert.ok(material.includes('任务开始时已有改动'));
    assert.ok(!material.includes('（任务开始时）：任务开始时已改动，本次未变化'));
  } finally { wipe(dir, snap, out); }
});

test('deleting a file that was untracked at the baseline is reported', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, write} = initRepo({'src/tracked.js': 'x\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/draft.js', 'USER_DRAFT\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    fs.rmSync(path.join(dir, 'src/draft.js'));
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.ok(layers(data.pre_existing_also_modified, 'src/draft.js').includes('worktree'));
    const material = materialOf(out);
    assert.ok(material.includes('src/draft.js'), 'the deletion must be listed');
    assert.ok(material.includes('任务开始时已存在'), 'the deleted content was not written by the task');
  } finally { wipe(dir, snap, out); }
});

test('a baseline edit that really did not change is still described as such', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, write} = initRepo({'src/a.js': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/a.js', 'USER_EDIT\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.deepEqual(data.task, []);
    assert.ok(layers(data.pre_existing, 'src/a.js').includes('baseline'));
    assert.ok(materialOf(out).includes('任务开始时已改动，本次未变化'));
  } finally { wipe(dir, snap, out); }
});

test('a snapshot with no commit compares the first commit against the empty tree', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo();
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/a.js', 'BEFORE_FIRST\n');
    write('src/keep.js', 'KEEP_CONTENT\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/a.js', 'AFTER_FIRST\n');
    write('src/new.js', 'NEW_IN_FIRST\n');
    git('add', '-A'); git('commit', '-q', '-m', 'first');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.equal(data.base, null);
    assert.equal(data.base_kind, 'empty');
    assert.deepEqual(data.committed.sort(), ['src/a.js', 'src/keep.js', 'src/new.js']);
    assert.ok(layers(data.task, 'src/new.js').includes('committed'));
    assert.ok(layers(data.pre_existing, 'src/keep.js').includes('committed'),
      'a pre-existing file committed unchanged is not task-authored');
    assert.ok(layers(data.pre_existing_also_modified, 'src/a.js').includes('committed'));
    const material = materialOf(out);
    for (const marker of ['NEW_IN_FIRST', 'AFTER_FIRST', 'KEEP_CONTENT']) {
      assert.ok(material.includes(marker), 'material must contain ' + marker);
    }
    assert.ok(material.includes('空树'));

    write('src/a.js', 'STAGED_AFTER\n');
    git('add', 'src/a.js');
    write('src/later.js', 'LATER_UNTRACKED\n');
    const second = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.ok(second.staged.includes('src/a.js'));
    assert.ok(second.untracked.includes('src/later.js'));
    const text = materialOf(out);
    assert.ok(text.includes('STAGED_AFTER') && text.includes('LATER_UNTRACKED'));
  } finally { wipe(dir, snap, out); }
});

test('output guard refuses repository paths including a ..name directory', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir} = initRepo({'src/a.js': 'a\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const outside = path.join(workRoot(), path.basename(dir) + '-material.md');
  const link = path.join(workRoot(), path.basename(dir) + '-link');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    const victimDir = path.join(dir, '..internal');
    fs.mkdirSync(victimDir, {recursive: true});
    const victim = path.join(victimDir, 'victim.txt');
    fs.writeFileSync(victim, 'ORIGINAL\n');
    const rejected = [
      {out: path.join(dir, 'material.md'), file: null},
      {out: victim, file: victim},
    ];
    for (const item of rejected) {
      const before = item.file ? fs.readFileSync(item.file) : null;
      const result = runTool(['collect', '--repo', dir, '--out', item.out, '--snapshot', snap]);
      assert.equal(result.status, 2, item.out);
      assert.ok(JSON.parse(result.stdout).errors.some(message => message.includes('outside the repository')));
      if (item.file) assert.deepEqual(fs.readFileSync(item.file), before, 'the original bytes must not change');
      else assert.equal(fs.existsSync(item.out), false, 'no file may be created');
    }
    const snapshotBytes = fs.readFileSync(snap);
    const overwrite = runTool(['collect', '--repo', dir, '--out', snap, '--snapshot', snap]);
    assert.equal(overwrite.status, 2);
    assert.ok(JSON.parse(overwrite.stdout).errors.some(message => message.includes('overwrite the baseline')));
    assert.deepEqual(fs.readFileSync(snap), snapshotBytes, 'the baseline bytes must not change');
    const outsideRun = runOk(['collect', '--repo', dir, '--out', outside, '--snapshot', snap]);
    assert.equal(outsideRun.ok, true);
    assert.ok(fs.existsSync(outside));

    let linked = false;
    try {
      fs.symlinkSync(dir, link, 'junction');
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) {
      t.skip('junction/symlink creation unavailable on this platform: link guard not exercised');
    } else {
      const viaLink = path.join(link, 'material.md');
      const result = runTool(['collect', '--repo', dir, '--out', viaLink, '--snapshot', snap]);
      assert.equal(result.status, 2, 'a link resolving back into the repository must be refused');
      assert.equal(fs.existsSync(path.join(dir, 'material.md')), false);
    }
  } finally { wipe(dir, snap, outside); fs.rmSync(link, {recursive: true, force: true}); }
});

test('a rename from out of scope does not pull the excluded path into the diff', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const cases = [
    {name: 'out-to-in', from: 'docs/private.js', to: 'src/public.js', expectOutside: 'docs/private.js'},
    {name: 'in-to-out', from: 'src/secret.js', to: 'docs/secret.js', expectOutside: 'docs/secret.js'},
    {name: 'in-to-in', from: 'src/old.js', to: 'src/new.js', expectOutside: null},
  ];
  for (const scenario of cases) {
    const files = {};
    files[scenario.from] = 'RENAME_BODY_' + scenario.name.toUpperCase() + '\n';
    files['src/keep.js'] = 'k\n';
    files['docs/keep.md'] = 'd\n';
    const {dir, git} = initRepo(files);
    const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
    const out = path.join(workRoot(), path.basename(dir) + '-material.md');
    try {
      runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
      git('mv', scenario.from, scenario.to);
      const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
      const material = materialOf(out);
      assert.deepEqual(data.renamed, [{from: scenario.from, file: scenario.to, layer: 'index'}], scenario.name);
      if (scenario.expectOutside) {
        assert.ok(data.out_of_scope.some(entry => entry.file === scenario.expectOutside), scenario.name);
        assert.ok(!material.includes('diff --git a/' + scenario.expectOutside),
          scenario.name + ': an out-of-scope path must not be passed to git diff');
      }
      if (scenario.to.startsWith('src/')) assert.ok(material.includes('RENAME_BODY_' + scenario.name.toUpperCase()));
    } finally { wipe(dir, snap, out); }
  }
});

test('a committed rename keeps scope filtering after the commit', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git} = initRepo({'docs/private.js': 'COMMITTED_RENAME_BODY\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    fs.mkdirSync(path.join(dir, 'src'), {recursive: true});
    git('mv', 'docs/private.js', 'src/public.js');
    git('commit', '-q', '-m', 'rename');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.deepEqual(data.renamed, [{from: 'docs/private.js', file: 'src/public.js', layer: 'committed'}]);
    const material = materialOf(out);
    assert.ok(!material.includes('diff --git a/docs/private.js'));
    assert.ok(material.includes('COMMITTED_RENAME_BODY'));
  } finally { wipe(dir, snap, out); }
});

test('integrity marks binary content and keeps the header and summary in agreement', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/a.js': 'text\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/a.bin', 'BINARY\x00BYTES');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.equal(data.ok, true, 'ok only means the command ran');
    assert.equal(data.integrity.status, 'incomplete');
    assert.ok(data.integrity.limits.some(item => item.file === 'src/a.bin' && item.kind === 'binary'));
    const material = materialOf(out);
    assert.ok(material.includes('完整性：incomplete'));
    assert.ok(/incomplete: src\/a\.bin/.test(material));

    write('src/a.bin', 'BINARY2\x00BYTES');
    git('add', 'src/a.bin');
    write('src/a.bin', 'BINARY3\x00BYTES');
    const second = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.ok(second.integrity.limits.some(item => item.file === 'src/a.bin' && item.layer === 'index'));
    assert.ok(second.integrity.limits.some(item => item.file === 'src/a.bin' && item.layer === 'worktree'));
  } finally { wipe(dir, snap, out); }
});

test('truncated and oversized content are reported without unbounded buffering', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, write} = initRepo({'src/a.js': 'small\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    const big = 'X'.repeat(210 * 1024);
    write('src/big.txt', big);
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    const entry = data.integrity.limits.find(item => item.file === 'src/big.txt');
    assert.ok(entry, 'truncated text must be recorded');
    assert.equal(entry.kind, 'text');
    assert.equal(entry.reason, 'content truncated');
    const material = materialOf(out);
    assert.ok(material.includes('正文截断') || material.includes('content truncated'));

    write('src/huge.bin', Buffer.alloc(21 * 1024 * 1024, 7));
    const second = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    const huge = second.integrity.limits.find(item => item.file === 'src/huge.bin');
    assert.ok(huge, 'an unsupported blob size must be recorded');
    assert.equal(huge.kind, 'toolarge');
    assert.ok(materialOf(out).includes('incomplete: src/huge.bin'));
  } finally { wipe(dir, snap, out); }
});

test('a fully readable text change keeps integrity complete', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, write} = initRepo({'src/a.js': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/a.js', 'PLAIN_TEXT_CHANGE\n');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.equal(data.integrity.status, 'complete');
    assert.deepEqual(data.integrity.limits, []);
    assert.ok(materialOf(out).includes('PLAIN_TEXT_CHANGE'));
    assert.ok(!materialOf(out).includes('incomplete:'));
  } finally { wipe(dir, snap, out); }
});

// ---- 复审第四轮：同层补充材料、非 Git 删除指纹、索引/工作区分层归属 ----
test('a reverted file keeps its material when the same layer also has a normal diff', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, write} = initRepo({'src/a.js': 'HEAD_CONTENT_A\n', 'src/b.js': 'BASE_B\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/a.js', 'USER_CHANGE_A\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/a.js', 'HEAD_CONTENT_A\n');
    write('src/b.js', 'TASK_CHANGED_B\n');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    const material = materialOf(out);
    assert.ok(material.includes('TASK_CHANGED_B'), 'the normal diff must still be present');
    assert.ok(/基线指纹：[0-9a-f]{12}…/.test(material), 'the reverted file keeps a baseline digest');
    assert.ok(material.includes('HEAD_CONTENT_A'), 'the reverted file keeps its current content');
    assert.ok(material.includes('当前指纹：'), 'the reverted file keeps a current digest');
    assert.ok(data.integrity.status === 'complete', 'text supplements keep the material complete');
    assert.ok(layers(data.pre_existing_also_modified, 'src/a.js').includes('worktree'));
  } finally { wipe(dir, snap, out); }
});

test('several reverted files keep material beside a normal diff', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, write} = initRepo({
    'src/a.js': 'HEAD_A\n', 'src/c.js': 'HEAD_C\n', 'src/d.js': 'HEAD_D\n', 'src/b.js': 'BASE_B\n',
  });
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/a.js', 'USER_A\n');
    write('src/c.js', 'USER_C\n');
    write('src/d.js', 'USER_D\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/a.js', 'HEAD_A\n');
    write('src/c.js', 'HEAD_C\n');
    write('src/d.js', 'HEAD_D\n');
    write('src/b.js', 'TASK_CHANGED_B\n');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    const material = materialOf(out);
    assert.ok(material.includes('TASK_CHANGED_B'));
    for (const [file, head] of [['src/a.js', 'HEAD_A'], ['src/c.js', 'HEAD_C'], ['src/d.js', 'HEAD_D']]) {
      assert.ok(material.includes(head), file + ' must keep its content');
      assert.ok(new RegExp('### ' + file.replace('.', '\\.')).test(material), file + ' must have its own block');
    }
    assert.equal(data.integrity.status, 'complete');
    assert.deepEqual(
      ['src/a.js', 'src/c.js', 'src/d.js'].map(file => layers(data.pre_existing_also_modified, file)).flat().sort(),
      ['worktree', 'worktree', 'worktree']);
  } finally { wipe(dir, snap, out); }
});

test('a non-Git deletion keeps the snapshot digest even without the old body', () => {
  const dir = fs.mkdtempSync(path.join(workRoot(), 'nogit-del-'));
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src/a.js'), 'DELETED_ORIGINAL\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    const state = JSON.parse(fs.readFileSync(snap, 'utf8'));
    const digest = state.files['src/a.js'].sha256;
    const size = state.files['src/a.js'].size;
    fs.rmSync(path.join(dir, 'src/a.js'));
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.ok(data.deleted.includes('src/a.js'));
    const material = materialOf(out);
    assert.ok(material.includes(digest.slice(0, 12)), 'the real snapshot digest must be shown');
    assert.ok(material.includes(String(size)), 'the snapshot size must be shown');
    assert.ok(material.includes('基线正文不可用'), 'the missing body must be stated');
    assert.ok(material.includes('incomplete: src/a.js'));
    const limit = data.integrity.limits.find(item => item.file === 'src/a.js');
    assert.ok(limit, 'the missing body must be an integrity entry');
    assert.equal(limit.kind, 'digest-only');
    assert.equal(limit.reason, 'baseline body not stored');
    assert.equal(limit.digest, digest);
    assert.equal(limit.bytes, size);
  } finally { wipe(dir, snap, out); }
});

test('an index that differs from the worktree at task start is not a change', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/a.js': 'BASE\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/a.js', 'USER_STAGED\n');
    git('add', 'src/a.js');
    write('src/a.js', 'USER_WORKTREE\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.deepEqual(data.task, []);
    assert.deepEqual(data.pre_existing_also_modified, [], 'no layer changed, so nothing is mixed');
    assert.ok(layers(data.pre_existing, 'src/a.js').includes('baseline'));
    const material = materialOf(out);
    assert.ok(material.includes('任务开始时已改动，本次未变化'));
    assert.ok(!material.includes('当前内容与任务开始时不同'), 'must not claim the task changed the content');
  } finally { wipe(dir, snap, out); }
});

test('index-only, worktree-only and both-layer changes are distinguished', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const cases = [
    {name: 'index-only', stage: true, worktree: false, expect: ['index']},
    {name: 'worktree-only', stage: false, worktree: true, expect: ['worktree']},
    {name: 'both', stage: true, worktree: true, expect: ['index', 'worktree']},
  ];
  for (const scenario of cases) {
    const {dir, git, write} = initRepo({'src/a.js': 'BASE\n'});
    const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
    const out = path.join(workRoot(), path.basename(dir) + '-material.md');
    try {
      runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
      if (scenario.stage) {
        write('src/a.js', 'TASK_INDEX_CONTENT\n');
        git('add', 'src/a.js');
      }
      if (scenario.worktree) write('src/a.js', 'TASK_WORKTREE_CONTENT\n');
      const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
      const recorded = layers(data.task, 'src/a.js');
      assert.deepEqual(recorded, scenario.expect, scenario.name);
      assert.equal(data.integrity.status, 'complete', scenario.name);
    } finally { wipe(dir, snap, out); }
  }
});

test('staging pre-existing user content stays pre-existing and is described accurately', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/a.js': 'BASE\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    write('src/a.js', 'USER_CONTENT\n');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    git('add', 'src/a.js');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.deepEqual(data.task, []);
    assert.deepEqual(layers(data.pre_existing, 'src/a.js'), ['index']);
    const material = materialOf(out);
    assert.ok(material.includes('仅位置变化') || material.includes('仅暂存状态变化'));
    assert.ok(!material.includes('当前内容与任务开始时不同'));
  } finally { wipe(dir, snap, out); }
});
