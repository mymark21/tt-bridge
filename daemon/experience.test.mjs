/**
 * Experience store tests: URL identity, frontmatter, learning transitions,
 * entry lifecycle, execution, validation and the daemon-free CLI surface.
 *
 * Run: node daemon/experience.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  advise,
  beginEpisode,
  classifyError,
  createDraft,
  defaultExperienceDir,
  deprecateEntry,
  endEpisode,
  entryFile,
  episodePath,
  finalizeEntry,
  findEntries,
  formatAdviceLine,
  hasSeen,
  hostIndexPath,
  ledgerList,
  ledgerShow,
  listEntries,
  loadEpisode,
  loadHostIndex,
  loadLedger,
  markSeen,
  normalizeIntent,
  normalizeUrl,
  parseFrontmatter,
  pruneLedger,
  readEntry,
  rebuildIndex,
  recordAttempt,
  reindexHost,
  resetAdviceSession,
  resetLedger,
  runEntry,
  serializeFrontmatter,
  updateEntry,
  validateAll,
  validateEntry,
  PROCESS_SESSION_ID,
} from './bin/experience.mjs';

const tmpDirs = [];
function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-bridge-experience-'));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const cliPath = fileURLToPath(new URL('./bin/cli.mjs', import.meta.url));
function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

try {
  // ── URL normalization ─────────────────────────────────────────────
  assert.equal(
    normalizeUrl('HTTPS://Example.COM:443/a/?utm_source=x&b=2&fbclid=y&gclid=z#frag'),
    'https://example.com/a?b=2',
    'normalizeUrl lowercases host, strips default port, fragment, tracking params and trailing slash',
  );
  assert.equal(normalizeUrl('http://example.com:80'), 'http://example.com/');
  assert.equal(normalizeUrl('https://example.com/a///'), 'https://example.com/a');
  assert.equal(normalizeUrl('https://example.com:8443/x'), 'https://example.com:8443/x');
  assert.equal(
    normalizeUrl('https://user:secret@example.com/x'),
    'https://example.com/x',
    'userinfo credentials are never stored',
  );
  assert.throws(() => normalizeUrl('not a url'), /Invalid URL/);
  assert.throws(() => normalizeUrl(''), /URL is required/);

  assert.equal(normalizeIntent('  Post a Comment! '), 'post-a-comment');
  assert.equal(normalizeIntent('!!!'), 'default');
  assert.equal(normalizeIntent('a'.repeat(80)).length, 64);

  assert.equal(defaultExperienceDir({ TT_BRIDGE_EXPERIENCE_DIR: '/tmp/x' }), '/tmp/x');
  assert.match(defaultExperienceDir({}), /\.agents\/skills\/tt-bridge\/experience$/);

  // ── frontmatter roundtrip ─────────────────────────────────────────
  const fm = {
    schema: 1,
    id: 'example.com/post-comment',
    host: 'example.com',
    url: 'https://example.com/a?b=2',
    match: 'prefix',
    kind: 'text',
    description: 'Post a comment: "quoted", with: colon',
    created: '2026-10-17T00:00:00.000Z',
    updated: '2026-10-17T00:00:00.000Z',
    last_verified: '',
    status: 'draft',
    confidence: 0.5,
    tags: ['a', 'b c', 'x,y'],
    preconditions: [],
    selectors: ['button.primary'],
    verification: [],
    attempts: 2,
    misses: 1,
    source: 'manual',
    script: 'script.py',
  };
  const serialized = serializeFrontmatter(fm);
  const parsedFm = parseFrontmatter(`${serialized}## 目标\n\nbody\n`);
  assert.deepEqual(parsedFm.data, fm, 'frontmatter roundtrips flat scalars and arrays');
  assert.equal(parsedFm.body, '## 目标\n\nbody\n');
  assert.equal(parsedFm.hasFrontmatter, true);

  const blockArray = parseFrontmatter('---\ntags:\n  - one\n  - two\n---\nbody');
  assert.deepEqual(blockArray.data.tags, ['one', 'two'], 'block string arrays parse');

  const noFm = parseFrontmatter('# just markdown');
  assert.equal(noFm.hasFrontmatter, false);
  assert.equal(noFm.body, '# just markdown');

  assert.throws(
    () => parseFrontmatter('---\nfoo:\n  bar: baz\n---\n'),
    /Unsupported nested mapping/,
    'nested maps are rejected',
  );
  assert.throws(
    () => parseFrontmatter('---\ndescription: |\n  multi\n---\n'),
    /Block scalars are not supported/,
    'block scalars are rejected',
  );
  assert.throws(() => serializeFrontmatter({ nested: { a: 1 } }), /Unsupported nested object/);
  assert.throws(() => serializeFrontmatter({ description: 'a\nb' }), /single-line/);
  assert.throws(() => serializeFrontmatter({ tags: [{ a: 1 }] }), /only supports scalar items/);

  // ── find ranking ──────────────────────────────────────────────────
  {
    const root = tmpRoot();
    const base = 'https://example.com/a';
    createDraft(root, { url: base, intent: 'prefix-one', kind: 'text', description: 'prefix', match: 'prefix' });
    createDraft(root, { url: base, intent: 'exact-one', kind: 'text', description: 'exact', match: 'exact' });
    createDraft(root, { url: 'https://example.com/a*', intent: 'glob-one', kind: 'text', description: 'glob', match: 'glob' });

    const ranked = findEntries(root, base);
    assert.deepEqual(
      ranked.map((entry) => entry.id),
      ['example.com/exact-one', 'example.com/glob-one', 'example.com/prefix-one'],
      'exact > glob > prefix',
    );
    assert.equal(ranked[0].matchType, 'exact');
    assert.ok(ranked[0].score > ranked[1].score && ranked[1].score > ranked[2].score);

    assert.equal(findEntries(root, 'https://example.com/ab').length, 1, 'glob * matches within a path segment');
    assert.equal(findEntries(root, 'https://example.com/ab')[0].id, 'example.com/glob-one');
    assert.equal(findEntries(root, 'https://example.com/a/b').length, 1, 'prefix matches deeper URLs; exact and glob * do not');
    assert.equal(findEntries(root, 'https://example.com/a/b')[0].id, 'example.com/prefix-one');
    assert.equal(findEntries(root, 'https://example.com/a', { intent: 'exact-one' }).length, 1);

    updateEntry(root, 'example.com/exact-one', { status: 'deprecated' });
    assert.equal(
      findEntries(root, base).some((entry) => entry.id === 'example.com/exact-one'),
      false,
      'deprecated entries are hidden by default',
    );
    assert.equal(
      findEntries(root, base, { all: true }).length,
      3,
      '--all includes deprecated and non-matching entries',
    );
  }

  // ── learning transitions: 1/2/3 misses ────────────────────────────
  {
    const root = tmpRoot();
    const url = 'https://example.com/flow';
    const intent = 'complete-flow';

    const first = recordAttempt(root, { url, intent, result: 'miss', error: 'selector missing' });
    assert.equal(first.attempts, 1);
    assert.equal(first.misses, 1);
    assert.equal(first.captureRequired, false);
    assert.equal(first.state, null);
    assert.equal(first.recommendedKind, 'script');

    const second = recordAttempt(root, { url, intent, result: 'miss', error: 'still missing' });
    assert.equal(second.attempts, 2);
    assert.equal(second.misses, 2);
    assert.equal(second.state, 'candidate');
    assert.equal(second.captureRequired, false);
    assert.equal(second.updateRequired, false);
    assert.equal(second.recommendedKind, 'text');
    assert.equal(second.draftPath, null, 'no draft before the capture threshold');
    assert.equal(fs.existsSync(path.join(root, 'example.com', 'complete-flow', 'entry.md')), false);

    const third = recordAttempt(root, { url, intent, result: 'miss', error: 'gave up' });
    assert.equal(third.attempts, 3);
    assert.equal(third.captureRequired, true);
    assert.equal(third.state, 'captured');
    assert.equal(third.suggestedId, 'example.com/complete-flow');
    assert.ok(third.draftPath && fs.existsSync(third.draftPath), 'third miss auto-creates a draft');
    const draft = readEntry(third.draftPath);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.source, 'auto');
    assert.equal(draft.kind, 'text');
    assert.equal(draft.attempts, 3);
    assert.equal(draft.misses, 3);
    assert.match(draft.body, /自动捕获/);
    assert.match(draft.body, /gave up/);
    assert.ok(validateEntry(root, draft.id).ok, 'auto draft is valid (missing script is not required for text)');
  }

  // ── capture resets the miss streak (review regression) ────────────
  {
    const root = tmpRoot();
    const url = 'https://example.com/reset-flow';
    const intent = 'reset-flow';
    recordAttempt(root, { url, intent, result: 'miss' });
    recordAttempt(root, { url, intent, result: 'miss' });
    const third = recordAttempt(root, { url, intent, result: 'miss' });
    assert.equal(third.captureRequired, true);
    finalizeEntry(root, third.suggestedId);

    const next = recordAttempt(root, { url, intent, result: 'miss', error: 'one new failure' });
    assert.equal(next.consecutiveMisses, 1, 'capture resets the consecutive-miss counter');
    assert.equal(next.updateRequired, false, 'a single post-capture miss must not stale the entry');
    assert.equal(next.status, 'verified');
  }

  // ── scalar tags must not crash discovery (review regression) ──────
  {
    const root = tmpRoot();
    const created = createDraft(root, {
      url: 'https://example.com/scalar',
      intent: 'scalar-tags',
      kind: 'text',
      description: 'scalar tags',
    });
    const file = entryFile(root, created.id);
    const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    parsed.data.tags = 'social';
    writeFile(file, `${serializeFrontmatter(parsed.data)}${parsed.body}`);
    const entry = readEntry(file);
    assert.deepEqual(entry.tags, ['social'], 'scalar tags normalize to an array');
    assert.doesNotThrow(() => findEntries(root, 'https://example.com/scalar', { intent: 'scalar-tags' }));
  }

  // ── credentials are redacted before persistence ───────────────────
  {
    const root = tmpRoot();
    assert.equal(
      normalizeUrl('https://example.com/x?access-token=A&X-Amz-Signature=B&session_id=C&ok=1'),
      'https://example.com/x?ok=1',
      'broad sensitive-param patterns are stripped',
    );
    const result = recordAttempt(root, {
      url: 'https://example.com/reset?token=SECRET&code=ABC&ok=1',
      intent: 'redact-flow',
      result: 'miss',
      error: 'Authorization: Bearer LEAKED\nCookie: a=1; session_id=SECRET2',
    });
    assert.equal(result.misses, 1);
    const ledger = loadLedger(root);
    const record = ledger.keys['example.com|redact-flow'];
    assert.doesNotMatch(record.lastUrl, /SECRET|ABC/);
    assert.match(record.lastUrl, /ok=1/);
    assert.doesNotMatch(record.lastError, /LEAKED|SECRET2/);
    assert.match(record.lastError, /REDACTED/);
    assert.doesNotMatch(JSON.stringify(ledger), /SECRET|LEAKED/);
  }

  // ── deprecation reasons are redacted too ─────────────────────────
  {
    const root = tmpRoot();
    const created = createDraft(root, {
      url: 'https://example.com/deprecate',
      intent: 'deprecate-flow',
      kind: 'text',
      description: 'deprecate',
    });
    finalizeEntry(root, created.id);
    const deprecated = deprecateEntry(root, created.id, {
      reason: 'Authorization: Bearer LEAKED while fetching ?access-token=SECRET',
    });
    assert.equal(deprecated.status, 'deprecated');
    assert.doesNotMatch(deprecated.body, /LEAKED|SECRET/);
    assert.match(deprecated.body, /REDACTED/);
  }

  // ── run is gated to verified entries unless forced ────────────────
  {
    const root = tmpRoot();
    const scriptDir = tmpRoot();
    const script = path.join(scriptDir, 'ok.py');
    writeFile(script, '#!/usr/bin/env python3\nprint("{\\"ok\\": true}")\n');
    const created = createDraft(root, {
      url: 'https://example.com/gated',
      intent: 'gated-flow',
      kind: 'script',
      description: 'gated',
      scriptFile: script,
    });
    const blocked = runEntry(root, created.id, {});
    assert.equal(blocked.exitCode, 2);
    assert.match(blocked.error, /only verified entries/);
    const forced = runEntry(root, created.id, { force: true });
    assert.equal(forced.exitCode, 0);
    assert.equal(forced.ok, true);
  }

  // ── verify-script requires explicit execution consent ─────────────
  {
    const root = tmpRoot();
    const scriptDir = tmpRoot();
    const script = path.join(scriptDir, 'ok.py');
    writeFile(script, '#!/usr/bin/env python3\nprint("{\\"ok\\": true}")\n');
    const created = createDraft(root, {
      url: 'https://example.com/verify',
      intent: 'verify-gate',
      kind: 'script',
      description: 'verify gate',
      scriptFile: script,
    });
    finalizeEntry(root, created.id);
    assert.equal(readEntry(entryFile(root, created.id)).status, 'verified');
    assert.throws(
      () => finalizeEntry(root, created.id, { verifyScript: true }),
      /allow-script-exec/,
      'stored scripts are not executed by finalize without explicit consent',
    );
    assert.equal(
      readEntry(entryFile(root, created.id)).status,
      'verified',
      'a rejected verify must not downgrade a verified entry',
    );
    const finalized = finalizeEntry(root, created.id, { verifyScript: true, allowScriptExec: true });
    assert.equal(finalized.status, 'verified');
  }

  // ── symlinked entry dirs cannot escape the root ───────────────────
  {
    const root = tmpRoot();
    const outside = tmpRoot();
    writeFile(path.join(outside, 'entry.md'), '---\nid: evil.com/x\n---\nbody\n');
    fs.symlinkSync(outside, path.join(root, 'evil.com'));
    assert.throws(() => entryFile(root, 'evil.com/x'), /symlink escape/);
    assert.throws(
      () => createDraft(root, { url: 'https://evil.com/x', intent: 'x', kind: 'text' }),
      /symlink escape/,
      'draft creation must not write through a symlinked host dir',
    );
    const ledgerRoot = tmpRoot();
    const ledgerOutside = tmpRoot();
    fs.symlinkSync(ledgerOutside, path.join(ledgerRoot, '_ledger'));
    assert.throws(
      () => recordAttempt(ledgerRoot, { url: 'https://example.com/l', intent: 'l', result: 'miss' }),
      /symlink escape/,
      'ledger writes must not follow a symlinked _ledger dir',
    );
  }

  // ── hit3 recommends a script ──────────────────────────────────────
  {
    const root = tmpRoot();
    const url = 'https://example.com/scripted';
    recordAttempt(root, { url, intent: 'scripted-flow', result: 'hit' });
    recordAttempt(root, { url, intent: 'scripted-flow', result: 'hit' });
    const third = recordAttempt(root, { url, intent: 'scripted-flow', result: 'hit' });
    assert.equal(third.captureRequired, true);
    assert.equal(third.recommendedKind, 'script');
    assert.ok(third.draftPath && fs.existsSync(third.draftPath));
    const draft = readEntry(third.draftPath);
    assert.equal(draft.kind, 'script');
    const validation = validateEntry(root, draft.id);
    assert.equal(validation.ok, true, 'script draft without a script is valid but warned');
    assert.ok(validation.warnings.some((warning) => /requires a script/.test(warning)));
  }

  // ── --no-auto-capture ─────────────────────────────────────────────
  {
    const root = tmpRoot();
    const url = 'https://example.com/no-capture';
    recordAttempt(root, { url, intent: 'manual-only', result: 'miss' });
    recordAttempt(root, { url, intent: 'manual-only', result: 'miss' });
    const third = recordAttempt(root, {
      url,
      intent: 'manual-only',
      result: 'miss',
      autoCapture: false,
    });
    assert.equal(third.captureRequired, true);
    assert.equal(third.draftPath, null);
    assert.equal(third.state, 'candidate');
    assert.equal(fs.existsSync(path.join(root, 'example.com', 'manual-only')), false);
  }

  // ── capture, finalize, find ───────────────────────────────────────
  {
    const root = tmpRoot();
    const created = createDraft(root, {
      url: 'https://example.com/posts/1?utm_source=x',
      intent: 'post-comment',
      kind: 'text',
      description: 'Leave a comment',
      tags: 'social, comment',
    });
    assert.equal(created.id, 'example.com/post-comment');
    assert.equal(created.created, true);
    assert.equal(created.url, 'https://example.com/posts/1');
    assert.deepEqual(created.tags, ['social', 'comment']);
    assert.equal(created.status, 'draft');

    const finalized = finalizeEntry(root, created.id, {
      body: '## 目标\n\nComment.\n\n## 步骤\n\n1. Open.\n\n## 验证\n\n- [x] Posted.\n',
    });
    assert.equal(finalized.status, 'verified');
    assert.ok(finalized.last_verified);
    assert.ok(finalized.confidence >= 0.6);

    const found = findEntries(root, 'https://example.com/posts/1', { intent: 'post-comment' });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, created.id);

    const listed = listEntries(root, { host: 'example.com', kind: 'text', status: 'verified' });
    assert.equal(listed.length, 1);
    assert.equal(listEntries(root, { status: 'draft' }).length, 0);

    // id collision: never overwrite; suffix -2
    const second = createDraft(root, {
      url: 'https://example.com/posts/1',
      intent: 'post-comment',
      kind: 'text',
      description: 'duplicate',
    });
    assert.equal(second.id, 'example.com/post-comment-2');
    assert.notEqual(second.file, created.file);
    assert.equal(readEntry(created.file).description, 'Leave a comment', 'original untouched');
    assert.ok(
      findEntries(root, 'https://example.com/posts/1', { intent: 'post-comment' })
        .some((entry) => entry.id === second.id),
      'collision-suffixed entries remain discoverable by intent',
    );
  }

  // ── stale after 2 misses, hit resets ──────────────────────────────
  {
    const root = tmpRoot();
    const created = createDraft(root, {
      url: 'https://example.com/x',
      intent: 'verify-flow',
      kind: 'text',
      description: 'flow',
    });
    finalizeEntry(root, created.id);

    const firstMiss = recordAttempt(root, { url: 'https://example.com/x', intent: 'verify-flow', result: 'miss', error: 'gone' });
    assert.equal(firstMiss.updateRequired, false);
    assert.equal(firstMiss.status, 'verified');

    const secondMiss = recordAttempt(root, { url: 'https://example.com/x', intent: 'verify-flow', result: 'miss' });
    assert.equal(secondMiss.updateRequired, true);
    assert.equal(secondMiss.status, 'stale');
    assert.equal(readEntry(created.file).status, 'stale');

    const hit = recordAttempt(root, { url: 'https://example.com/x', intent: 'verify-flow', result: 'hit' });
    assert.equal(hit.consecutiveMisses, 0);
    assert.equal(hit.updateRequired, false);
    assert.equal(hit.status, 'verified');
    const entry = readEntry(created.file);
    assert.equal(entry.status, 'verified');
    assert.equal(entry.confidence, 0.7, 'hit bumps confidence by 0.1');
    assert.equal(entry.attempts, 3);
    assert.equal(entry.misses, 2);
    assert.ok(entry.last_verified);
  }

  // ── path traversal rejection ──────────────────────────────────────
  {
    const root = tmpRoot();
    assert.throws(() => entryFile(root, '../../etc/passwd'), /Invalid experience id/);
    assert.throws(() => entryFile(root, 'example.com/..'), /Invalid experience id/);
    assert.throws(() => entryFile(root, '/abs/path'), /Invalid experience id/);
    assert.throws(() => entryFile(root, 'example.com/ok/extra'), /Invalid experience id/);
    assert.throws(
      () => createDraft(root, { url: 'https://../x', intent: 'evil', kind: 'text' }),
      /Unsupported host/,
      'hosts that could escape the root are rejected',
    );

    const unsafe = path.join(root, 'example.com', 'unsafe', 'entry.md');
    writeFile(unsafe, serializeFrontmatter({
      schema: 1,
      id: 'example.com/unsafe',
      host: 'example.com',
      url: 'https://example.com/unsafe',
      match: 'prefix',
      kind: 'script',
      description: 'unsafe',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      last_verified: '',
      status: 'verified',
      confidence: 0.5,
      tags: [],
      preconditions: [],
      selectors: [],
      verification: [],
      attempts: 0,
      misses: 0,
      source: 'manual',
      script: '../evil.py',
    }) + '## 目标\n\n## 步骤\n\n## 验证\n');
    const validation = validateEntry(root, 'example.com/unsafe');
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((error) => /simple relative filename/.test(error)));
    const unsafeRun = runEntry(root, 'example.com/unsafe', {});
    assert.equal(unsafeRun.exitCode, 2);
    assert.match(unsafeRun.error, /Unsafe script path/);
  }

  // ── script run: hit and miss ──────────────────────────────────────
  {
    const root = tmpRoot();
    const scriptDir = tmpRoot();
    const okScript = path.join(scriptDir, 'ok.py');
    writeFile(okScript, [
      'import argparse, json, os',
      'p = argparse.ArgumentParser()',
      "p.add_argument('--url', required=True)",
      "p.add_argument('--extra', default='')",
      'a, _ = p.parse_known_args()',
      'print(json.dumps({"ok": True, "steps": ["ran"], "evidence": {"url": a.url, "id": os.environ["TT_BRIDGE_ENTRY_ID"], "root": os.environ["TT_BRIDGE_EXPERIENCE_DIR"], "extra": a.extra}}))',
      '',
    ].join('\n'));

    const created = createDraft(root, {
      url: 'https://example.com/run',
      intent: 'run-flow',
      kind: 'script',
      description: 'run',
      scriptFile: okScript,
    });
    finalizeEntry(root, created.id);

    const hit = runEntry(root, created.id, { args: ['--extra', 'value'] });
    assert.equal(hit.exitCode, 0);
    assert.equal(hit.ok, true);
    assert.equal(hit.data.ok, true);
    assert.equal(hit.data.evidence.url, 'https://example.com/run');
    assert.equal(hit.data.evidence.id, created.id);
    assert.equal(hit.data.evidence.root, path.resolve(root));
    assert.equal(hit.data.evidence.extra, 'value');
    assert.equal(hit.recorded.result, 'hit');
    assert.equal(loadLedger(root).keys['example.com|run-flow'].lastResult, 'hit');

    const override = runEntry(root, created.id, { url: 'https://other.example/x' });
    assert.equal(override.exitCode, 0);
    assert.equal(override.data.evidence.url, 'https://other.example/x');
    assert.equal(override.recorded.host, 'example.com', 'ledger stays scoped to the entry host');

    const failScript = path.join(scriptDir, 'fail.py');
    writeFile(failScript, 'import sys\nprint("boom", file=sys.stderr)\nsys.exit(7)\n');
    const failing = createDraft(root, {
      url: 'https://example.com/fail',
      intent: 'fail-flow',
      kind: 'script',
      description: 'fail',
      scriptFile: failScript,
    });
    finalizeEntry(root, failing.id);
    const miss = runEntry(root, failing.id, {});
    assert.equal(miss.exitCode, 7);
    assert.equal(miss.ok, false);
    assert.match(miss.stderr, /boom/);
    assert.equal(miss.recorded.result, 'miss');
    assert.match(miss.recorded.misses >= 1 ? 'miss' : '', /miss/);
    assert.match(loadLedger(root).keys['example.com|fail-flow'].lastError, /boom/);

    const textEntry = createDraft(root, { url: 'https://example.com/text', intent: 'text-flow', kind: 'text' });
    const noScript = runEntry(root, textEntry.id, { force: true });
    assert.equal(noScript.exitCode, 2);
    assert.match(noScript.error, /no script/);
  }

  // ── validate / reindex / deprecate ────────────────────────────────
  {
    const root = tmpRoot();
    const created = createDraft(root, {
      url: 'https://example.com/valid',
      intent: 'valid-flow',
      kind: 'text',
      description: 'valid',
    });
    finalizeEntry(root, created.id);

    const invalidFile = path.join(root, 'example.com', 'invalid', 'entry.md');
    writeFile(invalidFile, serializeFrontmatter({
      schema: 1,
      id: 'example.com/invalid',
      host: 'wrong.example.com',
      url: 'not-a-url',
      match: 'nope',
      kind: 'bogus',
      description: '',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      last_verified: '',
      status: 'bogus',
      confidence: 2,
      tags: [],
      preconditions: [],
      selectors: [],
      verification: [],
      attempts: -1,
      misses: 0,
      source: 'other',
    }) + 'no sections\n');

    const validation = validateAll(root);
    assert.equal(validation.ok, false);
    assert.equal(validation.checked, 2);
    const invalid = validation.errors.find((item) => item.id === 'example.com/invalid');
    assert.ok(invalid);
    for (const fragment of ['invalid url', 'invalid match', 'invalid kind', 'invalid status', 'confidence', 'attempts', 'source']) {
      assert.ok(
        invalid.errors.some((message) => message.includes(fragment)),
        `validation reports ${fragment}: ${JSON.stringify(invalid.errors)}`,
      );
    }

    const mismatchFile = path.join(root, 'example.com', 'mismatch', 'entry.md');
    writeFile(mismatchFile, serializeFrontmatter({
      schema: 1,
      id: 'example.com/mismatch',
      host: 'wrong.example.com',
      url: 'https://example.com/mismatch',
      match: 'prefix',
      kind: 'text',
      description: '',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      last_verified: '',
      status: 'draft',
      confidence: 0.5,
      tags: [],
      preconditions: [],
      selectors: [],
      verification: [],
      attempts: 0,
      misses: 0,
      source: 'manual',
    }) + '## 目标\n\n## 步骤\n\n## 验证\n');
    const mismatch = validateEntry(root, 'example.com/mismatch');
    assert.equal(mismatch.ok, false);
    assert.ok(mismatch.errors.some((message) => /does not match url host/.test(message)));

    const missingRoot = tmpRoot();
    writeFile(path.join(missingRoot, 'example.com', 'missing', 'entry.md'), serializeFrontmatter({
      schema: 1,
      id: 'example.com/missing',
      host: 'example.com',
    }) + '## 目标\n\n## 步骤\n\n## 验证\n');
    const missing = validateEntry(missingRoot, 'example.com/missing');
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some((message) => /missing required field "url"/.test(message)));
    assert.ok(missing.errors.some((message) => /missing required field "kind"/.test(message)));

    const index = rebuildIndex(root);
    assert.equal(index.count, 3);
    assert.ok(fs.existsSync(path.join(root, 'index.json')));
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
    assert.equal(onDisk.count, 3);
    assert.ok(onDisk.entries.some((entry) => entry.id === created.id && entry.status === 'verified'));

    const deprecated = deprecateEntry(root, created.id, { reason: 'site changed' });
    assert.equal(deprecated.status, 'deprecated');
    assert.match(deprecated.body, /deprecated: site changed/);
    assert.equal(findEntries(root, 'https://example.com/valid').length, 0);
    assert.equal(findEntries(root, 'https://example.com/valid', { all: true }).length, 1);
  }

  // ── ledger prune / reset ──────────────────────────────────────────
  {
    const root = tmpRoot();
    recordAttempt(root, { url: 'https://example.com/l', intent: 'old-flow', result: 'miss' });
    const ledger = loadLedger(root);
    ledger.keys['example.com|old-flow'].lastAt = '2000-01-01T00:00:00.000Z';
    fs.mkdirSync(path.join(root, '_ledger'), { recursive: true });
    fs.writeFileSync(path.join(root, '_ledger', 'attempts.json'), `${JSON.stringify(ledger, null, 2)}\n`);

    const pruned = pruneLedger(root, { olderThan: '90d' });
    assert.equal(pruned.removed, 1);
    assert.equal(pruned.remaining, 0);
    assert.deepEqual(ledgerList(root), []);

    recordAttempt(root, { url: 'https://example.com/l', intent: 'new-flow', result: 'hit' });
    assert.equal(ledgerList(root).length, 1);
    const reset = resetLedger(root);
    assert.equal(reset.remaining, 0);
    assert.deepEqual(loadLedger(root).keys, {});
  }

  // ── CLI: daemon-free commands ─────────────────────────────────────
  {
    const root = tmpRoot();
    const env = { TT_BRIDGE_EXPERIENCE_DIR: root };

    const empty = runCli(['experience', 'find', 'https://example.com/a', '--json'], env);
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(JSON.parse(empty.stdout), [], 'find on an empty store returns []');

    let third;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = runCli([
        'experience', 'miss',
        '--url', 'https://example.com/a',
        '--intent', 'do-thing',
        '--error', `failure ${attempt}`,
        '--json',
      ], env);
      assert.equal(result.status, 0, result.stderr);
      third = JSON.parse(result.stdout);
    }
    assert.equal(third.captureRequired, true);
    assert.equal(third.recommendedKind, 'text');
    assert.ok(third.draftPath && fs.existsSync(third.draftPath));

    const finalize = runCli(['experience', 'finalize', third.entryId, '--json'], env);
    assert.equal(finalize.status, 0, finalize.stderr);
    assert.equal(JSON.parse(finalize.stdout).status, 'verified');

    const found = runCli([
      'experience', 'find', 'https://example.com/a',
      '--intent', 'do-thing',
      '--json',
    ], env);
    assert.equal(found.status, 0, found.stderr);
    const matches = JSON.parse(found.stdout);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, third.entryId);

    const validate = runCli(['experience', 'validate', '--json'], env);
    assert.equal(validate.status, 0, validate.stdout);
    assert.equal(JSON.parse(validate.stdout).ok, true);

    const reindex = runCli(['experience', 'reindex', '--json'], env);
    assert.equal(reindex.status, 0, reindex.stderr);
    const reindexed = JSON.parse(reindex.stdout);
    assert.equal(reindexed.ok, true);
    assert.equal(reindexed.count, 1);
    assert.ok(fs.existsSync(reindexed.indexPath));

    const list = runCli(['experience', 'list', '--status', 'verified', '--json'], env);
    assert.equal(list.status, 0, list.stderr);
    assert.equal(JSON.parse(list.stdout).length, 1);

    const show = runCli(['experience', 'show', third.entryId, '--json'], env);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).id, third.entryId);

    // --no-auto-capture: captureRequired but no draft on disk
    const manualRoot = tmpRoot();
    const manualEnv = { TT_BRIDGE_EXPERIENCE_DIR: manualRoot };
    let manualThird;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = runCli([
        'experience', 'miss',
        '--url', 'https://example.com/b',
        '--intent', 'manual-thing',
        '--no-auto-capture',
        '--json',
      ], manualEnv);
      assert.equal(result.status, 0, result.stderr);
      manualThird = JSON.parse(result.stdout);
    }
    assert.equal(manualThird.captureRequired, true);
    assert.equal(manualThird.draftPath, null);
    assert.equal(fs.existsSync(path.join(manualRoot, 'example.com', 'manual-thing')), false);

    // run: script args after --, stdout JSON, exit code propagation
    const scriptRoot = tmpRoot();
    const scriptEnv = { TT_BRIDGE_EXPERIENCE_DIR: scriptRoot };
    const scriptFile = path.join(tmpRoot(), 'cli.py');
    writeFile(scriptFile, [
      'import argparse, json, sys',
      'p = argparse.ArgumentParser()',
      "p.add_argument('--url', required=True)",
      "p.add_argument('--flag', default='')",
      'a, _ = p.parse_known_args()',
      'print(json.dumps({"ok": True, "flag": a.flag}))',
      'sys.exit(0 if a.flag == "yes" else 3)',
      '',
    ].join('\n'));

    const captured = runCli([
      'experience', 'capture',
      '--url', 'https://example.com/run',
      '--intent', 'cli-run',
      '--kind', 'script',
      '--description', 'cli run',
      '--script-file', scriptFile,
      '--json',
    ], scriptEnv);
    assert.equal(captured.status, 0, captured.stderr);
    const capturedEntry = JSON.parse(captured.stdout);
    assert.equal(capturedEntry.created, true);

    const finalized = runCli(['experience', 'finalize', capturedEntry.id, '--json'], scriptEnv);
    assert.equal(finalized.status, 0, finalized.stderr);
    assert.equal(JSON.parse(finalized.stdout).status, 'verified');

    const ran = runCli([
      'experience', 'run', capturedEntry.id,
      '--json', '--', '--flag', 'yes',
    ], scriptEnv);
    assert.equal(ran.status, 0, ran.stderr);
    const runPayload = JSON.parse(ran.stdout);
    assert.equal(runPayload.exitCode, 0);
    assert.equal(runPayload.data.flag, 'yes');
    assert.equal(runPayload.recorded.result, 'hit');

    const ranFail = runCli([
      'experience', 'run', capturedEntry.id,
      '--json', '--', '--flag', 'no',
    ], scriptEnv);
    assert.equal(ranFail.status, 3, 'CLI propagates the script exit code');
    assert.equal(JSON.parse(ranFail.stdout).exitCode, 3);

    // validate exits 1 when an entry is invalid
    const brokenRoot = tmpRoot();
    writeFile(path.join(brokenRoot, 'example.com', 'broken', 'entry.md'), serializeFrontmatter({
      schema: 1,
      id: 'example.com/broken',
      host: 'example.com',
      url: 'https://example.com/broken',
      match: 'prefix',
      kind: 'script',
      description: 'broken',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      last_verified: '',
      status: 'verified',
      confidence: 0.5,
      tags: [],
      preconditions: [],
      selectors: [],
      verification: [],
      attempts: 0,
      misses: 0,
      source: 'manual',
    }) + '## 目标\n');
    const brokenValidate = runCli(['experience', 'validate', '--json'], { TT_BRIDGE_EXPERIENCE_DIR: brokenRoot });
    assert.equal(brokenValidate.status, 1);
    assert.equal(JSON.parse(brokenValidate.stdout).ok, false);

    // ledger commands
    const ledgerListResult = runCli(['experience', 'ledger', 'list', '--json'], env);
    assert.equal(ledgerListResult.status, 0, ledgerListResult.stderr);
    assert.ok(JSON.parse(ledgerListResult.stdout).length >= 1);
    const ledgerShow = runCli(['experience', 'ledger', 'show', 'example.com|do-thing', '--json'], env);
    assert.equal(ledgerShow.status, 0, ledgerShow.stderr);
    assert.equal(JSON.parse(ledgerShow.stdout).key, 'example.com|do-thing');
    const pruned = runCli(['experience', 'ledger', 'prune', '--older-than', '90d', '--json'], env);
    assert.equal(pruned.status, 0, pruned.stderr);
    assert.equal(JSON.parse(pruned.stdout).ok, true);
    const reset = runCli(['experience', 'ledger', 'reset', '--json'], env);
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(JSON.parse(reset.stdout).ok, true);
  }

  // ── CLI help and unknown command ──────────────────────────────────
  {
    const help = runCli(['experience', '--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /experience find/);
    assert.match(help.stdout, /experience begin/);
    assert.match(help.stdout, /experience end/);
    const unknown = runCli(['experience', 'nope']);
    // Usage errors are exit 2 everywhere in the experience command family.
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Unknown experience command/);
  }

  // ── episode transactions (begin / end) ─────────────────────────────
  {
    const root = tmpRoot();
    const env = { TT_BRIDGE_EXPERIENCE_DIR: root };

    const assertOkPath = path.join(root, 'assert-ok.js');
    const assertFailPath = path.join(root, 'assert-fail.js');
    const assertSyntaxPath = path.join(root, 'assert-syntax.js');
    const assertEnvPath = path.join(root, 'assert-env.js');

    writeFile(assertOkPath, 'return true;');
    writeFile(assertFailPath, 'return false;');
    writeFile(assertSyntaxPath, 'return {{{;');
    writeFile(assertEnvPath, "const fs = require('node:fs'); return Boolean(process.env.TT_BRIDGE_EXPERIENCE_DIR && fs.existsSync(process.env.TT_BRIDGE_EXPERIENCE_DIR));");

    // Usage errors: begin requires url and intent
    const noUrl = runCli(['experience', 'begin', '--intent', 'test'], env);
    assert.equal(noUrl.status, 2, 'begin without url exits with code 2');
    const noIntent = runCli(['experience', 'begin', '--url', 'https://example.com'], env);
    assert.equal(noIntent.status, 2, 'begin without intent exits with code 2');

    // begin creates state file and is idempotent
    const beginRes = runCli([
      'experience', 'begin',
      '--url', 'https://example.com/checkout',
      '--intent', 'buy-item',
      '--session', 'ep-test-1',
      '--json',
    ], env);
    assert.equal(beginRes.status, 0, beginRes.stderr);
    const beginData = JSON.parse(beginRes.stdout);
    assert.equal(beginData.session, 'ep-test-1');
    assert.equal(beginData.url, 'https://example.com/checkout');
    assert.equal(beginData.intent, 'buy-item');
    assert.ok(fs.existsSync(beginData.stateFile), 'state file exists after begin');

    const stateOnDisk = JSON.parse(fs.readFileSync(beginData.stateFile, 'utf8'));
    assert.equal(stateOnDisk.schema, 1);
    assert.equal(stateOnDisk.session, 'ep-test-1');
    assert.equal(stateOnDisk.url, 'https://example.com/checkout');
    assert.equal(stateOnDisk.intent, 'buy-item');
    assert.deepEqual(stateOnDisk.steps, []);
    assert.ok(stateOnDisk.startedAt);

    // idempotent overwrite with same session
    const beginIdempotent = runCli([
      'experience', 'begin',
      '--url', 'https://example.com/checkout',
      '--intent', 'buy-item',
      '--session', 'ep-test-1',
      '--json',
    ], env);
    assert.equal(beginIdempotent.status, 0, 'begin with same session succeeds idempotently');

    // begin with auto-generated session
    const autoBegin = runCli([
      'experience', 'begin',
      '--url', 'https://example.com/search',
      '--intent', 'search-item',
      '--json',
    ], env);
    assert.equal(autoBegin.status, 0, autoBegin.stderr);
    const autoData = JSON.parse(autoBegin.stdout);
    assert.ok(autoData.session && autoData.session.length >= 10, 'generates uuid session');
    assert.ok(fs.existsSync(autoData.stateFile), 'auto session state file exists');

    // end with unknown session exits with code 2
    const unknownEnd = runCli([
      'experience', 'end',
      '--session', 'nonexistent-session-id',
      '--assert', assertOkPath,
    ], env);
    assert.equal(unknownEnd.status, 2, 'end with unknown session exits code 2');
    assert.match(unknownEnd.stderr, /not found/i);

    // end usage errors: missing session or missing assert & error
    const noSessionEnd = runCli(['experience', 'end', '--assert', assertOkPath], env);
    assert.equal(noSessionEnd.status, 2, 'end without session exits code 2');
    const noAssertEnd = runCli(['experience', 'end', '--session', 'ep-test-1'], env);
    assert.equal(noAssertEnd.status, 2, 'end without assert or error exits code 2');

    // end assert true => hit, exit code 0, cleans up state file
    const endHit = runCli([
      'experience', 'end',
      '--session', 'ep-test-1',
      '--assert', assertOkPath,
      '--json',
    ], env);
    assert.equal(endHit.status, 0, endHit.stderr);
    const hitData = JSON.parse(endHit.stdout);
    assert.equal(hitData.session, 'ep-test-1');
    assert.equal(hitData.result, 'hit');
    assert.equal(hitData.ledgerKey, 'example.com|buy-item');
    assert.equal(hitData.captureRequired, false);
    assert.equal(hitData.record.attempts, 1);
    assert.equal(hitData.record.misses, 0);
    assert.equal(hitData.record.lastResult, 'hit');
    assert.equal(hitData.record.lastError, null);
    assert.equal(fs.existsSync(beginData.stateFile), false, 'session state file is removed after end');

    // end assert false => miss, exit code 1
    runCli([
      'experience', 'begin',
      '--url', 'https://example.com/checkout',
      '--intent', 'buy-item',
      '--session', 'ep-test-2',
      '--json',
    ], env);
    const endMiss = runCli([
      'experience', 'end',
      '--session', 'ep-test-2',
      '--assert', assertFailPath,
      '--json',
    ], env);
    assert.equal(endMiss.status, 1, 'end with false assertion exits with code 1');
    const missData = JSON.parse(endMiss.stdout);
    assert.equal(missData.session, 'ep-test-2');
    assert.equal(missData.result, 'miss');
    assert.equal(missData.record.attempts, 2);
    assert.equal(missData.record.misses, 1);
    assert.equal(missData.record.lastResult, 'miss');
    assert.equal(missData.record.lastError, 'assertion returned false');
    assert.equal(fs.existsSync(episodePath(root, 'ep-test-2')), false, 'session file removed');

    // end syntax error in assert => env class, exit code 3, assert-error prefix.
    // A broken assert file says nothing about the page, so it must not count
    // as a page miss.
    runCli([
      'experience', 'begin',
      '--url', 'https://example.com/checkout',
      '--intent', 'buy-item',
      '--session', 'ep-test-3',
      '--json',
    ], env);
    const endSyntax = runCli([
      'experience', 'end',
      '--session', 'ep-test-3',
      '--assert', assertSyntaxPath,
      '--json',
    ], env);
    assert.equal(endSyntax.status, 3, 'end with syntax error exits with code 3 (env)');
    const syntaxData = JSON.parse(endSyntax.stdout);
    assert.equal(syntaxData.result, 'miss');
    assert.equal(syntaxData.record.errclass, 'env');
    assert.match(syntaxData.record.lastError, /^assert-error:\s*syntax error/i);
    assert.equal(fs.existsSync(episodePath(root, 'ep-test-3')), false);

    // --error straight to miss (skips assert execution)
    runCli([
      'experience', 'begin',
      '--url', 'https://example.com/checkout',
      '--intent', 'buy-item',
      '--session', 'ep-test-4',
      '--json',
    ], env);
    const endError = runCli([
      'experience', 'end',
      '--session', 'ep-test-4',
      '--assert', assertOkPath,
      '--error', 'payment gateway timeout',
      '--json',
    ], env);
    assert.equal(endError.status, 1, 'end with --error exits with code 1');
    const errorData = JSON.parse(endError.stdout);
    assert.equal(errorData.result, 'miss');
    assert.equal(errorData.record.lastError, 'payment gateway timeout');
    assert.equal(fs.existsSync(episodePath(root, 'ep-test-4')), false);

    // assert can read TT_BRIDGE_EXPERIENCE_DIR
    runCli([
      'experience', 'begin',
      '--url', 'https://example.com/checkout',
      '--intent', 'buy-item',
      '--session', 'ep-test-5',
      '--json',
    ], env);
    const endEnv = runCli([
      'experience', 'end',
      '--session', 'ep-test-5',
      '--assert', assertEnvPath,
      '--json',
    ], env);
    assert.equal(endEnv.status, 0, endEnv.stderr);
    const envData = JSON.parse(endEnv.stdout);
    assert.equal(envData.result, 'hit');
    assert.equal(fs.existsSync(episodePath(root, 'ep-test-5')), false);

    // programmatic API: beginEpisode and endEpisode
    const epDirect = beginEpisode(root, {
      url: 'https://example.com/api',
      intent: 'api-flow',
      session: 'ep-direct',
    });
    assert.equal(epDirect.session, 'ep-direct');
    assert.ok(fs.existsSync(epDirect.stateFile));
    const loaded = loadEpisode(root, 'ep-direct');
    assert.equal(loaded.episode.intent, 'api-flow');

    const epEndDirect = endEpisode(root, {
      session: 'ep-direct',
      assert: assertOkPath,
    });
    assert.equal(epEndDirect.result, 'hit');
    assert.equal(fs.existsSync(epDirect.stateFile), false);
  }

  // ── step 3: index, advise, lazy verification & contract F ──────────
  {
    const root = tmpRoot();
    const env = { TT_BRIDGE_EXPERIENCE_DIR: root };

    // 1. loadHostIndex 缺失/损坏返回空索引不抛错
    const missingIndex = loadHostIndex(root, 'nonexistent.com');
    assert.equal(missingIndex.schema, 1);
    assert.equal(missingIndex.host, 'nonexistent.com');
    assert.deepEqual(missingIndex.entries, []);

    const corruptFile = hostIndexPath(root, 'corrupt.com');
    writeFile(corruptFile, '{ invalid json');
    const corruptIndex = loadHostIndex(root, 'corrupt.com');
    assert.equal(corruptIndex.schema, 1);
    assert.equal(corruptIndex.host, 'corrupt.com');
    assert.deepEqual(corruptIndex.entries, []);

    // 2. advise 4 priorities (entry > pattern > atom > silent)
    // Setup Level 1 (host entry with triggers)
    createDraft(root, {
      url: 'https://gemini.google.com/app',
      intent: 'send-prompt',
      description: 'Send prompt via button',
    });
    // Finalize with triggers
    const entryPath = path.join(root, 'gemini.google.com', 'send-prompt', 'entry.md');
    const entryData = parseFrontmatter(fs.readFileSync(entryPath, 'utf8')).data;
    entryData.status = 'verified';
    entryData.triggers = ['key:Enter'];
    entryData.last_verified = new Date().toISOString();
    writeFile(entryPath, serializeFrontmatter(entryData) + '\n## 目标\n\n## 步骤\n\n## 验证\n');
    reindexHost(root, 'gemini.google.com');

    // Setup Level 2 (cross-site pattern)
    const patternDir = path.join(root, '_patterns', 'enter-submit');
    fs.mkdirSync(patternDir, { recursive: true });
    writeFile(path.join(patternDir, 'entry.md'), serializeFrontmatter({
      schema: 1,
      id: '_patterns/enter-submit',
      host: '_patterns',
      url: 'https://example.com',
      match: 'exact',
      kind: 'text',
      description: 'Enter key can trigger double submit',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      status: 'verified',
      confidence: 0.8,
      tags: [],
      triggers: ['key:Enter'],
    }) + '\n## 目标\n\n## 步骤\n\n## 验证\n');

    // Setup Level 3 (_trace failure rate)
    const traceDir = path.join(root, '_trace');
    fs.mkdirSync(traceDir, { recursive: true });
    writeFile(path.join(traceDir, 'trace.jsonl'), [
      JSON.stringify({ host: 'gemini.google.com', action: 'click', ok: false, at: new Date().toISOString() }),
      JSON.stringify({ host: 'gemini.google.com', action: 'click', ok: false, at: new Date().toISOString() }),
    ].join('\n') + '\n');

    // Test priority 0: the first command on a host lists its verified entries
    // once per session, before any targeted stage gets a say.
    resetAdviceSession();
    const catalogAdvice = advise(root, { host: 'gemini.google.com', action: 'key', arg: 'Enter' });
    assert.ok(catalogAdvice, 'first command on a host should catalog');
    assert.equal(catalogAdvice.kind, 'catalog');
    assert.match(catalogAdvice.line, /tt-bridge experience show/);
    const catalogAgain = advise(root, { host: 'gemini.google.com', action: 'key', arg: 'Enter' });
    assert.notEqual(catalogAgain && catalogAgain.kind, 'catalog', 'catalog is listed once per session');
    assert.equal(catalogAgain && catalogAgain.kind, 'entry', 'after the catalog the funnel reaches the targeted stage');

    // Test priority 1: entry hits, pattern does not appear. ignoreSession asks
    // for the best answer now, so the one-time catalog is skipped.
    resetAdviceSession();
    const l1Advice = advise(root, { host: 'gemini.google.com', action: 'key', arg: 'Enter', ignoreSession: true });
    assert.ok(l1Advice, 'entry should hit');
    assert.equal(l1Advice.kind, 'entry');
    assert.equal(l1Advice.entryId, 'gemini.google.com/send-prompt');
    assert.match(l1Advice.line, /^\[exp\]\s+/);

    // Test priority 2: when entry does not match, pattern hits
    resetAdviceSession();
    const l2Advice = advise(root, { host: 'other-site.com', action: 'key', arg: 'Enter', ignoreSession: true });
    assert.ok(l2Advice, 'pattern should hit for other site');
    assert.equal(l2Advice.kind, 'pattern');
    assert.equal(l2Advice.entryId, '_patterns/enter-submit');

    // Test priority 3: atom hits when entry and pattern do not match, but trace has >= 0.5 failure rate
    resetAdviceSession();
    const l3Advice = advise(root, { host: 'gemini.google.com', action: 'click', arg: 'submit-btn', ignoreSession: true });
    assert.ok(l3Advice, 'atom should hit for high failure rate');
    assert.equal(l3Advice.kind, 'atom');
    assert.match(l3Advice.reason, /failure-rate/);

    // Test priority 4: silent when none match
    resetAdviceSession();
    const l4Advice = advise(root, { host: 'gemini.google.com', action: 'focus', arg: 'input', ignoreSession: true });
    assert.equal(l4Advice, null, 'unmatched action should be silent');

    // Catalog is non-repeating: once seen, the same session falls through to
    // the targeted stages instead of re-listing the host.
    resetAdviceSession('session-catalog');
    const catalogOnce = advise(root, { host: 'gemini.google.com', action: 'key', arg: 'Enter', session: 'session-catalog' });
    assert.equal(catalogOnce.kind, 'catalog');
    const afterCatalog = advise(root, { host: 'gemini.google.com', action: 'key', arg: 'Enter', session: 'session-catalog' });
    assert.equal(afterCatalog.kind, 'entry', 'a seen catalog must not re-list; the trigger stage answers instead');
    const afterTrigger = advise(root, { host: 'gemini.google.com', action: 'key', arg: 'Enter', session: 'session-catalog' });
    assert.equal(afterTrigger, null, 'the trigger hint itself is per-session deduped');

    // 3. 同一 trigger 第二次调用返回 null（每 session 一次）。第一阶段会给
    // 该 session 先发一次 catalog，所以先把它消耗掉再断言 trigger 去重。
    resetAdviceSession('session-test-a');
    const catalogCall = advise(root, { host: 'gemini.google.com', action: 'key', arg: 'Enter', session: 'session-test-a' });
    assert.equal(catalogCall.kind, 'catalog', 'first call on a session is the catalog');
    const firstCall = advise(root, { host: 'gemini.google.com', action: 'key', arg: 'Enter', session: 'session-test-a' });
    assert.ok(firstCall, 'first call returns advice');
    assert.equal(firstCall.kind, 'entry');
    const secondCall = advise(root, { host: 'gemini.google.com', action: 'key', arg: 'Enter', session: 'session-test-a' });
    assert.equal(secondCall, null, 'second call for the same trigger in one session returns null');

    // 4. TT_BRIDGE_EXPERIENCE_SILENT=1 时始终 null
    process.env.TT_BRIDGE_EXPERIENCE_SILENT = '1';
    try {
      resetAdviceSession('session-test-silent');
      // Silent mode must win over every stage, catalog included.
      const silentCall = advise(root, { host: 'gemini.google.com', action: 'key', arg: 'Enter', session: 'session-test-silent' });
      assert.equal(silentCall, null, 'silent mode returns null');
    } finally {
      delete process.env.TT_BRIDGE_EXPERIENCE_SILENT;
    }

    // 5. line 长度 ≤200 且以 `[exp] ` 开头
    const formattedLong = formatAdviceLine('A'.repeat(300));
    assert.ok(formattedLong.startsWith('[exp] '));
    assert.equal(formattedLong.length, 200);
    assert.ok(formattedLong.endsWith('…'));

    // 6. 懒验证：lastVerified 超 30 天 + assert 返回 false → 条目变 stale 且提示不含可执行命令
    const staleEntryDir = path.join(root, 'gemini.google.com', 'stale-test');
    fs.mkdirSync(staleEntryDir, { recursive: true });
    const pastDate = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    writeFile(path.join(staleEntryDir, 'entry.md'), serializeFrontmatter({
      schema: 1,
      id: 'gemini.google.com/stale-test',
      host: 'gemini.google.com',
      url: 'https://gemini.google.com/test',
      match: 'exact',
      kind: 'text',
      description: 'Stale test entry',
      created: pastDate,
      updated: pastDate,
      last_verified: pastDate,
      status: 'verified',
      confidence: 0.9,
      tags: [],
      triggers: ['type:special-text'],
    }) + '\n## 目标\n\n## 步骤\n\n## 验证\n');
    writeFile(path.join(staleEntryDir, 'assert.js'), 'return false;');
    reindexHost(root, 'gemini.google.com');

    // ignoreSession: assert the lazy-verification stage itself, not the
    // one-time catalog that would otherwise answer first.
    resetAdviceSession();
    const staleAdvice = advise(root, { host: 'gemini.google.com', action: 'type', arg: 'special-text', ignoreSession: true });
    assert.ok(staleAdvice, 'should return advice');
    assert.equal(staleAdvice.reason, 'assertion-failed-stale');
    assert.match(staleAdvice.line, /stale|未验证/i);
    assert.equal(/tt-bridge\s+run/i.test(staleAdvice.line), false, 'stale advice must not contain executable commands');

    const entryAfterAssert = readEntry(path.join(staleEntryDir, 'entry.md'));
    assert.equal(entryAfterAssert.status, 'stale', 'status must be updated to stale on disk');

    // 7. 注入异常被吞：构造 triggers 非法值时不抛错、返回 null
    const brokenIndexFile = hostIndexPath(root, 'broken.com');
    writeFile(brokenIndexFile, JSON.stringify({
      schema: 1,
      host: 'broken.com',
      builtAt: new Date().toISOString(),
      entries: [
        {
          id: 'broken.com/bad-triggers',
          slug: 'bad-triggers',
          kind: 'text',
          status: 'verified',
          confidence: 0.5,
          lastVerified: new Date().toISOString(),
          triggers: [123, null, undefined, {}],
        },
        {
          id: 'broken.com/not-array-triggers',
          slug: 'not-array',
          kind: 'text',
          status: 'verified',
          confidence: 0.5,
          lastVerified: new Date().toISOString(),
          triggers: 'illegal-string-not-array',
        },
      ],
    }));

    // Malformed triggers must be ignored, not thrown on. ignoreSession skips
    // the catalog so this asserts the trigger stage in isolation.
    let brokenAdvice = null;
    assert.doesNotThrow(() => {
      brokenAdvice = advise(root, { host: 'broken.com', action: 'custom-action', arg: 'Enter', ignoreSession: true });
    });
    assert.equal(brokenAdvice, null);

    // 7b. 阶段 1 token 召回：命令 arg 与条目 codeTokens/descTokens 重合即命中，
    // 未 ack 每 5 步重提醒一次，ack 之后彻底静音。
    const slateHost = 'slate.example.com';
    const slateDir = path.join(root, slateHost, 'open-dialog');
    fs.mkdirSync(slateDir, { recursive: true });
    const iso = new Date().toISOString();
    writeFile(path.join(slateDir, 'entry.md'), serializeFrontmatter({
      schema: 1,
      id: `${slateHost}/open-dialog`,
      host: slateHost,
      url: `https://${slateHost}/**`,
      match: 'glob',
      kind: 'text',
      description: 'Open the Slate comment dialog',
      created: iso,
      updated: iso,
      last_verified: iso,
      status: 'verified',
      confidence: 0.9,
      tags: ['slate'],
      selectors: [],
      triggers: [],
    }) + '\n## 步骤\n\n```javascript\nconst e = document.querySelector(\'span[data-slate-leaf="true"]\');\n```\n');
    reindexHost(root, slateHost);
    const slateId = `${slateHost}/open-dialog`;
    const slateArg = "document.querySelector('span[data-slate-leaf=\"true\"]')";
    const askSlate = () => advise(root, { host: slateHost, action: 'eval', arg: slateArg, session: 'sess-similar' });

    resetAdviceSession('sess-similar');
    // Stage 0 answers the first command on a host; consume it to reach stage 1.
    assert.equal(advise(root, { host: slateHost, action: 'noop', arg: '', session: 'sess-similar' }).kind, 'catalog');
    const similarHit = askSlate();
    assert.equal(similarHit.kind, 'similar', 'arg tokens must recall the entry');
    assert.equal(similarHit.entryId, slateId);
    assert.match(similarHit.line, new RegExp(`experience show ${slateHost}/open-dialog`));
    assert.match(similarHit.reason, /token-match-/);
    // The hit consumed the first call; every later blind command is one step,
    // and the nag speaks on the 5th.
    for (let step = 1; step <= 4; step += 1) {
      assert.equal(askSlate(), null, `steps 1-4 after the first hit stay silent (step ${step})`);
    }
    const nag = askSlate();
    assert.equal(nag.kind, 'similar', 'an un-acked hit re-nags after 5 blind steps');
    assert.match(nag.line, /仍未查阅/);

    markSeen('sess-similar', `ack::${slateId}`);
    assert.equal(askSlate(), null, 'acking an entry stops the similarity nag for good');

    // www.<host> falls back to the bare-host bucket instead of going silent.
    assert.equal(loadHostIndex(root, `www.${slateHost}`).entries.length, 1, 'loadHostIndex strips www.');
    assert.equal(loadHostIndex(root, 'www.absent.example.com').entries.length, 0);
    const wwwHit = advise(root, { host: `www.${slateHost}`, action: 'eval', arg: slateArg, ignoreSession: true });
    assert.equal(wwwHit.kind, 'similar', 'advise recalls the bucket through the www alias');

    // 7c. `experience show` / `experience run` are the ack the funnel waits for.
    // Dedupe lives in TMPDIR keyed by session, so pin every session used here.
    resetAdviceSession('sess-cli-ack');
    const shown = runCli(['experience', 'show', slateId, '--session', 'sess-cli-ack', '--json'], env);
    assert.equal(shown.status, 0, shown.stderr);
    // Ack silences the similarity stage for the whole session; the one-time
    // catalog is a different notice, so drain it to reach the stage under test.
    assert.equal(advise(root, { host: slateHost, action: 'noop', arg: '', session: 'sess-cli-ack' }).kind, 'catalog');
    assert.equal(advise(root, { host: slateHost, action: 'eval', arg: slateArg, session: 'sess-cli-ack' }), null,
      'a shown entry must not be nagged again in that session');

    const runnableDir = path.join(root, slateHost, 'run-dialog');
    fs.mkdirSync(runnableDir, { recursive: true });
    writeFile(path.join(runnableDir, 'entry.md'), serializeFrontmatter({
      schema: 1,
      id: `${slateHost}/run-dialog`,
      host: slateHost,
      url: `https://${slateHost}/run`,
      match: 'exact',
      kind: 'script',
      description: 'Runnable slate dialog entry',
      created: iso,
      updated: iso,
      last_verified: iso,
      status: 'verified',
      confidence: 0.9,
      tags: [],
      selectors: [],
      script: 'run.sh',
      triggers: [],
    }) + '\n## 步骤\n');
    writeFile(path.join(runnableDir, 'run.sh'), '#!/bin/sh\necho ran\n');
    fs.chmodSync(path.join(runnableDir, 'run.sh'), 0o755);
    resetAdviceSession('sess-cli-run');
    const ran = runCli(['experience', 'run', `${slateHost}/run-dialog`, '--session', 'sess-cli-run'], env);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(hasSeen('sess-cli-run', `ack::${slateHost}/run-dialog`), true, 'run must write ack::<id>');
    resetAdviceSession('sess-cli-miss');
    const missingAck = runCli(['experience', 'show', 'slate.example.com/nope', '--session', 'sess-cli-miss'], env);
    assert.notEqual(missingAck.status, 0);
    assert.equal(hasSeen('sess-cli-miss', `ack::${slateHost}/nope`), false, 'a failed show writes no ack');

    // 8. 契约 F: 环境错误不增加 misses/consecutiveMisses，errclass 为 env，exit code 为 3
    runCli([
      'experience', 'begin',
      '--url', 'https://example.com/checkout',
      '--intent', 'env-error-test',
      '--session', 'sess-env-err',
    ], env);

    const envEndRes = runCli([
      'experience', 'end',
      '--session', 'sess-env-err',
      '--error', 'Pinned tab 123 is no longer available',
      '--json',
    ], env);
    assert.equal(envEndRes.status, 3, 'env error exits with code 3');
    const envEndData = JSON.parse(envEndRes.stdout);
    assert.equal(envEndData.result, 'miss');
    assert.equal(envEndData.errclass, 'env');
    assert.equal(envEndData.record.misses, 0, 'env error must not increment misses');
    assert.equal(envEndData.record.consecutiveMisses, 0, 'env error must not increment consecutiveMisses');
    assert.equal(envEndData.record.errclass, 'env');

    // 9. 命令行 advise: experience advise --host <h> --action <a> [--arg <x>] [--json]
    const cliAdvise = runCli([
      'experience', 'advise',
      '--host', 'gemini.google.com',
      '--action', 'key',
      '--arg', 'Enter',
      '--json',
    ], env);
    assert.equal(cliAdvise.status, 0);
    const cliAdviseData = JSON.parse(cliAdvise.stdout);
    assert.equal(cliAdviseData.ok, true);
    assert.equal(cliAdviseData.entryId, 'gemini.google.com/send-prompt');
    assert.ok(cliAdviseData.lastVerified);

    // 10. 性能自证：50 个条目下，advise 单次耗时 < 5ms
    const perfHost = 'perf.example.com';
    const perfHostDir = path.join(root, perfHost);
    fs.mkdirSync(perfHostDir, { recursive: true });
    const nowIso = new Date().toISOString();
    for (let i = 1; i <= 50; i++) {
      const slug = `act-${i}`;
      const d = path.join(perfHostDir, slug);
      fs.mkdirSync(d, { recursive: true });
      writeFile(path.join(d, 'entry.md'), serializeFrontmatter({
        schema: 1,
        id: `${perfHost}/${slug}`,
        host: perfHost,
        url: `https://${perfHost}/${slug}`,
        match: 'exact',
        kind: 'text',
        description: `perf item ${i}`,
        created: nowIso,
        updated: nowIso,
        last_verified: nowIso,
        status: 'verified',
        confidence: 0.9,
        tags: [],
        triggers: i === 50 ? ['key:Enter'] : [`click:btn-${i}`],
      }) + '\n## 目标\n\n## 步骤\n\n## 验证\n');
    }
    reindexHost(root, perfHost);

    // The hot path pays this cost once per CLI command, and the first call also
    // pays for reading the index off disk. Measure the median of warm calls:
    // that is what every subsequent command actually experiences.
    resetAdviceSession();
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const t0 = process.hrtime.bigint();
      const perfResult = advise(root, { host: perfHost, action: 'key', arg: 'Enter', ignoreSession: true });
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0) / 1e6);
      assert.ok(perfResult, 'advise must hit the perf entry');
      assert.equal(perfResult.entryId, `${perfHost}/act-50`);
    }
    samples.sort((a, b) => a - b);
    const perfMs = samples[Math.floor(samples.length / 2)];
    assert.ok(perfMs < 5, `advise median took ${perfMs}ms (samples: ${samples.map((n) => n.toFixed(2)).join(', ')})`);
  }

  // ── security regressions (RCE, trace privacy, classifier) ──────────
  {
    // C-1/C-2: a hostile id can never make advise execute a file outside the root.
    const root = tmpRoot();
    const outside = tmpRoot();
    const payloadDir = path.join(outside, 'payload');
    fs.mkdirSync(payloadDir, { recursive: true });
    const marker = path.join(outside, 'PWNED');
    fs.writeFileSync(path.join(payloadDir, 'assert.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); return true;`);
    // Poison the index bucket itself, exactly like a pre-created file would.
    writeFile(hostIndexPath(root, 'victim.com'), JSON.stringify({
      schema: 1,
      host: 'victim.com',
      entries: [{
        id: `../../${path.basename(outside)}/payload`,
        slug: 'payload', kind: 'hybrid', status: 'verified', confidence: 0.9,
        lastVerified: '2020-01-01T00:00:00.000Z', triggers: ['click'],
        description: 'evil', hasAssert: true,
      }],
    }));
    resetAdviceSession();
    advise(root, { host: 'victim.com', action: 'click', arg: '#btn', ignoreSession: true });
    assert.equal(fs.existsSync(marker), false, 'advise must never execute an assertion outside the experience root');

    // C-2: a shared playbook with a hostile frontmatter id is re-homed to its
    // real location, so the index cannot be poisoned at all.
    const root2 = tmpRoot();
    const dir = path.join(root2, 'shared.com', 'task');
    fs.mkdirSync(dir, { recursive: true });
    writeFile(path.join(dir, 'entry.md'), serializeFrontmatter({
      schema: 1, id: '../../../../tmp/elsewhere/payload', host: 'shared.com',
      url: 'https://shared.com/task', kind: 'text', status: 'verified',
      description: 'shared', last_verified: new Date().toISOString(), triggers: ['click'],
    }) + '\nbody\n');
    assert.equal(readEntry(path.join(dir, 'entry.md')).id, 'shared.com/task', 'entry id comes from its location, not frontmatter');
  }

  {
    // C-4: every env fault the daemon/extension actually emits is classified
    // env, and page-level text is not.
    for (const text of [
      'attach failed: Another debugger is already attached',
      'Timed out waiting for result after 30000ms',
      'Instance "chrome-ab12" is not connected',
      'Designated instance "x" is not connected. Connected instances: y',
      'Owner instance "x" is currently disconnected; ownership is held for its reconnect',
      'Extension not connected after waiting 20000ms',
      'Pinned tab 7 is no longer available (closed or non-debuggable URL)',
      'Timed out starting local daemon',
      'fetch failed',
      'This operation was aborted',
    ]) {
      assert.equal(classifyError(text), 'env', `env fault misclassified: ${text}`);
    }
    for (const text of [
      'element is no longer available',
      'assertion returned false',
      'TimeoutError: waiting for selector',
    ]) {
      assert.equal(classifyError(text), 'page', `page-level text misclassified as env: ${text}`);
    }
  }

  {
    // H5: env faults must not accumulate attempts (three restarts used to
    // auto-capture a phantom playbook).
    const root = tmpRoot();
    for (let i = 0; i < 3; i++) {
      recordAttempt(root, {
        url: 'https://env.example.com/x', intent: 'flaky',
        result: 'miss', error: 'Extension not connected after waiting 20000ms',
      });
    }
    const entry = listEntries(root).find((e) => e.id === 'env.example.com/flaky');
    assert.equal(entry, undefined, 'env-only failures must not create a draft');
    const shown = ledgerShow(root, 'env.example.com|flaky');
    assert.equal(shown.misses, 0, 'env failures never count as misses');
  }

  {
    // H7/M4/M3: the assertion sandbox uses SIGKILL, rejects async assertions,
    // and resolves relative requires against the assertion file.
    const root = tmpRoot();
    const dir = path.join(root, 'assert.example.com', 'run');
    fs.mkdirSync(dir, { recursive: true });
    writeFile(path.join(dir, 'entry.md'), serializeFrontmatter({
      schema: 1, id: 'assert.example.com/run', host: 'assert.example.com',
      url: 'https://assert.example.com/run', kind: 'text', status: 'verified',
      description: 'd', last_verified: new Date().toISOString(), triggers: [],
    }) + '\nbody\n');
    writeFile(path.join(dir, 'helper.js'), 'module.exports = true;');
    writeFile(path.join(dir, 'entry.md'), serializeFrontmatter({
      schema: 1, id: 'assert.example.com/run', host: 'assert.example.com',
      url: 'https://assert.example.com/run', kind: 'text', status: 'verified',
      description: 'd', last_verified: new Date().toISOString(), triggers: [],
    }) + '\nbody\n');

    // M3 relative require
    writeFile(path.join(dir, 'rel.js'), "return require('./helper.js') === true;");
    const begin = beginEpisode(root, { url: 'https://assert.example.com/run', intent: 'run' });
    const relEnd = endEpisode(root, { session: begin.session, assert: path.join(dir, 'rel.js') });
    assert.equal(relEnd.result, 'hit', 'relative require resolves against the assertion file');

    // M4 async assertion is an env fault, not a page miss
    writeFile(path.join(dir, 'async.js'), 'async function f() { return true; } return f();');
    const b2 = beginEpisode(root, { url: 'https://assert.example.com/run', intent: 'run' });
    const asyncEnd = endEpisode(root, { session: b2.session, assert: path.join(dir, 'async.js') });
    assert.equal(asyncEnd.result, 'miss');
    assert.equal(asyncEnd.errclass, 'env', 'an async assertion is a broken assertion, not a page miss');
  }

  {
    // H7: an assertion that ignores SIGTERM still cannot outlive the 5s budget.
    const root = tmpRoot();
    const dir = path.join(root, 'slow.example.com', 'x');
    fs.mkdirSync(dir, { recursive: true });
    writeFile(path.join(dir, 'stubborn.js'), 'process.on("SIGTERM", () => {}); while (true) {}');
    const began = beginEpisode(root, { url: 'https://slow.example.com/x', intent: 'hang' });
    const t0 = Date.now();
    const ended = endEpisode(root, { session: began.session, assert: path.join(dir, 'stubborn.js') });
    const elapsed = Date.now() - t0;
    assert.equal(ended.errclass, 'env', 'a timeout is an env fault');
    assert.ok(elapsed < 12000, `SIGKILL must end the assert promptly (took ${elapsed}ms)`);
  }

  console.log('experience.test.mjs: all assertions passed');
} finally {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
