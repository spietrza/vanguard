// Static build for taskcell.dev: node build.mjs → dist/. No framework and no dependencies: src/ is the site,
// copied as is, then every local reference in the HTML and CSS is checked so a broken link fails the build.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const out = join(root, 'dist');

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });

/** All files under dir, as paths relative to dist/. */
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [relative(out, join(dir, e.name))],
  );
const files = walk(out);

// Local references: href/src/srcset in HTML, url() in CSS, import specifiers in JS. Absolute ones start at dist/.
const refs = [];
for (const f of files) {
  const text = /\.(html|css|js)$/.test(f) && !f.includes('three-') ? readFileSync(join(out, f), 'utf8') : '';
  const found = [
    ...[...text.matchAll(/\b(?:href|src)="([^"#?]+)/g)].map((m) => m[1]),
    ...[...text.matchAll(/\bsrcset="([^"]+)"/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+/)[0])),
    ...[...text.matchAll(/url\(([^)'"]+)\)/g)].map((m) => m[1]),
    ...[...text.matchAll(/(?:from|import\()\s*'(\.[^']+)'/g)].map((m) => m[1]),
  ];
  for (const r of found) if (!/^[a-z]+:/.test(r)) refs.push({ from: f, ref: r });
}
const missing = refs.filter(({ from, ref }) => !existsSync(ref.startsWith('/') ? join(out, ref) : join(out, dirname(from), ref)));
if (missing.length) {
  for (const m of missing) console.error(`missing: ${m.ref} (in ${m.from})`);
  process.exit(1);
}

console.log(`dist/ written: ${files.length} files, ${refs.length} local references checked`);
