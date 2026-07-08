// bundle-integrity.test.mjs — verify each plugin's bundled shared/ matches cc-market/shared/
// Catches: missing files, stale copies, wrong import paths after refactor.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Recursive relative paths (e.g. 'codex/task.mjs'), excluding shared/tests/
function listSharedFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'tests') continue;
    if (entry.isDirectory()) out.push(...listSharedFiles(join(dir, entry.name), prefix + entry.name + '/'));
    else if (entry.name.endsWith('.mjs')) out.push(prefix + entry.name);
  }
  return out;
}
const SHARED_FILES = listSharedFiles(join(ROOT, 'shared'));

// All plugins with plugin.json — shared/ presence is asserted (not used as filter)
const ALL_PLUGINS = readdirSync(ROOT).filter(name =>
  existsSync(join(ROOT, name, '.claude-plugin', 'plugin.json'))
);

// Plugins that actually import from shared/ (need bundled copy)
function usesShared(pluginDir) {
  const re = /from\s+['"][^'"]*shared\/[^'"]+['"]/;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name === 'shared') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (walk(full)) return true; }
      else if ((entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) &&
               re.test(readFileSync(full, 'utf8'))) return true;
    }
    return false;
  };
  return walk(pluginDir);
}

const PLUGINS = ALL_PLUGINS.filter(name => usesShared(join(ROOT, name)));

describe('bundle integrity', () => {
  for (const plugin of PLUGINS) {
    describe(plugin, () => {
      it('shared/ directory exists', () => {
        assert.ok(
          existsSync(join(ROOT, plugin, 'shared')),
          `${plugin}/shared/ missing — run pre-push or bundle_shared manually`
        );
      });
      for (const file of SHARED_FILES) {
        it(`${file} exists in ${plugin}/shared/`, () => {
          assert.ok(
            existsSync(join(ROOT, plugin, 'shared', file)),
            `${plugin}/shared/${file} missing — run pre-push or bundle_shared manually`
          );
        });

        it(`${file} content matches cc-market/shared/${file}`, () => {
          const src = readFileSync(join(ROOT, 'shared', file), 'utf8');
          const bundled = readFileSync(join(ROOT, plugin, 'shared', file), 'utf8');
          assert.equal(bundled, src,
            `${plugin}/shared/${file} is stale — re-run pre-push or bundle_shared`
          );
        });
      }
    });
  }
});

describe('import paths', () => {
  // A shared/ import must resolve inside the plugin's own bundled shared/ dir —
  // an import that escapes the plugin (e.g. up to cc-market/shared/) breaks once
  // the plugin is installed standalone from the marketplace cache.
  const checkFile = (filePath, relPath, pluginRoot) => {
    const src = readFileSync(filePath, 'utf8');
    // Create a fresh regex each call — avoids stale lastIndex if assert throws mid-loop
    const re = /from\s+['"]([^'"]*shared\/[^'"]+)['"]/g;
    const bundledShared = join(pluginRoot, 'shared') + '/';
    let m;
    while ((m = re.exec(src)) !== null) {
      const resolved = join(dirname(filePath), m[1]).replace(/\\/g, '/');
      assert.ok(
        resolved.startsWith(bundledShared.replace(/\\/g, '/')),
        `${relPath}: import '${m[1]}' resolves outside the plugin's shared/`
      );
    }
  };

  for (const plugin of PLUGINS) {
    it(`${plugin} — shared/ imports stay inside the plugin`, () => {
      const pluginRoot = join(ROOT, plugin);
      // Check all .js/.mjs files recursively (skip node_modules, tests)
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name === 'shared') continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
            checkFile(full, full.replace(ROOT + '/', ''), pluginRoot);
          }
        }
      };
      walk(pluginRoot);
    });
  }
});
