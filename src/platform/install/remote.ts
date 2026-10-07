import { spawn } from 'node:child_process';
import { sshCommand, StderrTail } from '../dialer/index.js';
import { preparePrivateDirs, type HostPaths } from '../files/index.js';
import { checkNodePath } from './formats.js';
import { releaseEntries } from './release.js';
import { tarArchive, type TarEntry } from './tar.js';

/**
 * The fixed remote command: unpacks the archive on stdin into a temporary directory and runs its
 * `install.sh` from the home directory. Its quoted part holds no quote or backslash, so every common
 * login shell parses it alike; `IFS=` and `set -f` keep the unquoted temporary path one word.
 */
export const REMOTE_INSTALL_COMMAND =
  "exec sh -c 'set -f; IFS=; cd && T=$(mktemp -d) && { tar -x -f - -C $T && exec sh $T/install.sh $T; rm -rf $T; exit 1; }'";

const RESULT = '@@wtd-install@@';

/**
 * Runs remotely as `sh install.sh <dir>` from the home directory, `<dir>` holding `version`,
 * optionally `node`, and `release/`. Prints one result line starting with the marker.
 */
const INSTALL_SCRIPT = String.raw`T=$1
M='${RESULT}'
trap 'rm -rf "$T"' EXIT
result() { printf '%s %s\n' "$M" "$*"; }
fail() { result "error $*"; exit 1; }

D=$HOME/.local/share/worktree-term
V=$D/versions
C=$D/current
B=$HOME/.local/bin
W=$B/wtd

S=$(uname -s)
[ "$S" = Linux ] || fail "unsupported system $S: only Linux is supported"
VERSION=$(cat "$T/version") || fail "the archive holds no version"

major_ok() {
  v=$("$1" -p process.versions.node 2>/dev/null) || return 1
  m=$(printf '%s\n' "$v" | head -n 1 | cut -d. -f1)
  case $m in ''|*[!0-9]*) return 1 ;; esac
  [ "$m" -ge 20 ]
}
usable() { [ -f "$1" ] && [ -x "$1" ] && major_ok "$1"; }

if [ -f "$T/node" ]; then
  N=$(cat "$T/node")
  usable "$N" || fail "$N is not a usable Node: version 20 or later is needed"
else
  N=
  c=$(command -v node 2>/dev/null) || c=
  case $c in /*) usable "$c" && N=$c ;; esac
  if [ -z "$N" ] && [ -n "$SHELL" ]; then
    c=$("$SHELL" -l -i -c 'printf "%s\n" @@wtd-node@@; command -v node; printf "%s\n" @@wtd-node-end@@' </dev/null 2>/dev/null | sed -n '/^@@wtd-node@@$/,/^@@wtd-node-end@@$/p' | sed -n 2p)
    case $c in /*) usable "$c" && N=$c ;; esac
  fi
  if [ -z "$N" ] && [ -f "$W" ]; then
    c=$(sed -n "2s/^exec '\(.*\)' \"\$HOME\/.*$/\1/p" "$W" | sed "s/'\\\\''/'/g")
    case $c in /*) usable "$c" && N=$c ;; esac
  fi
  [ -n "$N" ] || fail "no Node 20 or later on the PATH, in the login shell or in the installed shim"
fi

owned() { [ -n "$(find "$1" -maxdepth 0 -user "$(id -u)" 2>/dev/null)" ]; }
check() {
  if [ -L "$1" ]; then
    [ "$2" = link ] || fail "$1 is a symbolic link"
  elif [ -e "$1" ]; then
    case $2 in
      dir) [ -d "$1" ] || fail "$1 is not a directory" ;;
      file) [ -f "$1" ] || fail "$1 is not a regular file" ;;
      link) fail "$1 is not a symbolic link" ;;
    esac
  else
    return 0
  fi
  owned "$1" || fail "$1 is owned by another user"
}
check "$D" dir
check "$V" dir
check "$C" link
check "$W" file
if [ -d "$V" ]; then
  for e in "$V"/* "$V"/.[!.]*; do
    if [ -e "$e" ] || [ -L "$e" ]; then check "$e" dir; fi
  done
fi

mkd() { [ -d "$1" ] || mkdir -m 700 "$1" || fail "cannot create $1"; }
mkd "$HOME/.local"
mkd "$HOME/.local/share"
mkd "$D"
mkd "$V"
mkd "$B"

hex() { od -An -N6 -tx1 /dev/urandom | tr -d ' \n'; }
R=$VERSION-$(hex)
mv "$T/release" "$V/.$R" || { rm -rf "$V/.$R"; fail "cannot copy the release into $V"; }
mv "$V/.$R" "$V/$R" || { rm -rf "$V/.$R"; fail "cannot rename the release in $V"; }

P=$(readlink "$C" 2>/dev/null) || P=
[ -z "$P" ] || P=$(basename "$P")
L=$D/.current-$(hex)
ln -s "versions/$R" "$L" || fail "cannot create $L"
"$N" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$L" "$C" || { rm -f "$L"; fail "cannot replace $C"; }

for e in "$V"/*; do
  n=$(basename "$e")
  if [ "$n" != "$R" ] && [ "$n" != "$P" ] && [ -d "$e" ]; then rm -rf "$e"; fi
done

Q=$(printf '%s\n' "$N" | sed "s/'/'\\\\''/g")
X=$B/.wtd-$(hex)
{ printf '#!/bin/sh\nexec %s "$HOME/.local/share/worktree-term/current/wtd.mjs" "$@"\n' "'$Q'" > "$X" && chmod 700 "$X" && mv -f "$X" "$W"; } || { rm -f "$X"; fail "cannot write $W"; }
result "ok $R $N"
`;

