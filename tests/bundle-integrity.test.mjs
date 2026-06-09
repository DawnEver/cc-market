// bundle-integrity.test.mjs — verify each plugin's bundled shared/ matches cc-market/shared/
// Catches: missing files, stale copies, wrong import paths after refactor.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SHARED_FILES = readdirSync(join(ROOT, 'shared')).filter(f => f.endsWith('.mjs'));

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
  const checkFile = (filePath, relPath) => {
    const src = readFileSync(filePath, 'utf8');
    // Create a fresh regex each call — avoids stale lastIndex if assert throws mid-loop
    const re = /from\s+['"]([^'"]*shared\/[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const imp = m[1];
      assert.ok(
        imp.startsWith('./shared/') || imp.startsWith('../shared/'),
        `${relPath}: import '${imp}' must use ./shared/ or ../shared/ (not ../../shared/)`
      );
    }
  };

  for (const plugin of PLUGINS) {
    it(`${plugin} — no ../../shared/ imports`, () => {
      const pluginRoot = join(ROOT, plugin);
      // Check all .js/.mjs files recursively (skip node_modules, tests)
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name === 'shared') continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
            checkFile(full, full.replace(ROOT + '/', ''));
          }
        }
      };
      walk(pluginRoot);
    });
  }
});
