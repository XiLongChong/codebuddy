const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async () => {
  const ext = vscode.extensions.getExtension('codebuddy-demo.agent-editor');
  assert.ok(ext); await ext.activate();
  await vscode.commands.executeCommand('agentEditor.open');
  const commands = (await vscode.commands.getCommands()).filter(c => c.startsWith('agentEditor.'));
  for (const name of ['open', 'configure', 'newChat', 'history', 'selection', 'quickEdit', 'complete', 'undoRound']) {
    assert.ok(commands.includes('agentEditor.' + name), name);
  }
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'sample.js')));
  const editor = await vscode.window.showTextDocument(doc);
  const formatter = vscode.extensions.getExtension('esbenp.prettier-vscode');
  await formatter.activate();
  await vscode.commands.executeCommand('editor.action.formatDocument');
  assert.ok(await doc.save()); assert.equal(doc.getText().trim(), 'const sum = (a, b) => a + b;');
  editor.selection = new vscode.Selection(0, 0, 0, 5);
  await vscode.commands.executeCommand('agentEditor.selection');
  await vscode.commands.executeCommand('agentEditor.configure');
  fs.writeFileSync(path.join(root, 'verified.json'), JSON.stringify({
    editor: vscode.version, extension: ext.id, prettier: formatter.packageJSON.version,
    formatted: fs.readFileSync(doc.uri.fsPath, 'utf8').trim(), commands: commands.length
  }, null, 2));
};
