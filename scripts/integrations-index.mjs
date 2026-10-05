// Writes docs/reference/integrations.md, the catalog of every @mayurajs/* package in extensions/, grouped by area, from
// each package's own description. Run it after adding an extension; --check fails when the page is out of date.
//   node scripts/integrations-index.mjs [--check]
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = join(root, 'docs', 'reference', 'integrations.md');

/** Each area: the package name prefixes it holds, its guide, and one line about it. */
const areas = [
  { title: 'Model providers', prefixes: ['provider-'], guide: '../guides/model-registry.md', about: 'Models as `provider/model` in a model registry, with prices.' },
  { title: 'Voice', prefixes: ['voice-'], guide: '../guides/voice.md', about: 'Speech-to-text and text-to-speech in the voice registry.' },
  { title: 'Storage', prefixes: ['storage-'], guide: '../guides/storage.md', about: 'Databases for runs, workflows, memory and keys, beside the built-in SQLite and PostgreSQL.' },
  { title: 'Files', prefixes: ['filestorage-'], guide: '../guides/files.md', about: 'Object stores and filesystems for file stores and artifacts, beside the built-in S3.' },
  { title: 'Observability', prefixes: ['observability-'], guide: '../guides/observability.md', about: 'Trace exporters for observability services, over OpenTelemetry.' },
  { title: 'Sandboxes', prefixes: ['sandbox-'], guide: '../guides/sandboxes.md', about: 'Hosted Linux machines for agents, beside the built-in Docker sandboxes.' },
  { title: 'Browsers', prefixes: ['browser-', 'cloudflare-quick-action'], guide: '../guides/browsers.md', about: 'Hosted browsers, browser tools and a live viewer, beside the local Chrome or Edge.' },
  { title: 'Sign-in providers', prefixes: ['auth-'], guide: '../guides/authentication.md', about: 'Identity provider tokens as server identities.' },
  { title: 'API key services', prefixes: ['km-'], guide: '../guides/authentication.md#api-keys', about: 'Keys issued by a key service, beside the built-in key manager.' },
  { title: 'Deploy targets', prefixes: ['deploy-'], guide: '../cli/deploy.md', about: 'Platforms for `mayura deploy`, beside Docker, Compose and Kubernetes.' },
];

const packages = [];
for (const entry of (await readdir(join(root, 'extensions'), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort()) {
  const manifest = JSON.parse(await readFile(join(root, 'extensions', entry, 'package.json'), 'utf8'));
  const area = areas.find(candidate => candidate.prefixes.some(prefix => entry === prefix || entry.startsWith(prefix)));
  if (!area) throw new Error(`extensions/${entry} belongs to no area: add its prefix to scripts/integrations-index.mjs.`);
  if (typeof manifest.description !== 'string' || manifest.description === '') throw new Error(`extensions/${entry} has no description.`);
  packages.push({ name: manifest.name, description: manifest.description, area });
}

const lines = [
  '---',
  'title: "Integration packages"',
  'description: "Every @mayurajs package: model providers, voice, storage, files, observability, sandboxes, browsers, sign-in, API keys and deploy targets."',
  '---',
  '',
  `Beside \`mayura\`, ${packages.length} optional \`@mayurajs/*\` packages connect it to other services. Each is published with every Mayura`,
  'release at the same version, takes `mayura` as a peer, and is installed only if you use it:',
  '',
  '```bash',
  'npm install mayura @mayurajs/storage-mysql',
  '```',
  '',
  'The packages read no environment variables themselves: you pass credentials in as options, and deploy targets use',
  'the platform\'s own command-line tool, signed in as you. Each area\'s guide shows how to use them.',
  '',
];
for (const area of areas) {
  const members = packages.filter(item => item.area === area);
  if (members.length === 0) continue;
  lines.push(`## ${area.title}`, '', `${area.about} See [${area.title === 'Deploy targets' ? 'mayura deploy' : area.title}](${area.guide}).`, '', '| Package | What it does |', '| --- | --- |');
  for (const item of members) lines.push(`| \`${item.name}\` | ${item.description.replaceAll('|', '\\|')} |`);
  lines.push('');
}
const page = `${lines.join('\n').trimEnd()}\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current !== page) { console.error('docs/reference/integrations.md is out of date: run node scripts/integrations-index.mjs.'); process.exit(1); }
  console.log(`docs/reference/integrations.md lists all ${packages.length} packages.`);
} else {
  await writeFile(target, page);
  console.log(`Wrote docs/reference/integrations.md: ${packages.length} packages in ${new Set(packages.map(item => item.area)).size} areas.`);
}
