## MODIFIED Requirements

### Requirement: Protocol version and frozen handshake messages
The protocol SHALL define two integer versions: `DAEMON_PROTOCOL_VERSION`, equal to 6, for the daemon link (client ↔ daemon), and `BROWSER_PROTOCOL_VERSION`, equal to 10, for the browser link (browser ↔ hub). A change to the messages of one link SHALL raise that link's version; a change to the shared constants SHALL raise both. The `hello` message SHALL be `{t: "hello", protocol, version, instance}` where `protocol` is an integer ≥ 1 carrying the sender's version of the link it is sent on, `version` is a string of 1–64 characters, and `instance` is a string of 1–64 characters from `[A-Za-z0-9_-]`. The `shutdown` message SHALL be `{t: "shutdown"}`. The shapes of `hello` and `shutdown` and the stream frame header SHALL be identical in every version of either link, so that peers of different versions can always exchange them. The print-code line and the page fragments, exchanged between `wtd` installations of any versions, SHALL likewise never change shape.

#### Scenario: Hello round-trips
- **WHEN** a `hello` with `protocol` 1, `version` "0.1.0" and `instance` "a1B2_c3" is encoded and decoded
- **THEN** the decoded value equals the original

#### Scenario: Hello from another protocol version is still decodable
- **WHEN** a `hello` carrying `protocol` 7 is decoded
- **THEN** decoding succeeds and yields `protocol` 7

#### Scenario: Invalid instance rejected
- **WHEN** a `hello` whose `instance` contains a space is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Browser-link change leaves the daemon version
- **WHEN** a message is added to the browser-to-hub catalogue and only `BROWSER_PROTOCOL_VERSION` is raised
- **THEN** the wire golden check passes, and it fails if a daemon-link schema changed as well

#### Scenario: Shared constant needs both versions
- **WHEN** `MAX_FRAME` changes and only one of the two versions is raised
- **THEN** the wire golden check fails

#### Scenario: Frozen print-code and fragment shapes
- **WHEN** the print-code line or a page fragment schema accepts or rejects a sample differently from the frozen golden
- **THEN** the frozen golden check fails

### Requirement: Browser-link message catalogue
Browser-to-hub messages SHALL be exactly: `hello`; `host{host, m}` where `m` is any client-to-daemon message except `hello` and `shutdown`; `addRepo{req, host, repo}`; `removeRepo{req, host, repo}`; `discoverRepos{req, host}`; `restartDaemon{req, host}`; `reinstallDaemon{req, host}`; `openHub{req, host}`; `installHub{req, host}`; `addPreset{req, preset}`; `removePreset{req, name}` where `name` is a preset name; `movePreset{req, name, to}` where `name` is a preset name and `to` an integer from 0 to 63.
Hub-to-browser messages SHALL be exactly: `hello`; `token{token}`; `host{host, m}` where `m` is any daemon-to-client message except `hello`; `hosts{hosts}`; `presets{presets}`; `done{req}`; `error{req, host, code, message}` with `req` and `host` each nullable and `code` a hub error code; `reposDiscovered{req, host, repos}`; `hubLogin{req, login}` with `login` a login URL as in a host entry; `hubOpened{req, url}`.
A host entry SHALL be `{idx, name, remote, status, reason, daemonVersion, instance, login, repos}` with `status` one of `connecting`, `connected`, `reconnecting`, `down`, `outdated`, `needs-login`, and `reason`, `daemonVersion`, `instance` and `login` nullable; `instance` SHALL be the `hello.instance` of the daemon the host is `connected` to or found `outdated`, and null in every other status. `login` SHALL be a string of at most 1024 characters starting with `https://login.tailscale.com/`, non-null exactly when `status` is `needs-login`; decoding SHALL reject any other `login`. A preset SHALL be `{name, command}` with `command` nullable. A `hubOpened` `url` SHALL be `http://127.0.0.1:<port>/#` with `<port>` from 1024 to 65535 without leading zeros, followed by a remote page fragment; decoding SHALL reject any other `url`.

