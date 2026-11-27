import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellQuote } from './fake-ssh.js';

/** One recorded run of the fake mount or unmount program. */
export interface SshfsCall {
  readonly program: 'sshfs' | 'fusermount3';
  readonly args: readonly string[];
}

/** Environment pointing the mount code at the fakes: `WTD_SSHFS`, `WTD_FUSERMOUNT`, `WTD_MOUNTINFO`. */
export type SshfsEnv = Readonly<Record<'WTD_SSHFS' | 'WTD_FUSERMOUNT' | 'WTD_MOUNTINFO', string>>;

/** Octal escapes `/proc/self/mountinfo` uses for a path field. */
export const mountinfoEscape = (path: string): string =>
  path.replaceAll(/[\\ \t\n]/g, (c) => `\\${(c.codePointAt(0) ?? 0).toString(8).padStart(3, '0')}`);

const mountinfoLine = (point: string, source: string): string =>
  `100 1 0:99 / ${mountinfoEscape(point)} rw,nosuid,nodev,relatime - fuse.sshfs ${mountinfoEscape(source)} rw,user_id=1000,group_id=1000\n`;

const RECORD = String.raw`n=$(date +%s%N)-$$
for a in "$@"; do printf '%s\0' "$a"; done > "$d/calls/$prog.$n.tmp" && mv "$d/calls/$prog.$n.tmp" "$d/calls/$prog.$n"`;

const SSHFS_SCRIPT = (dir: string): string => String.raw`#!/bin/sh
d=${shellQuote(dir)}
prog=sshfs
${RECORD}
while [ -e "$d/hold" ]; do sleep 0.05; done
eval "point=\${$#}"
src=
for a in "$@"; do case "$a" in -o) ;; *:/*) src=$a ;; esac; done
mode=$(cat "$d/mode" 2>/dev/null)
case "$mode" in
  fail:*) printf 'fake sshfs: starting\n%s\n\n' "$(printf '%s' "$mode" | cut -c6-)" >&2; exit 1 ;;
  unlisted) exit 0 ;;
esac
if [ ! -d "$point" ]; then echo "fuse: bad mount point \`$point': No such file or directory" >&2; exit 1; fi
p=$(printf '%s' "$point" | sed 's/\\/\\134/g; s/ /\\040/g; s/	/\\011/g')
s=$(printf '%s' "$src" | sed 's/\\/\\134/g; s/ /\\040/g; s/	/\\011/g')
printf '100 1 0:99 / %s rw,nosuid,nodev,relatime - fuse.sshfs %s rw,user_id=1000,group_id=1000\n' "$p" "$s" >> "$d/mountinfo"
`;

const FUSERMOUNT_SCRIPT = (dir: string): string => String.raw`#!/bin/sh
d=${shellQuote(dir)}
prog=fusermount3
${RECORD}
eval "point=\${$#}"
p=$(printf '%s' "$point" | sed 's/\\/\\134/g; s/ /\\040/g; s/	/\\011/g')
if ! P="$p" awk '$5 == ENVIRON["P"] { found = 1 } END { exit !found }' "$d/mountinfo"; then
  echo "fusermount3: entry for $point not found in /etc/mtab" >&2
  exit 1
fi
P="$p" awk '$5 != ENVIRON["P"]' "$d/mountinfo" > "$d/mountinfo.tmp" && mv "$d/mountinfo.tmp" "$d/mountinfo"
`;

/** Fake `sshfs` and `fusermount3` that record their arguments and edit a fake mount table instead of mounting. */
export class FakeSshfs {
  readonly env: SshfsEnv;

  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'calls'), { recursive: true });
    writeFileSync(join(dir, 'mountinfo'), '22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n');
    writeFileSync(join(dir, 'bin', 'sshfs'), SSHFS_SCRIPT(dir));
    writeFileSync(join(dir, 'bin', 'fusermount3'), FUSERMOUNT_SCRIPT(dir));
    chmodSync(join(dir, 'bin', 'sshfs'), 0o755);
    chmodSync(join(dir, 'bin', 'fusermount3'), 0o755);
    this.env = {
      WTD_SSHFS: join(dir, 'bin', 'sshfs'),
      WTD_FUSERMOUNT: join(dir, 'bin', 'fusermount3'),
      WTD_MOUNTINFO: join(dir, 'mountinfo'),
    };
  }

  /** Every completed run of either program, oldest first. */
  calls(program?: SshfsCall['program']): SshfsCall[] {
    const calls: (SshfsCall & { readonly at: string })[] = [];
    for (const name of readdirSync(join(this.dir, 'calls'))) {
      const match = /^(sshfs|fusermount3)\.(\d+-\d+)$/.exec(name);
      if (match?.[1] !== 'sshfs' && match?.[1] !== 'fusermount3') continue;
      if (program !== undefined && match[1] !== program) continue;
      const args = readFileSync(join(this.dir, 'calls', name), 'utf8')
        .split('\0')
        .slice(0, -1);
      calls.push({ program: match[1], args, at: match[2] ?? '' });
    }
    return calls.toSorted((a, b) => a.at.localeCompare(b.at)).map(({ program: p, args }) => ({ program: p, args }));
  }

  /** Mount points the fake mount table lists, unescaped. */
  mounted(): string[] {
    return readFileSync(this.env.WTD_MOUNTINFO, 'utf8')
      .split('\n')
      .map((line) => line.split(' '))
      .filter((fields) => fields[fields.indexOf('-') + 1] === 'fuse.sshfs')
      .map((fields) => (fields[4] ?? '').replaceAll(/\\([0-7]{3})/g, (_, o: string) => String.fromCodePoint(Number.parseInt(o, 8))));
  }

  /** Lists `point` as mounted without running anything, as a mount left by a killed hub. */
  addMount(point: string, source = 'box:/srv/app'): void {
    writeFileSync(this.env.WTD_MOUNTINFO, readFileSync(this.env.WTD_MOUNTINFO, 'utf8') + mountinfoLine(point, source));
  }

  /** Later mounts exit 1 after printing `line` (and blank lines). */
  failWith(line: string): void {
    writeFileSync(join(this.dir, 'mode'), `fail:${line}`);
  }

  /** Later mounts exit 0 without listing the mount point. */
  exitUnlisted(): void {
    writeFileSync(join(this.dir, 'mode'), 'unlisted');
  }

  /** Later mounts succeed. */
  succeed(): void {
    rmSync(join(this.dir, 'mode'), { force: true });
  }

  /** Later mounts wait, after recording their call, until `release`. */
  hold(): void {
    writeFileSync(join(this.dir, 'hold'), '');
  }

  release(): void {
    rmSync(join(this.dir, 'hold'), { force: true });
  }

  get held(): boolean {
    return existsSync(join(this.dir, 'hold'));
  }
}