export interface RemoteInstallation {
  /** This host's files, for the SSH control path. */
  paths: HostPaths;
  alias: string;
  /** The running `wtd.mjs`. */
  bundle: string;
  version: string;
  /** The remote Node to use; null finds one there. */
  node: string | null;
  /** Gives up after this long. */
  timeoutMs: number;
}

export interface InstalledRemote {
  version: string;
  release: string;
  node: string;
}

const encoder = new TextEncoder();
const MAX_STDOUT = 64 * 1024;
const EXIT_GRACE_MS = 1000;

const archiveOf = async ({ bundle, version, node }: RemoteInstallation): Promise<Uint8Array> => {
  const entries: TarEntry[] = [
    { path: 'install.sh', mode: 0o600, data: encoder.encode(INSTALL_SCRIPT) },
    { path: 'version', mode: 0o600, data: encoder.encode(version) },
    ...(node === null ? [] : [{ path: 'node', mode: 0o600, data: encoder.encode(node) }]),
    { path: 'release', mode: 0o700 },
    ...(await releaseEntries(bundle)).map((entry) => ({ ...entry, path: `release/${entry.path}` })),
  ];
  return tarArchive(entries);
};

/** The result line the remote installer printed, without its marker, or null. */
const resultOf = (stdout: string): string | null => {
  const line = stdout.split('\n').find((l) => l.startsWith(`${RESULT} `));
  return line === undefined ? null : line.slice(RESULT.length + 1);
};

/** Installs the running bundle on the SSH host `alias`; throws one line naming the cause. */
export const installRemote = async (installation: RemoteInstallation): Promise<InstalledRemote> => {
  const { paths, alias, version, node, timeoutMs } = installation;
  if (node !== null) checkNodePath(node);
  const [program, ...args] = sshCommand(paths, alias, REMOTE_INSTALL_COMMAND);
  await preparePrivateDirs(paths);
  const archive = await archiveOf(installation);
  const { stdout, code, tail } = await new Promise<{ stdout: string; code: number | string; tail: StderrTail }>((resolve, reject) => {
    const child = spawn(program ?? 'ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const tail = new StderrTail();
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${alias}: the installation did not finish within ${String(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (out.length < MAX_STDOUT) out += chunk;
    });
    tail.follow(child.stderr);
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`cannot run ${program ?? 'ssh'}: ${error.message}`, { cause: error }));
    });
    const done = (exit: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({ stdout: out, code: exit ?? signal ?? 'unknown', tail });
    };
    child.once('close', done);
    // A control master forked by this SSH may hold its output open; the exit is what counts.
    child.once('exit', (exit, signal) => {
      setTimeout(() => {
        done(exit, signal);
      }, EXIT_GRACE_MS).unref();
    });
    child.stdin.end(archive);
  });
  const result = resultOf(stdout);
  if (result?.startsWith('ok ')) {
    const [release = '', ...rest] = result.slice(3).split(' ');
    return { version, release, node: rest.join(' ') };
  }
  if (result?.startsWith('error ')) throw new Error(`${alias}: ${result.slice(6)}`);
  throw new Error(tail.reason() ?? `${alias}: ssh exited with status ${String(code)}`);
};
