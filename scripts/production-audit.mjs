import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { parse } from 'yaml';
import { bundledDependencies, workspacePackages } from './bundle-package.mjs';
import { checkSource, extensions } from './extensions.mjs';

const severityLevels = new Set(['info', 'low', 'moderate', 'high', 'critical']);
const reviewLink = /^https:\/\/github\.com\/KartikeyAI\/mayura\/pull\/(\d+)#pullrequestreview-(\d+)$/u;
const repositoryRoles = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const auditEndpoint = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const dataFile = name => new URL(`../${name}`, import.meta.url);

/** Follow exact workspace resolutions for the dependencies installed by the published manifests. */
export function productionInventory(lock, packages, releaseExtensions) {
  assert.equal(String(lock.lockfileVersion), '9.0', 'Unsupported pnpm lockfile version.');
  assert(lock.importers && lock.packages && lock.snapshots, 'Missing pnpm production dependency graph.');
  const roots = new Map();
  const edges = (importer, dependencies) => Object.entries(dependencies).map(([name, range]) => {
    const entry = lock.importers[importer]?.dependencies?.[name];
    assert(entry?.specifier === range && typeof entry.version === 'string', `Missing locked dependency ${name}@${range} in ${importer}.`);
    return [name, entry.version];
  });
  const versions = new Map();
  const visit = (name, reference, seen, inventory) => {
    // npm aliases store the registry package's name in the lockfile reference.
    const ref = reference.replace(/^npm:/u, '');
    const identity = ref.split('(')[0];
    const separator = identity.lastIndexOf('@');
    const actualName = separator > 0 ? identity.slice(0, separator) : name;
    const version = separator > 0 ? identity.slice(separator + 1) : identity;
    assert(semver.valid(version), `Unsupported registry resolution for ${name}.`);
    const snapshotKey = separator > 0 ? ref : `${name}@${ref}`;
    const snapshot = lock.snapshots[snapshotKey];
    const metadata = lock.packages[`${actualName}@${version}`];
    assert(snapshot, `Missing lockfile snapshot ${snapshotKey}.`);
    assert(metadata, `Missing lockfile metadata for ${actualName}@${version}.`);
    if (seen.has(snapshotKey)) return;
    seen.add(snapshotKey);
    const packageVersions = versions.get(actualName) ?? new Set();
    packageVersions.add(version);
    versions.set(actualName, packageVersions);
    inventory.add(`${actualName}@${version}`);
    for (const [dependency, resolved] of Object.entries(snapshot.dependencies ?? {})) {
      visit(dependency, resolved, seen, inventory);
    }
    for (const [dependency, resolved] of Object.entries(snapshot.optionalDependencies ?? {})) {
      // pnpm also records workspace-provided optional peers here. npm does not auto-install them.
      if (metadata.peerDependenciesMeta?.[dependency]?.optional !== true) visit(dependency, resolved, seen, inventory);
    }
  };
  const base = new Set();
  const baseSeen = new Set();
  for (const [name, range] of Object.entries(bundledDependencies(packages).dependencies)) {
    const owners = packages.filter(({ manifest }) => manifest.dependencies?.[name] === range);
    assert(owners.length > 0, `Missing workspace owner for ${name}@${range}.`);
    for (const owner of owners) {
      for (const [dependency, resolved] of edges(`packages/${owner.name}`, { [name]: range })) {
        visit(dependency, resolved, baseSeen, base);
      }
    }
  }
  roots.set('mayura', base);
  for (const extension of releaseExtensions) {
    const importer = `extensions/${extension.name}`;
    const inventory = new Set(base); // The installed Mayura peer has the same release version.
    const seen = new Set(baseSeen);
    for (const [name, resolved] of edges(importer, extension.manifest.dependencies ?? {})) {
      if (name.startsWith('@mayurajs/')) {
        const directory = name.slice('@mayurajs/'.length);
        assert(resolved.startsWith('link:') && posix.normalize(posix.join(importer, resolved.slice(5))) === `extensions/${directory}`, `Unexpected workspace resolution for ${name} in ${importer}.`);
        assert(roots.has(name), `Missing published dependency ${name} for ${importer}.`);
        for (const entry of roots.get(name)) inventory.add(entry);
      } else visit(name, resolved, seen, inventory);
    }
    roots.set(extension.manifest.name, inventory);
  }
  return { roots, versions };
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Ask npm about the exact versions, then map matching advisories back to each published package. */
export async function productionFindings({ roots, versions }, fetcher = fetch) {
  const response = await fetcher(auditEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.fromEntries([...versions].sort().map(([name, resolved]) => [name, [...resolved].sort()]))),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `npm audit service returned HTTP ${response.status}.`);
  const report = await response.json();
  assert(record(report), 'Invalid npm audit response.');
  const findings = [];
  for (const [name, advisories] of Object.entries(report)) {
    assert(versions.has(name) && Array.isArray(advisories), 'Unexpected entry in npm audit response.');
    for (const advisory of advisories) {
      assert(record(advisory) && Number.isSafeInteger(advisory.id) && advisory.id > 0 && severityLevels.has(advisory.severity), `Invalid npm advisory for ${name}.`);
      const range = typeof advisory.vulnerable_versions === 'string' && semver.validRange(advisory.vulnerable_versions, { includePrerelease: true });
      assert(range, `Invalid npm advisory version range for ${name}.`);
      for (const version of versions.get(name)) {
        if (!semver.satisfies(version, range, { includePrerelease: true })) continue;
        const affected = [...roots].filter(([, dependencies]) => dependencies.has(`${name}@${version}`)).map(([root]) => root);
        findings.push({ name, version, id: advisory.id, severity: advisory.severity, affected });
      }
    }
  }
  return findings;
}

