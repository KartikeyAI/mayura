// The shell scripts a Docker sandbox runs with `sh -c <script> mayura <arguments>`. They need a POSIX shell and the
// usual tools (cat, head, rm, mkdir, stat, tr, grep, kill), from BusyBox or coreutils.

/** Where the scripts keep files: the sandbox's environment, and each command's own until it starts. */
export const stateDirectory = '/tmp/.mayura';

/**
 * Runs a command. $1: bytes of standard input to pass on, or `-` for none; $2: the directory; $3: a file of the
 * command's environment (read and removed before the command starts), or `-`; the command follows. The sandbox's and
 * the command's environment are applied last, so nothing they set changes how the script runs.
 */
export const execScript = [
  'cd -- "$2" || exit',
  '_mayura_head=$(command -v head)',
  `[ ! -f ${stateDirectory}/env ] || . ${stateDirectory}/env`,
  'if [ "$3" != - ]; then _mayura_env=$(cat -- "$3"); rm -f -- "$3"; eval "$_mayura_env"; unset _mayura_env; fi',
  'if [ "$1" = - ]; then shift 3; exec "$@" </dev/null; fi',
  '_mayura_bytes=$1; shift 3',
  '"$_mayura_head" -c "$_mayura_bytes" | "$@"',
].join('\n');

/** Stops every process of one command, found by the tag in its environment. $1: the tag's value. */
export const killScript = [
  'for _round in 1 2; do',
  '  for _dir in /proc/[0-9]*; do',
  '    _pid=${_dir#/proc/}; [ "$_pid" = "$$" ] && continue',
  '    if tr "\\000" "\\n" < "$_dir/environ" 2>/dev/null | grep -qxF "MAYURA_SANDBOX_EXEC=$1"; then kill -KILL "$_pid" 2>/dev/null; fi',
  '  done',
  'done',
  'exit 0',
].join('\n');

/** Writes standard input to a file, creating its directories. $1: the path; $2: its length. Exit 4: a directory is there. */
export const writeScript = [
  '[ ! -d "$1" ] || exit 4',
  'mkdir -p -- "$(dirname -- "$1")" || exit',
  'head -c "$2" > "$1"',
].join('\n');

/** Prints a file. $1: the path; $2: the most bytes. Exit 3: none; 4: not a regular file; 6: too large. */
export const readScript = [
  '[ -e "$1" ] || exit 3',
  '[ -f "$1" ] || exit 4',
  '_size=$(stat -c %s -- "$1") || exit',
  '[ "$_size" -le "$2" ] || exit 6',
  'exec cat -- "$1"',
].join('\n');

/**
 * Lists a directory as NUL-separated fields: type (`f`, `d` or `o`), size, modified (Unix seconds) and name, for each
 * entry. $1: the directory; $2: the most entries. Exit 3: none; 4: not a directory.
 */
export const listScript = [
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

/** Removes a file or directory. $1: the path; $2: `1` to remove a directory with everything in it. Exit 7: a directory is not empty. */
export const removeScript = [
  '[ -e "$1" ] || [ -L "$1" ] || exit 0',
  'if [ "$2" = 1 ]; then exec rm -rf -- "$1"; fi',
  'if [ -d "$1" ] && [ ! -L "$1" ]; then [ -z "$(ls -A -- "$1")" ] || exit 7; exec rmdir -- "$1"; fi',
  'exec rm -f -- "$1"',
].join('\n');

/** Shell-quotes a value: safe inside an `eval`ed or sourced script. */
export function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** An environment as a script of `export` lines. */
export function environmentScript(env: Readonly<Record<string, string>>): string {
  return Object.entries(env).map(([name, value]) => `export ${name}=${quote(value)}\n`).join('');
}
