const PROVIDER = 'agent-editor-model';
const SECRET = 'agentEditor.model.v1';

function normalizeConfig(draft, saved) {
  let url;
  try { url = new URL(draft.baseUrl.trim()); } catch { throw new Error('请输入有效的 API Base URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 应为 HTTP(S) 接口地址，密钥请填在 API Key 中。');
  }
  const baseUrl = url.href.replace(/\/+$/, '');
  const modelId = draft.modelId?.trim();
  if (!modelId) throw new Error('请输入模型 ID。');
  const apiKey = draft.apiKey?.trim() || (saved?.baseUrl === baseUrl ? saved.apiKey : '');
  if (!apiKey && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('请为此接口填写 API Key。');
  return { baseUrl, modelId, apiKey };
}

async function connectRuntime(config) {
  const [sdk, ai] = await Promise.all([import('@earendil-works/pi-coding-agent'), import('@earendil-works/pi-ai')]);
  const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(),
    modelsStore: new ai.InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  const modelSpec = { id: config.modelId, name: config.modelId, input: ['text'], reasoning: false,
    contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  if (new URL(config.baseUrl).hostname !== 'api.openai.com') {
    modelSpec.compat = { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' };
  }
  runtime.registerProvider(PROVIDER, { baseUrl: config.baseUrl, api: 'openai-completions', models: [modelSpec] });
  await runtime.setRuntimeApiKey(PROVIDER, config.apiKey || 'local');
  return { sdk, runtime, model: runtime.getModel(PROVIDER, config.modelId) };
}

function redact(message, key) {
  let result = String(message || '模型请求失败。');
  if (key) result = result.replaceAll(key, '••••');
  return result.replace(/Bearer\s+[^\s",]+/gi, 'Bearer ••••');
}
function textOf(content) {
  return (content || []).filter(part => part.type === 'text').map(part => part.text).join('');
}

class Models {
  constructor(secrets) { this.secrets = secrets; }
  async load() {
    const data = await this.secrets.get(SECRET);
    this.config = data ? JSON.parse(data) : null;
    this.connection = null;
  }
  publicConfig() {
    return this.config ? { baseUrl: this.config.baseUrl, modelId: this.config.modelId, hasKey: !!this.config.apiKey } : null;
  }
  async save(draft) {
    const next = normalizeConfig(draft, this.config);
    await this.secrets.store(SECRET, JSON.stringify(next));
    this.config = next;
    this.connection = null;
  }
  get() {
    if (!this.config) throw new Error('请先配置模型。');
    return this.connection ??= connectRuntime(this.config).catch(error => { this.connection = null; throw error; });
  }
  async test(draft) {
    const config = normalizeConfig(draft, this.config);
    try {
      const connection = await connectRuntime(config);
      await generate(connection, 'Reply with OK.', 'Connection test', 16, AbortSignal.timeout(45000));
    } catch (error) { throw new Error(redact(error.message, config.apiKey)); }
  }
}

async function generate(connection, systemPrompt, prompt, maxTokens, signal) {
  signal?.throwIfAborted();
  const { runtime, model } = connection;
  const msg = await runtime.completeSimple(model, { systemPrompt, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] },
    { maxTokens, signal, maxRetries: 0 });
  signal?.throwIfAborted();
  if (msg.stopReason === 'error' || msg.stopReason === 'aborted') throw new Error(msg.errorMessage || '模型请求中断。');
  return textOf(msg.content);
}

function unfence(text) {
  const match = /^\s*\x60{3,}[^\r\n]*\r?\n([\s\S]*?)\r?\n\x60{3,}\s*$/.exec(text);
  return match ? match[1] : text;
}

function inlineText(raw, prefix, suffix) {
  let insertion = unfence(raw).replace(/\r\n/g, '\n');
  const before = prefix.replace(/\r\n/g, '\n');
  const after = suffix.replace(/\r\n/g, '\n');
  // Chat models sometimes return the completed line or several surrounding lines.
  // Remove an exact replay, keeping leading spaces of a genuine insertion.
  let start = 0;
  while (start < before.length) {
    const block = before.slice(start);
    const candidates = [block, block.trimStart(), block.trim()];
    const replay = candidates.find(s => s.trim().length >= 3 && insertion.startsWith(s));
    if (replay) {
      insertion = insertion.slice(replay.length);
      break;
    }
    const newline = before.indexOf('\n', start);
    if (newline === -1) {
      const word = before.match(/[\p{L}_$][\p{L}\p{N}_$]*$/u)?.[0];
      if (word?.length >= 2 && insertion.startsWith(word)) insertion = insertion.slice(word.length);
      break;
    }
    start = newline + 1;
  }
  for (let n = Math.min(after.length, insertion.length); n > 0; n--) {
    const overlap = after.slice(0, n);
    if (insertion.endsWith(overlap) && (n > 1 || /[\n)\]};,.]/.test(overlap))) {
      insertion = insertion.slice(0, -n);
      break;
    }
  }
  return insertion.split('\n').slice(0, 3).join('\n');
}
module.exports = { Models, connectRuntime, generate, normalizeConfig, textOf, redact, unfence, inlineText };
