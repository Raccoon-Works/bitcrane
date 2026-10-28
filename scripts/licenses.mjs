// Collects the licenses of all third-party packages shipped with Bitcrane
// (npm production dependencies and Rust crates) into src/licenses.json.
// Run after changing dependencies: node scripts/licenses.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = [];

// npm: walk the production dependency tree.
const tree = JSON.parse(execSync('npm ls --omit=dev --all --json', { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }));
const seen = new Set();
(function walk(deps) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    const key = `${name}@${info.version}`;
    if (seen.has(key) || !info.version) continue;
    seen.add(key);
    let license = '';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
      license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? '';
    } catch {
      // Nested copy; the license of the top-level copy is used if present.
    }
    out.push({ name, version: info.version, license: license || '', kind: 'npm' });
    walk(info.dependencies);
  }
})(tree.dependencies);

// Rust: every crate in the dependency graph except Bitcrane itself.
const meta = JSON.parse(execSync('cargo metadata --format-version 1 --locked', { cwd: path.join(root, 'src-tauri'), encoding: 'utf8', maxBuffer: 256 << 20 }));
const used = new Set(meta.resolve.nodes.map((n) => n.id));
for (const p of meta.packages) {
  if (p.name === 'bitcrane' || !used.has(p.id) || p.source == null) continue;
  out.push({ name: p.name, version: p.version, license: p.license ?? '', kind: 'rust' });
}

out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
fs.writeFileSync(path.join(root, 'src', 'licenses.json'), JSON.stringify(out));
console.log(`${out.length} packages`);
