## ADDED Requirements

### Requirement: Tailscale SSH check login
While a remote link has received no frame from its daemon, the hub SHALL read its SSH process's standard error as it is written, line by line. A line containing `To authenticate, visit:` followed by a URL that, with control characters removed, starts with `https://login.tailscale.com/` and has at most 1024 characters SHALL make the host `needs-login` with that URL as `login`, within 1 s of being written, with `reason`, `daemonVersion` and `instance` null, keeping the link open and counting no failure. A line naming any other URL SHALL change nothing, as SHALL a repeat of the URL the host already shows. Standard error read after the link's first daemon frame, after the link was closed or ended, or after the link was replaced SHALL change no host. A `needs-login` host SHALL become `connected` or `outdated` when its link exchanges `hello`, and `reconnecting` or `down` when its link is lost, as for any other link, counting the consecutive failures from before it was `needs-login`; `login` SHALL be null in every status other than `needs-login`. A request for a `needs-login` host SHALL fail with `host-unavailable`. When a link of one session to a host exchanges `hello`, every other session's link to the same host that is `needs-login` SHALL be closed and at once replaced by a new link, that session's host becoming `connecting` with `login` null; links of other sessions in any other status SHALL be left alone.

#### Scenario: Login link surfaced
- **WHEN** the SSH process for host `box` writes `# Tailscale SSH requires an additional check.` and `# To authenticate, visit: https://login.tailscale.com/a/abc123` to standard error and then waits
- **THEN** within 1 s the session receives `box` as `needs-login` with `login` `https://login.tailscale.com/a/abc123` and a null `reason`, and no second SSH process is started

#### Scenario: Approval connects without retry
- **WHEN** a `needs-login` host's waiting SSH process proceeds and the daemon greets
- **THEN** the session receives the host as `connected` with a null `login`, over the same SSH process

#### Scenario: Other URL ignored
- **WHEN** the SSH process for a host writes `To authenticate, visit: https://login.tailscale.com.evil/a/x` to standard error and waits
- **THEN** the host stays `connecting`

#### Scenario: Expired check falls back to retrying
- **WHEN** a `needs-login` host's SSH process exits writing `Tailscale SSH check timed out` to standard error, and the next SSH process writes a new login URL
- **THEN** the session receives the host as `reconnecting` with that reason and a null `login`, then as `needs-login` with the new URL

#### Scenario: Banner from a closed link ignored
- **WHEN** a session's link is closed and its SSH process writes a login banner while it is being terminated
- **THEN** no host entry changes

#### Scenario: Request to a needs-login host
- **WHEN** a browser sends `host{host: 1, m: watchRepo}` while host 1 is `needs-login`
- **THEN** the session receives an `error` with code `host-unavailable`

#### Scenario: One approval connects every session
- **WHEN** sessions A and B each hold a `needs-login` link to `box` over their own SSH processes, a session C is `connected` to `box`, and only A's SSH process proceeds and greets
- **THEN** B's original SSH process is terminated, B receives `box` as `connecting` and then `connected` over a new SSH process, and C receives no change to `box`
