import { SandboxError, type SandboxEntry } from './contracts.js';

// Shell scripts for providers whose APIs only run commands, run as `sh -c <script> mayura <arguments>`. They need a
// POSIX shell and the usual tools (cat, rm, stat, tr, grep, kill), from BusyBox or coreutils.

/** The environment variable that tags every process of one command, so all of them can be stopped together. */
const tagVariable = 'MAYURA_SANDBOX_EXEC';

const kill = [
  'for _round in 1 2; do',
  '  for _dir in /proc/[0-9]*; do',
  '    _pid=${_dir#/proc/}; [ "$_pid" = "$$" ] && continue',
  `    if tr "\\000" "\\n" < "$_dir/environ" 2>/dev/null | grep -qxF "${tagVariable}=$1"; then kill -KILL "$_pid" 2>/dev/null; fi`,
  '  done',
  'done',
  'exit 0',
].join('\n');

const read = [
  '[ -e "$1" ] || exit 3',
  '[ -f "$1" ] || exit 4',
  '_size=$(stat -c %s -- "$1") || exit',
  '[ "$_size" -le "$2" ] || exit 6',
  'exec cat -- "$1"',
].join('\n');

const list = [
  '[ -e "$1" ] || exit 3',
  '[ -d "$1" ] || exit 4',
  'cd -- "$1" || exit',
  '_count=0',
  'for _name in .* *; do',
  '  case $_name in .|..) continue ;; esac',
  '  [ -e "$_name" ] || [ -L "$_name" ] || continue',
  '  _count=$((_count + 1)); [ "$_count" -le "$2" ] || break',
  '  if [ -L "$_name" ]; then _type=o; elif [ -d "$_name" ]; then _type=d; elif [ -f "$_name" ]; then _type=f; else _type=o; fi',
  '  _stat=$(stat -c "%s %Y" -- "$_name" 2>/dev/null) || _stat="0 0"',
  '  printf "%s\\000%s\\000%s\\000%s\\000" "$_type" "${_stat% *}" "${_stat#* }" "$_name"',
  'done',
].join('\n');

const remove = [
  '[ -e "$1" ] || [ -L "$1" ] || exit 0',
  'if [ "$2" = 1 ]; then exec rm -rf -- "$1"; fi',
  'if [ -d "$1" ] && [ ! -L "$1" ]; then [ -z "$(ls -A -- "$1")" ] || exit 7; exec rmdir -- "$1"; fi',
  'exec rm -f -- "$1"',
].join('\n');

/**
 * For sandbox providers whose APIs only run commands: shell scripts that do what the `SandboxBackend` contract asks.
 * Run each as `['sh', '-c', script, 'mayura', ...arguments]`.
 *
 * - `kill`: stops every process whose environment has `tagVariable` set to `$1`. Give each command a fresh tag, then
 *   run this when its call ends, so the processes it started end with it.
 * - `read`: prints the file `$1`, of at most `$2` bytes. Exit 3: there is none; 4: not a regular file; 6: too large.
 * - `list`: lists the directory `$1`, at most `$2` entries; parse the output with `parseSandboxListing`. Exit 3: there
 *   is none; 4: not a directory.
 * - `remove`: removes `$1`; with `$2` set to `1`, a directory and everything in it. Exit 7: a directory is not empty.
 */
export const sandboxScripts = Object.freeze({ tagVariable, kill, read, list, remove });

/**
 * The output of `sandboxScripts.list` as entries. Names with control characters cannot be listed safely and are left
 * out.
 */
export function parseSandboxListing(output: Uint8Array): SandboxEntry[] {
  const fields = new TextDecoder().decode(output).split('\u0000'); fields.pop();
  if (fields.length % 4 !== 0) throw new SandboxError('invalid_response');
  const entries: SandboxEntry[] = [];
  for (let index = 0; index < fields.length; index += 4) {
    const [type, size, modified, name] = fields.slice(index, index + 4) as [string, string, string, string];
    if (/[\u0000-\u001f\u007f]/u.test(name) || !/^\d{1,16}$/u.test(size) || !/^\d{1,16}$/u.test(modified)) continue;
    entries.push({ name, type: type === 'f' ? 'file' : type === 'd' ? 'directory' : 'other', size: type === 'd' ? 0 : Number(size), modified: Number(modified) * 1_000 });
  }
  return entries;
}
