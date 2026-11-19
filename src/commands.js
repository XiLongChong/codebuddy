const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const OUTPUT_LIMIT = 32000;
function tail(text) {
  return text.length <= OUTPUT_LIMIT ? text : '…（仅保留最近输出）\n' + text.slice(-OUTPUT_LIMIT + 16);
}
function commandText(result) {
  return '命令：' + result.command + '\n工作目录：' + result.cwd + '\nstdout:\n' + result.stdout
    + '\nstderr:\n' + result.stderr + '\n退出码：' + (result.code ?? '已终止');
}
class Approvals {
  constructor(update) { this.update = update; this.pending = new Map(); }
  request(command, cwd, signal, toolId) {
    signal.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (allowed, reason) => {
        this.pending.delete(id);
        signal.removeEventListener('abort', cancel);
        this.update();
        if (allowed) resolve();
        else reject(new Error(reason || '用户拒绝了这次命令。'));
      };
      const cancel = () => finish(false, '本轮已停止。');
      this.pending.set(id, { id, toolId, command, cwd, finish });
      signal.addEventListener('abort', cancel, { once: true });
      this.update();
    });
  }
  respond(id, allowed) { this.pending.get(id)?.finish(allowed === true); }
  visible() { return Array.from(this.pending.values(), ({ id, toolId, cwd, command }) => ({ id, toolId, cwd, command })); }
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const kill = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    kill.on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
async function runApproved({ workspace, approvals, command, directory = '.', signal, toolId, report }) {
  if (!command?.trim() || command.includes('\0')) throw new Error('无效命令。');
  const cwd = workspace.resolve(directory);
  if (!fs.statSync(cwd).isDirectory()) throw new Error('工作目录无效。');
  await approvals.request(command, cwd, signal, toolId);
  signal.throwIfAborted();
  if (workspace.resolve(directory) !== cwd) throw new Error('工作目录已改变，请重试。');
  const result = { command, cwd, stdout: '', stderr: '', code: null };
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const abort = () => killTree(child);
    signal.addEventListener('abort', abort, { once: true });
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8');
      child[name].on('data', chunk => { result[name] = tail(result[name] + chunk); report?.(result); });
    }
    child.once('error', e => { signal.removeEventListener('abort', abort); reject(e); });
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      result.code = code;
      report?.(result);
      resolve(result);
    });
  });
}
module.exports = { Approvals, runApproved, commandText };
