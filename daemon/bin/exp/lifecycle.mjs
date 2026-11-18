// experience/lifecycle: an entry stops being a draft and becomes trustworthy.
//
// Separate from entry.mjs (pure record I/O) because capture/finalize/update are
// policy: what may be written, when a script must be verified first, and when a
// status change is legitimate.
import fs from 'node:fs';
import path from 'node:path';
import { assertInsideRoot, atomicWrite, entryFile, loadLedger, saveLedger, withLedgerLock } from './store.mjs';
import { readEntry, writeEntry, mutateEntry, nextAvailableId, entryExists, frontmatterFromEntry } from './entry.mjs';
import { normalizeTags, now, tail } from './util.mjs';
import { slugFromId } from './store.mjs';
import { KINDS, MATCH_TYPES, STATUSES, SCHEMA_VERSION, HOST_RE } from './config.mjs';
import { urlParts, redactError, makeKey, normalizeIntent } from './identity.mjs';
import { reindexHost } from './index.mjs';
import { runEntry } from './exec.mjs';
import { serializeFrontmatter } from './frontmatter.mjs';

function renderAutoBody({ info, slug, attempts, misses, consecutiveMisses, error, hasScript = false, result = 'miss' }) {
  const observation = result === 'hit'
    ? `- ${now()} 自动捕获：第 ${attempts} 次尝试成功（累计 ${misses} miss）。方法可复现，值得沉淀。`
    : `- ${now()} 自动捕获：连续 ${consecutiveMisses} 次未达成目标（累计 ${misses} miss / ${attempts} 次尝试）。`;
  return [
    '## 目标',
    '',
    `在 ${info.host} 上完成「${slug}」操作。`,
    '',
    '## 触发条件',
    '',
    `- URL: ${info.url}`,
    '',
    '## 步骤',
    '',
    '1. 打开页面并等待目标区域加载。',
    '2. 使用下面记录的选择器/脚本复现操作。',
    '3. 把可复用的文本流程或脚本补全到本条目。',
    '',
    '## 坑与修正',
    '',
    observation,
    ...(error ? [`- 最近错误：${redactError(error, 500)}`] : []),
    '- TODO: 记录真实坑点与修正。',
    '',
    '## 验证',
    '',
    '- [ ] 按步骤执行后目标达成。',
    '- [ ] 选择器/脚本在最新页面结构下仍可用。',
    '',
    '## 脚本说明',
    '',
    ...(hasScript
      ? ['- script.py 已附加；运行：`tt-bridge experience run <id> --json`。']
      : ['（暂无脚本；可在 finalize 时用 --script-file 添加。）']),
    '',
  ].join('\n');
}



/**
 * Create a draft entry. Never overwrites: a colliding id gets a -2, -3, …
 * suffix. The experience root is the only write target.
 */