#### Scenario: Envelope cannot carry a handshake message
- **WHEN** a browser `host` envelope whose `m` is a `hello` or a `shutdown` is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Every browser-link message round-trips
- **WHEN** a valid instance of each browser-link message is encoded and decoded
- **THEN** each decoded value equals its original

#### Scenario: Host entry without instance rejected
- **WHEN** a `hosts` message whose entry lacks `instance` is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Host entry without reason rejected
- **WHEN** a `hosts` message whose entry lacks `reason` is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Outdated host carries its instance
- **WHEN** a `hosts` entry with `status` "outdated" and a non-null `instance` is decoded
- **THEN** decoding succeeds and yields that instance

#### Scenario: Token message only from the hub
- **WHEN** a `token` message is decoded as a browser-to-hub message
- **THEN** decoding fails with a protocol error

#### Scenario: Preset edits only from the browser
- **WHEN** a `removePreset` message is decoded as a hub-to-browser message, or an `addPreset` as a client-to-daemon message
- **THEN** decoding fails with a protocol error

#### Scenario: Invalid preset edit rejected
- **WHEN** an `addPreset` whose preset has a blank name or an empty command, or a `removePreset` with an empty name, is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Preset position bounded
- **WHEN** a `movePreset` with `to` −1, 64 or 0.5 is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Needs-login host carries its login URL
- **WHEN** a `hosts` entry with `status` "needs-login" and `login` "https://login.tailscale.com/a/abc123" is decoded
- **THEN** decoding succeeds and yields that URL

#### Scenario: Login URL outside Tailscale rejected
- **WHEN** a `hosts` entry with `status` "needs-login" whose `login` is "http://login.tailscale.com/a/x", "https://login.tailscale.com.evil/a/x", "javascript:alert(1)" or 1025 characters long is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Login present exactly while needs-login
- **WHEN** a `hosts` entry with `status` "needs-login" and a null `login`, or with `status` "connecting" and a non-null `login`, is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Hub opening messages only in their direction
- **WHEN** an `openHub` is decoded as a hub-to-browser message, or a `hubOpened` as a browser-to-hub message
- **THEN** decoding fails with a protocol error

#### Scenario: Opened URL must be a loopback page
- **WHEN** a `hubOpened` whose `url` is "http://evil.example:7418/#code=…", "https://127.0.0.1:7418/#…", "http://127.0.0.1:80/#…", "http://127.0.0.1:7418/x#…" or "javascript:alert(1)" is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Hub login URL outside Tailscale rejected
- **WHEN** a `hubLogin` whose `login` is "https://login.tailscale.com.evil/a/x" is decoded
- **THEN** decoding fails with a protocol error

### Requirement: Value limits
Decoding and encoding SHALL enforce: paths are absolute, at most 4096 characters, without NUL; discovery roots are absolute paths, `~`, or `~/` followed by at least one character, at most 4096 characters, without NUL; terminal ids are integers from 1 to 2^32−1; offsets are integers from 0 to 2^53−1; `cols` and `rows` are integers from 1 to 1000; host indices are integers from 0 to 65535; `depth` is 1–6; `head` is null or 40 or 64 lowercase hex digits; host names and tab ids are 1–64 characters; preset names are 1–64 characters with at least one non-whitespace character; `branch` and `command` are null or at most 4096 characters, and a preset's `command` is null or 1–4096 characters; `signal` is null or at most 32 characters; `version` is 1–64 characters; tokens and one-time codes are exactly 64 lowercase hex digits; error messages and host reasons are at most 1024 characters; daemon error codes are one of `bad-message`, `unknown-host`, `unknown-term`, `unknown-worktree`, `not-watched`, `busy`, `spawn-failed`, `version-mismatch`, `not-a-repo`, `host-unavailable`, `internal`; hub error codes, used only by the hub-to-browser `error`, are the daemon error codes and `hub-outdated` and `hub-failed`. Collections SHALL hold at most: 1024 worktrees, terminals, checked paths or layout entries per message; 32 discovery roots (at least 1); 4096 discovered repos; 4096 visible terminal ids; 64 hosts; 256 repos per host; 64 presets.

