## ADDED Requirements

### Requirement: Remote directory mounts
The mount directory SHALL be `run/mounts` under the state directory, owner-only. A mount of the absolute path `<path>` on the SSH alias `<alias>` for the host `<name>` SHALL have the mount point `run/mounts/<id>`, `<id>` being the first 32 lowercase hex digits of the SHA-256 of `<name>`, `<alias>` and `<path>` joined by NUL characters, created owner-only. Mounting SHALL run the mount program — `$WTD_SSHFS` when set and non-empty, else `sshfs` — with the arguments `-o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3`, `-o ssh_command=<command>`, `<alias>:<path>` and the mount point, `<command>` being the SSH program followed by the options of the SSH command line, the control path included, joined by spaces. An alias the SSH command line refuses, or an SSH program or control path holding whitespace, a `,` or a `\`, SHALL be refused with an error naming it, running nothing. A mount SHALL be ready only when the mount program has exited with status 0 and the process mount table lists the mount point; otherwise mounting SHALL fail with the program's last non-empty error line, or with `not mounted` when it gave none, after removing the mount point. A mount program still running 60 seconds after it started SHALL be stopped and any mount it made unmounted, and mounting SHALL fail with `timed out`. Unmounting SHALL run the unmount program — `$WTD_FUSERMOUNT` when set and non-empty, else `fusermount3` — with `-u -z` and the mount point, then remove the mount point. A missing mount or unmount program SHALL fail naming it. Listing the mounts SHALL return the mount points under the mount directory that the process mount table lists.

#### Scenario: Mount point per host and path
- **WHEN** mount points are built for host `box` alias `box` path `/srv/a`, for host `box` alias `box` path `/srv/b`, and for host `gpu` alias `box` path `/srv/a`
- **THEN** they are three distinct directories under `run/mounts`, each named by 32 hex digits

#### Scenario: Mount command line
- **WHEN** the mount command for alias `box` and path `/srv/a b` is built
- **THEN** its arguments are the reconnect and keep-alive options, `ssh_command` holding the SSH program with `BatchMode=yes` and the control path, `box:/srv/a b` as one argument, and the mount point

#### Scenario: Ready only when listed
- **WHEN** the mount program exits with status 0 but the mount table does not list the mount point
- **THEN** mounting fails with `not mounted` and the mount point is removed

#### Scenario: Mount failure reported
- **WHEN** the mount program exits with status 1 after printing `read: Connection reset by peer`
- **THEN** mounting fails with that line

#### Scenario: Missing programs named
- **WHEN** `$WTD_SSHFS` names a program that does not exist, or `$WTD_FUSERMOUNT` does when unmounting
- **THEN** the operation fails naming that program

#### Scenario: Option-like alias refused
- **WHEN** a mount on alias `-oProxyCommand=touch /tmp/x` is requested
- **THEN** it fails naming the alias and no program runs

## MODIFIED Requirements

### Requirement: SSH command line
The SSH command for an alias SHALL be the SSH program followed by `-o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPersist=10m -o ControlPath=<control path> -o ServerAliveInterval=15 --`, the alias, and the remote command as one argument. The SSH program SHALL be `$WTD_SSH` when set and non-empty, else `ssh`. An alias that is empty, longer than 255 characters, starts with `-`, or contains whitespace or a control character SHALL be refused with an error naming it. Every SSH process the hub or an installer starts SHALL use this command line, except the SSH process a mount program starts, which SHALL use the same program and options as the remote directory mount requirement states.

#### Scenario: Options precede the alias
- **WHEN** the SSH command for alias `box` and remote command `"$HOME/.local/bin/wtd" connect` is built
- **THEN** its arguments are the options above, `--`, `box` and `"$HOME/.local/bin/wtd" connect`, in that order

#### Scenario: Option-like alias refused
- **WHEN** the SSH command for alias `-oProxyCommand=touch /tmp/x` is built
- **THEN** building fails with an error naming the alias and nothing is run
