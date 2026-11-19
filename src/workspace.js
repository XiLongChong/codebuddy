const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_FILE = 1024 * 1024;
const ignored = new Set(['.git', '.svn', '.hg', '.ssh', '.aws', '.azure', '.gnupg',
  '.kube', '.docker', '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials',
  '.envrc', 'node_modules', '.venv', '__pycache__', '.cache', '.terraform']);
const sensitive = /^(?:\.env(?:[.-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:[._-].*)?|(?:credentials?|secrets?|service[-_]?account|application_default_credentials|kubeconfig)(?:[._-].*)?|\.agent-editor-.*)$|\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i;

function safeSegment(part) {
  return part !== '..' && !ignored.has(part.toLowerCase()) && !sensitive.test(part)
    && !/[<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    && !(process.platform === 'win32' && /~\d/.test(part));
}

function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function atomicText(target, text, mode) {
  const tmp = path.join(path.dirname(target), '.agent-editor-' + randomUUID() + '.tmp');
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx', mode: mode ?? 0o600, flush: true });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

class Workspace {
  constructor(root, guard = () => {}, dirty = () => false) {
    this.root = fs.realpathSync.native(root);
    this.guard = guard;
    this.dirty = dirty;
  }

  resolve(input = '.', allowMissing = false) {
    this.guard();
    if (typeof input !== 'string' || path.isAbsolute(input) || /^[\\/]|^[a-z]:/i.test(input)) {
      throw new Error('请使用工作区相对路径。');
    }
    const parts = input.split(/[\\/]/).filter(part => part && part !== '.');
    if (!parts.every(safeSegment)) throw new Error('路径受保护或无效：' + input);
    let target = this.root;
    for (const part of parts) {
      target = path.join(target, part);
      const stat = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!stat) {
        if (!allowMissing) throw new Error('路径不存在：' + input);
        continue;
      }
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('跳过链接：' + input);
      target = fs.realpathSync.native(target);
      if (!isInside(this.root, target) || !path.relative(this.root, target).split(path.sep).every(safeSegment)) {
        throw new Error('路径不在允许的工作区范围内。');
      }
    }
    return target;
  }

  relative(file) {
    if (!isInside(this.root, file)) throw new Error('文件位于工作区外。');
    const rel = path.relative(this.root, file).split(path.sep).join('/') || '.';
    this.resolve(rel, true);
    return rel;
  }

  read(rel, allowMissing = false) {
    const target = this.resolve(rel, allowMissing);
    const st = fs.statSync(target, { throwIfNoEntry: false });
    if (!st && allowMissing) return null;
    if (!st?.isFile() || st.size > MAX_FILE) throw new Error('仅支持 1 MiB 以内的 UTF-8 文本：' + rel);
    const buf = fs.readFileSync(target);
    if (buf.includes(0) || !require('node:buffer').isUtf8(buf)) throw new Error('跳过非 UTF-8 文本：' + rel);
    return buf.toString('utf8');
  }

  writable(rel) {
    const target = this.resolve(rel, true);
    if (this.dirty(target)) throw new Error('编辑器中有未保存的修改，请先保存：' + rel);
    return target;
  }

  replace(rel, expected, next) {
    let target = this.writable(rel);
    if (next !== null && (typeof next !== 'string' || next.includes('\0') || Buffer.byteLength(next) > MAX_FILE)) {
      throw new Error('写入内容须为 1 MiB 以内的文本。');
    }
    if (this.read(rel, true) !== expected) throw new Error('文件内容已发生变化：' + rel);
    if (next === null) {
      if (expected !== null) fs.unlinkSync(target);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      target = this.writable(rel);
      if (expected === null) {
        fs.writeFileSync(target, next, { flag: 'wx', encoding: 'utf8', flush: true });
      } else {
        atomicText(target, next, fs.statSync(target).mode);
      }
    }
  }

  entries(scope = '.') {
    const dir = this.resolve(scope);
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => safeSegment(e.name) && (e.isFile() || e.isDirectory()))
      .map(e => ({ path: path.posix.join(scope.replaceAll('\\', '/'), e.name), directory: e.isDirectory() }))
      .filter(e => { try { this.resolve(e.path); return true; } catch { return false; } })
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path));
  }

  async *walk(scopes, signal) {
    const queue = [...new Set(scopes)];
    const seen = new Set();
    for (let i = 0; i < queue.length; i++) {
      signal?.throwIfAborted();
      const scope = queue[i];
      if (seen.has(scope)) continue;
      seen.add(scope);
      await new Promise(resolve => setImmediate(resolve));
      let entries;
      try { entries = this.entries(scope); } catch (error) {
        if (i < scopes.length) throw error;
        continue;
      }
      for (const entry of entries) {
        signal?.throwIfAborted();
        yield entry;
        if (entry.directory) queue.push(entry.path);
      }
    }
  }

  async find(query = '', scopes = ['.'], signal, limit = 60) {
    const matches = [];
    for await (const entry of this.walk(scopes, signal)) {
      if (entry.path.toLowerCase().includes(query.toLowerCase())) matches.push(entry);
      if (matches.length >= limit) break;
    }
    return matches;
  }

  async search(query, scopes, signal) {
    if (!query) throw new Error('请输入要搜索的文本。');
    const matches = [];
    for await (const entry of this.walk(scopes, signal)) {
      if (entry.directory) continue;
      let content;
      try { content = this.read(entry.path); } catch { continue; }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const col = lines[i].indexOf(query);
        if (col !== -1) matches.push(entry.path + ':' + (i + 1) + ': ' + lines[i].slice(Math.max(0, col - 80), col + 240));
        if (matches.length >= 60) return matches;
      }
    }
    return matches;
  }
}

module.exports = { Workspace, isInside, atomicText };
