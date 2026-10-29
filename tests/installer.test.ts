import { afterEach, describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configSchema, names, validateLive, validateManifest } from '../scripts/config.mjs';
import { rows } from '../scripts/provider.mjs';
import { tables, validateBackup } from '../scripts/backup.mjs';
const dirs: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'postbox-installer-'));
  dirs.push(root);
  for (const dir of ['scripts', 'migrations'])
    cpSync(resolve(dir), join(root, dir), { recursive: true });
  mkdirSync(join(root, 'node_modules/cf/bin'), { recursive: true });
  mkdirSync(join(root, 'node_modules/typescript/bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules/typescript/bin/tsc'), 'process.exit(0)');
  symlinkSync(resolve('node_modules/zod'), join(root, 'node_modules/zod'));
  const c = configSchema.parse({
    ...JSON.parse(readFileSync('mailbox.example.json', 'utf8')),
    resourcePrefix: 'test-box',
    accountId: 'a'.repeat(32),
    hostname: 'mail.example.test',
    access: { allowedUsers: ['owner@example.test'], mfa: false },
  });
  writeFileSync(join(root, 'mailbox.config.json'), JSON.stringify(c));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { build: 'node -e "process.exit(0)"' } }),
  );
  writeFileSync(
    join(root, 'node_modules/cf/bin/cf'),
    `const fs=require('fs');const a=process.argv.slice(2),s=(a.includes('--body')?a.slice(0,a.indexOf('--body')):a).join(' ');fs.appendFileSync('calls.jsonl',JSON.stringify(a)+'\\n');const c=JSON.parse(fs.readFileSync('mailbox.config.json'));const b=a.includes('--body')?JSON.parse(a[a.indexOf('--body')+1]):{};const m=fs.existsSync('.postbox/install.json')?JSON.parse(fs.readFileSync('.postbox/install.json')):{resources:[]};const get=k=>m.resources.find(r=>r.kind===k);let out;
 if(s==='zero-trust organization get')out={auth_domain:'team.cloudflareaccess.com'};
 else if(s==='zero-trust identity-providers list')out=[{id:'idp-1',type:'cloudflare'}];
 else if(s.startsWith('d1 list')||s==='queues list'||s.startsWith('r2 buckets list')||s==='zero-trust access policies list')out=[];
 else if(s.startsWith('zero-trust access applications list'))out=fs.existsSync('collision')?[{name:'foreign',domain:c.hostname}]:fs.existsSync('shared-policy')?[{id:'foreign',policies:[{id:get('accessPolicy').id}]}]:[];
 else if(s.startsWith('workers list'))out=fs.existsSync('deployed')?[{id:'1'.repeat(32),name:'test-box-app'}]:[];
 else if(s==='d1 create')out={uuid:'2'.repeat(32),name:b.name};
 else if(s==='r2 buckets create')out={name:b.name,creation_date:'2026-10-14T00:00:00Z'};
 else if(s==='queues create')out={queue_id:(b.queue_name.endsWith('-dlq')?'3':'4').repeat(32)};
 else if(s==='zero-trust access policies create')out={id:'5'.repeat(32)};
 else if(s==='zero-trust access applications create')out={id:'6'.repeat(32),aud:'aud-test'};
 else if(s.startsWith('zero-trust access applications get'))out={id:get('accessApplication').id,name:get('accessApplication').name,domain:c.hostname,aud:'aud-test',policies:[{id:get('accessPolicy').id}]};
 else if(s.startsWith('zero-trust access applications update'))out={aud:'aud-test'};
 else if(s.startsWith('zero-trust access applications revoke-tokens')||s.startsWith('zero-trust access policies update'))out=null;
 else if(s.startsWith('zero-trust access policies get'))out={name:get('accessPolicy').name,decision:'allow',include:c.access.allowedUsers.map(email=>({email:{email}})),require:[{login_method:{id:'idp-1'}}]};
 else if(s.startsWith('workers get'))out={id:get('worker').id,name:get('worker').name};
 else if(s.startsWith('d1 get'))out={name:fs.existsSync('rename')?'foreign-db':get('database').name};
 else if(s.startsWith('r2 buckets get')){if(a.length!==4)throw Error('bucket name must be positional');out={name:get('bucket')?.name||a[3],creation_date:fs.existsSync('replace-bucket')?'2099-01-01T00:00:00Z':'2026-10-14T00:00:00Z'};}
 else if(s.startsWith('queues consumers list'))out=a.includes(get('queue')?.id)&&!fs.existsSync('consumer-detached')?[{consumer_id:'consumer-id',queue_id:get('queue').id,type:'worker',script:fs.existsSync('foreign-consumer')?'foreign-worker':get('worker').name}]:[];
 else if(s.startsWith('queues consumers delete')){fs.writeFileSync('consumer-detached','1');out=null;}
 else if(s.startsWith('workers delete')){if(!fs.existsSync('consumer-detached'))throw Error('Worker still has Queue consumer');if(fs.existsSync('fail-worker-once')){fs.unlinkSync('fail-worker-once');throw Error('Transient worker deletion failure');}out=null;}
 else if(s.startsWith('accounts logs audit list'))out=[{id:'00000000-0000-4000-8000-000000000000',account:{id:c.accountId},action:{type:'create',result:'success',time:'2026-10-14T00:00:00Z'},resource:{product:'r2',type:'buckets',request:{name:get('bucket').name},response:{name:get('bucket').name}},raw:{method:'POST',uri:'/accounts/'+c.accountId+'/r2/buckets'}}];
 else if(s.startsWith('queues get'))out={queue_name:m.resources.find(r=>r.id===a[2]).name};
 else if(s.startsWith('d1 raw'))out=[{results:{columns:['count'],rows:b.sql.startsWith('SELECT count')?[[0]]:[]}}];
 else if(s.startsWith('r2 objects put')){fs.writeFileSync('bucket-marker.json',JSON.stringify(b));out={};}
 else if(s.startsWith('r2 objects get')){if(!fs.existsSync('bucket-marker.json')){process.stderr.write('404 Not Found');process.exit(1);}process.stdout.write(fs.readFileSync('bucket-marker.json'));process.exit(0);}
 else if(s.startsWith('r2 objects delete'))out=null;
 else if(s.startsWith('r2 objects list'))out={objects:[]};
 else if(s==='workers types'||s==='build')out=null;
 else if(s==='deploy'){fs.writeFileSync('deployed','1');out=null;}
 else if(s.includes(' delete '))out=null;
 else throw Error('Unexpected CLI command: '+s);
 console.log(JSON.stringify(out));`,
  );
  const run = (...args: string[]) =>
    execFileSync(process.execPath, ['scripts/mailbox.mjs', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const calls = () =>
    readFileSync(join(root, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x) as string[]);
  const manifest = () => JSON.parse(readFileSync(join(root, '.postbox/install.json'), 'utf8'));
  return { root, c, run, calls, manifest };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('configuration and ownership', () => {
  it('requires exact login users, validates domains, and prefixes every name', () => {
    const c = configSchema.parse(JSON.parse(readFileSync('mailbox.example.json', 'utf8')));
    expect(() => validateLive(c)).toThrow('accountId');
    expect(names(c).database).toBe('postbox-prod-db');
    expect(c.access.mfa).toBe(false);
    expect(() => names({ ...c, resources: { ...c.resources, worker: 'foreign-app' } })).toThrow(
      'resourcePrefix',
    );
    expect(() =>
      configSchema.parse({ ...c, domains: [{ name: 'bad..domain', zoneId: 'a'.repeat(32) }] }),
    ).toThrow();
  });
  it('does not accept a manifest from another account', () => {
    const f = fixture();
    expect(() =>
      validateManifest(
        {
          version: 1,
          installId: 'x',
          accountId: 'b'.repeat(32),
          prefix: f.c.resourcePrefix,
          resources: [],
          routes: [],
        },
        f.c,
      ),
    ).toThrow('account/prefix');
  });
  it('decodes D1 raw results including nested columns and rows', () => {
    expect(rows([{ results: { columns: ['id', 'count'], rows: [['abc', 2]] } }])).toEqual([
      { id: 'abc', count: 2 },
    ]);
  });
});
describe('installer without live Cloudflare calls', () => {
  it('plans without calling the provider', () => {
    const f = fixture();
    expect(f.run('plan')).toContain('test-box-db');
    expect(f.run('plan')).toContain('"mfa": false');
  });
  it('creates narrow Access policy before deployment, and records exact IDs', () => {
    const f = fixture();
    f.run('install', '--apply');
    const calls = f.calls();
    const policy = calls.find(
      (a) => a.slice(0, 4).join(' ') === 'zero-trust access policies create',
    )!;
    const body = JSON.parse(policy[policy.indexOf('--body') + 1]);
    expect(body.include).toEqual([{ email: { email: 'owner@example.test' } }]);
    expect(body.require).toContainEqual({
      cloudflare_account_member: { account_id: f.c.accountId },
    });
    expect(body.mfa_config).toBeUndefined();
    expect(
      calls.findIndex((a) => a.slice(0, 4).join(' ') === 'zero-trust access applications create'),
    ).toBeLessThan(calls.findIndex((a) => a[0] === 'deploy'));
    expect(f.manifest().resources).toHaveLength(7);
    expect(f.manifest().databaseId).toBe('2'.repeat(32));
  });
  it('keeps resource IDs through upgrade and revokes old application sessions', () => {
    const f = fixture();
    f.run('install', '--apply');
    const ids = f.manifest().resources.map((r) => r.id);
    f.run('upgrade', '--apply');
    expect(f.manifest().resources.map((r) => r.id)).toEqual(ids);
    expect(
      f
        .calls()
        .some((a) => a.slice(0, 4).join(' ') === 'zero-trust access applications revoke-tokens'),
    ).toBe(true);
  });
  it('refuses an existing hostname before creating resources', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'collision'), '1');
    expect(() => f.run('install', '--apply')).toThrow();
    expect(f.calls().some((a) => a.includes('create'))).toBe(false);
  });
  it('dry-run removal makes no provider calls; default removal retains mail and removes Access last', () => {
    const f = fixture();
    f.run('install', '--apply');
    const count = f.calls().length;
    f.run('uninstall');
    expect(f.calls()).toHaveLength(count);
    f.run('uninstall', '--apply');
    const deleted = f.calls().filter((a) => a.includes('delete') && !a.includes('consumers'));
    expect(deleted.map((a) => a[0])).toEqual([
      'workers',
      'queues',
      'queues',
      'zero-trust',
      'zero-trust',
    ]);
    expect(
      f
        .manifest()
        .resources.filter((r) => r.owned)
        .map((r) => r.kind),
    ).toEqual(['database', 'bucket']);
  });
  it('can remove retained storage after a prior application removal', () => {
    const f = fixture();
    f.run('install', '--apply');
    f.run('uninstall', '--apply');
    f.run('uninstall', '--apply', '--delete-mail', '--confirm-prefix=test-box');
    expect(f.manifest().resources.some((r) => r.owned)).toBe(false);
  });
  it('permanent removal requires matching prefix, and refuses renamed resources', () => {
    const f = fixture();
    f.run('install', '--apply');
    expect(() => f.run('uninstall', '--apply', '--delete-mail')).toThrow();
    expect(f.calls().some((a) => a.includes('delete'))).toBe(false);
    writeFileSync(join(f.root, 'rename'), '1');
    expect(() =>
      f.run('uninstall', '--apply', '--delete-mail', '--confirm-prefix=test-box'),
    ).toThrow();
    expect(f.calls().some((a) => a.includes('delete'))).toBe(false);
  });
  it('preserves an owned policy referenced by a different app', () => {
    const f = fixture();
    f.run('install', '--apply');
    writeFileSync(join(f.root, 'shared-policy'), '1');
    f.run('uninstall', '--apply');
    expect(f.manifest().resources.find((r) => r.kind === 'accessPolicy')).toMatchObject({
      owned: false,
      retainedShared: true,
    });
    expect(
      f.calls().some((a) => a.slice(0, 4).join(' ') === 'zero-trust access policies delete'),
    ).toBe(false);
  });
});
it('rejects backups that point outside their private directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'postbox-backup-'));
  dirs.push(root);
  const file = join(root, 'backup.json');
  writeFileSync(
    file,
    JSON.stringify({
      format: 'postbox-backup-v1',
      tables: Object.fromEntries(tables.map((t) => [t, []])),
      objects: { 'raw/test.eml': { file: '../outside', sha256: 'bad' } },
    }),
  );
  expect(() => validateBackup(file)).toThrow('Unsafe');
});

