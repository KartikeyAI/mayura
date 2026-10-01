// The shell scripts a Docker sandbox runs with `sh -c <script> mayura <arguments>`, beyond the shared
// `sandboxScripts` for reading, listing, removing and stopping. They need a POSIX shell and the usual tools (cat, head,
// rm, mkdir), from BusyBox or coreutils.

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

/** Writes standard input to a file, creating its directories. $1: the path; $2: its length. Exit 4: a directory is there. */
export const writeScript = [
  '[ ! -d "$1" ] || exit 4',
  'mkdir -p -- "$(dirname -- "$1")" || exit',
  'head -c "$2" > "$1"',
].join('\n');

/** Shell-quotes a value: safe inside an `eval`ed or sourced script. */
export function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** An environment as a script of `export` lines. */
export function environmentScript(env: Readonly<Record<string, string>>): string {
  return Object.entries(env).map(([name, value]) => `export ${name}=${quote(value)}\n`).join('');
}
