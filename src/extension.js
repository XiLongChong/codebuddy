const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { Workspace } = require('./workspace');
const { History } = require('./history');
const { Models, redact } = require('./model');
const { AgentRunner } = require('./agent');
const { commandText } = require('./commands');
const { Previews, EditorAI } = require('./editing');

class App {
  constructor(ctx) {
    this.ctx = ctx;
    this.models = new Models(ctx.secrets);
    this.previews = new Previews(ctx);
    this.attachments = [];
    this.lastEditor = vscode.window.activeTextEditor;
  }
  async start() {
    await this.models.load();
    this.setupWorkspace();
    this.editorAI = new EditorAI(this.ctx, this, this.previews);
    const command = (name, fn) => vscode.commands.registerCommand('agentEditor.' + name, async () => {
      try { return await fn(); } catch (e) { this.error(e); }
    });
    this.ctx.subscriptions.push(
      vscode.window.registerWebviewViewProvider('agentEditor.chat', this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => { this.setupWorkspace(); this.update(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.runner?.stop(); this.setupWorkspace(); this.update(); }),
      vscode.window.onDidChangeActiveTextEditor(e => { if (e?.document.uri.scheme === 'file') this.lastEditor = e; }),
      command('open', () => this.open()), command('configure', () => this.open('config')),
      command('newChat', async () => { await this.open(); this.newChat(); }),
      command('history', async () => { await this.open(); await this.pickHistory(); }),
      command('selection', () => this.addSelection()), command('quickEdit', () => this.editorAI.quickEdit()),
      command('complete', async () => {
        if (!this.models.publicConfig()) return this.open('config');
        await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      }),
      command('undoRound', () => this.undoLast()), { dispose: () => this.dispose() }
    );
  }
  usable() {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length !== 1 || folders[0].uri.scheme !== 'file') throw new Error('请打开一个本地项目文件夹。');
    if (!vscode.workspace.isTrusted) throw new Error('请先在工作区信任设置中信任此项目。');
    return folders[0];
  }
  setupWorkspace() {
    this.workspace = this.history = this.runner = undefined;
    this.attachments = [];
    let folder;
    try { folder = this.usable(); } catch (e) { this.unavailable = e.message; return; }
    try {
      const ws = new Workspace(folder.uri.fsPath, () => {
        if (this.usable().uri.toString() !== folder.uri.toString()) throw new Error('工作区已切换。');
      }, target => vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.scheme === 'file' && path.relative(target, d.uri.fsPath) === ''));
      const rootId = createHash('sha256').update(process.platform === 'win32' ? ws.root.toLowerCase() : ws.root).digest('hex').slice(0, 24);
      const storage = this.ctx.storageUri.fsPath;
      this.history = new History(vscode.workspace.workspaceFile ? path.join(storage, rootId) : storage, ws);
      this.workspace = ws;
      this.runner = new AgentRunner({ workspace: ws, history: this.history, models: this.models,
        diagnostics: rel => this.diagnostics(rel), notify: () => this.scheduleUpdate() });
      this.unavailable = '';
    } catch (e) { this.unavailable = e.message; }
  }
  requireWorkspace() {
    this.usable();
    if (!this.workspace) throw new Error(this.unavailable || '工作区未就绪。');
    return this.workspace;
  }
  documentPath(doc) {
    if (!doc || doc.uri.scheme !== 'file') throw new Error('请先打开工作区中的文本文件。');
    return this.requireWorkspace().relative(doc.uri.fsPath);
  }
  diagnostics(rel) {
    const uri = vscode.Uri.file(this.requireWorkspace().resolve(rel, true));
    return vscode.languages.getDiagnostics(uri).slice(0, 120).map(d =>
      rel + ':' + (d.range.start.line + 1) + ':' + (d.range.start.character + 1) + ' [' + vscode.DiagnosticSeverity[d.severity] + '] ' + d.message).join('\n') || '当前文件没有诊断。';
  }
  async open(screen) {
    if (screen) this.nextScreen = screen;
    await vscode.commands.executeCommand('agentEditor.chat.focus');
    if (screen && this.ready) { this.post({ type: 'screen', screen }); this.nextScreen = undefined; }
  }
  resolveWebviewView(view) {
    this.view = view;
    this.ready = false;
    const local = (...parts) => vscode.Uri.joinPath(this.ctx.extensionUri, ...parts);
    const web = view.webview;
    web.options = { enableScripts: true, localResourceRoots: [local('media'), local('node_modules', 'markdown-it', 'dist')] };
    const uri = (...parts) => web.asWebviewUri(local(...parts)).toString();
    const nonce = randomBytes(16).toString('hex');
    web.html = fs.readFileSync(local('media', 'sidebar.html').fsPath, 'utf8')
      .replaceAll('{{csp}}', web.cspSource).replaceAll('{{nonce}}', nonce).replace('{{css}}', uri('media', 'sidebar.css'))
      .replace('{{markdown}}', uri('node_modules', 'markdown-it', 'dist', 'browser', 'markdown-it.umd.min.js')).replace('{{js}}', uri('media', 'sidebar.js'));
    const listener = web.onDidReceiveMessage(async m => {
      try { await this.message(m); } catch (e) { this.error(e, m.type === 'testModel' || m.type === 'saveModel' ? 'config' : undefined); }
    });
    view.onDidDispose(() => { listener.dispose(); if (this.view === view) { this.view = undefined; this.ready = false; } });
  }
  post(message) { if (this.view) void this.view.webview.postMessage(message); }
  error(e, screen) {
    const message = redact(e.message || e, this.models.config?.apiKey);
    if (this.view?.visible) this.post({ type: 'notice', error: true, message, screen });
    else void vscode.window.showErrorMessage(message);
  }
  scheduleUpdate() {
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.update(); }, 45);
  }
  update() {
    const chat = this.history?.chat;
    const brief = a => ({ id: a.id, kind: a.kind, label: a.label });
    this.post({ type: 'state', config: this.models.publicConfig(), unavailable: this.unavailable,
      workspace: vscode.workspace.workspaceFolders?.[0]?.name, chat: chat?.id, title: chat?.title,
      rounds: chat?.rounds.map(r => ({ id: r.id, mode: r.mode, prompt: r.prompt, status: r.status, error: r.error, events: r.events,
        attachments: r.attachments.map(brief), changes: r.changes.map(c => ({ path: c.path, status: c.status, created: c.before === null })) })) || [],
      attachments: this.attachments.map(brief), running: !!this.runner?.active, stopping: !!this.runner?.active?.controller.signal.aborted,
      approvals: this.runner?.approvals.visible() || [], lastCommand: !!chat?.lastCommand });
  }
  idle() { if (this.runner?.active) throw new Error('请先停止或等待当前任务完成。'); }
  add(item) {
    this.idle();
    if (this.attachments.length >= 12) throw new Error('每条消息最多附加 12 项。');
    this.attachments.push({ ...item, id: randomUUID() });
    this.update();
  }
  async addSelection() {
    const editor = vscode.window.activeTextEditor;
    const rel = this.documentPath(editor?.document);
    const range = editor.selection;
    if (range.isEmpty) throw new Error('请先选择一段代码。');
    this.add({ kind: 'selection', path: rel, label: rel + ':' + (range.start.line + 1) + '–' + (range.end.line + (range.end.character === 0 ? 0 : 1)),
      text: editor.document.getText(range) });
    await this.open();
  }
  newChat() {
    this.requireWorkspace(); this.idle();
    this.history.newChat(); this.attachments = []; this.update();
  }
  async pickHistory() {
    this.requireWorkspace(); this.idle();
    const entries = [...this.history.data.chats].sort((a, b) => b.updated - a.updated).map(c => ({
      label: c.title, description: new Date(c.updated).toLocaleString(), id: c.id }));
    const picked = await vscode.window.showQuickPick(entries, { title: '当前工作区的历史对话', placeHolder: '选择要继续的对话' });
    if (picked) { this.idle(); this.history.select(picked.id); this.attachments = []; this.update(); }
  }
  review(round, action, rel) {
    this.idle();
    const conflicts = this.history.review(round, action, rel);
    this.update();
    if (conflicts.length) {
      const message = '以下文件已跳过：\n' + conflicts.join('\n');
      this.post({ type: 'notice', error: true, message });
      if (!this.view?.visible) void vscode.window.showWarningMessage(message);
    }
    return conflicts;
  }
  undoLast() {
    this.requireWorkspace(); this.idle();
    const round = this.history.chat.rounds.findLast(r => r.mode === 'agent' && r.changes.length);
    if (!round) throw new Error('当前对话没有可撤销的 Agent 改动。');
    this.review(round, 'undo');
  }
  async message(m) {
    if (m.type === 'ready') {
      this.ready = true; this.update();
      if (this.nextScreen) { this.post({ type: 'screen', screen: this.nextScreen }); this.nextScreen = undefined; }
      return;
    }
    if (m.type === 'testModel' || m.type === 'saveModel') {
      if (m.type === 'testModel') {
        await this.models.test(m); this.post({ type: 'notice', screen: 'config', message: '连接成功，模型已响应。' });
      } else {
        this.idle(); await this.models.save(m); this.update(); this.post({ type: 'saved' });
      }
      return;
    }
    if (m.type === 'openFolder') return vscode.commands.executeCommand('vscode.openFolder');
    if (m.type === 'trust') return vscode.commands.executeCommand('workbench.trust.manage');
    this.requireWorkspace();
    switch (m.type) {
      case 'stop': return this.runner.stop();
      case 'approve': return this.runner.approvals.respond(m.id, m.allowed);
      case 'new': return this.newChat();
      case 'history': return this.pickHistory();
      case 'send': {
        this.idle();
        const current = this.history.chat.id;
        const run = await this.runner.send(m.text, m.mode, [...this.attachments]);
        if (this.history.chat.id === current && run.status !== 'failed') {
          this.attachments = [];
          this.post({ type: 'sent', chat: current });
        }
        this.update(); return;
      }
      case 'find': {
        this.search?.abort();
        const search = this.search = new AbortController();
        try { const files = await this.workspace.find(String(m.query || ''), ['.'], search.signal, 30);
          if (!search.signal.aborted) this.post({ type: 'matches', seq: m.seq, files });
        } catch (e) { if (!search.signal.aborted) throw e; }
        return;
      }
      case 'attachPath': {
        const target = this.workspace.resolve(m.path);
        const dir = fs.statSync(target).isDirectory();
        return this.add({ kind: dir ? 'directory' : 'file', path: m.path, label: m.path + (dir ? '/' : '') });
      }
      case 'diagnostics': {
        const rel = this.documentPath(this.lastEditor?.document);
        return this.add({ kind: 'diagnostics', path: rel, label: rel + ' · 诊断', text: this.diagnostics(rel) });
      }
      case 'output': {
        const output = this.history.chat.lastCommand;
        if (!output) throw new Error('当前对话还没有命令输出。');
        return this.add({ kind: 'output', label: output.command + ' · 命令输出', text: commandText(output) });
      }
      case 'remove': this.idle(); this.attachments = this.attachments.filter(a => a.id !== m.id); return this.update();
      case 'file': {
        const file = this.workspace.resolve(m.path);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const line = Math.min(doc.lineCount - 1, Math.max(0, (Number(m.line) || 1) - 1));
        return vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });
      }
      case 'undoLast': return this.undoLast();
      case 'diff':
      case 'review': {
        const round = this.history.chat.rounds.find(r => r.id === m.round);
        if (!round) throw new Error('找不到这轮对话。');
        const change = round.changes.find(c => c.path === m.path);
        if (m.type === 'diff' && change) return this.previews.open(change.path, change.before, change.after, 'Agent 改动 · ' + change.path);
        if (m.type === 'review' && ['keep', 'undo'].includes(m.action)) return this.review(round, m.action, m.path);
      }
    }
  }
  dispose() { this.runner?.stop(); this.search?.abort(); clearTimeout(this.timer); }
}
async function activate(ctx) { const app = new App(ctx); await app.start(); }
module.exports = { activate, App };
