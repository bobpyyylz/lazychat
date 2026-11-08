import fs from 'node:fs';
import path from 'node:path';

const metadata = JSON.parse(fs.readFileSync('.tools/dependency-metadata.json', 'utf8'));
const report = fs.readFileSync(process.argv[2] || 'distribution/THIRD_PARTY_NOTICES.md', 'utf8');
const missing = new Set((report.split('## Packages without a matching license filename')[1] || '').split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).trim()));
const cache = new Map();
const packages = metadata.packages.filter(p => missing.has(p.name + ' ' + p.version));
let cursor = 0;
async function worker() {
  while (cursor < packages.length) {
    const p = packages[cursor++];
    const match = /^https:\/\/github.com\/([^/]+)\/([^/#]+)/.exec(p.repository || '');
    const info = path.join(path.dirname(p.manifest_path), '.cargo_vcs_info.json');
    if (!match || !fs.existsSync(info)) continue;
    const commit = JSON.parse(fs.readFileSync(info, 'utf8')).git?.sha1;
    if (!/^[a-f0-9]{40}$/.test(commit || '')) continue;
    const base = 'https://raw.githubusercontent.com/' + match[1] + '/' + match[2].replace(/\.git$/, '') + '/' + commit + '/';
    if (!cache.has(base)) cache.set(base, (async () => {
      const results = [];
      for (const name of ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
        try {
          const response = await fetch(base + name, {signal: AbortSignal.timeout(10000)});
          if (response.ok) { const text = await response.text(); if (text.length > 50 && !text.includes('<html')) results.push({name, text, url:base + name}); }
        } catch {}
      }
      return results;
    })());
    const results = await cache.get(base);
    const folder = path.join('.tools/upstream-licenses', p.name + '-' + p.version);
    if (results.length) {
      fs.mkdirSync(folder, {recursive:true});
      for (const item of results) fs.writeFileSync(path.join(folder, item.name), item.text);
      fs.writeFileSync(path.join(folder, 'PROVENANCE.json'), JSON.stringify(results.map(({name,url}) => ({name,url})),null,2));
    }
    console.log(p.name + ': ' + results.length + ' upstream license files');
  }
}
await Promise.all(Array.from({length:6}, worker));
