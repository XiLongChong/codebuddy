const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Workspace } = require('../src/workspace');
const { History } = require('../src/history');
const { Approvals, runApproved } = require('../src/commands');
const { Models, normalizeConfig, inlineText } = require('../src/model');
const { buildTools } = require('../src/tools');

function setup(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-editor-test-'));
  const root = path.join(temp, 'project');
  fs.mkdirSync(root);
  t.after(() => {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('agent-editor-test-'));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const dirty = new Set(), ws = new Workspace(root, () => {}, p => dirty.has(p));
  const dir = path.join(temp, 'history'), h = new History(dir, ws);
  return { root, temp, dirty, ws, dir, h };
}
test('最初快照、重复写入、重新打开、保留和逐文件冲突撤销', t => {
  const { root, ws, dir, h, dirty } = setup(t);
  fs.writeFileSync(path.join(root, 'a.js'), '\uFEFFlet x = 1;\r\n');
  const r = h.begin('修复', 'agent', []);
  h.write(r, 'a.js', 'second'); h.write(r, './a.js', 'third');
  h.write(r, 'new/b.js', 'created'); h.write(r, 'c.js', 'temporary');
  r.status = 'done'; h.review(r, 'keep', 'a.js');
  assert.deepEqual(r.changes.map(c => c.status), ['kept', 'pending', 'pending']);
  h.review(r, 'keep');
  const loaded = new History(dir, ws), round = loaded.chat.rounds[0];
  assert.equal(round.changes.length, 3);
  assert.equal(round.changes[0].before, '\uFEFFlet x = 1;\r\n');
  assert.deepEqual(loaded.review(round, 'undo', 'a.js'), []);
  assert.equal(ws.read('a.js'), '\uFEFFlet x = 1;\r\n');
  fs.writeFileSync(path.join(root, 'new/b.js'), 'human');
  dirty.add(path.join(root, 'c.js'));
  assert.equal(loaded.review(round, 'undo').length, 2);
  assert.equal(ws.read('a.js'), '\uFEFFlet x = 1;\r\n'); assert.equal(ws.read('new/b.js'), 'human');
  assert.equal(ws.read('c.js'), 'temporary');
  dirty.clear(); loaded.review(round, 'undo');
  assert.equal(ws.read('c.js', true), null); assert.equal(round.changes[0].status, 'undone');
  assert.equal(loaded.newChat().rounds.length, 0); loaded.select(h.chat.id); assert.equal(loaded.chat.rounds[0].id, r.id);
});
test('跳过敏感文件、工作区外路径、目录联接、硬链接和未保存的编辑', async t => {
  const { root, temp, ws, h, dirty } = setup(t);
  fs.writeFileSync(path.join(root, '.env.local'), 'private');
  fs.writeFileSync(path.join(root, 'visible.txt'), 'hello');
  fs.writeFileSync(path.join(temp, 'outside'), 'outside'); fs.linkSync(path.join(temp, 'outside'), path.join(root, 'linked.txt'));
  fs.symlinkSync(temp, path.join(root, 'jump'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const p of ['../outside', '.git/config', '.env.local', 'id_ed25519', 'sub/private.pem', 'jump/outside', 'linked.txt', 'file:stream', 'con.txt']) {
    assert.throws(() => ws.resolve(p, true), p);
  }
  assert.deepEqual((await ws.find('')).map(x => x.path), ['visible.txt']);
  const r = h.begin('edit', 'agent', []); dirty.add(path.join(root, 'visible.txt'));
  assert.throws(() => h.write(r, 'visible.txt', 'new'), /未保存/); assert.equal(ws.read('visible.txt'), 'hello');
  dirty.clear(); h.write(r, 'visible.txt', 'first'); fs.writeFileSync(path.join(root, 'visible.txt'), 'person');
  assert.throws(() => h.write(r, 'visible.txt', 'again'), /已被修改/);
});
test('崩溃后恢复已落盘写入和中断的运行状态', t => {
  const { h, ws, dir } = setup(t), r = h.begin('test', 'agent', []);
  const next = { path: 'created.txt', before: null, after: '', status: 'pending' };
  r.intent = { path: next.path, from: null, to: '', previous: null, next }; h.save();
  ws.replace(next.path, null, '');
  const reopened = new History(dir, ws), after = reopened.chat.rounds[0];
  assert.equal(after.status, 'stopped'); assert.deepEqual(after.changes, [next]);
  assert.deepEqual(reopened.review(after, 'undo'), []); assert.equal(ws.read(next.path, true), null);
});
test('目录附件限制默认搜索范围，Windows 多行编辑保留 CRLF', async t => {
  const { ws, h, root } = setup(t);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'one\r\ntwo\r\nthree\r\n');
  fs.writeFileSync(path.join(root, 'a.js'), 'one\n');
  const round = h.begin('edit', 'agent', [{ kind: 'directory', path: 'src' }]);
  const tools = await buildTools({ workspace: ws, history: h, round, signal: new AbortController().signal });
  const call = (name, args) => tools.find(tool => tool.name === name).execute('id', args);
  const found = (await call('find_files', { query: 'a.js' })).content[0].text;
  assert.deepEqual(JSON.parse(found).map(x => x.path), ['src/a.js']);
  const hits = JSON.parse((await call('search_text', { query: 'one' })).content[0].text);
  assert.deepEqual(hits, ['src/a.js:1: one']);
  await call('edit_file', { path: 'src/a.js', oldText: 'one\ntwo', newText: 'first\nsecond' });
  assert.equal(ws.read('src/a.js'), 'first\r\nsecond\r\nthree\r\n');
  round.status = 'done'; h.review(round, 'undo'); assert.equal(ws.read('src/a.js'), 'one\r\ntwo\r\nthree\r\n');
});
test('命令每次批准、拒绝、退出码和输出', async t => {
  // This fixture starts a separate project's test runner, just as the editor does.
  const parentTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (parentTestContext) process.env.NODE_TEST_CONTEXT = parentTestContext; });
  const { root, ws } = setup(t), controls = new Approvals(() => {});
  const opts = { workspace: ws, approvals: controls, signal: new AbortController().signal, toolId: 'command' };
  const denied = runApproved({ ...opts, command: 'node -e "process.exit(42)"' });
  const old = controls.visible()[0].id; controls.respond(old, false); await assert.rejects(denied, /拒绝/);
  fs.writeFileSync(path.join(root, 'foo.test.js'), "require('node:test')('math', () => {throw Error('test failure')});");
  const pending = runApproved({ ...opts, command: 'node --test' });
  controls.respond(old, true); assert.equal(controls.visible().length, 1);
  controls.respond(controls.visible()[0].id, true); const result = await pending;
  assert.equal(result.code, 1); assert.match(result.stdout, /test failure/);
  const err = runApproved({ ...opts, command: 'node -e "console.error(123)"' });
  controls.respond(controls.visible()[0].id, true); assert.match((await err).stderr, /123/);
});
test('停止取消待批准请求，并终止已运行的子进程树', async t => {
  const { ws, root } = setup(t), approvals = new Approvals(() => {});
  const ctrl = new AbortController(), opt = { workspace: ws, approvals, command: 'node wait.cjs', signal: ctrl.signal, toolId: 'stop' };
  const wait = runApproved(opt); ctrl.abort(); await assert.rejects(wait); assert.equal(approvals.visible().length, 0);
  fs.writeFileSync(path.join(root, 'wait.cjs'), "const {spawn}=require('node:child_process');spawn(process.execPath,['-e',\"setTimeout(()=>require('node:fs').writeFileSync('survived','x'),1100)\"],{stdio:'inherit'}); console.log('ready');setInterval(()=>{},10000)");
  const c = new AbortController();
  const running = runApproved({ ...opt, signal: c.signal, report: r => { if (r.stdout.includes('ready')) c.abort(); } });
  approvals.respond(approvals.visible()[0].id, true); await running;
  await new Promise(resolve => setTimeout(resolve, 1250)); assert.equal(fs.existsSync(path.join(root, 'survived')), false);
});
test('配置仅向面板提供脱敏信息，切换地址时重新填写密钥', async () => {
  const data = new Map(), m = new Models({ get: async k => data.get(k), store: async (k, v) => data.set(k, v) });
  await m.load(); await m.save({ baseUrl: 'https://example.test/v1/', modelId: 'm', apiKey: 'sensitive' });
  assert.deepEqual(m.publicConfig(), { baseUrl: 'https://example.test/v1', modelId: 'm', hasKey: true });
  assert.equal(normalizeConfig({ baseUrl: 'https://example.test/v1', modelId: 'm2' }, m.config).apiKey, 'sensitive');
  assert.throws(() => normalizeConfig({ baseUrl: 'https://other.test/v1', modelId: 'm2' }, m.config), /API Key/);
});
test('灰字仅插入光标缺失部分，去除模型复述的前后文并保留缩进', () => {
  const line = 'const double = (n) => n * ';
  assert.equal(inlineText(line + '2;', 'const marker = 0;\r\n' + line, ''), '2;');
  assert.equal(inlineText('return sum(a, b);', '  return sum(', ');'), 'a, b');
  assert.equal(inlineText('parseInt', 'let n = par', '(value)'), 'seInt');
  assert.equal(inlineText('  return 42;\n}', 'function answer() {\n', '\n}'), '  return 42;');
  assert.equal(inlineText('foo();', 'foo(', ');'), '');
});
