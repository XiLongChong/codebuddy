import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = createRequire(import.meta.url)('../package.json');
const cache = path.join(root, '.cache');
const archive = path.join(root, 'out', 'AgentEditor-' + version + '-win32-x64.zip');
if (!fs.existsSync(archive)) throw Error('请先运行 npm run package:win。');
const dir = fs.mkdtempSync(path.join(cache, 'host-test-'));
const edit = path.join(dir, 'editor'), project = path.join(dir, 'project'), harness = path.join(dir, 'harness');
const exe = path.join(edit, 'VSCodium.exe'), cli = path.join(edit, 'resources', 'app', 'out', 'cli.js');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of ['VSCODE_PORTABLE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_EXTENSIONS', 'VSCODE_DEV']) delete env[key];
function run(args, cliMode = true) {
  const result = spawnSync(exe, cliMode ? [cli, ...args] : args, { encoding: 'utf8', windowsHide: true,
    env: cliMode ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env, timeout: 150000, maxBuffer: 4000000 });
  if (result.error || result.status !== 0) throw Error([result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
  return (result.stdout || '') + (result.stderr || '');
}
let passed = false;
try {
  for (const folder of [edit, project, harness]) fs.mkdirSync(folder);
  execFileSync('tar', ['-xf', archive, '-C', edit]);
  const user = path.join(edit, 'data/user-data/User'); fs.mkdirSync(user, { recursive: true });
  fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
    'extensions.autoUpdate': false, 'update.mode': 'none', 'editor.defaultFormatter': 'esbenp.prettier-vscode' }));
  fs.writeFileSync(path.join(harness, 'package.json'), JSON.stringify({ name: 'host-test', publisher: 'codebuddy-test', version: '1.0.0',
    engines: { vscode: '^1.110.0' }, main: './empty.js' })); fs.writeFileSync(path.join(harness, 'empty.js'), 'exports.activate = () => {};');
  fs.writeFileSync(path.join(project, 'sample.js'), 'const sum=(a,b)=>a+b\n');
  let vsix = process.env.PRETTIER_VSIX || path.join(cache, 'prettier-openvsx.vsix');
  if (!fs.existsSync(vsix)) {
    const url = 'https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/esbenp.prettier-vscode-12.4.0.vsix';
    const res = await fetch(url); if (!res.ok) throw Error('下载 Prettier 失败，HTTP ' + res.status);
    fs.writeFileSync(vsix, Buffer.from(await res.arrayBuffer()));
  }
  if (crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex') !== 'fb730ea4306d09cdc0a3aaa9e9baae28058cc97a4fbfce8b056b377a0639a9fe') throw Error('Prettier 12.4.0 VSIX 校验失败。');
  console.log(run(['--install-extension', path.resolve(vsix), '--force']).trim());
  const list = run(['--list-extensions', '--show-versions']);
  for (const id of ['codebuddy-demo.agent-editor@' + version, 'esbenp.prettier-vscode@12.4.0']) if (!list.includes(id)) throw Error('便携扩展列表缺少 ' + id + '\n' + list);
  const result = run([project, '--new-window', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--disable-updates', '--disable-gpu', '--extensionDevelopmentPath=' + harness, '--extensionTestsPath=' + path.join(root, 'test/editor.cjs')], false);
  if (!fs.existsSync(path.join(project, 'verified.json'))) throw Error('扩展宿主未完成验证。\n' + result.slice(-3000));
  console.log(fs.readFileSync(path.join(project, 'verified.json'), 'utf8'));
  console.log(run(['--uninstall-extension', 'esbenp.prettier-vscode']).trim());
  if (run(['--list-extensions']).includes('esbenp.prettier-vscode')) throw Error('Prettier 卸载失败。');
  passed = true;
} finally {
  if (passed && path.dirname(dir) === cache && path.basename(dir).startsWith('host-test-')) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  else console.log('测试目录：' + dir);
}