export function createDraft(root, opts = {}) {
  const {
    url,
    intent,
    kind = 'text',
    description = '',
    tags = [],
    body,
    scriptFile,
    source = 'manual',
    match = 'prefix',
    attempts = 0,
    misses = 0,
    consecutiveMisses = 0,
    error = null,
    result = 'miss',
  } = opts;

  if (!url) throw new Error('createDraft requires a url');
  if (!intent) throw new Error('createDraft requires an intent');
  if (!KINDS.includes(kind)) throw new Error(`Invalid kind "${kind}" (expected ${KINDS.join('|')})`);
  if (!MATCH_TYPES.includes(match)) throw new Error(`Invalid match "${match}" (expected ${MATCH_TYPES.join('|')})`);
  if (source !== 'manual' && source !== 'auto') throw new Error('source must be "manual" or "auto"');

  const info = urlParts(url);
  const slug = normalizeIntent(intent);
  if (!HOST_RE.test(info.host) || info.host.includes('..')) {
    throw new Error(`Unsupported host "${info.host}" for the experience store`);
  }
  const id = nextAvailableId(root, info.host, slug);
  const dir = path.join(path.resolve(root), info.host, slugFromId(id));
  const file = path.join(dir, 'entry.md');
  if (fs.existsSync(file)) throw new Error(`Entry already exists: ${id}`);
  fs.mkdirSync(path.resolve(root), { recursive: true });
  assertInsideRoot(root, dir);

  const timestamp = now();
  const data = {
    schema: SCHEMA_VERSION,
    id,
    host: info.host,
    url: info.url,
    match,
    kind,
    description: String(description || ''),
    created: timestamp,
    updated: timestamp,
    last_verified: '',
    status: 'draft',
    confidence: source === 'auto' ? 0.3 : 0.5,
    tags: normalizeTags(tags),
    preconditions: [],
    selectors: [],
    verification: [],
    attempts: Number(attempts) || 0,
    misses: Number(misses) || 0,
    source,
    script: null,
  };

  let scriptBody = null;
  if (scriptFile) {
    if (kind === 'text') throw new Error('kind "text" cannot include a script; use "script" or "hybrid"');
    scriptBody = fs.readFileSync(path.resolve(scriptFile), 'utf8');
    data.script = 'script.py';
  }

  const finalBody = body !== undefined
    ? String(body)
    : renderAutoBody({
      info,
      slug,
      attempts: data.attempts,
      misses: data.misses,
      consecutiveMisses,
      error,
      hasScript: scriptBody !== null,
      result,
    });

  fs.mkdirSync(dir, { recursive: true });
  if (scriptBody !== null) {
    atomicWrite(path.join(dir, 'script.py'), scriptBody);
    try { fs.chmodSync(path.join(dir, 'script.py'), 0o755); } catch { /* non-POSIX */ }
  }
  atomicWrite(file, serializeFrontmatter(data) + (finalBody.endsWith('\n') ? finalBody : `${finalBody}\n`));

  withLedgerLock(root, () => {
    const ledger = loadLedger(root);
    const key = makeKey(info.host, slug);
    const record = ledger.keys[key] || {
      host: info.host,
      intent: slug,
      attempts: 0,
      misses: 0,
      consecutiveMisses: 0,
      state: null,
      entryId: null,
      history: [],
    };
    if (!record.entryId || !entryExists(root, record.entryId)) record.entryId = id;
    record.state = 'captured';
    record.consecutiveMisses = 0;
    record.lastAt = timestamp;
    ledger.keys[key] = record;
    saveLedger(root, ledger);
  });

  reindexHost(root, info.host);
  const entry = readEntry(file);
  return {
    ...entry,
    ok: true,
    created: true,
    draftPath: file,
  };
}

export function finalizeEntry(root, id, opts = {}) {
  const { body, scriptFile, kind, verifyScript = false, url, allowScriptExec = false } = opts;
  const entry = readEntry(entryFile(root, id));
  const data = frontmatterFromEntry(entry);
  const timestamp = now();

  if (kind !== undefined) {
    if (!KINDS.includes(kind)) throw new Error(`Invalid kind "${kind}" (expected ${KINDS.join('|')})`);
    data.kind = kind;
  }
  if (scriptFile) {
    if (data.kind === 'text') {
      throw new Error(`Entry ${id} is kind "text"; pass --kind script or --kind hybrid to attach a script`);
    }
    const source = fs.readFileSync(path.resolve(scriptFile), 'utf8');
    atomicWrite(path.join(entry.dir, 'script.py'), source);
    try { fs.chmodSync(path.join(entry.dir, 'script.py'), 0o755); } catch { /* non-POSIX */ }
    data.script = 'script.py';
  }
  if (data.kind === 'script' || data.kind === 'hybrid') {
    if (!data.script) throw new Error(`Entry ${id} kind "${data.kind}" requires a script (pass --script-file)`);
  }
  if (data.kind === 'text' && data.script) {
    throw new Error(`Entry ${id} kind "text" must not declare a script (use "script" or "hybrid")`);
  }

  const finalBody = body !== undefined ? String(body) : entry.body;
  if (!finalBody.trim()) throw new Error(`Entry ${id} has an empty body`);

  if (verifyScript) {
    if (!data.script) throw new Error(`Entry ${id} has no script to verify`);
    if (!scriptFile && !allowScriptExec) {
      throw new Error('--verify-script executes the stored script; pass --script-file in this command or --allow-script-exec');
    }
  }

  data.updated = timestamp;
  data.status = verifyScript ? 'draft' : 'verified';
  if (!verifyScript) {
    data.last_verified = timestamp;
    data.confidence = Math.max(0.6, Number(data.confidence) || 0);
  }
  writeEntry(entry.dir, data, finalBody);

  if (verifyScript) {
    const run = runEntry(root, id, { record: false, force: true, url });
    if (run.exitCode !== 0) {
      throw new Error(`Script verification failed (exit ${run.exitCode}): ${tail(run.stderr || run.error || 'no stderr', 800)}`);
    }
    mutateEntry(root, id, (next) => {
      next.status = 'verified';
      next.last_verified = now();
      next.confidence = Math.max(0.6, Number(next.confidence) || 0);
      next.updated = now();
    });
  }

  reindexHost(root, entry.host);
  return readEntry(entry.file);
}

