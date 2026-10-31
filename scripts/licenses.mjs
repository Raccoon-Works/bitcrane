// Collects the licenses of all third-party packages shipped with Bitcrane
// (npm production dependencies and Rust crates) into src/licenses.json.
// Run after changing dependencies: node scripts/licenses.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath also handles Windows drive letters (D:\...).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  // Crates from crates.io, plus the patched copies in src-tauri/vendor.
  const vendored = p.source == null && p.manifest_path.includes(`${path.sep}vendor${path.sep}`);
  if (p.name === 'bitcrane' || !used.has(p.id) || (p.source == null && !vendored)) continue;
  out.push({ name: p.name, version: p.version, license: p.license ?? '', kind: 'rust' });
}

// Not packages, but taken over: the terminal's colour schemes (published palettes).
for (const name of ['Dracula (colour scheme)', 'Nord (colour scheme)', 'Gruvbox (colour scheme)', 'Solarized (colour scheme)', 'One Dark (colour scheme)', 'Tomorrow Night (colour scheme)']) {
  out.push({ name, version: '', license: 'MIT', kind: 'other' });
}

out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
fs.writeFileSync(path.join(root, 'src', 'licenses.json'), JSON.stringify(out));
console.log(`${out.length} packages`);
