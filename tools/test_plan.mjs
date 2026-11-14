import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
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
test('nextActions on a story-less plan is a safe no-op, not a crash',()=>{
  assert.deepEqual(nextActions(null),[{action:'final_acceptance'}]);
  assert.deepEqual(nextActions({}),[{action:'final_acceptance'}]);
});
test('explicit {stories:null} is story-less, not a crash',()=>{
  assert.deepEqual(nextActions({stories:null}),[{action:'final_acceptance'}]);
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
  scattered:()=>['# progress','- wish-id: W-01','杂项说明：随便写','备注：进度还行','- acceptance: AC-01 保存后刷新可读取','- current-package: T-1-01','其他：略','- next-action: 派发 T-1-01','- blocker: 无'].join('\n')+'\n',
  commented:()=>['# progress','<!--',...fieldLines,'-->'].join('\n')+'\n',
  fenced:()=>['# progress','\`\`\`',...fieldLines,'\`\`\`'].join('\n')+'\n',
  secondComment:()=>['<!-- first --> <!--',...fieldLines,'-->'].join('\n'),
  continuedComment:()=>['<!-- first','--> <!-- second',...fieldLines,'-->'].join('\n'),
  quotedFence:()=>['> ~~~',...fieldLines.map(line=>'> '+line),'> ~~~'].join('\n'),
  listFence:()=>['> - ~~~',...fieldLines.map(line=>'> '+line),'> ~~~'].join('\n'),
  fakeFenceClose:()=>['~~~md','example','~~~not-a-close',...fieldLines,'~~~'].join('\n'),
  visibleComments:()=>fieldLines.map(line=>'<!-- first --> <!-- second --> '+line+' <!-- tail -->').join('\n'),
  afterQuotedFence:()=>['> ~~~~md','> example','> ~~~~~  ',...fieldLines].join('\n'),
  afterLiteralFenceComment:()=>['~~~ <!-- literal info','<!-- literal body','~~~',...fieldLines].join('\n'),
  fakeListClose:()=>['~~~','- ~~~',...fieldLines,'~~~'].join('\n'),
  fakeHeadingClose:()=>['~~~','# ~~~',...fieldLines,'~~~'].join('\n'),
  fakeIndentClose:()=>['~~~','    ~~~',...fieldLines,'~~~'].join('\n'),
  fakeQuoteClose:()=>['~~~','> ~~~',...fieldLines,'~~~'].join('\n'),
  nestedListQuoteFence:()=>['- > ~~~',...fieldLines.map(line=>'  > '+line),'  > ~~~'].join('\n'),
  afterListFence:()=>['- ~~~','  sample','  ~~~',...fieldLines].join('\n'),
  afterNestedListQuoteFence:()=>['- > ~~~','  > sample','  > ~~~',...fieldLines].join('\n'),
  afterHeadingFenceText:()=>['# ~~~',...fieldLines].join('\n'),
  preface:()=>['# progress','- 下一步：等协调者补充（示例模板，不是账本表头）',ledgerHeader()].join('\n'),
  reordered:()=>[fieldLines[1],fieldLines[0],...fieldLines.slice(2)].join('\n')+'\n',
  reorderedRest:()=>[fieldLines[0],fieldLines[4],fieldLines[2],fieldLines[1],fieldLines[3]].join('\n')+'\n'
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
test('an HTML-commented template cannot satisfy the ledger gate',()=>{
  cli(JSON.stringify(fixture()),result=>{
    assert.equal(result.status,2);
    const data=JSON.parse(result.stdout);
    assert.equal(data.ledger,false);
    assert.ok(data.errors.some(e=>e.includes('wish-id')));
  },{ledger:'commented'});
});
test('a fenced template cannot satisfy the ledger gate',()=>{
  cli(JSON.stringify(fixture()),result=>{
    assert.equal(result.status,2);
    const data=JSON.parse(result.stdout);
    assert.equal(data.ledger,false);
    assert.ok(data.errors.some(e=>e.includes('wish-id')));
  },{ledger:'fenced'});
});
for(const ledger of ['secondComment','continuedComment','quotedFence','listFence','fakeFenceClose'])test(`hidden ledger regression: ${ledger}`,()=>{
  cli(JSON.stringify(fixture()),result=>{
    assert.equal(result.status,2);
    const data=JSON.parse(result.stdout);
    assert.equal(data.ok,false);
    assert.equal(data.ledger,false);
    assert.deepEqual(data.next_actions,[]);
  },{ledger});
});
for(const ledger of ['fakeListClose','fakeHeadingClose','fakeIndentClose','fakeQuoteClose','nestedListQuoteFence'])test(`fence context regression rejected: ${ledger}`,()=>{
  cli(JSON.stringify(fixture()),result=>{
    const data=JSON.parse(result.stdout);
    assert.equal(result.status,2);
    assert.equal(data.ledger,false);
    assert.deepEqual(data.next_actions,[]);
  },{ledger});
});
for(const ledger of ['afterListFence','afterNestedListQuoteFence','afterHeadingFenceText'])test(`fence context regression visible: ${ledger}`,()=>{
  cli(JSON.stringify(fixture()),result=>{
    const data=JSON.parse(result.stdout);
    assert.equal(result.status,0);
    assert.equal(data.ledger,true);
    assert.deepEqual(data.next_actions,[{action:'execute',task_id:'T-1-01'}]);
  },{ledger});
});
for(const ledger of ['visibleComments','afterQuotedFence','afterLiteralFenceComment'])test(`visible ledger regression: ${ledger}`,()=>{
  cli(JSON.stringify(fixture()),result=>{
    assert.equal(result.status,0);
    const data=JSON.parse(result.stdout);
    assert.equal(data.ledger,true);
    assert.deepEqual(data.next_actions,[{action:'execute',task_id:'T-1-01'}]);
  },{ledger});
});

test('a stray field line above the wish-id line does not open the ledger block',()=>{
  cli(JSON.stringify(fixture()),result=>{
    assert.equal(result.status,0);
    const data=JSON.parse(result.stdout);
    assert.equal(data.ledger,true);
    assert.deepEqual(data.next_actions,[{action:'execute',task_id:'T-1-01'}]);
  },{ledger:'preface'});
});
test('ledger requires wish-id as the first field of its complete block',()=>{
  cli(JSON.stringify(fixture()),result=>{
    const data=JSON.parse(result.stdout);
    assert.equal(result.status,2);
    assert.equal(data.ok,false);
    assert.equal(data.ledger,false);
    assert.ok(data.errors.some(e=>e.includes('acceptance')));
    assert.deepEqual(data.next_actions,[]);
  },{ledger:'reordered'});
});
test('ledger permits remaining fields in any order after wish-id',()=>{
  cli(JSON.stringify(fixture()),result=>{
    const data=JSON.parse(result.stdout);
    assert.equal(result.status,0);
    assert.equal(data.ok,true);
    assert.equal(data.ledger,true);
    assert.deepEqual(data.next_actions,[{action:'execute',task_id:'T-1-01'}]);
  },{ledger:'reorderedRest'});
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

test('snapshot refuses output symlinks without creating their targets',t=>{
  const root=fs.mkdtempSync(path.join(workRoot(),'snapshot-link-'));
  const repo=path.join(root,'repo'), out=path.join(root,'baseline.json');
  fs.mkdirSync(repo);
  try {
    const existing=path.join(root,'existing');
    fs.writeFileSync(existing,'original');
    for(const dest of [existing,path.join(root,'missing'),path.join(repo,'missing')]) {
      try { fs.symlinkSync(dest,out,'file'); } catch (error) {
        if (!['EPERM','EACCES','ENOTSUP','EOPNOTSUPP'].includes(error.code)) throw error;
        t.skip('file symlinks unavailable: ' + error.code); return;
      }
      assert.equal(runTool(['snapshot','--repo',repo,'--out',out]).status,2);
      assert.equal(fs.lstatSync(out).isSymbolicLink(),true);
      if(dest===existing) assert.equal(fs.readFileSync(dest,'utf8'),'original');
      else assert.equal(fs.existsSync(dest),false);
      fs.unlinkSync(out);
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('snapshot fails closed and reports cleanup failure',()=>{
  const root=fs.mkdtempSync(path.join(workRoot(),'snapshot-fail-'));
  const repo=path.join(root,'repo'), preload=path.join(root,'fault.cjs');
  fs.mkdirSync(repo);
  try {
    fs.writeFileSync(preload,"const fs=require('node:fs'); if(process.env.DENY_LINK) fs.linkSync=()=>{throw new Error('link denied')}; if(process.env.DENY_CLEANUP) fs.unlinkSync=()=>{throw new Error('cleanup denied')};\n");
    for(const mode of ['link','both','cleanup']) {
      const out=path.join(root,mode+'.json');
      const result=spawnSync(process.execPath,['--require',preload,reviewScript,'snapshot','--repo',repo,'--out',out],{encoding:'utf8',env:{...process.env,DENY_LINK:mode==='cleanup'?'':'1',DENY_CLEANUP:mode==='link'?'':'1'}});
      assert.equal(result.status,2,result.stdout);
      if(mode!=='cleanup') assert.match(result.stdout,/link denied/);
      if(mode!=='link') { assert.match(result.stdout,/cleanup denied/); assert.match(result.stdout,/\.review-material-/); }
      if(mode==='cleanup') assert.match(result.stdout,/output published/);
      assert.equal(fs.existsSync(out),mode==='cleanup');
      if(mode==='cleanup') assert.equal(JSON.parse(fs.readFileSync(out,'utf8')).tool,'review-material');
      if(mode==='link') assert.deepEqual(fs.readdirSync(root).filter(name=>name.startsWith('.review-material-')),[]);
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('snapshot preserves an output created after its precheck',()=>{
  const root=fs.mkdtempSync(path.join(workRoot(),'snapshot-race-injected-'));
  const repo=path.join(root,'repo'), out=path.join(root,'baseline.json'), preload=path.join(root,'race.cjs');
  fs.mkdirSync(repo);
  try {
    fs.writeFileSync(preload,"const fs=require('node:fs'); const write=fs.writeFileSync, link=fs.linkSync, out=process.env.TEST_OUTPUT; fs.writeFileSync=(file,...args)=>{if(file===out) write(out,'rival'); return write(file,...args)}; fs.linkSync=(src,dest)=>{if(dest===out) write(out,'rival'); return link(src,dest)};\n");
    const result=spawnSync(process.execPath,['--require',preload,reviewScript,'snapshot','--repo',repo,'--out',out],{encoding:'utf8',env:{...process.env,TEST_OUTPUT:out}});
    assert.equal(result.status,2,result.stdout);
    assert.equal(fs.readFileSync(out,'utf8'),'rival');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('competing snapshot processes cannot replace a baseline',async()=>{
  const root=fs.mkdtempSync(path.join(workRoot(),'snapshot-race-'));
  const repo=path.join(root,'repo'), out=path.join(root,'baseline.json');
  fs.mkdirSync(repo);
  try {
    const run=()=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[reviewScript,'snapshot','--repo',repo,'--out',out],{stdio:'ignore'});
      child.on('error',reject); child.on('exit',resolve);
    });
    assert.deepEqual((await Promise.all([run(),run()])).sort(),[0,2]);
    assert.equal(JSON.parse(fs.readFileSync(out,'utf8')).tool,'review-material');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('collect exclusively creates output and preserves existing files and links',t=>{
  const root=fs.mkdtempSync(path.join(workRoot(),'collect-output-'));
  const repo=path.join(root,'repo'), out=path.join(root,'material.md');
  fs.mkdirSync(repo);
  try {
    fs.writeFileSync(out,'original');
    const args=['collect','--repo',repo,'--out',out];
    assert.equal(runTool(args).status,2);
    assert.equal(fs.readFileSync(out,'utf8'),'original');
    fs.unlinkSync(out);
    assert.equal(runTool(args).status,0);
    assert.ok(fs.readFileSync(out,'utf8').length>0);
    fs.unlinkSync(out);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('collect refuses live and dangling output symlinks',t=>{
  const root=fs.mkdtempSync(path.join(workRoot(),'collect-link-'));
  const repo=path.join(root,'repo'), out=path.join(root,'material.md');
  fs.mkdirSync(repo);
  const args=['collect','--repo',repo,'--out',out];
  try {
    for(const target of ['existing','missing','repo-missing']) {
      const dest=target==='repo-missing' ? path.join(repo,'missing') : path.join(root,target);
      if(target==='existing') fs.writeFileSync(dest,'target');
      try { fs.symlinkSync(dest,out,'file'); } catch (error) {
        if (!['EPERM','EACCES','ENOTSUP','EOPNOTSUPP'].includes(error.code)) throw error;
        t.skip('file symlinks unavailable: ' + error.code); return;
      }
      assert.equal(runTool(args).status,2);
      assert.equal(fs.lstatSync(out).isSymbolicLink(),true);
      if(target==='existing') assert.equal(fs.readFileSync(dest,'utf8'),'target');
      else assert.equal(fs.existsSync(dest),false);
      assert.deepEqual(fs.readdirSync(root).filter(name=>name.startsWith('.review-material-')),[]);
      fs.unlinkSync(out);
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('collect refuses directory links at the output path',t=>{
  const root=fs.mkdtempSync(path.join(workRoot(),'collect-junction-'));
  const repo=path.join(root,'repo'), target=path.join(root,'target'), out=path.join(root,'output');
  fs.mkdirSync(repo); fs.mkdirSync(target);
  try {
    try { fs.symlinkSync(target,out,process.platform==='win32'?'junction':'dir'); }
    catch { t.skip('directory links unavailable'); return; }
    assert.equal(runTool(['collect','--repo',repo,'--out',out]).status,2);
    assert.equal(fs.lstatSync(out).isSymbolicLink(),true);
    assert.deepEqual(fs.readdirSync(target),[]);
    if(process.platform==='win32') fs.rmdirSync(out); else fs.unlinkSync(out);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('collect fails closed and cleans temporary file when hard links are unavailable',()=>{
  const root=fs.mkdtempSync(path.join(workRoot(),'collect-no-link-'));
  const repo=path.join(root,'repo'), out=path.join(root,'material.md'), preload=path.join(root,'deny-link.cjs');
  fs.mkdirSync(repo);
  try {
    fs.writeFileSync(preload,"require('node:fs').linkSync = () => { throw Object.assign(new Error('hard links unavailable'), {code: 'ENOTSUP'}); };\n");
    const result=spawnSync(process.execPath,['--require',preload,reviewScript,'collect','--repo',repo,'--out',out],{encoding:'utf8'});
    assert.equal(result.status,2,result.stdout);
    assert.match(result.stdout,/hard links unavailable/);
    assert.equal(fs.existsSync(out),false);
    assert.deepEqual(fs.readdirSync(root).filter(name=>name.startsWith('.review-material-')),[]);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('collect reports publication and cleanup failures without hiding either',()=>{
  const root=fs.mkdtempSync(path.join(workRoot(),'collect-cleanup-'));
  const repo=path.join(root,'repo'), preload=path.join(root,'deny-cleanup.cjs');
  fs.mkdirSync(repo);
  try {
    fs.writeFileSync(preload,"const fs=require('node:fs'); if (process.env.DENY_LINK) fs.linkSync=()=>{throw new Error('link denied')}; fs.unlinkSync=()=>{throw new Error('cleanup denied')};\n");
    for(const deny of [true,false]) {
      const out=path.join(root,deny?'failed.md':'published.md');
      const result=spawnSync(process.execPath,['--require',preload,reviewScript,'collect','--repo',repo,'--out',out],{encoding:'utf8',env:{...process.env,DENY_LINK:deny?'1':''}});
      assert.equal(result.status,2,result.stdout);
      assert.match(result.stdout,/cleanup denied/);
      assert.match(result.stdout,/\.review-material-/);
      if(deny) assert.match(result.stdout,/link denied/);
      else assert.match(result.stdout,/output published/);
      assert.equal(fs.existsSync(out),!deny);
    }
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('collect reports both write and close failures',()=>{
  const root=fs.mkdtempSync(path.join(workRoot(),'collect-write-close-'));
  const repo=path.join(root,'repo'), out=path.join(root,'material.md'), preload=path.join(root,'fail-io.cjs');
  fs.mkdirSync(repo);
  try {
    fs.writeFileSync(preload,"const fs=require('node:fs'); const write=fs.writeFileSync, close=fs.closeSync; let target; fs.writeFileSync=(file,...args)=>{if(typeof file==='number'){target=file; throw new Error('write denied')} return write(file,...args)}; fs.closeSync=fd=>{close(fd); if(fd===target) throw new Error('close denied')};\n");
    const result=spawnSync(process.execPath,['--require',preload,reviewScript,'collect','--repo',repo,'--out',out],{encoding:'utf8'});
    assert.equal(result.status,2,result.stdout);
    assert.match(result.stdout,/write denied/);
    assert.match(result.stdout,/close denied/);
    assert.equal(fs.existsSync(out),false);
    assert.deepEqual(fs.readdirSync(root).filter(name=>name.startsWith('.review-material-')),[]);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('competing collect processes cannot replace the winning output',async()=>{
  const root=fs.mkdtempSync(path.join(workRoot(),'collect-race-'));
  const repo=path.join(root,'repo'), out=path.join(root,'material.md');
  fs.mkdirSync(repo);
  try {
    const run=()=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[reviewScript,'collect','--repo',repo,'--out',out],{stdio:'ignore'});
      child.on('error',reject); child.on('exit',resolve);
    });
    assert.deepEqual((await Promise.all([run(),run()])).sort(),[0,2]);
    assert.ok(fs.readFileSync(out,'utf8').length>0);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

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

test('non-Git manifests record a link as itself and never follow it', t => {
  const base = fs.mkdtempSync(path.join(workRoot(), 'nogit-link-'));
  const dir = path.join(base, 'repo');
  const target = path.join(base, 'target');
  const link = path.join(dir, 'linked');
  const snap = path.join(base, 'snap.json');
  const out = path.join(base, 'material.md');
  fs.mkdirSync(dir, {recursive: true});
  // A garbage gitfile forces non-Git mode. The target lives OUTSIDE the repo, so
  // following the link would smuggle an external file into the repository manifest.
  fs.writeFileSync(path.join(dir, '.git'), 'garbage\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.mkdirSync(target, {recursive: true});
  fs.writeFileSync(path.join(target, 'secret.txt'), 'secret\n');
  let linked = false;
  try {
    if (process.platform === 'win32') fs.symlinkSync(target, link, 'junction');
    else fs.symlinkSync(target, link);
    linked = true;
  } catch {
    linked = false;
  }
  if (!linked) {
    t.skip('symlink/junction creation unavailable on this platform: link guard not exercised');
    wipe(base);
    return;
  }
  try {
    const data = runOk(['snapshot', '--repo', dir, '--out', snap]);
    const snapFiles = JSON.parse(fs.readFileSync(snap, 'utf8')).files;
    assert.deepEqual(Object.keys(snapFiles).sort(), ['a.txt', 'linked'],
      'the link itself is recorded; nothing behind it may enter the manifest');
    assert.equal(snapFiles.linked.status, 'link', 'the link is a link entry, not its target');
    assert.equal(typeof snapFiles.linked.sha256, 'string',
      'the link entry carries a digest of its own target string');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    const collected = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    const listed = [...collected.untracked, ...collected.unstaged, ...collected.deleted,
      ...collected.out_of_scope.map(entry => entry.file), ...collected.unscoped.map(entry => entry.file)];
    assert.ok(listed.includes('b.txt'), 'a real addition must still be detected');
    assert.ok(!listed.some(file => file.startsWith('linked/')),
      'files reachable only through the link must stay out of the collect manifest');
    assert.equal(collected.integrity.status, 'incomplete',
      'a link is compared only by its own target, so integrity must say so');
    assert.ok(collected.integrity.limits.some(limit => limit.file === 'linked' && limit.kind === 'link'),
      'the link must be recorded as a limit');
    const material = fs.readFileSync(out, 'utf8');
    assert.ok(!material.includes('secret'), 'the target body must never reach the material');
  } finally {
    // Remove the link itself only: rmSync(recursive) walks through Windows junctions
    // and would delete the target directory's contents.
    try {
      if (process.platform === 'win32') fs.rmdirSync(link);
      else fs.unlinkSync(link);
    } catch {}
    wipe(base);
  }
});


// A tracked directory replaced by a junction must be rejected before Git can
// inspect its target, including paths outside scope and paths only in history.
for (const scenario of [
  {command: 'snapshot', scope: 'src/**'},
  {command: 'snapshot', scope: 'docs/**'},
  {command: 'collect', scope: 'src/**'},
  {command: 'collect', scope: 'docs/**'},
  {command: 'collect', scope: 'docs/**', historical: true},
]) {
  test('tracked junction fails closed: ' + JSON.stringify(scenario), t => {
    if (process.platform !== 'win32' || !hasGit) { t.skip('requires Windows and Git'); return; }
    const {dir, git, write} = initRepo({'src/nested/tracked.txt': 'tracked body\n', 'docs/keep.txt': 'keep\n'});
    const base = fs.mkdtempSync(path.join(workRoot(), 'tracked-junction-'));
    const parent = path.join(dir, 'src', 'nested');
    const outside = path.join(base, 'outside');
    const snap = path.join(base, 'baseline.json');
    const out = path.join(base, 'output');
    const marker = path.join(base, 'node-access');
    const preload = path.join(base, 'guard.cjs');
    const token = 'external-junction-secret';
    let linked = false;
    try {
      if (scenario.command === 'collect') {
        if (scenario.historical) write('src/nested/tracked.txt', 'dirty baseline\n');
        runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', scenario.scope]);
        if (scenario.historical) { git('rm', '-q', '-f', 'src/nested/tracked.txt'); git('commit', '-q', '-m', 'remove'); }
      }
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'tracked.txt'), token + '\n');
      fs.rmSync(parent, {recursive: true, force: true});
      fs.mkdirSync(path.dirname(parent), {recursive: true});
      fs.symlinkSync(outside, parent, 'junction'); linked = true;
      assert.ok(fs.lstatSync(parent).isSymbolicLink(), 'fixture must be a real junction');
      assert.equal(fs.realpathSync.native(path.join(parent, 'tracked.txt')).toLowerCase(),
        fs.realpathSync.native(path.join(outside, 'tracked.txt')).toLowerCase());
      // Intercept and deny Node content reads. This probe cannot observe native Git.
      fs.writeFileSync(preload, "const fs=require('node:fs'),path=require('node:path');\n" +
        "const target=path.resolve(process.env.GUARDED_FILE).toLowerCase();\n" +
        "for(const name of ['openSync','readFileSync']) {const original=fs[name]; fs[name]=function(file,...args) {\n" +
        "if(typeof file==='string' && path.resolve(file).toLowerCase()===target) {fs.writeFileSync(process.env.ACCESS_MARKER,name); throw new Error('external access blocked by test');}\n" +
        "return original.call(this,file,...args);};}\n");
      const args = [scenario.command, '--repo', dir, '--out', out, '--scope', scenario.scope];
      if (scenario.command === 'collect') args.push('--snapshot', snap);
      const result = spawnSync(process.execPath, ['--require', preload, reviewScript, ...args], {
        encoding: 'utf8', env: {...process.env, GUARDED_FILE: path.join(parent, 'tracked.txt'), ACCESS_MARKER: marker},
      });
      assert.equal(fs.existsSync(marker), false, 'must not attempt Node content access through the junction');
      assert.equal(fs.existsSync(out), false, 'must not publish output');
      assert.equal(result.status, 2, 'must fail closed: ' + result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
    } finally {
      if (linked) fs.rmdirSync(parent); // Never recursively remove a junction.
      wipe(dir, base);
    }
  });
}

test('git-mode fingerprints never read content through a symlink or junction', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const base = fs.mkdtempSync(path.join(workRoot(), 'gitlink-'));
  const dir = path.join(base, 'repo');
  const snap = path.join(base, 'snap.json');
  const out = path.join(base, 'material.md');
  const token = 'secret-outside-body';
  fs.mkdirSync(dir, {recursive: true});
  const git = (...args) => {
    const r = spawnSync('git', args, {cwd: dir, encoding: 'utf8'});
    assert.equal(r.status, 0, 'git ' + args.join(' ') + ': ' + r.stderr);
    return r;
  };
  git('init', '-q');
  git('config', 'user.email', 'eval@example.invalid');
  git('config', 'user.name', 'eval');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  // Snapshot first, link second: the linked path must land as an untracked new-in-task
  // entry, exactly the case whose body used to be expanded straight from outside bytes.
  const snapshot = runOk(['snapshot', '--repo', dir, '--out', snap]);
  assert.equal(snapshot.mode, 'git');
  const isWin = process.platform === 'win32';
  const link = isWin ? path.join(dir, 'sneaky') : path.join(dir, 'sneaky.txt');
  const expectedFile = isWin ? 'sneaky/secret.txt' : 'sneaky.txt';
  let linked = false;
  try {
    if (isWin) {
      const outsideDir = path.join(base, 'outside');
      fs.mkdirSync(outsideDir);
      fs.writeFileSync(path.join(outsideDir, 'secret.txt'), token + '\n');
      fs.symlinkSync(outsideDir, link, 'junction');
    } else {
      fs.writeFileSync(path.join(base, 'outside-secret.txt'), token + '\n');
      fs.symlinkSync(path.join(base, 'outside-secret.txt'), link);
    }
    linked = true;
  } catch {
    linked = false;
  }
  if (!linked) {
    t.skip('link creation unavailable on this platform: git-mode link guard not exercised');
    wipe(base);
    return;
  }
  try {
    if (isWin) {
      const refused = runTool(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
      assert.equal(refused.status, 2, 'directory junction must be refused');
      assert.equal(fs.existsSync(out), false, 'no material may be published');
      return;
    }
    const collected = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.ok(collected.untracked.includes(expectedFile),
      'the linked path itself is still an untracked entry and must be listed');
    const entry = collected.integrity.limits.find(x => x.file === expectedFile);
    assert.ok(entry, 'the linked path must show as an integrity limit');
    assert.equal(entry.kind, 'link');
    assert.equal(collected.integrity.status, 'incomplete');
    const body = fs.readFileSync(out, 'utf8');
    assert.ok(!body.includes(token),
      'material must never contain content read through a link or junction');
  } finally {
    try {
      if (isWin) fs.rmdirSync(link);
      else fs.unlinkSync(link);
    } catch {}
    wipe(base);
  }
});

test('git never hashes a tracked file replaced by a real file symlink', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir} = initRepo({'src/lf.txt': 'TRACKED_BODY\n'});
  const base = fs.mkdtempSync(path.join(workRoot(), 'hash-link-'));
  const snap = path.join(base, 'snapshot.json');
  const out = path.join(base, 'material.md');
  const outside = path.join(base, 'secret.txt');
  const target = path.join(dir, 'src', 'lf.txt');
  const preload = path.join(base, 'capture.cjs');
  const calls = path.join(base, 'calls.jsonl');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    fs.writeFileSync(outside, 'OUTSIDE_SECRET_MARKER\n');
    fs.unlinkSync(target);
    try { fs.symlinkSync(outside, target, 'file'); } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('real file symlink unavailable: ' + error.code); return; }
      throw error;
    }
    fs.writeFileSync(preload, `
      const cp = require('node:child_process');
      const fs = require('node:fs');
      const original = cp.spawnSync;
      cp.spawnSync = function(command, args, options) {
        if (command === 'git' && args.includes('hash-object'))
          fs.appendFileSync(process.env.HASH_CALLS, JSON.stringify(args) + '\\n');
        return original.apply(this, arguments);
      };
      require('node:module').syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, ['--require', preload, reviewScript,
      'collect', '--repo', dir, '--out', out, '--snapshot', snap],
      {encoding: 'utf8', env: {...process.env, HASH_CALLS: calls}});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.integrity.status, 'incomplete');
    assert.ok(data.integrity.limits.some(item => item.kind === 'link' && item.file === 'src/lf.txt'));
    assert.ok(!fs.readFileSync(out, 'utf8').includes('OUTSIDE_SECRET_MARKER'));
    const hashes = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
    assert.ok(!hashes.includes('src/lf.txt'), 'git hash-object must never receive the symlink path: ' + hashes);
  } finally { wipe(dir, base); }
});

test('a tracked file replaced by a link is compared as a link, not by target bytes', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir} = initRepo({'src/lf.txt': 'TRACKED_BODY\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  const isWin = process.platform === 'win32';
  const outside = path.join(workRoot(), path.basename(dir) + '-outside.txt');
  const outsideDir = path.join(workRoot(), path.basename(dir) + '-outside-dir');
  const token = 'secret-through-link';
  const target = path.join(dir, 'src', 'lf.txt');
  // The path is tracked and clean at snapshot time, so the baseline is a HEAD blob; the
  // replacement must be compared as a link, never by hashing what the link points at.
  runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
  fs.rmSync(target);
  let mode = null;
  try {
    fs.writeFileSync(outside, token + '\n');
    fs.symlinkSync(outside, target, 'file');
    mode = 'file-link';
  } catch {
    // Windows without developer mode cannot create file symlinks; a junction to a directory
    // is the equivalent reparse point Git for Windows enumerates as that very path.
    try {
      fs.mkdirSync(outsideDir);
      fs.writeFileSync(path.join(outsideDir, 'secret.txt'), token + '\n');
      fs.symlinkSync(outsideDir, target, 'junction');
      mode = 'junction';
    } catch {
      mode = null;
    }
  }
  if (!mode || (mode === 'junction' && !isWin)) {
    wipe(dir, snap, out, outside, outsideDir);
    t.skip('link creation unavailable on this platform: tracked-file link guard not exercised');
    return;
  }
  try {
    if (mode === 'junction') {
      const refused = runTool(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
      assert.equal(refused.status, 2, 'directory junction must be refused');
      assert.equal(fs.existsSync(out), false, 'no material may be published');
      return;
    }
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.equal(data.integrity.status, 'incomplete',
      'a link is compared only by its own target, so integrity must say so');
    const limit = data.integrity.limits.find(item =>
      item.kind === 'link' && item.file.startsWith('src/lf.txt'));
    assert.ok(limit, 'a link at a tracked path must show up as an integrity limit');
    const body = fs.readFileSync(out, 'utf8');
    assert.ok(!body.includes(token), 'material must never contain bytes read through a link');
  } finally {
    try {
      if (isWin) fs.rmdirSync(target);
      else fs.unlinkSync(target);
    } catch {}
    wipe(dir, snap, out, outside, outsideDir);
  }
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
// A configured filter on a tracked file outside the requested scope must be detected
// before Git can run its command, even when merely inspecting repository status.
for (const operation of ['snapshot', 'collect']) {
  for (const kind of ['clean', 'process']) {
    test(`custom Git filter ${kind} refuses ${operation} without executing it`, t => {
      if (!hasGit) { t.skip('git unavailable'); return; }
      const {dir, git, write} = initRepo({'src/in-scope.txt': 'safe\n', 'other/tracked.txt': 'before\n'});
      const snap = path.join(workRoot(), path.basename(dir) + '-filter-snap.json');
      const out = path.join(workRoot(), path.basename(dir) + '-filter-output');
      const marker = path.join(dir, 'filter-marker');
      try {
        if (operation === 'collect') runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
        fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), 'other/tracked.txt filter=hostile\n');
        git('config', 'filter.hostile.' + kind, 'echo invoked > filter-marker; exit 1');
        write('other/tracked.txt', 'changed tracked file\n');
        const args = [operation, '--repo', dir, '--out', out, '--scope', 'src/**'];
        if (operation === 'collect') args.push('--snapshot', snap);
        const result = runTool(args);
        assert.deepEqual({status: result.status, marker: fs.existsSync(marker), output: fs.existsSync(out)},
          {status: 2, marker: false, output: false}, result.stdout + result.stderr);
      } finally { wipe(dir, snap, out); }
    });
  }
}

// Both index-deleted and never-tracked paths can still have worktree bytes and attributes.
for (const operation of ['snapshot', 'collect']) {
  for (const state of ['index-deleted', 'untracked']) {
    test(`custom filter on ${state} worktree file refuses ${operation}`, t => {
      if (!hasGit) { t.skip('git unavailable'); return; }
      const {dir, git, write} = initRepo({'src/safe.txt': 'safe\n', 'other/file.txt': 'old\n'});
      const snap = path.join(workRoot(), path.basename(dir) + '-edge-snap.json');
      const out = path.join(workRoot(), path.basename(dir) + '-edge-out');
      const marker = path.join(dir, 'filter-marker');
      try {
        if (operation === 'collect') runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
        if (state === 'index-deleted') git('rm', '--cached', '--', 'other/file.txt');
        else { git('rm', '-q', '--', 'other/file.txt'); write('other/new.txt', 'untracked\n'); }
        const file = state === 'index-deleted' ? 'other/file.txt' : 'other/new.txt';
        fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), file + ' filter=hostile\n');
        git('config', 'filter.hostile.clean', 'echo invoked > filter-marker; exit 1');
        const args = [operation, '--repo', dir, '--out', out, '--scope', 'src/**'];
        if (operation === 'collect') args.push('--snapshot', snap);
        const result = runTool(args);
        assert.deepEqual({status: result.status, marker: fs.existsSync(marker), output: fs.existsSync(out)},
          {status: 2, marker: false, output: false}, result.stdout + result.stderr);
      } finally { wipe(dir, snap, out); }
    });
  }
}

test('a baseline file inside a newly nested Git repository never executes its filter', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'nested/file.txt': 'before\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-nested-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-nested-out');
  const marker = path.join(dir, 'filter-marker');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap]);
    git('rm', '--cached', '--', 'nested/file.txt');
    const init = spawnSync('git', ['init', '-q', 'nested'], {cwd: dir, encoding: 'utf8'});
    assert.equal(init.status, 0, init.stderr);
    fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), 'nested/file.txt filter=hostile\n');
    git('config', 'filter.hostile.clean', 'echo invoked > filter-marker; exit 1');
    write('nested/file.txt', 'changed\n');
    const result = runTool(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.equal(fs.existsSync(marker), false, 'nested baseline path must not execute its filter');
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(fs.existsSync(out), false);
  } finally { wipe(dir, snap, out); }
});

test('old Git without no-lazy-fetch support fails closed', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir} = initRepo({'src/a.txt': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-oldgit-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-oldgit-out');
  const preload = path.join(workRoot(), path.basename(dir) + '-oldgit.cjs');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap]);
    fs.writeFileSync(preload, "const cp=require('node:child_process'); const original=cp.spawnSync; cp.spawnSync=(cmd,args,opts)=>args.includes('--no-lazy-fetch') ? {status:129, stdout:'', stderr:'unknown option: --no-lazy-fetch'} : original(cmd,args,opts); require('node:module').syncBuiltinESMExports();\n");
    for (const operation of ['snapshot', 'collect']) {
      const args = [operation, '--repo', dir, '--out', out];
      if (operation === 'collect') args.push('--snapshot', snap);
      const result = spawnSync(process.execPath, ['--require', preload, reviewScript, ...args], {encoding:'utf8'});
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stdout, /no-lazy-fetch/);
      assert.equal(fs.existsSync(out), false);
    }
  } finally { wipe(dir, snap, out, preload); }
});

test('attribute inspection failure is fail closed for snapshot and collect', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir} = initRepo({'src/a.txt': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-attr-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-attr-out');
  const preload = path.join(workRoot(), path.basename(dir) + '-attr-fail.cjs');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap]);
    fs.writeFileSync(preload, "const cp=require('node:child_process'); const original=cp.spawnSync; cp.spawnSync=(cmd,args,opts)=>args.includes('check-attr') ? {status: 1, stdout: '', stderr: 'injected attribute failure'} : original(cmd,args,opts); require('node:module').syncBuiltinESMExports();\n");
    for (const operation of ['snapshot', 'collect']) {
      const args = [operation, '--repo', dir, '--out', out];
      if (operation === 'collect') args.push('--snapshot', snap);
      const result = spawnSync(process.execPath, ['--require', preload, reviewScript, ...args], {encoding: 'utf8'});
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.equal(fs.existsSync(out), false);
    }
  } finally { wipe(dir, snap, out, preload); }
});

test('external diff and fsmonitor commands are not executed by snapshot or collect', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/a.txt': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-hooks-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-hooks-out');
  const marker = path.join(dir, 'hook-marker');
  try {
    // Configuration alone is inert; Git must never be allowed to invoke these commands.
    git('config', 'core.fsmonitor', 'echo invoked > hook-marker; exit 1');
    git('config', 'diff.external', 'echo invoked > hook-marker; exit 1');
    write('src/a.txt', 'changed\n');
    runOk(['snapshot', '--repo', dir, '--out', snap]);
    write('src/a.txt', 'changed again\n');
    runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.equal(fs.existsSync(marker), false, 'Git must not execute external commands');
    assert.ok(fs.readFileSync(out, 'utf8').includes('changed again'), 'native diff remains available');
  } finally { wipe(dir, snap, out); }
});

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

// Git stores executable bits in its index/tree on Windows too; do not emulate Unix chmod.
for (const scenario of ['staged', 'committed', 'index-over-commit', 'dirty-index-restore', 'dirty-index-unchanged', 'dirty-index-committed', 'legacy-dirty-index']) {
  test('Git mode regression: ' + scenario, t => {
    if (!hasGit) { t.skip('git unavailable'); return; }
    const file = 'src/run.sh';
    const {dir, git} = initRepo({[file]: 'echo hello\n'});
    const snap = path.join(workRoot(), path.basename(dir) + '-mode-snap.json');
    const out = path.join(workRoot(), path.basename(dir) + '-mode-material.md');
    try {
      git('config', 'core.filemode', 'false');
      git('update-index', '--chmod=-x', file);
      const dirty = scenario.startsWith('dirty-') || scenario === 'legacy-dirty-index';
      if (dirty) git('update-index', '--chmod=+x', file);
      runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
      if (scenario === 'legacy-dirty-index') {
        const old = JSON.parse(fs.readFileSync(snap, 'utf8'));
        for (const entry of Object.values(old.dirty)) {
          for (const key of ['index', 'head']) if (entry[key] && typeof entry[key] === 'object') entry[key] = entry[key].blob;
        }
        fs.writeFileSync(snap, JSON.stringify(old));
      }
      if (scenario === 'dirty-index-restore' || scenario === 'legacy-dirty-index') git('update-index', '--chmod=-x', file);
      else if (!dirty) git('update-index', '--chmod=+x', file);
      if (['committed', 'index-over-commit', 'dirty-index-committed'].includes(scenario)) git('commit', '-q', '-m', 'mode');
      if (scenario === 'index-over-commit') git('update-index', '--chmod=-x', file);
      const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
      const material = materialOf(out);
      if (scenario === 'legacy-dirty-index') {
        assert.equal(data.integrity.status, 'incomplete');
        assert.ok(data.integrity.limits.some(limit => /mode/i.test(limit.reason)), 'missing legacy mode must be explicit');
        assert.equal(layers(data.pre_existing, file).includes('baseline'), false, 'unknown mode cannot prove unchanged');
        return;
      }
      assert.equal(data.integrity.status, 'complete');
      const expectedTask = scenario === 'staged' ? ['index'] : scenario === 'committed' ? ['committed'] : scenario === 'index-over-commit' ? ['committed', 'index'] : [];
      assert.deepEqual(layers(data.task, file), expectedTask);
      assert.deepEqual(layers(data.pre_existing_also_modified, file), scenario === 'dirty-index-restore' ? ['index'] : []);
      assert.deepEqual(layers(data.pre_existing, file), scenario === 'dirty-index-unchanged' ? ['baseline'] : scenario === 'dirty-index-committed' ? ['committed'] : []);
      assert.deepEqual(data.committed, ['committed', 'index-over-commit', 'dirty-index-committed'].includes(scenario) ? [file] : []);
      assert.deepEqual(data.staged, ['staged', 'index-over-commit', 'dirty-index-unchanged'].includes(scenario) ? [file] : []);
      assert.deepEqual(data.unstaged, []);
      if (scenario !== 'dirty-index-unchanged') {
        assert.ok(material.includes('100644'), 'old mode is reviewable');
        assert.ok(material.includes('100755'), 'new mode is reviewable');
      }
      if (dirty) {
        const saved = JSON.parse(fs.readFileSync(snap, 'utf8')).dirty[file];
        assert.equal(saved.index.mode, '100755');
        assert.equal(saved.head.mode, '100644');
        assert.equal(saved.index.blob, saved.head.blob, 'test changes mode only, never content');
      }
    } finally { wipe(dir, snap, out); }
  });
}

// ---- 第六轮全量审查修复（2.3.13）--------------------------------------------

test('a clean tracked baseline is compared by Git content id, not by raw bytes', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/lf.txt': 'line one\nline two\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    // core.autocrlf rewrites the checkout without changing the content Git stores: the
    // task-start baseline is the HEAD blob, so a CRLF checkout is not a task change (comparing
    // raw worktree bytes made it a phantom one).
    git('config', 'core.autocrlf', 'true');
    fs.rmSync(path.join(dir, 'src', 'lf.txt'));
    git('checkout', '--', 'src/lf.txt');
    assert.ok(fs.readFileSync(path.join(dir, 'src', 'lf.txt'), 'utf8').includes('\r\n'),
      'the checkout must produce a CRLF worktree for this test to mean anything');
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    const still = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap, '--scope', 'src/**']);
    assert.deepEqual(still.unstaged, [], 'an untouched CRLF checkout is not a change');
    assert.deepEqual(still.task, []);
    assert.equal(still.integrity.status, 'complete');
    assert.ok(!materialOf(out).includes('line two'), 'no phantom diff may reach the material');
    // A real edit is still detected and attributed to the task.
    fs.unlinkSync(out);
    write('src/lf.txt', 'line one\r\nline three\r\n');
    const changed = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap, '--scope', 'src/**']);
    assert.deepEqual(changed.unstaged, ['src/lf.txt']);
    assert.deepEqual(changed.task.map(entry => entry.file), ['src/lf.txt']);
    assert.ok(materialOf(out).includes('line three'), 'the real edit must reach the material');
  } finally { wipe(dir, snap, out); }
});

test('a link present at snapshot time is compared by its own target only', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const base = fs.mkdtempSync(path.join(workRoot(), 'gitsnap-link-'));
  const dir = path.join(base, 'repo');
  const isWin = process.platform === 'win32';
  const link = path.join(dir, isWin ? 'linked' : 'linked.txt');
  const snap = path.join(base, 'snap.json');
  const out = path.join(base, 'material.md');
  const token = 'outside-body-must-not-leak';
  const git = (...args) => {
    const result = spawnSync('git', args, {cwd: dir, encoding: 'utf8'});
    assert.equal(result.status, 0, 'git ' + args.join(' ') + ': ' + result.stderr);
    return result;
  };
  fs.mkdirSync(dir, {recursive: true});
  git('init', '-q'); git('config', 'user.email', 'eval@example.invalid');
  git('config', 'user.name', 'eval'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const first = path.join(base, 'first');
  const second = path.join(base, 'second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  fs.writeFileSync(path.join(first, 'secret.txt'), token + '\n');
  fs.writeFileSync(path.join(second, 'secret.txt'), token + '\n');
  const makeLink = target => {
    try {
      if (isWin) fs.symlinkSync(target, link, 'junction');
      else fs.symlinkSync(isWin ? target : path.join(target, 'secret.txt'), link);
      return true;
    } catch { return false; }
  };
  if (!makeLink(first)) { t.skip('link creation unavailable on this platform'); wipe(base); return; }
  try {
    if (isWin) {
      const refused = runTool(['snapshot', '--repo', dir, '--out', snap]);
      assert.equal(refused.status, 2, 'directory junction must be refused');
      assert.equal(fs.existsSync(snap), false, 'no snapshot may be published');
      return;
    }
    runOk(['snapshot', '--repo', dir, '--out', snap]);
    // Retarget the junction: the recorded identity must differ even though the bytes behind
    // it are byte-for-byte identical.
    if (isWin) fs.rmdirSync(link); else fs.unlinkSync(link);
    assert.ok(makeLink(second), 'the retargeted link could not be created');
    const collected = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    // Git enumerates through the junction as a directory, so the recorded path is the file
    // inside it; its digest comes from the junction component, never from its bytes.
    const file = isWin ? 'linked/secret.txt' : 'linked.txt';
    assert.ok([...collected.untracked, ...collected.unstaged].includes(file),
      'a retargeted link is a change');
    const snapshotState = JSON.parse(fs.readFileSync(snap, 'utf8'));
    const baseline = (snapshotState.untracked ?? {})[file];
    const recorded = collected.integrity.limits.find(limit => limit.file === file);
    assert.ok(recorded?.digest && baseline.sha256 && recorded.digest !== baseline.sha256,
      'the retarget must change the recorded identity');
    const entry = collected.integrity.limits.find(limit => limit.file === file);
    assert.ok(entry, 'a link change must be recorded as an integrity limit');
    assert.equal(entry.kind, 'link');
    assert.ok(!materialOf(out).includes(token), 'no target body may reach the material');
  } finally {
    try { if (isWin) fs.rmdirSync(link); else fs.unlinkSync(link); } catch {}
    wipe(base);
  }
});

test('deleting a link recorded at snapshot time shows its identity, not "（无）"', t => {
  const base = fs.mkdtempSync(path.join(workRoot(), 'nogit-link-del-'));
  const dir = path.join(base, 'repo');
  const target = path.join(base, 'target');
  const link = path.join(dir, 'linked');
  const snap = path.join(base, 'snap.json');
  const out = path.join(base, 'material.md');
  fs.mkdirSync(dir, {recursive: true});
  fs.mkdirSync(target, {recursive: true});
  fs.writeFileSync(path.join(dir, '.git'), 'garbage\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(target, 'secret.txt'), 'secret\n');
  try {
    if (process.platform === 'win32') fs.symlinkSync(target, link, 'junction');
    else fs.symlinkSync(path.join(target, 'secret.txt'), link);
  } catch { t.skip('link creation unavailable on this platform'); wipe(base); return; }
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', '**']);
    if (process.platform === 'win32') fs.rmdirSync(link); else fs.unlinkSync(link);
    const collected = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap, '--scope', '**']);
    assert.deepEqual(collected.deleted, ['linked']);
    const entry = collected.integrity.limits.find(limit => limit.file === 'linked' && limit.layer === 'worktree');
    assert.ok(entry, 'the deleted link needs an integrity entry');
    assert.equal(entry.kind, 'link');
    assert.ok(entry.reason.includes('target not read'), entry.reason);
    const material = materialOf(out);
    assert.ok(material.includes('基线记录为 link'), 'the deletion must show what was compared');
    assert.ok(!material.includes('基线内容不可完整展示'), 'a recorded link is not an unknown baseline');
    assert.ok(!material.includes('secret'), 'the link target body must never be read');
  } finally { wipe(base); }
});

test('snapshot refuses --base and --snapshot instead of ignoring them', () => {
  const dir = fs.mkdtempSync(path.join(workRoot(), 'snap-args-'));
  const out = path.join(workRoot(), path.basename(dir) + '-snap.json');
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    const withBase = runTool(['snapshot', '--repo', dir, '--out', out, '--base', 'HEAD']);
    assert.equal(withBase.status, 2);
    assert.ok(JSON.parse(withBase.stdout).errors.some(message => message.includes('--base')));
    const withSnapshot = runTool(['snapshot', '--repo', dir, '--out', out, '--snapshot', out]);
    assert.equal(withSnapshot.status, 2);
    assert.ok(JSON.parse(withSnapshot.stdout).errors.some(message => message.includes('--snapshot')));
    assert.equal(fs.existsSync(out), false, 'a refused snapshot must not write a baseline');
  } finally { wipe(dir, out); }
});

test('the output guard refuses a hard link pointing at a repository file', t => {
  const dir = fs.mkdtempSync(path.join(workRoot(), 'hardlink-out-'));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root, {recursive: true});
  const victim = path.join(root, 'victim.txt');
  fs.writeFileSync(victim, 'original\n');
  const out = path.join(workRoot(), path.basename(dir) + '-material.md');
  try {
    try { fs.linkSync(victim, out); } catch { t.skip('hard links unavailable on this filesystem'); return; }
    const result = runTool(['collect', '--repo', root, '--out', out]);
    assert.equal(result.status, 2, result.stdout);
    assert.ok(JSON.parse(result.stdout).errors.some(message => message.includes('hard link')));
    assert.equal(fs.readFileSync(victim, 'utf8'), 'original\n', 'the linked file must stay untouched');
  } finally { wipe(dir, out); }
});

test('the CLI still runs when its path is reached through a junction', t => {
  const base = fs.mkdtempSync(path.join(workRoot(), 'cli-link-'));
  const alias = path.join(base, 'alias');
  const repo = path.join(base, 'repo');
  const out = path.join(base, 'snap.json');
  try {
    try {
      if (process.platform === 'win32') fs.symlinkSync(path.dirname(reviewScript), alias, 'junction');
      else fs.symlinkSync(path.dirname(reviewScript), alias);
    } catch { t.skip('link creation unavailable on this platform'); return; }
    fs.mkdirSync(repo, {recursive: true});
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    const result = spawnSync(process.execPath, [path.join(alias, 'review-material.mjs'),
      'snapshot', '--repo', repo, '--out', out], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true, 'the CLI must not exit silently through a link');
    assert.equal(fs.existsSync(out), true);
  } finally { wipe(base); }
});

test('the empty baseline tree follows the repository object format', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const dir = fs.mkdtempSync(path.join(workRoot(), 'empty-tree-'));
  try {
    const git = (...args) => spawnSync('git', args, {cwd: dir, encoding: 'utf8', input: ''});
    assert.equal(git('init', '-q').status, 0);
    const sha1Tree = git('hash-object', '-t', 'tree', '--stdin').stdout.trim();
    assert.equal(review.emptyTree(dir), sha1Tree);
    // A SHA-256 repository has a different empty-tree id; the hard-coded SHA-1 value used to
    // make every empty-baseline diff fail there.
    const sha256 = path.join(dir, 'sha256');
    fs.mkdirSync(sha256);
    if (git('init', '-q', '--object-format=sha256').status !== 0) return;
    const init = spawnSync('git', ['init', '-q', '--object-format=sha256'], {cwd: sha256, encoding: 'utf8'});
    if (init.status !== 0) return;
    const expected = spawnSync('git', ['hash-object', '-t', 'tree', '--stdin'],
      {cwd: sha256, encoding: 'utf8', input: ''}).stdout.trim();
    assert.equal(review.emptyTree(sha256), expected);
    assert.notEqual(expected, sha1Tree);
  } finally { wipe(dir); }
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
    assert.ok(material.includes('src/a.js：任务开始时已有改动'),
      'the mixed attribution must reach the material, not just the summary');
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
    assert.ok(material.includes('BASE：不适用（无 Git，按前后文件清单与指纹比较）'),
      'non-Git material must not print Git-only BASE concepts');
    assert.ok(!material.includes('空树'), 'the Git empty-tree wording must not leak into non-Git material');
    assert.ok(!material.includes('基线 无提交'), 'a non-Git snapshot has no baseline commit to report');
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
    assert.ok(material.includes('src/a.js：任务开始时已有改动'),
      'a task-start untracked file the task edited is mixed and must be flagged per file');
    assert.ok(!material.includes('src/b.js：任务开始时已有改动'),
      'a file that did not exist at task start is task content, never mixed');
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

    fs.unlinkSync(out);
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
  } finally {
    wipe(dir, snap, outside);
    // Remove the junction itself only; recursive rmSync follows it into the repository.
    try {
      if (process.platform === 'win32') fs.rmdirSync(link);
      else fs.unlinkSync(link);
    } catch {}
  }
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

    fs.unlinkSync(out);
    write('src/a.bin', 'BINARY2\x00BYTES');
    git('add', 'src/a.bin');
    write('src/a.bin', 'BINARY3\x00BYTES');
    const second = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.ok(second.integrity.limits.some(item => item.file === 'src/a.bin' && item.layer === 'index'));
    assert.ok(second.integrity.limits.some(item => item.file === 'src/a.bin' && item.layer === 'worktree'));
  } finally { wipe(dir, snap, out); }
});

test('truncated and oversized content are reported as integrity limits', t => {
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

    fs.unlinkSync(out);
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

test('file content with consecutive blank lines is reproduced verbatim', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, write} = initRepo({'src/a.js': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-blank-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-blank-material.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/gaps.txt', 'A\n\n\n\nB\n');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.equal(data.integrity.status, 'complete');
    assert.ok(materialOf(out).includes('A\n\n\n\nB'),
      'blank lines inside file content must survive into the material');
  } finally { wipe(dir, snap, out); }
});

test('a clean worktree matching the commit is explained by the commit layer, not re-reported', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, git, write} = initRepo({'src/a.js': 'BASE\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-explained-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-explained-material.md');
  try {
    // P1-A regression: a clean tracked baseline compares by Git content id, and the commit
    // layer stores the HEAD blob object id in .blob (its .sha256 is the byte digest, a
    // different namespace a content id can never equal). A worktree whose content matches
    // the commit is covered by the committed layer even while the index diverges.
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/a.js', 'TASK_COMMIT\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'task');
    write('src/a.js', 'TASK_INDEX\n');
    git('add', 'src/a.js');
    write('src/a.js', 'TASK_COMMIT\n');
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.ok(data.committed.includes('src/a.js'), 'the commit layer must be visible');
    assert.ok(data.staged.includes('src/a.js'), 'the diverged index must be visible');
    assert.deepEqual(layers(data.task, 'src/a.js'), ['committed', 'index'],
      'a worktree matching the commit is explained by it, no redundant worktree record');
    assert.equal(data.integrity.status, 'complete');
    // Back at the pre-task value the worktree layer is net zero again.
    write('src/a.js', 'BASE\n');
    fs.unlinkSync(out);
    const restored = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.deepEqual(layers(restored.task, 'src/a.js'), ['committed', 'index'],
      'restored to the baseline content the worktree layer is gone');
  } finally { wipe(dir, snap, out); }
});

test('content that is not valid UTF-8 is recorded as an integrity limit', t => {
  if (!hasGit) { t.skip('git unavailable'); return; }
  const {dir, write} = initRepo({'src/a.js': 'base\n'});
  const snap = path.join(workRoot(), path.basename(dir) + '-utf8-snap.json');
  const out = path.join(workRoot(), path.basename(dir) + '-utf8-material.md');
  try {
    runOk(['snapshot', '--repo', dir, '--out', snap, '--scope', 'src/**']);
    write('src/latin.txt', Buffer.from([0x41, 0xff, 0x42, 0x0a]));
    const data = runOk(['collect', '--repo', dir, '--out', out, '--snapshot', snap]);
    assert.equal(data.integrity.status, 'incomplete');
    const entry = data.integrity.limits.find(item => item.file === 'src/latin.txt');
    assert.ok(entry, 'undecodable content must be recorded as a limit');
    assert.equal(entry.kind, 'undecodable');
    assert.ok(!materialOf(out).includes('\ufffd'),
      'replacement characters must never be presented as if they were the content');
  } finally { wipe(dir, snap, out); }
});