export function updateEntry(root, id, patch = {}) {
  const entry = readEntry(entryFile(root, id));
  const data = frontmatterFromEntry(entry);
  const timestamp = now();

  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw new Error(`Invalid status "${patch.status}" (expected ${STATUSES.join('|')})`);
    data.status = patch.status;
    if (patch.status === 'verified') data.last_verified = timestamp;
  }
  if (patch.description !== undefined) data.description = String(patch.description);
  if (patch.tags !== undefined) data.tags = normalizeTags(patch.tags);
  if (patch.kind !== undefined) {
    if (!KINDS.includes(patch.kind)) throw new Error(`Invalid kind "${patch.kind}"`);
    if (patch.kind === 'text' && data.script) {
      throw new Error(`Entry ${id} still declares script "${data.script}"; remove the script or use script/hybrid`);
    }
    if ((patch.kind === 'script' || patch.kind === 'hybrid') && !data.script) {
      throw new Error(`Entry ${id} has no script; use finalize --script-file before setting kind "${patch.kind}"`);
    }
    data.kind = patch.kind;
  }
  if (patch.match !== undefined) {
    if (!MATCH_TYPES.includes(patch.match)) throw new Error(`Invalid match "${patch.match}"`);
    data.match = patch.match;
  }
  if (patch.confidence !== undefined) {
    const confidence = Number(patch.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('confidence must be between 0 and 1');
    }
    data.confidence = confidence;
  }
  if (patch.url !== undefined) {
    const info = urlParts(patch.url);
    data.url = info.url;
    data.host = info.host;
  }
  data.updated = timestamp;

  const body = patch.body !== undefined ? String(patch.body) : entry.body;
  writeEntry(entry.dir, data, body);
  reindexHost(root, data.host);
  if (entry.host && entry.host !== data.host) {
    try { reindexHost(root, entry.host); } catch {}
  }
  return readEntry(entry.file);
}

export function deprecateEntry(root, id, opts = {}) {
  const { reason = '' } = opts;
  const entry = readEntry(entryFile(root, id));
  const data = frontmatterFromEntry(entry);
  data.status = 'deprecated';
  data.updated = now();

  let body = entry.body;
  if (reason) {
    const line = `- ${now()} deprecated: ${redactError(reason, 500)}`;
    if (/^## 坑与修正\s*$/m.test(body)) {
      body = body.replace(/^(## 坑与修正)\s*$/m, `$1\n\n${line}`);
    } else {
      body = `${body.replace(/\s*$/, '')}\n\n## 坑与修正\n\n${line}\n`;
    }
  }
  writeEntry(entry.dir, data, body);
  reindexHost(root, entry.host);
  return readEntry(entry.file);
}
