import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { migrateLegacyGraph } from '../lib/migrate.js'
import { readFlow, readBinding } from '../lib/flow-store.js'
import { buildPackage, packageToFlow, preflightPackage } from '../lib/package.js'
import { hashValue } from '../lib/hash.js'
function hasKey(value, key) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key))
  return Object.entries(value).some(([name, child]) => name === key || hasKey(child, key))
}
async function root(){return await fs.mkdtemp(path.join(os.tmpdir(),'isf-pkg-'))}
function rehash(pkg) {
  delete pkg.integrity
  pkg.integrity = { algorithm: 'sha256', specVersion: 1, flowHash: hashValue(pkg), archiveHash: null }
  return pkg
}
async function built() {
  const r = await root()
  await migrateLegacyGraph(r, legacy)
  return buildPackage(await readFlow(r, 'default', '1.0.0'), await readBinding(r, 'default'))
}
const legacy={version:2,viewport:{x:0,y:0,zoom:1},nodes:[{id:'n1',sessionId:'session-a',title:'写作',cwd:'C:/x',prompt:'写',outputSpec:{mode:'text',fields:['x'],maxResults:1},defaultOutputPortId:'out_1',inputPorts:[{id:'in_1',policy:'each'}],outputPorts:[{id:'out_1',policy:'all'}],x:0,y:0}],edges:[]}
test('build package has flowHash and no session keys', async()=>{const r=await root();await migrateLegacyGraph(r,legacy);const line=await readFlow(r,'default','1.0.0');const b=await readBinding(r,'default');const pkg=buildPackage(line,b);assert.match(pkg.integrity.flowHash,/^sha256:/);assert.equal(hasKey(pkg,'sessionId'),false);const pre=preflightPackage(pkg,{mode:'import'});assert.equal(pre.ok,true,JSON.stringify(pre.checks.filter(x=>x.status!=='pass')));const publish=preflightPackage(pkg,{mode:'publish'});assert.equal(publish.ok,false);const flow2=packageToFlow(pkg);assert.equal(flow2.flowId,'default');})
test('tampered flowHash is rejected', async()=>{const r=await root();await migrateLegacyGraph(r,legacy);const line=await readFlow(r,'default','1.0.0');const b=await readBinding(r,'default');const pkg=buildPackage(line,b);pkg.flow.nodes[0].prompt='changed';const pre=preflightPackage(pkg,{mode:'import'});assert.equal(pre.ok,false);assert.ok(pre.checks.some(x=>x.id==='integrity:flowHash'&&x.status==='error'));})
test('rejects v1 package explicitly', async()=>{const pkg=await built();pkg.packageVersion=1;const pre=preflightPackage(pkg,{mode:'import'});assert.equal(pre.ok,false);const item=pre.checks.find(x=>x.id==='package-version');assert.equal(item.status,'error');assert.match(item.message,/v1 package not supported/)})
test('draft null flowHash is allowed for import but blocked for publish', async()=>{const pkg=await built();pkg.integrity.flowHash=null;const pre=preflightPackage(pkg,{mode:'import'});assert.equal(pre.ok,true);const pub=preflightPackage(pkg,{mode:'publish'});assert.equal(pub.ok,false);assert.ok(pub.checks.some(x=>x.id==='integrity:flowHash'&&x.status==='error'))})
test('reject-licensefile-absolute', async()=>{const pkg=await built();pkg.flow.nodes[0].skillRefs=['demo@1.0.0'];pkg.manifest.skillLocks=[{name:'demo',version:'1.0.0',license:'MIT',licenseFile:{path:'C:/x',sha256:'sha256:'+'0'.repeat(64)}}];rehash(pkg);const pre=preflightPackage(pkg,{mode:'import'});assert.equal(pre.ok,false);assert.ok(pre.checks.some(x=>x.id==='skill:demo@1.0.0:license-path'&&x.status==='error'))})
test('licenseFile schema pattern rejects absolute/URI, accepts relative', async()=>{const schema=JSON.parse(await fs.readFile(new URL('../schemas/package.schema.json',import.meta.url),'utf8'));let pattern=null;const walk=(x)=>{if(!x||typeof x!=='object')return;if(typeof x.pattern==='string'&&x.pattern.includes('A-Za-z]:')&&x.pattern.includes('\\.\\.'))pattern=x.pattern;for(const v of Object.values(x))walk(v)};walk(schema);assert.ok(pattern);const r=new RegExp(pattern);for(const bad of ['C:/x','http://x','../x','a/../x','a\\b'])assert.equal(r.test(bad),false,bad);assert.equal(r.test('licenses/a.LICENSE'),true)})
