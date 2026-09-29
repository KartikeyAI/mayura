// Pack the workspace's Mayura packages, and the third-party packages they need from the local pnpm installation, into
// tarballs that a project outside the workspace can install offline. Shared by the starter check (CI) and
// `pnpm local:init` (trying a starter before Mayura is published), so both install exactly the same way.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const workspace = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
export const compilerPlatform = `@typescript/typescript-${process.platform}-${process.arch}`;
export const inside = (parent, child) => { const value = relative(parent, child); return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value); };

/** A minimal child environment: no credentials, no network for corepack, no install scripts. */
export function environment(extra = {}) {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMFILES', 'COREPACK_HOME']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase()))),
    COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', ...extra };
}
export async function run(args, cwd, { timeout = 120_000, env } = {}) {
  try { return await exec(process.execPath, args, { cwd, env: environment(env), timeout, windowsHide: true, maxBuffer: 16 * 1_048_576 }); }
  catch (error) { throw new Error(`Command failed in ${relative(workspace, cwd) || '.'}: ${args.slice(0, 3).map(value => relative(workspace, value) || value).join(' ')}\n${String(error.stdout ?? '').slice(-6_000)}\n${String(error.stderr ?? '').slice(-6_000)}`); }
}
/** The local JavaScript entry point of npm or pnpm, run through this Node. */
export function cli(kind) {
  const shebang = path => { const bytes = Buffer.alloc(256); let descriptor;
    try { descriptor = openSync(path, 'r'); return /^#![^\r\n]*\bnode\b/u.test(bytes.subarray(0, readSync(descriptor, bytes, 0, bytes.length, 0)).toString('utf8')); }
    catch { return false; } finally { if (descriptor !== undefined) closeSync(descriptor); } };
  const valid = path => { try { return isAbsolute(path) && statSync(path).isFile() && (/\.(?:js|cjs|mjs)$/iu.test(path) || shebang(path)); } catch { return false; } };
  const configured = process.env[`MAYURA_${kind.toUpperCase()}_CLI`];
  if (configured) { assert(valid(configured), `Configured ${kind} CLI must be an absolute local JavaScript entry point.`); return realpathSync(configured); }
  const directories = [...new Set([dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean).map(value => value.replace(/^"|"$/gu, ''))])];
  const suffixes = kind === 'npm' ? ['npm/bin/npm-cli.js'] : ['pnpm/bin/pnpm.cjs', 'corepack/dist/pnpm.js'];
  const candidates = suffixes.flatMap(suffix => directories.flatMap(directory => [join(directory, 'node_modules', suffix), resolve(directory, '..', 'lib', 'node_modules', suffix)]));
  for (const directory of directories) { try { const path = realpathSync(join(directory, kind)); if (valid(path)) candidates.push(path); } catch { /* next */ } }
  const found = candidates.find(valid); assert(found, `Set MAYURA_${kind.toUpperCase()}_CLI to an existing local JavaScript entry point.`); return realpathSync(found);
}
/** The installed directory of `name` as Node resolves it from `parent` (a pnpm-linked package), or undefined. */
export function findInstalled(name, parent) {
  const require = createRequire(join(parent, 'package.json'));
  // Node's lookup climbs past the workspace (for example to a node_modules folder in the home directory); only the
  // workspace's own installation counts, so anything installed above it is ignored rather than packed.
  const candidates = (require.resolve.paths(name) ?? []).filter(path => inside(workspace, path)).map(path => join(path, name, 'package.json'));
  candidates.push(join(workspace, 'node_modules', '.pnpm', 'node_modules', name, 'package.json'));
  const found = candidates.find(existsSync); if (!found) return undefined;
  const directory = dirname(realpathSync(found)); assert(inside(resolve(workspace, '..', '..'), directory), `Dependency path is outside the local installation: ${name}`);
  return directory;
}
/** Whether a package's `os` and `cpu` fields (npm's rules, including `!` exclusions) allow this machine. */
export function forThisPlatform(manifest) {
  const allows = (list, value) => !Array.isArray(list) || list.length === 0
    || (list.some(entry => entry === value) || (list.every(entry => entry.startsWith('!')) && !list.includes(`!${value}`)));
  return allows(manifest.os, process.platform) && allows(manifest.cpu, process.arch);
}
export function installedDirectory(name, parent) {
  const directory = findInstalled(name, parent); assert(directory, `Dependency is not installed: ${name} (from ${relative(workspace, parent)})`); return directory;
}

