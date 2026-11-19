const { commandText, runApproved } = require('./commands');

async function buildTools({ workspace, history, round, signal, approvals, diagnostics, notify, trackCommand }) {
  const { Type } = await import('typebox');
  const string = () => Type.String();
  const scope = Type.Optional(Type.String({ description: 'Workspace-relative directory. Defaults to attached directories or the project root.' }));
  const attached = round.attachments.filter(a => a.kind === 'directory').map(a => a.path);
  const chat = history.chat;
  const scopes = dir => dir ? [dir] : (attached.length ? attached : ['.']);
  function tool(name, label, description, properties, run) {
    return { name, label, description, parameters: Type.Object(properties), executionMode: 'sequential',
      async execute(id, args, sdkSignal) {
        const active = sdkSignal ? AbortSignal.any([signal, sdkSignal]) : signal;
        active.throwIfAborted();
        workspace.guard();
        const result = await run(args, active, id);
        active.throwIfAborted();
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: 'text', text: text || '（无结果）' }], details: {} };
      } };
  }
  const readTools = [
    tool('list_directory', '列出目录', 'List immediate children of a project directory.', { directory: scope },
      ({ directory }) => scopes(directory).flatMap(dir => workspace.entries(dir)).slice(0, 200)),
    tool('find_files', '查找文件', 'Find files or directories by a case-insensitive path substring.', { query: string(), directory: scope },
      ({ query, directory }, sig) => workspace.find(query, scopes(directory), sig)),
    tool('search_text', '搜索文本', 'Search for literal text and report file paths and line numbers.', { query: string(), directory: scope },
      ({ query, directory }, sig) => workspace.search(query, scopes(directory), sig)),
    tool('read_file', '读取文件', 'Read UTF-8 text. startLine is 1-based. Read more with another call.', {
      path: string(), startLine: Type.Optional(Type.Integer({ minimum: 1 })), lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 400 })) },
      ({ path, startLine = 1, lines = 200 }) => {
        const all = workspace.read(path).split(/\r?\n/);
        return 'Lines ' + startLine + '–' + Math.min(all.length, startLine + lines - 1) + ' / ' + all.length + '\n'
          + all.slice(startLine - 1, startLine - 1 + lines).join('\n').slice(0, 24000);
      }),
    tool('get_diagnostics', '获取诊断', 'Get editor diagnostics for a workspace file.', { path: string() }, ({ path }) => diagnostics(path))
  ];
  if (round.mode !== 'agent') return readTools;
  return [...readTools,
    tool('write_file', '写入文件', 'Create or replace a text file with the complete content. Use project-relative paths.', { path: string(), content: string() },
      ({ path, content }) => '已写入 ' + history.write(round, path, content)),
    tool('edit_file', '修改文件', 'Replace one exact, unique piece of text. Preserve surrounding whitespace and line endings.', {
      path: string(), oldText: string(), newText: string() }, ({ path, oldText, newText }) => {
        const original = workspace.read(path);
        let match = oldText;
        let replacement = newText;
        if (original.includes('\r\n') && !oldText.includes('\r\n')) {
          if (!original.includes(match)) match = oldText.replaceAll('\n', '\r\n');
          replacement = newText.replace(/\r?\n/g, '\r\n');
        }
        if (!match || !original.includes(match) || original.indexOf(match) !== original.lastIndexOf(match)) {
          throw new Error('找不到唯一匹配的原文，请重新读取文件。');
        }
        return '已修改 ' + history.write(round, path, original.replace(match, () => replacement));
      }),
    tool('run_command', '运行命令', 'Run a shell command after one explicit user approval. Inspect stdout, stderr and exit code; fix failed tests when appropriate.', {
      command: string(), directory: scope }, async ({ command, directory }, sig, toolId) => {
        const result = await trackCommand(runApproved({ workspace, approvals, command, directory, signal: sig, toolId, report: output => {
          const card = round.events.find(e => e.id === toolId);
          if (card) card.output = { ...output };
          notify();
        } }));
        chat.lastCommand = { ...result };
        history.save();
        if (result.code !== 0) throw new Error(commandText(result));
        return commandText(result);
      })
  ];
}
module.exports = { buildTools };
