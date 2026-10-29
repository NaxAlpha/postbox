import { afterEach, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  symlinkSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'postbox-cli-'));
  dirs.push(dir);
  cpSync('scripts', join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'cloudflare.config.ts'), '');
  cpSync('mailbox.example.json', join(dir, 'mailbox.example.json'));
  mkdirSync(join(dir, 'node_modules/cf/bin'), { recursive: true });
  symlinkSync(resolve('node_modules/zod'), join(dir, 'node_modules/zod'));
  const config = {
    ...JSON.parse(readFileSync('mailbox.example.json', 'utf8')),
    accountId: 'a'.repeat(32),
    hostname: 'mail.example.com',
    access: { allowedUsers: ['owner@example.test'] },
    domains: [
      {
        name: 'example.com',
        zoneId: 'b'.repeat(32),
        sending: true,
        receiving: true,
        catchAll: false,
      },
    ],
    addresses: [{ email: 'hello@example.com', name: 'Hello' }],
  };
  writeFileSync(join(dir, 'input.json'), JSON.stringify(config));
  writeFileSync(
    join(dir, 'scripts/mailbox.mjs'),
    `import{appendFileSync}from'node:fs';appendFileSync('installer.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');`,
  );
  writeFileSync(
    join(dir, 'node_modules/cf/bin/cf'),
    `const fs=require('fs'),args=process.argv.slice(2),s=args.join(' '),body=args.includes('--body')?JSON.parse(args[args.indexOf('--body')+1]):{};fs.appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');let state=fs.existsSync('provider.json')?JSON.parse(fs.readFileSync('provider.json')):{dns:[],senders:[],enabled:false};let out;
 if(s.startsWith('zones list'))out=[{id:'b'.repeat(32),name:'example.com',status:'active',account:{id:'a'.repeat(32)}}];
 else if(s.startsWith('dns records list'))out=state.dns;
 else if(s.startsWith('email-routing settings get'))out={enabled:state.enabled};
 else if(s.startsWith('email-routing dns get'))out={records:[]};
 else if(s.startsWith('email-routing rules list-account'))out=[];
 else if(s.startsWith('email-sending subdomains list'))out=state.senders;
 else if(s.startsWith('email-sending subdomains dns status'))out={status:'ready'};
 else if(s.startsWith('email-routing enable')){state.enabled=true;state.dns=[1,2,3].map(i=>({id:'mx'+i,name:'example.com',type:'MX',content:'route'+i+'.mx.cloudflare.net'}));out={enabled:true};}
 else if(s.startsWith('email-sending subdomains create')){state.senders=[{id:'sender',name:body.name}];out=state.senders[0];}
 else if(s==='zero-trust organization get')out={auth_domain:'team.cloudflareaccess.com'};
 else if(s==='zero-trust identity-providers list')out=[{id:'existing-idp',type:'cloudflare'}];
 else if(s==='dev'||s==='auth login')out={ok:true};
 else throw Error('Unexpected '+s);fs.writeFileSync('provider.json',JSON.stringify(state));console.log(JSON.stringify(out));`,
  );
  const run = (...args: string[]) =>
    execFileSync(process.execPath, ['scripts/postbox.mjs', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  return { dir, run };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it('supports help/start through cf and refuses login without a terminal', () => {
  const f = fixture();
  expect(f.run('help')).toContain('postbox init');
  f.run('start');
  expect(() => f.run('login')).toThrow('requires a terminal');
  expect(readFileSync(join(f.dir, 'calls.jsonl'), 'utf8')).toContain('["dev"]');
});
it('imports configuration without requiring a terminal or mutating DNS', () => {
  const f = fixture();
  f.run('init', '--config=input.json', '--no-dns');
  expect(existsSync(join(f.dir, 'mailbox.config.json'))).toBe(true);
  expect(existsSync(join(f.dir, 'calls.jsonl'))).toBe(false);
  expect(() => f.run('init', '--config=input.json', '--no-dns')).toThrow();
});
it('dry-run init does not save config or mutate provider DNS', () => {
  const f = fixture();
  expect(f.run('init', '--config=input.json', '--dry-run')).toContain('Enable receiving');
  expect(existsSync(join(f.dir, 'mailbox.config.json'))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.dir, 'provider.json'), 'utf8')).enabled).toBe(false);
});
it('prepares domains at init, then deploys through installer in correct order', () => {
  const f = fixture();
  f.run('init', '--config=input.json', '--yes');
  expect(JSON.parse(readFileSync(join(f.dir, 'provider.json'), 'utf8')).enabled).toBe(true);
  f.run('deploy', '--yes');
  expect(
    readFileSync(join(f.dir, 'installer.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x)),
  ).toEqual([['install', '--apply'], ['connect-mail', '--apply'], ['doctor']]);
});
it('deploy dry-run does not create Access or deploy a Worker', () => {
  const f = fixture();
  f.run('init', '--config=input.json', '--no-dns');
  f.run('deploy', '--dry-run');
  expect(existsSync(join(f.dir, 'installer.jsonl'))).toBe(false);
  expect(JSON.parse(readFileSync(join(f.dir, 'provider.json'), 'utf8')).enabled).toBe(false);
});

it('refuses unknown flags before making any provider calls', () => {
  const f = fixture();
  expect(() => f.run('init', '--config=input.json', '--yes', '--dryrun')).toThrow();
  expect(existsSync(join(f.dir, 'calls.jsonl'))).toBe(false);
});
it('noninteractive setup requires an explicit config file', () => {
  const f = fixture();
  expect(() => f.run('init')).toThrow();
  expect(existsSync(join(f.dir, 'calls.jsonl'))).toBe(false);
});

it('destroy and its typo alias preview permanent removal without provider calls and require a prefix to apply', () => {
  const f = fixture();
  f.run('init', '--config=input.json', '--no-dns');
  expect(JSON.parse(f.run('destory')).permanentMailDeletion).toBe(true);
  expect(() => f.run('destroy', '--apply')).toThrow();
  expect(existsSync(join(f.dir, 'calls.jsonl'))).toBe(false);
});

it('supports silent setup plans and structured errors without prompting', () => {
  const f = fixture();
  const imported = JSON.parse(f.run('init', '--config=input.json', '--no-dns', '--silent'));
  expect(imported).toMatchObject({ ok: true, command: 'init' });
  const inspected = JSON.parse(f.run('domains', '--silent'));
  expect(inspected.ok).toBe(true);
  try {
    f.run('domains', '--apply', '--silent');
    throw Error('Expected confirmation error');
  } catch (error: any) {
    expect(JSON.parse(error.stdout)).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_FAILED' },
    });
    expect(JSON.parse(error.stdout).error.message).toContain('--yes');
  }
  expect(readFileSync(join(f.dir, 'calls.jsonl'), 'utf8')).not.toContain('enable');
});
it('silent start delegates quietly and returns JSON when the server exits', () => {
  const f = fixture();
  expect(JSON.parse(f.run('start', '--silent'))).toMatchObject({ ok: true, command: 'start' });
});

it('exposes reconciliation help and forwards separate flags in silent mode', () => {
  const f = fixture();
  expect(f.run('help', 'reconcile-bucket')).toContain('original Cloudflare');
  const auditId = '00000000-0000-4000-8000-000000000000';
  expect(
    JSON.parse(
      f.run(
        'reconcile-bucket',
        '--audit-id',
        auditId,
        '--apply',
        '--confirm-prefix',
        'test-box',
        '--silent',
      ),
    ).ok,
  ).toBe(true);
  expect(JSON.parse(readFileSync(join(f.dir, 'installer.jsonl'), 'utf8').trim())).toEqual([
    'reconcile-bucket',
    `--audit-id=${auditId}`,
    '--apply',
    '--confirm-prefix=test-box',
  ]);
});
