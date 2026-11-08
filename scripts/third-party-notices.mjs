import fs from 'node:fs';
import path from 'node:path';

const destination = path.resolve(process.argv[2]);
const metadata = JSON.parse(fs.readFileSync('.tools/dependency-metadata.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('apps/client/package-lock.json', 'utf8'));
const lines = ['# Third-party notices', '', 'Includes runtime, build, development and platform-specific dependencies.', 'License texts are copied from installed source packages.', ''];
const missing = [];

function collect(root, prefix, license, name) {
  if (!fs.existsSync(root)) return;
  const copied = [];
  function visit(folder, relative = '') {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      if (['node_modules', '.git', 'target', 'test', 'tests'].includes(item.name)) continue;
      const source = path.join(folder, item.name);
      const rel = path.join(relative, item.name);
      if (item.isDirectory()) visit(source, rel);
      else if (item.isFile() && /^(licen[sc]e|notice|copying|copyright|authors)([._-]|$)/i.test(item.name)) {
        const target = path.join(destination, 'LICENSES', prefix, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        fs.utimesSync(target, new Date('2000-01-01'), new Date('2000-01-01'));
        copied.push(path.relative(destination, target).split(path.sep).join('/'));
      }
    }
  }
  visit(root);
  const supplementalRoot = fs.existsSync('third-party-notices') ? 'third-party-notices' : '.tools/upstream-licenses';
  const supplemental = path.resolve(supplementalRoot, path.basename(prefix));
  if (!copied.length && fs.existsSync(supplemental)) visit(supplemental);
  lines.push('## ' + name, '', 'Declared license: ' + (license || 'See upstream'), '', ...copied.map(p => '- ' + p), '');
  if (!copied.length) missing.push(name);
}

for (const p of metadata.packages) if (p.source) collect(path.dirname(p.manifest_path), 'rust/' + p.name + '-' + p.version, p.license, p.name + ' ' + p.version);
for (const [entry, p] of Object.entries(lock.packages)) if (entry) {
  const root = path.resolve('apps/client', entry);
  if (!fs.existsSync(path.join(root, 'package.json'))) continue;
  const actual = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  collect(root, 'npm/' + actual.name.replaceAll('/', '_') + '-' + p.version, actual.license, actual.name + ' ' + p.version);
}
if (missing.length) lines.push('## Packages without a matching license filename', '', ...missing.map(p => '- ' + p), '', 'Review upstream license terms before a stable public release.');
fs.writeFileSync(path.join(destination, 'THIRD_PARTY_NOTICES.md'), lines.join('\n'));
console.log('Collected dependency licenses; ' + missing.length + ' packages need manual license-file review.');
if (missing.length) process.exitCode = 1;
