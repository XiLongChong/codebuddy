const vscode = require('vscode');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { generate, unfence, inlineText } = require('./model');

class Previews {
  constructor(ctx) {
    this.texts = new Map();
    ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('agent-editor-diff', {
      provideTextDocumentContent: uri => this.texts.get(uri.toString()) ?? ''
    }), vscode.workspace.onDidCloseTextDocument(doc => this.texts.delete(doc.uri.toString())));
  }
  async open(rel, before, after, title) {
    const id = randomUUID();
    const side = (name, text) => {
      const uri = vscode.Uri.from({ scheme: 'agent-editor-diff', path: '/' + id + '/' + name + '/' + rel });
      this.texts.set(uri.toString(), text ?? '');
      return uri;
    };
    const left = side('before', before);
    const right = side('after', after);
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
    return right;
  }
  async close(right) {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === right.toString());
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }
}

function nearby(doc, range, size) {
  const start = doc.offsetAt(range.start);
  const end = doc.offsetAt(range.end);
  return { prefix: doc.getText(new vscode.Range(doc.positionAt(Math.max(0, start - size)), range.start)),
    suffix: doc.getText(new vscode.Range(range.end, doc.positionAt(end + size))) };
}

class EditorAI {
  constructor(ctx, app, previews) {
    this.app = app;
    this.previews = previews;
    ctx.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, {
      provideInlineCompletionItems: (...args) => this.complete(...args)
    }), { dispose: () => this.inline?.abort() });
  }
  async quickEdit() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error('请先打开要编辑的文件。');
    const rel = this.app.documentPath(editor.document);
    if (!this.app.models.publicConfig()) { await this.app.open('config'); return; }
    const doc = editor.document;
    const version = doc.version;
    const range = new vscode.Range(editor.selection.start, editor.selection.end);
    const check = () => {
      this.app.documentPath(doc);
      if (doc.isClosed || doc.version !== version) throw new Error('原文已发生变化，请重新发起快速编辑。');
    };
    const instruction = await vscode.window.showInputBox({ title: 'AI 快速编辑', prompt: range.isEmpty ? '在光标处生成什么？' : '如何修改选中的代码？',
      placeHolder: '输入编辑指令', ignoreFocusOut: true });
    if (!instruction?.trim()) return;
    check();
    const context = nearby(doc, range, 3000);
    const original = doc.getText(range);
    const prompt = JSON.stringify({ language: doc.languageId, instruction, ...context, selected: original });
    const generated = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: '正在生成快速编辑预览', cancellable: true }, async (_, token) => {
      const controller = new AbortController();
      const sub = token.onCancellationRequested(() => controller.abort());
      try {
        return unfence(await generate(await this.app.models.get(), 'Return ONLY the replacement for selected text, or the insertion if empty. Preserve indentation. No Markdown fences or explanation.', prompt, 2500, controller.signal));
      } catch (e) { if (!controller.signal.aborted) throw e; }
      finally { sub.dispose(); }
    });
    if (generated === undefined) return;
    check();
    const before = doc.getText();
    const after = before.slice(0, doc.offsetAt(range.start)) + generated + before.slice(doc.offsetAt(range.end));
    const right = await this.previews.open(rel, before, after, 'AI 快速编辑 · ' + path.basename(rel));
    try {
      const choice = await vscode.window.showInformationMessage('将预览中的改动应用到 ' + rel + '？', '应用', '取消');
      if (choice !== '应用') return;
      check();
      const target = await vscode.window.showTextDocument(doc, editor.viewColumn);
      check();
      if (!await target.edit(builder => builder.replace(range, generated), { undoStopBefore: true, undoStopAfter: true })) {
        throw new Error('应用时原文已更改，请重试。');
      }
    } finally { await this.previews.close(right); }
  }
  async complete(doc, pos, context, token) {
    this.inline?.abort();
    if (!vscode.workspace.getConfiguration('agentEditor', doc).get('tabCompletion', true) || !this.app.models.publicConfig()) return [];
    try { this.app.documentPath(doc); } catch { return []; }
    const controller = new AbortController();
    this.inline = controller;
    const { signal } = controller;
    const version = doc.version;
    const atCursor = () => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document === doc && editor.selection.isEmpty && editor.selection.active.isEqual(pos);
    };
    if (token.isCancellationRequested || !atCursor()) return [];
    const subs = [token.onCancellationRequested(() => controller.abort()),
      vscode.workspace.onDidChangeTextDocument(e => { if (e.document === doc) controller.abort(); }),
      vscode.window.onDidChangeTextEditorSelection(() => { if (!atCursor()) controller.abort(); }),
      vscode.window.onDidChangeActiveTextEditor(() => { if (!atCursor()) controller.abort(); })];
    try {
      if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) await delay(320, undefined, { signal });
      const range = new vscode.Range(pos, pos);
      const { prefix, suffix } = nearby(doc, range, 1800);
      const input = JSON.stringify({ language: doc.languageId, prefix, suffix });
      const result = await generate(await this.app.models.get(),
        'Continue the code between prefix and suffix. Return only a short insertion, at most three lines. Preserve needed spaces. Do not repeat existing text or add Markdown.', input, 96, signal);
      if (signal.aborted || version !== doc.version || !atCursor() || !vscode.workspace.getConfiguration('agentEditor', doc).get('tabCompletion', true)) return [];
      const text = inlineText(result, prefix, suffix);
      return text.trim() ? [new vscode.InlineCompletionItem(text, range)] : [];
    } catch { return []; }
    finally {
      for (const sub of subs) sub.dispose();
      if (this.inline === controller) this.inline = null;
    }
  }
}
module.exports = { EditorAI, Previews };