it('refuses deletion of a same-name replacement bucket before removing any resources', () => {
  const f = fixture();
  f.run('install', '--apply');
  writeFileSync(join(f.root, 'replace-bucket'), '1');
  expect(() => f.run('uninstall', '--apply', '--delete-mail', '--confirm-prefix=test-box')).toThrow(
    'replaced',
  );
  expect(f.calls().some((a) => a.includes('delete') || a.includes('bulk-delete'))).toBe(false);
});
it('refuses legacy ownership and altered marker without deleting resources', () => {
  const f = fixture();
  f.run('install', '--apply');
  const marker = JSON.parse(readFileSync(join(f.root, 'bucket-marker.json'), 'utf8'));
  writeFileSync(
    join(f.root, 'bucket-marker.json'),
    JSON.stringify({ ...marker, installId: 'another-installation' }),
  );
  expect(() => f.run('uninstall', '--apply', '--delete-mail', '--confirm-prefix=test-box')).toThrow(
    'marker does not match',
  );
  expect(f.calls().some((a) => a.includes('delete'))).toBe(false);
  const manifest = f.manifest();
  delete manifest.resources.find((r) => r.kind === 'bucket').bucketIdentity;
  writeFileSync(join(f.root, '.postbox/install.json'), JSON.stringify(manifest));
  expect(() => f.run('uninstall', '--apply', '--delete-mail', '--confirm-prefix=test-box')).toThrow(
    'legacy installation',
  );
  expect(f.calls().some((a) => a.includes('delete'))).toBe(false);
});

