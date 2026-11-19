import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = createRequire(import.meta.url)('../package.json');
const version = '1.143.17232';
const expected = 'a1090868af8ac0ac04c22d79fdd02246fa115a78daf38a741d8db06df1753c1d';
const url = 'https://github.com/VSCodium/vscodium/releases/download/' + version + '/VSCodium-win32-x64-' + version + '.zip';
const cache = path.join(root, '.cache');
const out = path.join(root, 'out');
await Promise.all([fsp.mkdir(cache, { recursive: true }), fsp.mkdir(out, { recursive: true })]);
const base = path.resolve(process.env.VSCODIUM_ZIP || path.join(cache, 'codium-win.zip'));
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
if (!fs.existsSync(base)) {
  const tmp = base + '.' + randomUUID() + '.part';
  try {
    const res = await fetch(url);
    if (!res.ok) throw Error('下载 VSCodium 失败，HTTP ' + res.status);
    await pipeline(res.body, fs.createWriteStream(tmp, { flags: 'wx' }));
    if (await digest(tmp) !== expected) throw Error('下载文件的 SHA-256 与上游记录不符。');
    await fsp.rename(tmp, base);
  } finally { await fsp.rm(tmp, { force: true }); }
}
if (await digest(base) !== expected) throw Error('VSCodium ZIP 的 SHA-256 不匹配：' + base);
const stage = await fsp.mkdtemp(path.join(cache, 'pack-'));
const filename = 'AgentEditor-' + manifest.version + '-win32-x64.zip';
const archive = path.join(stage, filename);
const app = path.join(stage, 'app');
try {
  await fsp.mkdir(app);
  execFileSync('tar', ['-xf', base, '-C', app]);
  const product = JSON.parse(await fsp.readFile(path.join(app, 'resources/app/product.json'), 'utf8'));
  if (!product.extensionsGallery?.serviceUrl?.includes('open-vsx.org')) throw Error('底座未配置 Open VSX。');
  const ext = path.join(app, 'data', 'extensions', manifest.publisher + '.' + manifest.name + '-' + manifest.version);
  await fsp.mkdir(ext, { recursive: true });
  for (const entry of ['package.json', 'package-lock.json', 'src', 'media', 'README.md', 'THIRD-PARTY-NOTICES.txt', 'node_modules']) {
    await fsp.cp(path.join(root, entry), path.join(ext, entry), { recursive: true, filter: name =>
      !name.endsWith('.map') && !name.endsWith('.d.ts') && !name.endsWith('.d.cts') && !name.endsWith('.d.mts') && path.basename(name) !== '.bin' });
  }
  await fsp.copyFile(path.join(root, 'README.md'), path.join(app, '使用说明.md'));
  execFileSync('tar', ['-a', '--options', 'zip:hdrcharset=UTF-8', '-cf', archive, '-C', app, '.'], { stdio: 'inherit' });
  const dest = path.join(out, filename);
  await fsp.rename(archive, dest);
  const sha = await digest(dest);
  await fsp.writeFile(dest + '.sha256', sha + '  ' + filename + '\n');
  console.log(dest + '\nSHA-256 ' + sha);
} finally {
  if (path.dirname(stage) !== cache || !path.basename(stage).startsWith('pack-')) throw Error('暂存目录无效。');
  await fsp.rm(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
}
