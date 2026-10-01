import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERIC_RULES, parseMarkers, scanText, scanRepo } from '../scripts/check-public-hygiene.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hit = (s, path = 'x.md', rules) => scanText(s, path, rules).length > 0;

test('flags real home paths, chat ids, org OneDrive, personal emails', () => {
  for (const s of [
    // Split literals so this file does not trip the guard it tests.
    'C:\\' + 'Users\\alice2\\repo',
    'see /' + 'Users/jdoe/Documents',
    'cd /' + 'home/jdoe/x',
    'chat -' + '1001234567890',
    'C:/OneDrive ' + '- Acme Corp/Sync',
    'mail someone' + '@uni.ac.uk',
  ]) assert.ok(hit(s), s);
});

test('allows placeholders and example addresses', () => {
  for (const s of [
    'C:\\Users\\<user>\\repo',
    '/Users/<user>/x and /home/$USER/y and ~/x',
    'C:\\Users\\USERNAME\\x',
    'OneDrive - <Org>',
    'user@example.com, 123+bot@users.noreply.github.com',
    'chat -100', '/home/u/x', 'C:/Users/x/y',
    'a@uni.edu.example, b@corp.test, permissions@publisher.com',
  ]) assert.ok(!hit(s), s);
});

test('manifest author name is exempt; emails and other files are not', () => {
  const rules = parseMarkers('secretname');
  const name = '  "author": {\n    "name": "Secretname"\n  }';
  assert.ok(!hit(name, 'fabric/.claude-plugin/plugin.json', rules));
  assert.ok(!hit('authors = [{ name = "Secretname" }]', 'x/pyproject.toml', rules));
  assert.ok(hit(name, 'fabric/README.md', rules));
  assert.ok(hit('    "email": "x' + '@corp.io"', 'fabric/.claude-plugin/plugin.json'));
});

test('private-markers: literals and /regex/, comments ignored', () => {
  const rules = parseMarkers('# c\nsecretbox\n/\\bHOST\\d\\b/\n\n');
  assert.equal(rules.length, 2);
  assert.ok(hit('on SecretBox today', 'a', rules));
  assert.ok(hit('on host3', 'a', rules));
  assert.ok(!hit('on host33 # c', 'a', rules));
});

test('generic rules are non-empty', () => assert.ok(GENERIC_RULES.length >= 5));

test('no tracked file carries private data', () => {
  const hits = scanRepo(root);
  assert.deepEqual(hits.map((h) => `${h.path}:${h.line} [${h.rule}] ${h.match}`), []);
});
