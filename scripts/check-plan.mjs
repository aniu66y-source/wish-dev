import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

// Structural gate only: never executes the plan's commands or claims their success.
export function validatePlan(plan) {
  const errors=[];
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const text=v=>typeof v==='string'&&v.trim().length>0;
  const criterionId=v=>typeof v==='string'&&/^AC-\d{2,}$/.test(v);
  const storyId=v=>typeof v==='string'&&/^(?:S|WP)-\d{2,}$/.test(v);
  const requireText=(v,p)=>{if(!text(v))errors.push(p+' must be a non-empty string');};
  if(!object(plan))return ['plan must be an object'];
  if(plan.version!==1)errors.push('version must be 1');
  requireText(plan.wish_id,'wish_id');
  const acceptance=Array.isArray(plan.acceptance)?plan.acceptance:[];
  if(!acceptance.length)errors.push('acceptance must not be empty');
  const criteria=new Set();
  acceptance.forEach((a,i)=>{
    if(!object(a)){errors.push(`acceptance[${i}] must be an object`);return;}
    if(!criterionId(a.id))errors.push(`acceptance[${i}].id must be a string matching AC-01`);
    else{if(criteria.has(a.id))errors.push('duplicate acceptance id');criteria.add(a.id);}
    requireText(a.text,`acceptance[${i}].text`);
  });
  const research=object(plan.research)?plan.research:{};
  if(research.status!=='complete')errors.push('research.status must be complete before implementation');
  requireText(research.checked_at,'research.checked_at');
  requireText(research.decision,'research.decision');requireText(research.rationale,'research.rationale');
  const candidates=Array.isArray(research.candidates)?research.candidates:[];
  if(!candidates.length)errors.push('research.candidates must contain inspected GitHub projects');
  candidates.forEach((c,i)=>{
    const prefix=`research.candidates[${i}]`;
    if(!object(c)){errors.push(prefix+' must be an object');return;}
    let repo;
    try{if(typeof c.url==='string'){const u=new URL(c.url);if(u.protocol==='https:'&&u.hostname==='github.com'&&!u.username&&!u.password&&!u.search&&!u.hash&&/^\/[^/]+\/[^/]+\/?$/.test(u.pathname))repo=u.origin+u.pathname.replace(/\/$/,'');}}catch{}
    if(!repo)errors.push(prefix+'.url must be a GitHub repository URL');
    const revisionValid=typeof c.revision==='string'&&/^[a-f0-9]{40}$/i.test(c.revision);
    if(!revisionValid)errors.push(prefix+'.revision must be an inspected 40-character commit SHA string');
    const refs=Array.isArray(c.code_refs)?c.code_refs:[];
    const checked=refs.map(ref=>{
      try{
        if(typeof ref!=='string'||!repo||!revisionValid)return {valid:false,implementation:false};
        const u=new URL(ref),base=repo+'/blob/'+c.revision+'/';
        const tail=decodeURIComponent(u.pathname.slice(new URL(base).pathname.length));
        const valid=u.href.startsWith(base)&&!u.username&&!u.password&&(!u.search||u.search==='?plain=1')&&tail.length>0&&!tail.split('/').some(v=>v==='.'||v==='..'||v==='');
        return {valid,implementation:valid&&!/(?:^|\/)readme(?:\.[^/]*)?$/i.test(tail)};
      }catch{return {valid:false,implementation:false};}
    });
    if(checked.some(v=>!v.valid))errors.push(prefix+'.code_refs must be string URLs at the same repository and commit; only plain=1 is allowed as a query');
    const implementation=checked.some(v=>v.implementation);
    if(!implementation)errors.push(prefix+'.code_refs must include implementation at the pinned commit, beyond README');
    requireText(c.fit,prefix+'.fit');requireText(c.limits,prefix+'.limits');
  });
  const architecture=object(plan.architecture)?plan.architecture:{};
  requireText(architecture.approach,'architecture.approach');
  requireText(architecture.simplification,'architecture.simplification');
  for(const name of ['concurrency','load_balancing']){
    const v=architecture[name],prefix='architecture.'+name;
    if(!object(v)||typeof v.applicable!=='boolean'){errors.push(prefix+'.applicable must be boolean');continue;}
    if(!v.applicable){requireText(v.reason,prefix+'.reason');if(name==='load_balancing')requireText(v.scale_trigger,prefix+'.scale_trigger');}
    else if(name==='concurrency'){
      for(const key of ['assumptions','controls','verification'])requireText(v[key],prefix+'.'+key);
    }else{
      for(const key of ['strategy','state','failure_handling','verification'])requireText(v[key],prefix+'.'+key);
    }
  }
  const budget=object(plan.budget)?plan.budget:{};
  for(const key of ['max_fix_attempts','max_tasks'])if((key==='max_fix_attempts'||budget[key]!==undefined)&&(!Number.isSafeInteger(budget[key])||budget[key]<1))errors.push('budget.'+key+' must be a positive integer');
  const stories=Array.isArray(plan.stories)?plan.stories:[];
  if(!stories.length)errors.push('stories must not be empty');
  if(budget.max_tasks!==undefined&&stories.length>budget.max_tasks)errors.push('stories exceed budget.max_tasks');
  const ids=new Set(),covered=new Set();
  const states=new Set(['pending','running','verifying','done','blocked']);
  stories.forEach((s,i)=>{
    const prefix=`stories[${i}]`;
    if(!object(s)){errors.push(prefix+' must be an object');return;}
    if(!storyId(s.id))errors.push(prefix+'.id must be a string matching WP-01 or legacy S-01');
    else{if(ids.has(s.id))errors.push('duplicate story id');ids.add(s.id);}
    requireText(s.title,prefix+'.title');
    if(!Array.isArray(s.allowed_files)||!s.allowed_files.length||s.allowed_files.some(v=>!text(v)))errors.push(prefix+'.allowed_files must declare the implementation scope');
    if(!states.has(s.status))errors.push(prefix+'.status is invalid');
    if(!Number.isSafeInteger(s.attempts)||s.attempts<0||s.attempts>budget.max_fix_attempts)errors.push(prefix+'.attempts exceeds retry budget or is invalid');
    if(!Array.isArray(s.accept_refs)||!s.accept_refs.length)errors.push(prefix+'.accept_refs must not be empty');
    else for(const id of s.accept_refs){if(!criterionId(id)||!criteria.has(id))errors.push(prefix+'.accept_refs contains an invalid or unknown criterion');else covered.add(id);}
    if(!Array.isArray(s.verify)||!s.verify.length)errors.push(prefix+'.verify must contain an executable or observable check');
    else s.verify.forEach((v,n)=>{
      const p=prefix+`.verify[${n}]`;
      if(!object(v)||!['command','browser','manual'].includes(v.kind)){errors.push(p+'.kind is invalid');return;}
      if(v.kind==='command')requireText(v.run,p+'.run');
      else{requireText(v.action,p+'.action');requireText(v.expected,p+'.expected');}
    });
    if(s.status==='done'&&(!Array.isArray(s.evidence)||!s.evidence.length))errors.push(prefix+'.evidence is required for done');
    if(s.status==='done'){
      const implementation=s.context_id??s.sessionId;
      const reviewer=s.review?.context_id??s.review?.sessionId;
      if(!object(s.review)||s.review.spec!=='pass'||s.review.quality!=='pass'||!text(implementation)||!text(reviewer)||reviewer===implementation)errors.push(prefix+'.review must pass specification and quality checks in a separate actual context');
    }
    if(s.evidence!==undefined){
      if(!Array.isArray(s.evidence))errors.push(prefix+'.evidence must be an array');
      else for(const file of s.evidence){const normalized=typeof file==='string'?file.replaceAll('\\','/') : '';if(!normalized.startsWith('evidence/')||normalized.split('/').some(x=>x==='..'||x==='')||normalized.includes(':'))errors.push(prefix+'.evidence must stay under evidence/');}
    }
  });
  const tasks=new Map(stories.filter(s=>object(s)&&storyId(s.id)).map(s=>[s.id,s]));
  for(const s of stories.filter(object)){
    if(s.depends_on===undefined)continue;
    if(!Array.isArray(s.depends_on)){errors.push('stories.depends_on must be an array');continue;}
    for(const id of s.depends_on){
      if(!storyId(id)||!tasks.has(id))errors.push('stories.depends_on contains an invalid or unknown task');
      else if(['running','verifying','done'].includes(s.status)&&tasks.get(id).status!=='done')errors.push('stories.depends_on must be done before this task starts');
    }
  }
  const visiting=new Set(),visited=new Set();
  function visit(id){
    if(visiting.has(id)){errors.push('stories.depends_on contains a cycle');return;}
    if(visited.has(id))return;
    visiting.add(id);
    const deps=tasks.get(id)?.depends_on;
    if(Array.isArray(deps))for(const dep of deps)if(tasks.has(dep))visit(dep);
    visiting.delete(id);visited.add(id);
  }
  for(const id of tasks.keys())visit(id);
  for(const id of criteria)if(!covered.has(id))errors.push('uncovered acceptance criterion');
  return errors;
}

