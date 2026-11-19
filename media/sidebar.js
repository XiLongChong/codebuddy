(() => {
  'use strict';
  const api = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const send = (type, fields = {}) => api.postMessage({ type, ...fields });
  const make = (name, cls, text) => {
    const el = document.createElement(name);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const button = (label, fn, cls) => {
    const el = make('button', cls, label);
    el.type = 'button'; el.addEventListener('click', fn); return el;
  };
  const md = window.markdownit({ html: false, linkify: false, breaks: true });
  md.disable('image');
  const store = api.getState() || { drafts: {}, mode: 'ask' };
  let state = {}, activeChat, screen = 'chat', seq = 0, timer, matches = [], index = 0;
  const prompt = $('prompt');
  const status = { pending: '待审阅', kept: '已保留', undone: '已撤销', done: '成功', failed: '失败', running: '执行中', stopped: '已停止' };
  const toolNames = { list_directory: '列出目录', find_files: '查找文件', search_text: '搜索文本', read_file: '读取文件',
    get_diagnostics: '读取诊断', write_file: '写入文件', edit_file: '修改文件', run_command: '运行命令' };
  function persist() {
    if (activeChat) store.drafts[activeChat] = prompt.value;
    api.setState(store);
  }
  function showNotice(message, error, where) {
    const el = $(where === 'config' ? 'configNotice' : 'notice');
    el.textContent = message || ''; el.hidden = !message; el.classList.toggle('error', !!error);
  }
  function showScreen(next) {
    screen = next;
    $('chat').hidden = next !== 'chat'; $('settings').hidden = next === 'chat';
    if (next === 'config') {
      $('baseUrl').value = state.config?.baseUrl || '';
      $('modelId').value = state.config?.modelId || '';
      $('apiKey').value = ''; $('apiKey').placeholder = state.config?.hasKey ? '••••••••' : '';
      $('keyHint').textContent = state.config?.hasKey ? '留空沿用当前地址已保存的密钥。' : '密钥保存在编辑器的 SecretStorage 中。';
      showNotice('', false, 'config'); $('baseUrl').focus();
    } else { $('apiKey').value = ''; prompt.focus(); }
  }
  function fileTarget(raw) {
    let value;
    try { value = decodeURIComponent(raw); } catch { return; }
    const match = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)?$/.exec(value);
    const file = match?.[1].replace(/^\.\//, '').replaceAll('\\', '/');
    if (!file || /^[/#]|^[a-z][\w+.-]*:/i.test(file) || file.split('/').includes('..')) return;
    return { path: file, line: Number(match[2] || match[3] || 1) };
  }
  function link(el, target) {
    el.href = '#'; el.addEventListener('click', e => { e.preventDefault(); send('file', target); });
  }
  function markdown(text) {
    const el = make('div', 'markdown');
    el.innerHTML = md.render(text);
    for (const a of el.querySelectorAll('a')) {
      const target = fileTarget(a.getAttribute('href') || '');
      if (target) link(a, target); else a.replaceWith(...a.childNodes);
    }
    // Recognize relative paths in prose and inline code, preserving literal code blocks.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('a,pre')) nodes.push(walker.currentNode);
    const pattern = /(?:[\w.\-\u4e00-\u9fff]+[/\\])*[\w\-\u4e00-\u9fff]+\.(?:[cm]?[jt]sx?|json|ya?ml|md|py|c|cc|cpp|h|hpp|cs|java|go|rs|vue|css|html|txt|toml|xml|sh|ps1)(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)?(?![\w/])/gi;
    for (const node of nodes) {
      const content = node.textContent;
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const m of content.matchAll(pattern)) {
        const target = fileTarget(m[0]);
        if (!target) continue;
        frag.append(content.slice(at, m.index));
        const a = make('a', '', m[0]); link(a, target); frag.append(a); at = m.index + m[0].length;
      }
      if (at) { frag.append(content.slice(at)); node.replaceWith(frag); }
    }
    return el;
  }
  function review(r) {
    const panel = make('div', 'review'), head = make('div', 'review-head');
    head.append(make('strong', '', '改动文件 · ' + r.changes.length));
    if (r.status !== 'running' && r.changes.some(c => c.status === 'pending')) {
      head.append(button('全部保留', () => send('review', { round: r.id, action: 'keep' })));
    }
    panel.append(head);
    for (const change of r.changes) {
      const fields = { round: r.id, path: change.path };
      const row = make('div', 'change');
      row.append(button(change.path, () => send('diff', fields), 'filepath'),
        make('span', 'status', (change.created ? '新建 · ' : '') + status[change.status]));
      if (r.status !== 'running' && change.status === 'pending') {
        row.append(button('保留', () => send('review', { ...fields, action: 'keep' })),
          button('撤销', () => send('review', { ...fields, action: 'undo' })));
      }
      panel.append(row);
    }
    return panel;
  }
  function roundView(r, expanded) {
    const el = make('article', 'round');
    el.append(make('span', 'meta', r.mode === 'agent' ? '你 · Agent' : '你 · 问答'), make('div', 'question', r.prompt));
    if (r.attachments.length) el.append(make('div', 'meta', r.attachments.map(a => a.label).join(' · ')));
    for (const e of r.events) {
      if (e.kind === 'assistant') { el.append(markdown(e.text)); continue; }
      const details = make('details', 'tool'); details.dataset.id = e.id; details.open = expanded.has(e.id);
      const summary = make('summary');
      summary.append(make('strong', '', toolNames[e.name] || e.name), make('span', 'target', e.target),
        make('span', 'status' + (e.status === 'failed' ? ' failure' : ''), status[e.status]));
      details.append(summary);
      if (e.output) details.append(make('pre', '', 'stdout:\n' + e.output.stdout + '\nstderr:\n' + e.output.stderr + '\n退出码：' + (e.output.code ?? '—')));
      else if (e.result) details.append(make('pre', '', e.result));
      el.append(details);
    }
    if (r.status === 'running') el.append(make('span', 'meta', 'Pi 正在处理…'));
    if (r.status === 'stopped') el.append(make('span', 'meta', '本轮已停止'));
    if (r.error) el.append(make('div', 'notice error', r.error));
    if (r.changes.length) el.append(review(r));
    return el;
  }
  const cache = new Map();
  function historyView(changedChat) {
    const list = $('messages');
    const stick = changedChat || list.scrollHeight - list.scrollTop - list.clientHeight < 70;
    const expanded = new Set([...list.querySelectorAll('details[open]')].map(e => e.dataset.id));
    const items = [];
    if (state.unavailable || !state.rounds?.length) {
      const empty = make('div', 'empty');
      empty.append(make('h2', '', state.workspace || 'AI 对话'));
      const copy = state.unavailable || (state.config ? '询问项目里的代码，或切换到 Agent 修改文件并运行测试。' : '连接 OpenAI 兼容模型后，即可提问或修改项目。');
      empty.append(make('p', 'muted', copy));
      if (state.unavailable) empty.append(button(state.unavailable.includes('信任') ? '管理工作区信任' : '打开文件夹',
        () => send(state.unavailable.includes('信任') ? 'trust' : 'openFolder'), 'secondary'));
      if (!state.config) empty.append(button('配置模型', () => showScreen('config'), 'primary'));
      items.push(empty);
    }
    for (const r of state.rounds || []) {
      const key = JSON.stringify(r), old = cache.get(r.id);
      const node = old?.key === key ? old.node : roundView(r, expanded);
      cache.set(r.id, { key, node }); items.push(node);
    }
    if (state.rounds?.some(r => r.changes.length)) {
      const undo = button('撤销最近一轮 Agent 改动', () => send('undoLast'), 'secondary');
      undo.disabled = state.running; items.push(undo);
    }
    list.replaceChildren(...items);
    if (stick) list.scrollTop = list.scrollHeight;
  }
  function render(data) {
    const changed = activeChat !== data.chat;
    if (changed) {
      persist(); cache.clear(); activeChat = data.chat;
      prompt.value = store.drafts[activeChat] || '';
      showNotice(''); hideMatches();
    }
    state = data;
    historyView(changed);
    $('attachments').replaceChildren(...data.attachments.map(a => {
      const item = button(a.label + ' ×', () => send('remove', { id: a.id }), 'chip');
      item.title = '移除附件 ' + a.label; item.disabled = data.running; return item;
    }));
    $('approvals').replaceChildren(...data.approvals.map(a => {
      const el = make('div', 'approval');
      el.append(make('strong', '', '是否运行这条命令？'), make('pre', '', a.command), make('small', 'muted', a.cwd));
      const controls = make('div', 'actions');
      for (const [label, allowed] of [['运行', true], ['拒绝', false]]) controls.append(button(label, () => {
        for (const b of controls.children) b.disabled = true;
        send('approve', { id: a.id, allowed });
      }, allowed ? 'primary' : 'secondary'));
      el.append(controls); return el;
    }));
    $('modelLabel').textContent = data.config?.modelId || '尚未配置模型';
    $('send').textContent = data.stopping ? '正在停止…' : data.running ? '停止' : '发送';
    $('send').disabled = !!data.unavailable || data.stopping;
    prompt.disabled = data.running || !!data.unavailable;
    for (const id of ['newChat', 'history', 'context', 'ask', 'agent']) $(id).disabled = data.running || !!data.unavailable;
    $('addOutput').disabled = !data.lastCommand;
    for (const mode of ['ask', 'agent']) $(mode).setAttribute('aria-pressed', String(store.mode === mode));
  }
  function sendPrompt() {
    if (state.running) return send('stop');
    if (!state.config) return showScreen('config');
    if (!prompt.value.trim()) { prompt.focus(); return; }
    persist(); hideMatches(); showNotice(''); send('send', { text: prompt.value, mode: store.mode });
  }
  function mention() { return /(?:^|\s)@([^\s@]*)$/.exec(prompt.value.slice(0, prompt.selectionStart)); }
  function hideMatches() { clearTimeout(timer); seq++; matches = []; $('matches').hidden = true; }
  function pickFile(item) {
    const pos = prompt.selectionStart, m = mention();
    if (!m || !item) return;
    prompt.setRangeText('', pos - m[1].length - 1, pos, 'end');
    send('attachPath', { path: item.path }); hideMatches(); persist(); prompt.focus();
  }
  function matching() {
    persist(); hideMatches();
    const m = mention(); if (!m) return;
    const request = seq;
    timer = setTimeout(() => send('find', { query: m[1], seq: request }), 100);
  }
  function drawMatches() {
    const el = $('matches'); el.hidden = false;
    el.replaceChildren(...matches.map((item, i) => {
      const option = button(item.path + (item.directory ? '/' : ''), () => pickFile(item));
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(i === index)); return option;
    }));
    if (!matches.length) el.append(make('span', 'muted', '没有匹配的文件或目录'));
    el.children[index]?.scrollIntoView({ block: 'nearest' });
  }
  $('newChat').onclick = () => send('new'); $('history').onclick = () => send('history');
  $('configure').onclick = () => showScreen('config'); $('back').onclick = () => showScreen('chat');
  for (const mode of ['ask', 'agent']) $(mode).onclick = () => { store.mode = mode; persist(); render(state); prompt.focus(); };
  $('send').onclick = sendPrompt;
  prompt.oninput = matching;
  prompt.onkeydown = e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (!$('matches').hidden) {
      if (e.key === 'Escape') { e.preventDefault(); return hideMatches(); }
      if (matches.length && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab'].includes(e.key)) {
        e.preventDefault();
        if (['Tab', 'Enter'].includes(e.key)) return pickFile(matches[index]);
        index = (index + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length; return drawMatches();
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
  };
  function toggleMenu(open) { $('contextMenu').hidden = !open; $('context').setAttribute('aria-expanded', String(open)); }
  $('context').onclick = () => toggleMenu($('contextMenu').hidden);
  $('addDiagnostics').onclick = () => { toggleMenu(false); send('diagnostics'); };
  $('addOutput').onclick = () => { toggleMenu(false); send('output'); };
  $('addFile').onclick = () => {
    toggleMenu(false); prompt.focus(); const at = prompt.selectionStart;
    prompt.setRangeText((at && !/\s/.test(prompt.value[at - 1]) ? ' @' : '@'), at, prompt.selectionEnd, 'end'); matching();
  };
  function modelAction(type) {
    if (!$('modelForm').reportValidity()) return;
    $('testModel').disabled = $('saveModel').disabled = true;
    showNotice(type === 'testModel' ? '正在测试连接…' : '正在保存…', false, 'config');
    send(type, { baseUrl: $('baseUrl').value, modelId: $('modelId').value, apiKey: $('apiKey').value });
  }
  $('testModel').onclick = () => modelAction('testModel');
  $('modelForm').onsubmit = e => { e.preventDefault(); modelAction('saveModel'); };
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') render(data);
    if (data.type === 'screen') showScreen(data.screen);
    if (data.type === 'notice') {
      if (data.screen === 'config') $('testModel').disabled = $('saveModel').disabled = false;
      showNotice(data.message, data.error, data.screen);
    }
    if (data.type === 'saved') {
      $('testModel').disabled = $('saveModel').disabled = false; showScreen('chat'); showNotice('模型配置已保存。');
    }
    if (data.type === 'sent' && data.chat === activeChat) { prompt.value = ''; persist(); }
    if (data.type === 'matches' && data.seq === seq && mention()) { matches = data.files; index = 0; drawMatches(); }
  });
  send('ready');
})();