#### Scenario: Relative path rejected
- **WHEN** a `watchRepo` whose `repo` is "repo/a" is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Home-relative discovery roots accepted
- **WHEN** a `discoverRepos` whose `roots` are "~" and "~/GitHub" is decoded
- **THEN** decoding succeeds and yields both roots unchanged

#### Scenario: Other relative discovery roots rejected
- **WHEN** a `discoverRepos` whose `roots` hold "GitHub", "~user/x" or "~/" is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Home-relative repo rejected
- **WHEN** a `watchRepo` or `addRepo` whose `repo` is "~/x" is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Overlong host reason rejected
- **WHEN** a `hosts` entry whose `reason` has 1025 characters is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Collection over limit rejected
- **WHEN** a `worktreesChanged` with 1025 worktrees is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Not-a-repo error code accepted
- **WHEN** an `error` whose `code` is "not-a-repo" is decoded
- **THEN** decoding succeeds

#### Scenario: Host-unavailable error code accepted
- **WHEN** a hub `error` whose `code` is "host-unavailable" is decoded
- **THEN** decoding succeeds

#### Scenario: Hub error codes only from the hub
- **WHEN** a hub `error` whose `code` is "hub-outdated" or "hub-failed" is decoded, and a daemon `error` with either code is decoded
- **THEN** the hub error decodes, and the daemon error fails with a protocol error

#### Scenario: Malformed token rejected
- **WHEN** a `token` message whose `token` has 63 hex digits, or contains an uppercase digit, is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Unknown error code rejected
- **WHEN** an `error` whose `code` is "oops" is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Blank preset name rejected
- **WHEN** a `presets` message with a preset named "   " is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Empty preset command rejected
- **WHEN** a `presets` message with a preset whose `command` is "" is decoded
- **THEN** decoding fails with a protocol error

## ADDED Requirements

### Requirement: Print-code line
The protocol SHALL define the print-code line as the JSON object `{port, code}` — `port` an integer from 1024 to 65535, `code` a one-time code — followed by one newline, decoded strictly like a control message from text that SHALL hold nothing else but optional trailing whitespace.

#### Scenario: Print-code line round-trips
- **WHEN** a print-code line with `port` 7417 and a valid code is encoded and decoded
- **THEN** the decoded value equals the original and the encoded text ends with exactly one newline

#### Scenario: Extra field or text rejected
- **WHEN** a print-code line carrying an additional field `token`, or preceded by a line `motd`, is decoded
- **THEN** decoding fails with a protocol error

#### Scenario: Port out of range rejected
- **WHEN** a print-code line with `port` 80 or 7417.5 is decoded
- **THEN** decoding fails with a protocol error

### Requirement: Page fragments
The protocol SHALL define two page fragments, each the text after `#` in a page URL, written as `application/x-www-form-urlencoded` parameters with no parameter repeated and no other parameter. A home fragment SHALL hold `code` (a one-time code), `hub` (a host name of 1–64 characters from `[A-Za-z0-9._-]`), or both. A remote fragment SHALL hold all of `code`, `host` (a host name), `home` (an integer port from 1024 to 65535 without leading zeros) and `hubs` (1 to 63 distinct host names joined by `,`, one of which is `host`). Decoding SHALL reject any other text.

#### Scenario: Home fragment forms
- **WHEN** `code=<64 hex>`, `hub=box` and `code=<64 hex>&hub=box` are decoded as home fragments
- **THEN** each decodes to the given values

#### Scenario: Remote fragment decoded
- **WHEN** `code=<64 hex>&host=box&home=7417&hubs=box,gpu` is decoded as a remote fragment
- **THEN** it yields that code, host `box`, home 7417 and hubs `box` and `gpu` in that order

#### Scenario: Malformed fragments rejected
- **WHEN** a home fragment `hub=a b`, `hub=box&hub=gpu` or `code=x`, or a remote fragment lacking `home`, with `home=0080`, with `hubs=gpu` while `host=box`, or with an extra parameter `token`, is decoded
- **THEN** decoding fails with a protocol error