const exceptionKey = ({ name, version, id }) => `${name}@${version} npm:${id}`;

/** Require a repository approval explicitly naming the moderate advisory, version and expiry. */
async function verifyReview({ review, marker }, fetcher = fetch) {
  const [, pull, reviewId] = reviewLink.exec(review);
  const token = process.env.GITHUB_TOKEN;
  const response = await fetcher(`https://api.github.com/repos/KartikeyAI/mayura/pulls/${pull}/reviews/${reviewId}`, {
    headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `GitHub advisory review verification returned HTTP ${response.status}.`);
  const approval = await response.json();
  return record(approval) && String(approval.id) === reviewId && approval.state === 'APPROVED' &&
    repositoryRoles.has(approval.author_association) &&
    typeof approval.body === 'string' && approval.body.split(/\r?\n/u).some(line => line.trim() === marker);
}

export async function evaluatePolicy(findings, policy, { now = Date.now(), approved = verifyReview } = {}) {
  assert(policy?.version === 1 && Array.isArray(policy.exceptions), 'Invalid production audit policy.');
  const exceptions = new Map();
  for (const entry of policy.exceptions) {
    assert(record(entry) && typeof entry.name === 'string' && /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u.test(entry.name) &&
      typeof entry.version === 'string' && semver.valid(entry.version) === entry.version &&
      Number.isSafeInteger(entry.id) && entry.id > 0 &&
      typeof entry.reason === 'string' && entry.reason.trim() &&
      typeof entry.review === 'string' && reviewLink.test(entry.review), 'Malformed moderate advisory exception.');
    const key = exceptionKey(entry);
    const expiry = Date.parse(`${entry.expiresOn}T00:00:00Z`);
    assert(typeof entry.expiresOn === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(entry.expiresOn) &&
      Number.isFinite(expiry) && new Date(expiry).toISOString().startsWith(entry.expiresOn), `Invalid UTC expiry for ${key}.`);
    assert(expiry > now, `Expired exception for ${key}.`);
    assert(!exceptions.has(key), `Duplicate exception for ${key}.`);
    exceptions.set(key, entry);
  }
  const blocked = [];
  const excepted = [];
  for (const finding of findings) {
    if (finding.severity === 'info' || finding.severity === 'low') continue;
    const key = exceptionKey(finding);
    const entry = exceptions.get(key);
    if (finding.severity === 'moderate' && entry &&
      await approved({ review: entry.review, marker: `Approve moderate ${key} until ${entry.expiresOn}` })) {
      excepted.push({ ...finding, expiresOn: entry.expiresOn });
    } else blocked.push(finding);
  }
  return { blocked, excepted };
}

async function main() {
  const lock = parse(await readFile(dataFile('pnpm-lock.yaml'), 'utf8'));
  const root = JSON.parse(await readFile(dataFile('package.json'), 'utf8'));
  const policy = JSON.parse(await readFile(dataFile('compatibility/production-audit.json'), 'utf8'));
  const releaseExtensions = extensions();
  for (const extension of releaseExtensions) checkSource(extension, root.version);
  const inventory = productionInventory(lock, await workspacePackages(), releaseExtensions);
  const findings = await productionFindings(inventory);
  const { blocked, excepted } = await evaluatePolicy(findings, policy);
  console.log(`Audited ${inventory.roots.size} published packages and ${[...inventory.versions.values()].reduce((total, versions) => total + versions.size, 0)} unique dependency versions.`);
  for (const item of [...blocked, ...excepted]) {
    const owners = item.affected.includes('mayura') ? 'mayura and all extensions' : item.affected.join(', ');
    console.log(`${item.severity} ${exceptionKey(item)} (${owners})${item.expiresOn ? ` excepted until ${item.expiresOn}` : ''}`);
  }
  if (blocked.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
