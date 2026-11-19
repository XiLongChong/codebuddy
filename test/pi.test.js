const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Workspace } = require('../src/workspace');
const { History } = require('../src/history');
const { Models } = require('../src/model');
const { AgentRunner } = require('../src/agent');

// Deterministic OpenAI wire fixture. The SDK, disk, command process and resumed transcript are real.
function stream(res, message, index) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'test-' + index, object: 'chat.completion.chunk',
    created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  chunk({ role: 'assistant' });
  if (typeof message === 'string') {
    chunk({ content: message.slice(0, 3) }); chunk({ content: message.slice(3) }); chunk({}, 'stop');
  } else {
    chunk({ tool_calls: [{ index: 0, id: 'call_' + index, type: 'function', function: { name: message[0], arguments: JSON.stringify(message[1]) } }] });
    chunk({}, 'tool_calls');
  }
  res.end('data: [DONE]\n\n');
}
test('Pi SDK 流式对话、多文件、失败测试反馈、会话恢复及模式隔离', { timeout: 50000 }, async t => {
  const parentTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  t.after(() => { if (parentTestContext) process.env.NODE_TEST_CONTEXT = parentTestContext; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pi-')), root = path.join(dir, 'project');
  fs.mkdirSync(root);
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('agent-pi-'));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const requests = [];
  const steps = [
    ['write_file', { path: 'add.js', content: 'exports.add = (a,b) => a-b;\n' }],
    ['write_file', { path: 'add.test.js', content: "require('node:test')('sum',()=>require('node:assert/strict').equal(require('./add').add(2,3),5))" }],
    ['run_command', { command: 'node --test' }],
    ['edit_file', { path: 'add.js', oldText: 'a-b', newText: 'a+b' }],
    ['run_command', { command: 'node --test' }], '测试通过。', '仍记得上轮修改。'
  ];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const data = JSON.parse(raw); requests.push(data);
    if (requests.length > steps.length) { res.writeHead(401); res.end('{"error":{"message":"invalid test key"}}'); return; }
    stream(res, steps[requests.length - 1], requests.length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const values = new Map(), models = new Models({ get: k => values.get(k), store: (k, v) => values.set(k, v) });
  await models.load(); await models.save({ baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', modelId: 'fixture', apiKey: 'test-key' });
  const ws = new Workspace(root), data = path.join(dir, 'history');
  let h = new History(data, ws), approvals = 0;
  const create = () => new AgentRunner({ workspace: ws, history: h, models, diagnostics: () => 'no diagnostics',
    notify: () => { for (const a of runner.approvals.visible()) { approvals++; runner.approvals.respond(a.id, true); } } });
  let runner = create();
  const first = await runner.send('实现并测试加法', 'agent', []);
  assert.equal(first.status, 'done', first.error); assert.equal(approvals, 2);
  assert.equal(first.changes.length, 2); assert.match(ws.read('add.js'), /a\+b/);
  const commands = first.events.filter(e => e.name === 'run_command');
  assert.deepEqual(commands.map(e => [e.status, e.output?.code]), [['failed', 1], ['done', 0]]);
  assert.match(JSON.stringify(requests[3].messages), /AssertionError/);
  assert.match(first.events.at(-1).text, /测试通过/);
  h = new History(data, ws); runner = create();
  const second = await runner.send('我上一轮做了什么？', 'ask', [{ kind: 'selection', path: 'add.js', label: 'add.js:1–1', text: 'UNSAVED_SELECTION' }]);
  assert.equal(second.status, 'done', second.error);
  const request = requests.at(-1);
  assert.deepEqual(request.tools.map(t => t.function.name).sort(), ['find_files', 'get_diagnostics', 'list_directory', 'read_file', 'search_text']);
  assert.match(JSON.stringify(request.messages), /实现并测试加法/); assert.match(JSON.stringify(request.messages), /UNSAVED_SELECTION/);
  const failed = await runner.send('保留这条失败的问题', 'ask', []);
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /401|invalid test key/i);
  assert.equal(failed.prompt, '保留这条失败的问题'); assert.equal(h.chat.lastCommand.code, 0);
});
