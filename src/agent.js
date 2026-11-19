const fs = require('node:fs');
const path = require('node:path');
const { buildTools } = require('./tools');
const { Approvals } = require('./commands');
const { textOf, redact } = require('./model');

function promptFor(round, workspace) {
  const parts = [round.prompt];
  for (const a of round.attachments) {
    if (a.kind === 'directory') parts.push('Directory search scope: ' + a.path);
    else if (a.kind === 'file') {
      const text = workspace.read(a.path);
      parts.push('File: ' + a.path + '\n' + text.slice(0, 16000) + (text.length > 16000 ? '\n[Use read_file for remaining lines.]' : ''));
    } else parts.push(a.label + '\n' + a.text);
  }
  return parts.join('\n\n');
}
function loader(sdk, mode) {
  const extensions = { extensions: [], errors: [], runtime: sdk.createExtensionRuntime() };
  const instruction = mode === 'agent'
    ? 'Implement the requested changes using the file tools. Run requested tests with run_command. When tests fail, inspect the output, repair, and test again. If a command is refused, respect that decision.'
    : 'Answer questions about the project. You can inspect it using the available read-only tools.';
  return { getExtensions: () => extensions, getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => 'You are a coding assistant in VSCodium. '
      + instruction + ' Use the user’s language. Link to project files with Markdown relative paths and optional #L line numbers.',
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources() {}, async reload() {} };
}

class AgentRunner {
  constructor(options) {
    Object.assign(this, options);
    this.approvals = new Approvals(() => this.notify());
  }
  stop() {
    const run = this.active;
    if (!run) return;
    run.controller.abort(new Error('本轮已停止。'));
    void run.session?.abort().catch(() => {});
    this.notify();
  }
  async send(prompt, mode, attachments) {
    if (this.active) throw new Error('已有一轮正在运行。');
    this.workspace.guard();
    if (!this.models.publicConfig()) throw new Error('请先配置模型。');
    if (!prompt.trim()) throw new Error('请输入问题或任务。');
    const round = this.history.begin(prompt, mode === 'agent' ? 'agent' : 'ask', attachments);
    const run = { controller: new AbortController(), round, session: null, commands: new Set() };
    this.active = run;
    const signal = run.controller.signal;
    this.notify();
    let unsubscribe;
    let assistant;
    let modelError;
    try {
      const input = promptFor(round, this.workspace);
      const { sdk, runtime, model } = await this.models.get();
      const customTools = await buildTools({ ...this, round, signal, trackCommand: promise => {
        run.commands.add(promise);
        return promise.finally(() => run.commands.delete(promise));
      } });
      signal.throwIfAborted();
      const dir = path.join(this.history.dir, 'pi', this.history.chat.id);
      fs.mkdirSync(dir, { recursive: true });
      const cwd = this.workspace.root;
      const { session } = await sdk.createAgentSession({ cwd, agentDir: this.history.dir,
        modelRuntime: runtime, model, thinkingLevel: 'off', customTools, tools: customTools.map(t => t.name),
        resourceLoader: loader(sdk, round.mode), sessionManager: sdk.SessionManager.continueRecent(cwd, dir),
        settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false } }) });
      run.session = session;
      signal.throwIfAborted();
      unsubscribe = session.subscribe(e => {
        if (e.type === 'message_start' && e.message.role === 'assistant') assistant = null;
        if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
          if (!assistant) { assistant = { kind: 'assistant', text: '' }; round.events.push(assistant); }
          assistant.text += e.assistantMessageEvent.delta;
        }
        if (e.type === 'message_end' && e.message.role === 'assistant') {
          const text = textOf(e.message.content);
          if (assistant) assistant.text = text;
          else if (text) round.events.push({ kind: 'assistant', text });
          if (e.message.stopReason === 'error') modelError = e.message.errorMessage || '模型请求失败。';
        }
        if (e.type === 'tool_execution_start') {
          round.events.push({ kind: 'tool', id: e.toolCallId, name: e.toolName, status: 'running',
            target: e.args?.path || e.args?.command || e.args?.query || e.args?.directory || '.' });
        }
        if (e.type === 'tool_execution_end') {
          let card = round.events.find(item => item.kind === 'tool' && item.id === e.toolCallId);
          if (!card) { card = { kind: 'tool', id: e.toolCallId, name: e.toolName }; round.events.push(card); }
          card.status = signal.aborted ? 'stopped' : e.isError ? 'failed' : 'done';
          card.result = textOf(e.result?.content).slice(0, 32000);
          this.history.save();
        }
        this.notify();
      });
      await session.prompt(input, { expandPromptTemplates: false });
      signal.throwIfAborted();
      if (modelError) throw new Error(modelError);
      round.status = 'done';
    } catch (error) {
      round.status = signal.aborted ? 'stopped' : 'failed';
      if (!signal.aborted) round.error = redact(error.message, this.models.config?.apiKey);
    } finally {
      if (run.commands.size) {
        run.controller.abort();
        await Promise.allSettled([...run.commands]);
      }
      unsubscribe?.();
      run.session?.dispose();
      for (const card of round.events) if (card.status === 'running') card.status = 'stopped';
      this.active = null;
      this.history.save();
      this.notify();
    }
    return round;
  }
}
module.exports = { AgentRunner, promptFor };
