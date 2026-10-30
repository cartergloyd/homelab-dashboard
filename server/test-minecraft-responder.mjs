import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-responder-'));
const waitFor = async (predicate) => { const deadline = Date.now() + 5000; while (!predicate()) { assert.ok(Date.now() < deadline, 'responder did not progress'); await delay(10); } };
let sidecar;
let runner;
try {
  await fs.mkdir(path.join(tmp, 'bin'));
  // Agents receive an allowlisted environment only, so the call log path is baked into the fixture.
  const fixture = `#!${process.execPath}\nimport fs from 'node:fs';if(process.argv[2]==='login')process.exit(0);let prompt='';for await(const c of process.stdin)prompt+=c;fs.appendFileSync(${JSON.stringify(path.join(tmp, 'cli-calls.jsonl'))},JSON.stringify({args:process.argv.slice(2),prompt,token:process.env.HOMELAB_KEY})+'\\n');console.log(JSON.stringify({type:'thread.started',thread_id:'responder-session'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Investigating the Minecraft outage.'}}));setTimeout(()=>{},300);`;
  await fs.writeFile(path.join(tmp, 'bin/codex'), fixture, { mode: 0o755 });
  Object.assign(process.env, { PATH: `${path.join(tmp,'bin')}:${process.env.PATH}`, DATA_DIR: tmp, MC_DIR: tmp, DEMO: '0', DASHBOARD_KEY: 'fixture' });
  await fs.writeFile(path.join(tmp,'sidecar.json'), JSON.stringify({ settings: { enabled:true, autoTrigger:true, quietSeconds:600, requireApproval:true } }));
  sidecar = await import('./dist/services/sidecar.js');
  runner = await import('./dist/services/agentRunner.js');
  const { publish } = await import('./dist/services/alerts.js');
  const { resolveIdentity } = await import('./dist/auth.js');
  const cliCalls = async () => (await fs.readFile(path.join(tmp,'cli-calls.jsonl'),'utf8').catch(()=>'')).trim().split('\n').filter(Boolean).map(JSON.parse);
  // the identity the dashboard gives the nth CLI call's MCP requests, from that run's own token
  const runIdentity = async (n) => {
    const deadline = Date.now() + 5000;
    while ((await cliCalls()).length < n) { assert.ok(Date.now() < deadline, 'CLI call was not recorded'); await delay(10); }
    const resolved = await resolveIdentity({ authorization: `Bearer ${(await cliCalls())[n-1].token}`, 'x-homelab-agent': 'Dashboard Codex' }, '127.0.0.1');
    assert.equal(resolved.ok, true, 'a live run token must authenticate');
    return resolved.user;
  };
  await sidecar.initSidecar();
  publish({source:'jellyfin',level:'error',text:'Unrelated outage'});
  assert.equal(sidecar.listIncidents().length,0);
  sidecar.reportProblem('outage','Players cannot connect','owner');
  await waitFor(()=>runner.currentRun());
  const first=runner.currentRun();
  assert.equal(first.kind,'incident');
  assert.ok(sidecar.getConversation().some(t=>t.role==='user'&&t.incidentId===first.incidentId&&t.text.includes('Players cannot connect')));
  const identity=await runIdentity(1);
  assert.deepEqual([identity.dashboardRunId,identity.lane,identity.runOrigin],[first.id,'minecraft','dashboard']);
  const { stepUp, requireStepUp } = await import('./dist/security.js');
  const activeAccounts = stepUp.activeAccounts;
  stepUp.activeAccounts = () => 1;
  let continued = false;
  try {
    await requireStepUp({ path: '/minecraft/action', method: 'POST', body: {action:'restart'} }, { locals: {user:identity} }, () => {continued=true;});
    assert.equal(continued,true,'an enrolled authenticator must not delay the dedicated responder recovery');
  } finally { stepUp.activeAccounts=activeAccounts; }
  await sidecar.gate('minecraft_service:restart',identity,'recover outage',true);
  await sidecar.gate('rcon:say',identity,'warn players',true);
  assert.equal(sidecar.listApprovals().length,0,'authorized recovery must not wait for dashboard approvals');
  sidecar.reportProblem('outage','Bedrock clients report connection refused','owner');
  await waitFor(()=>sidecar.getPayload().state.queue.length===1);
  assert.equal(runner.currentRun().id,first.id,'new outage input queues behind the active investigation');
  await waitFor(()=>first.finishedAt);
  await waitFor(()=>runner.listAgentRuns(10).length===2);
  await waitFor(()=>!runner.currentRun());
  const turns=sidecar.getConversation(100);
  assert.equal(turns.filter(t=>t.role==='user'&&t.incidentId).length,2);
  assert.equal(turns.filter(t=>t.role==='assistant'&&t.incidentId).length,2);
  assert.equal(sidecar.getPayload().state.sessionId,'responder-session');
  let supportSession = null;
  let supportIncident;
  sidecar.registerIncidentDelivery(id => id === supportIncident?.id ? { context: 'Discord player evidence only', imagePaths: [path.join(tmp, 'error.png')], sessionId: supportSession,
    complete: async run => { supportSession = run.sessionId; } } : null);
  supportIncident = sidecar.submitSupportReport('test-player-case', 'Cannot connect from Xbox');
  await waitFor(() => runner.currentRun());
  const supportRun = runner.currentRun();
  const supportIdentity=await runIdentity(3);
  assert.equal(supportIdentity.dashboardRunId,supportRun.id);
  assert.equal(sidecar.isPlayerSupportRun(supportIdentity),true);
  assert.equal(sidecar.isPlayerSupportRun(identity),false);
  let recoveryAllowed=false;
  await requireStepUp({path:'/minecraft/action',method:'POST',body:{action:'restart'}},{locals:{user:supportIdentity}},()=>{recoveryAllowed=true});
  assert.equal(recoveryAllowed,true);
  for(const req of [{path:'/minecraft/command',method:'POST',body:{command:'op BadActor'}},{path:'/config',method:'GET'}]) {
    await assert.rejects(requireStepUp(req,{locals:{user:supportIdentity}},()=>{}),/limited to Minecraft diagnosis/);
  }
  await assert.rejects(requireStepUp({path:'/terminal/execute',method:'POST',body:{command:'rm -rf world'}},{locals:{user:supportIdentity}},()=>{}),/no access to \/terminal/);
  sidecar.submitSupportReport('test-player-case', 'The screenshot says outdated client');
  await waitFor(() => supportRun.finishedAt);
  await waitFor(() => runner.listAgentRuns(10).length===4);
  await waitFor(() => !runner.currentRun());
  const calls=(await fs.readFile(path.join(tmp,'cli-calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const initial=calls.at(-2),followup=calls.at(-1);
  assert.equal(initial.args[initial.args.indexOf('--sandbox')+1],'read-only');
  assert.ok(initial.args.includes('shell_tool'));
  assert.ok(initial.args.includes('--image'));
  assert.ok(initial.args.includes(path.join(tmp,'error.png')));
  assert.equal(initial.args.includes('resume'),false,'Discord support starts an isolated CLI session');
  assert.ok(followup.args.includes('resume'));
  assert.ok(followup.args.includes('responder-session'));
  assert.match(followup.prompt,/outdated client/);
  assert.match(followup.prompt,/Discord player evidence only/);
  console.log('Minecraft responder: immediate outage queue, concurrent report input, Minecraft-only triggers, preauthorized recovery and continuous conversation passed');
} finally {
  if(runner?.currentRun()) await sidecar.stopAssistant('test cleanup');
  await delay(1300);
  await fs.rm(tmp,{recursive:true,force:true});
}
