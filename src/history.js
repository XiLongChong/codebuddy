const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicText } = require('./workspace');

function newChat() {
  return { id: randomUUID(), title: '新对话', updated: Date.now(), rounds: [], lastCommand: null };
}

class History {
  constructor(dir, workspace) {
    this.dir = dir;
    this.workspace = workspace;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'history.json');
    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (this.data.version !== 1 || !this.data.chats?.length) throw new Error('无法读取此版本的会话历史。');
      this.recover();
    } else {
      const chat = newChat();
      this.data = { version: 1, active: chat.id, chats: [chat] };
      this.save();
    }
  }

  save() { atomicText(this.file, JSON.stringify(this.data)); }
  get chat() { return this.data.chats.find(c => c.id === this.data.active); }
  newChat() {
    if (!this.chat.rounds.length) return this.chat;
    const chat = newChat();
    this.data.chats.unshift(chat);
    this.select(chat.id);
    return chat;
  }
  select(id) {
    if (!this.data.chats.some(c => c.id === id)) throw new Error('会话不存在。');
    this.data.active = id;
    this.save();
  }
  begin(prompt, mode, attachments) {
    const round = { id: randomUUID(), prompt, mode, attachments, time: Date.now(), status: 'running', events: [], changes: [] };
    if (!this.chat.rounds.length) this.chat.title = (prompt.trim() || attachments[0]?.label || '对话').slice(0, 45);
    this.chat.rounds.push(round);
    this.chat.updated = round.time;
    this.save();
    return round;
  }

  // Persist both sides before touching the project. A restart can finish recording the operation.
  transact(round, rel, from, to, previous, next) {
    round.intent = { path: rel, from, to, previous, next };
    this.save();
    try {
      this.workspace.replace(rel, from, to);
    } catch (error) {
      delete round.intent;
      this.save();
      throw error;
    }
    this.applyRecord(round, rel, next);
    delete round.intent;
    this.save();
  }
  applyRecord(round, rel, change) {
    const index = round.changes.findIndex(c => c.path === rel);
    if (index >= 0) round.changes.splice(index, 1, ...(change ? [change] : []));
    else if (change) round.changes.push(change);
  }
  recover() {
    let changed = false;
    for (const chat of this.data.chats) {
      for (const round of chat.rounds) {
        if (round.intent) {
          const op = round.intent;
          // An unreadable or externally changed file keeps a reviewable record. Undo checks it again.
          let current;
          try { current = this.workspace.read(op.path, true); } catch {}
          let record = op.next;
          if (current !== op.to && (current === op.from || op.next?.status === 'undone')) record = op.previous;
          this.applyRecord(round, op.path, record);
          delete round.intent;
          changed = true;
        }
        if (round.status === 'running') {
          round.status = 'stopped';
          for (const e of round.events) if (e.status === 'running' || e.status === 'approval') e.status = 'stopped';
          changed = true;
        }
      }
    }
    if (changed) this.save();
  }

  write(round, input, text) {
    const rel = this.workspace.relative(this.workspace.writable(input));
    const current = this.workspace.read(rel, true);
    const previous = round.changes.find(c => c.path === rel) ?? null;
    if (previous && previous.after !== current) throw new Error('上次写入后文件已被修改：' + rel);
    if (current === text) return rel;
    const before = previous ? previous.before : current;
    const next = before === text ? null : { path: rel, before, after: text, status: 'pending' };
    this.transact(round, rel, current, text, previous, next);
    return rel;
  }
  undo(round, change) {
    if (change.status === 'undone') return;
    this.workspace.writable(change.path);
    if (this.workspace.read(change.path, true) !== change.after) throw new Error('文件已有后续修改：' + change.path);
    this.transact(round, change.path, change.after, change.before, change, { ...change, status: 'undone' });
  }
  review(round, action, rel) {
    if (round.status === 'running') throw new Error('请先停止或等待这一轮完成。');
    const targets = rel ? round.changes.filter(c => c.path === rel) : [...round.changes];
    const conflicts = [];
    for (const item of targets) {
      if (action === 'keep' && item.status === 'pending') item.status = 'kept';
      if (action === 'undo') {
        try { this.undo(round, item); } catch (e) { conflicts.push(e.message); }
      }
    }
    this.save();
    return conflicts;
  }
}

module.exports = { History };