// A scheduling hint, not an executor or a permission grant. Validate the plan first.
export function nextActions(plan) {
  const tasks=plan.stories;
  const completed=new Set(tasks.filter(s=>s.status==='done').map(s=>s.id));
  const actions=[];
  for(const s of tasks){
    if(s.status==='running')actions.push({action:'observe',task_id:s.id});
    else if(s.status==='verifying')actions.push({action:'review',task_id:s.id});
    else if(s.status==='pending'&&(s.depends_on??[]).every(id=>completed.has(id)))actions.push({action:'execute',task_id:s.id});
  }
  if(actions.length)return actions;
  if(tasks.every(s=>s.status==='done'))return [{action:'final_acceptance'}];
  return [{action:'resolve_blockers',task_ids:tasks.filter(s=>s.status==='blocked').map(s=>s.id)}];
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    if(process.argv.length!==3)throw new Error('usage: node check-plan.mjs <prd.json>');
    const plan=JSON.parse(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));
    const errors=validatePlan(plan);
    console.log(JSON.stringify({ok:errors.length===0,errors,next_actions:errors.length?[]:nextActions(plan)},null,2));process.exitCode=errors.length?2:0;
  }catch{console.log(JSON.stringify({ok:false,errors:['Plan is unreadable, invalid JSON, or no plan path supplied.'],next_actions:[]}));process.exitCode=2;}
}
