/**
 * Unit tests for resolveProfileName's alias resolution order.
 * Run: node daemon/chrome-profiles.test.mjs
 *
 * An explicit profilesList is always passed so these tests never touch disk.
 */
import assert from 'node:assert/strict';
import { maskProfileName, resolveProfileName } from './bin/chrome-profiles.mjs';

const profiles = [
  {
    dir: 'Profile 1',
    name: 'Work Chrome',
    email: 'Alice@Example.com',
    gaiaId: '110612345683',
    isDefaultName: false,
  },
  {
    dir: 'Profile 2',
    name: 'Profile 2',
    email: 'bob@example.com',
    gaiaId: '220612345683',
    isDefaultName: true,
  },
];

// ── override beats the gaiaId match ────────────────────────────────
assert.equal(
  resolveProfileName({ name: 'My Alias', gaiaId: '110612345683', email: 'alice@example.com' }, profiles),
  'My Alias',
  'extension override wins over Local State alias'
);

// ── gaiaId match with a real alias ─────────────────────────────────
assert.equal(
  resolveProfileName({ gaiaId: '110612345683' }, profiles),
  'Work Chrome',
  'gaiaId match returns the Chrome alias when isDefaultName is false'
);
assert.equal(
  resolveProfileName({ gaiaId: '110612345683' }, [{ dir: 'Profile 3', name: 'Personal', email: '', gaiaId: '110612345683' }]),
  'Personal',
  'missing isDefaultName is treated as not default'
);

// ── gaiaId match on a default name is skipped ──────────────────────
assert.equal(
  resolveProfileName({ gaiaId: '220612345683' }, profiles),
  '',
  'default Chrome profile name is not surfaced as an alias'
);
assert.equal(
  resolveProfileName({ name: 'My Alias', gaiaId: '220612345683' }, profiles),
  'My Alias',
  'default-name gaiaId match falls through to the override'
);

// ── email match is case-insensitive and still rejects default names ─
assert.equal(
  resolveProfileName({ email: 'ALICE@example.COM' }, profiles),
  'Work Chrome',
  'email matching is case-insensitive'
);
assert.equal(
  resolveProfileName({ email: 'bob@example.com' }, profiles),
  '',
  'email match on a default-named profile is skipped'
);

// ── signed out (no email / gaiaId) without override ────────────────
assert.equal(
  resolveProfileName({ email: '', gaiaId: '' }, profiles),
  '',
  'signed-out descriptor without an override resolves to empty string when no profile is signed out'
);

// ── signed out with override ───────────────────────────────────────
assert.equal(
  resolveProfileName({ name: 'My Alias', email: '', gaiaId: '' }, profiles),
  'My Alias',
  'signed-out descriptor keeps the user override'
);

// ── exactly one signed-out Chrome profile: elimination, not a guess ─
const oneSignedOut = [
  ...profiles,
  { dir: 'Profile 9', name: 'Local Sandbox', email: '', gaiaId: '', isDefaultName: false },
];
assert.equal(
  resolveProfileName({ email: '', gaiaId: '' }, oneSignedOut),
  'Local Sandbox',
  'a single signed-out Chrome profile is attributed to a signed-out descriptor'
);

// ── two signed-out profiles are indistinguishable → stay silent ─────
const twoSignedOut = [
  ...oneSignedOut,
  { dir: 'Profile 10', name: 'Scratch', email: '', gaiaId: '', isDefaultName: false },
];
assert.equal(
  resolveProfileName({ email: '', gaiaId: '' }, twoSignedOut),
  '',
  'ambiguous signed-out profiles are never guessed'
);

// ── the single signed-out profile with only a default name is not an alias
assert.equal(
  resolveProfileName({ email: '', gaiaId: '' }, [
    ...profiles,
    { dir: 'Profile 11', name: 'Profile 11', email: '', gaiaId: '', isDefaultName: true },
  ]),
  '',
  'single signed-out profile with a default name is not surfaced'
);

// ── a signed-in descriptor never falls into the elimination tier ────
assert.equal(
  resolveProfileName({ email: 'nobody@example.com', gaiaId: '' }, oneSignedOut),
  '',
  'signed-in descriptors are not attributed to a signed-out profile'
);

// ── display names are shortened before public exposure ─────────────
assert.equal(maskProfileName('Terry Tang'), 'Terry T.');
assert.equal(maskProfileName('  Terry   Tang  '), 'Terry T.');
assert.equal(maskProfileName('Work'), 'Work W.');
assert.equal(maskProfileName('Terry T.'), 'Terry T.', 'masking is idempotent');
assert.equal(maskProfileName(''), '');
assert.equal(maskProfileName(null), '');