/**
 * Packs into `tarballs`. `packClosure(roots, { optional })` packs each root (resolved from its parent directory) and
 * everything it needs at run time; with `optional`, installed optional dependencies (such as this platform's native
 * binaries) come along too, and ones for other platforms are skipped. Third-party packages must not have install
 * scripts, apart from `allowScripts`, which are packed as already installed here and never run again.
 */
export function createPacker({ output, tarballs, allowScripts = ['better-sqlite3'] }) {
  const npm = cli('npm'); const pnpm = cli('pnpm'); const packages = new Map(); // name -> { archive, manifest, directory }
  const packDirectory = async (name, directory) => {
    if (packages.has(name)) return packages.get(name);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); assert.equal(manifest.name, name);
    const destination = join(tarballs, `${name.replace(/[^A-Za-z0-9]/gu, '-')}-${manifest.version}.tgz`);
    if (!name.startsWith('@mayura/')) for (const script of ['preinstall', 'install', 'postinstall']) {
      // better-sqlite3 is built once in the workspace (pnpm onlyBuiltDependencies) and packed with its binary.
      assert(!manifest.scripts?.[script] || allowScripts.includes(name), `${name} has an unreviewed installation script.`);
    }
    if (name === compilerPlatform && process.platform !== 'win32') {
      // pnpm pack writes every file as 0644, which strips the native compiler's execute bit on Linux and macOS; npm pack
      // keeps file modes. Everything else is packed by pnpm, as the template check does.
      const staging = await mkdtemp(join(output, 'npm-pack-'));
      await run([npm, 'pack', directory, '--ignore-scripts', '--offline', '--pack-destination', staging], workspace);
      const [archive] = await readdir(staging); assert(archive?.endsWith('.tgz')); await rename(join(staging, archive), destination);
    } else if (name.startsWith('@mayura/')) await run([pnpm, 'pack', '--out', destination], directory);
    else {
      try { await run([pnpm, 'pack', '--out', destination], directory); }
      catch {
        // Some published packages keep `workspace:` specs in their devDependencies, which pnpm pack cannot resolve
        // outside their own repository. Pack a staged copy without devDependencies or scripts with npm instead.
        const staged = await mkdtemp(join(output, 'stage-')); await cp(directory, staged, { recursive: true, dereference: true });
        const copy = JSON.parse(await readFile(join(staged, 'package.json'), 'utf8')); delete copy.devDependencies; delete copy.scripts;
        await writeFile(join(staged, 'package.json'), `${JSON.stringify(copy, null, 2)}\n`);
        const packing = await mkdtemp(join(output, 'npm-pack-'));
        await run([npm, 'pack', staged, '--ignore-scripts', '--offline', '--pack-destination', packing], workspace);
        const [archive] = await readdir(packing); assert(archive?.endsWith('.tgz')); await rename(join(packing, archive), destination);
      }
    }
    const entry = { archive: pathToFileURL(destination).href, manifest, directory }; packages.set(name, entry); return entry;
  };
  const workspacePackage = name => join(workspace, 'packages', name.slice('@mayura/'.length));
  /** A third-party package's installed directory, from whichever workspace package depends on it. */
  const thirdParty = name => {
    for (const entry of readdirSync(join(workspace, 'packages'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue; const found = findInstalled(name, join(workspace, 'packages', entry.name)); if (found) return found;
    }
    return installedDirectory(name, workspace);
  };
  // `mayura` is always the published bundle (scripts/bundle-package.mjs), never the workspace facade of that name.
  let bundled;
  const mayura = async () => {
    if (bundled) return bundled;
    const { bundle } = await import('./bundle-package.mjs');
    const staging = await mkdtemp(join(output, 'mayura-')); await bundle(staging);
    const packing = await mkdtemp(join(output, 'npm-pack-'));
    await run([npm, 'pack', staging, '--ignore-scripts', '--offline', '--pack-destination', packing], workspace);
    const [archive] = await readdir(packing); assert(archive?.endsWith('.tgz'));
    const manifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'));
    const destination = join(tarballs, `mayura-${manifest.version}.tgz`); await rename(join(packing, archive), destination);
    bundled = { archive: pathToFileURL(destination).href, manifest, directory: staging }; packages.set('mayura', bundled); return bundled;
  };
  // An @mayurajs extension is always its staged, publishable package (scripts/extensions.mjs), never the private source.
  const extension = async name => {
    if (packages.has(name)) return packages.get(name);
    const { extensions, stageExtension } = await import('./extensions.mjs');
    const found = extensions().find(entry => `@mayurajs/${entry.name}` === name); assert(found, `No extension named ${name}.`);
    const version = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')).version;
    const staging = await mkdtemp(join(output, 'extension-')); const manifest = await stageExtension(found, staging, version);
    const packing = await mkdtemp(join(output, 'npm-pack-'));
    await run([npm, 'pack', staging, '--ignore-scripts', '--offline', '--pack-destination', packing], workspace);
    const [archive] = await readdir(packing); assert(archive?.endsWith('.tgz'));
    const destination = join(tarballs, `${name.replace(/[^A-Za-z0-9]/gu, '-')}-${version}.tgz`); await rename(join(packing, archive), destination);
    const entry = { archive: pathToFileURL(destination).href, manifest, directory: found.directory }; packages.set(name, entry); return entry;
  };
  const packClosure = async (roots, { optional = false } = {}) => {
    const closure = new Set(); const queue = roots.map(([name, parent]) => ({ name, parent, required: true }));
    while (queue.length) {
      const { name, parent, required } = queue.shift(); if (closure.has(name)) continue;
      if (name.startsWith('@mayurajs/')) {
        // Its peer is the mayura bundle; its dependencies (vendor SDKs) come from the extension's own installation.
        closure.add(name); const { manifest, directory } = await extension(name);
        queue.push({ name: 'mayura', parent: workspace, required: true });
        for (const dependency of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dependency, parent: directory, required: true });
        continue;
      }
      if (name === 'mayura') {
        // Its optional peers are the project's to declare; its dependencies come from the workspace installation.
        closure.add(name); const { manifest } = await mayura();
        for (const dependency of Object.keys(manifest.dependencies ?? {})) {
          if (!closure.has(dependency)) { closure.add(dependency); const { manifest: third } = await packDirectory(dependency, thirdParty(dependency));
            for (const next of Object.keys(third.dependencies ?? {})) queue.push({ name: next, parent: thirdParty(dependency), required: true }); }
        }
        continue;
      }
      const directory = name.startsWith('@mayura/') ? workspacePackage(name) : required ? installedDirectory(name, parent) : findInstalled(name, parent);
      if (directory === undefined) continue; // an optional dependency that is not installed here
      // Optional packages for other platforms can be installed in the workspace too; npm would never install them here.
      if (!required && !forThisPlatform(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')))) continue;
      closure.add(name);
      if (name.startsWith('@mayura/')) assert(existsSync(join(directory, 'dist')), `Build ${name} first (pnpm build).`);
      const { manifest } = await packDirectory(name, directory);
      const needed = new Set(Object.keys(manifest.dependencies ?? {}));
      for (const peer of Object.keys(manifest.peerDependencies ?? {})) if (!manifest.peerDependenciesMeta?.[peer]?.optional) needed.add(peer);
      for (const dependency of needed) queue.push({ name: dependency, parent: directory, required: true });
      if (optional) for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) if (!needed.has(dependency)) queue.push({ name: dependency, parent: directory, required: false });
    }
    return closure;
  };
  return { npm, pnpm, packages, packDirectory, packClosure };
}