it('detaches only the owned queue consumer before deleting the Worker and Access', () => {
  const f = fixture();
  f.run('install', '--apply');
  f.run('uninstall', '--apply');
  const calls = f.calls();
  const detach = calls.findIndex((a) => a.slice(0, 3).join(' ') === 'queues consumers delete');
  const worker = calls.findIndex((a) => a[0] === 'workers' && a[1] === 'delete');
  const access = calls.findIndex(
    (a) => a.slice(0, 4).join(' ') === 'zero-trust access applications delete',
  );
  expect(detach).toBeGreaterThan(-1);
  expect(detach).toBeLessThan(worker);
  expect(worker).toBeLessThan(access);
});
it('refuses foreign queue consumers before any deletion', () => {
  const f = fixture();
  f.run('install', '--apply');
  writeFileSync(join(f.root, 'foreign-consumer'), '1');
  expect(() => f.run('uninstall', '--apply')).toThrow('foreign consumer');
  expect(f.calls().some((a) => a.includes('delete'))).toBe(false);
});
it('resumes after a Worker deletion failure without detaching twice', () => {
  const f = fixture();
  f.run('install', '--apply');
  writeFileSync(join(f.root, 'fail-worker-once'), '1');
  expect(() => f.run('uninstall', '--apply')).toThrow('Transient');
  f.run('uninstall', '--apply');
  expect(
    f.calls().filter((a) => a.slice(0, 3).join(' ') === 'queues consumers delete'),
  ).toHaveLength(1);
  expect(f.manifest().status).toBe('mail-retained');
});
it('reconciles legacy ownership from an original audit ID during deletion', () => {
  const f = fixture();
  f.run('install', '--apply');
  const m = f.manifest();
  delete m.resources.find((r) => r.kind === 'bucket').bucketIdentity;
  writeFileSync(join(f.root, '.postbox/install.json'), JSON.stringify(m));
  rmSync(join(f.root, 'bucket-marker.json'));
  f.run(
    'uninstall',
    '--apply',
    '--delete-mail',
    '--confirm-prefix=test-box',
    '--bucket-audit-id=00000000-0000-4000-8000-000000000000',
  );
  expect(f.manifest().status).toBe('removed');
  expect(
    f.manifest().resources.find((r) => r.kind === 'bucket').ownershipReconciliation.auditId,
  ).toBe('00000000-0000-4000-8000-000000000000');
});

it('reconciliation-only CLI supports preview, dry-run, and confirmed apply without deleting', () => {
  const f = fixture();
  f.run('install', '--apply');
  const m = f.manifest();
  delete m.resources.find((r) => r.kind === 'bucket').bucketIdentity;
  writeFileSync(join(f.root, '.postbox/install.json'), JSON.stringify(m));
  rmSync(join(f.root, 'bucket-marker.json'));
  const audit = '--audit-id=00000000-0000-4000-8000-000000000000';
  expect(JSON.parse(f.run('reconcile-bucket', audit)).status).toBe('verified-preview');
  expect(JSON.parse(f.run('reconcile-bucket', audit, '--apply', '--dry-run')).status).toBe(
    'verified-preview',
  );
  expect(f.manifest().resources.find((r) => r.kind === 'bucket').bucketIdentity).toBeUndefined();
  expect(
    JSON.parse(f.run('reconcile-bucket', audit, '--apply', '--confirm-prefix=test-box')).status,
  ).toBe('reconciled');
  expect(f.calls().some((a) => a.includes('delete'))).toBe(false);
});
