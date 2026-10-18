## MODIFIED Requirements

### Requirement: Authentication
On load, the page SHALL read its URL fragment as a remote fragment, else as a home fragment, else as no fragment, and then remove it from the address without a navigation. A fragment's code SHALL be used once to open the session; the token the hub returns SHALL be kept in session storage and used for every later connection. A remote fragment's `host`, `home` and `hubs` SHALL be kept in session storage, replacing any kept before, and used after reloads; a page with them kept is a remote page, any other page a home page. Without a code or stored token, or when the hub refuses the credential, the page SHALL show only a message telling the user to open worktree-term with `wtd ui`, and SHALL forget a refused stored token.

#### Scenario: Code exchanged for the token
- **WHEN** the page is opened with a valid one-time code
- **THEN** it connects, the fragment is removed from the address, and a reload connects again without a code

#### Scenario: No credential
- **WHEN** the page is opened without a code in a fresh browser session
- **THEN** it shows the `wtd ui` message and opens no session

#### Scenario: Remote fragment kept across a reload
- **WHEN** the page is opened with `#code=<code>&host=box&home=7417&hubs=box,gpu` and then reloaded
- **THEN** after the reload its title is `worktree-term — box` and its Hubs menu lists `box` and `gpu`

#### Scenario: Malformed fragment ignored
- **WHEN** the page is opened with `#code=x&hub=a b` and a stored token
- **THEN** the fragment is removed, the page connects with the stored token, and no hub is opened

## ADDED Requirements

### Requirement: Hubs menu
The page header SHALL show a "Hubs" menu when there is at least one remote host: on a home page the session's remote hosts, on a remote page its kept `hubs`. The menu SHALL list "This machine" followed by each such host name in order, marking the page's own hub — "This machine" on a home page, its `host` on a remote page. Picking the marked entry SHALL do nothing. On a home page, picking a host SHALL close the menu and open that host's hub as the hub opening requirement states. On a remote page, picking "This machine" SHALL navigate the tab to `http://127.0.0.1:<home>/`, and picking another host SHALL navigate it to `http://127.0.0.1:<home>/#hub=<name>`. On a home page, a fragment with `hub` SHALL open that host's hub once the session greets; a name no remote host carries SHALL show the status `no host named <name>`.

#### Scenario: Menu lists hubs
- **WHEN** a home page's session lists remote hosts `box` and `gpu`
- **THEN** the Hubs menu lists "This machine", `box` and `gpu`, with "This machine" marked

#### Scenario: No menu without remote hosts
- **WHEN** a home page's session lists only the local host
- **THEN** the header shows no Hubs menu

#### Scenario: Back home from a remote page
- **WHEN** a remote page with `home` 7417, opened from a home page in the same tab, picks "This machine"
- **THEN** the tab shows the home page on `http://127.0.0.1:7417/`, connected with its stored token

#### Scenario: Switching between remotes goes through home
- **WHEN** a remote page for `box` with `home` 7417 picks `gpu`
- **THEN** the tab navigates to `http://127.0.0.1:7417/#hub=gpu`, which opens `gpu`'s hub

#### Scenario: Opening from the address
- **WHEN** a home page is opened with `#code=<code>&hub=box`
- **THEN** it connects and opens `box`'s hub without any click

#### Scenario: Unknown hub in the address
- **WHEN** a home page is opened with `#hub=nope` and no remote host is named `nope`
- **THEN** the status line shows `no host named nope` and the page stays

### Requirement: Hub opening status
Opening a host's hub from a home page SHALL send `openHub` for that host and show a status line beside the Hubs menu for the latest opening only, ignoring any reply to an earlier one: `Opening <host>…` while waiting; on `hubLogin`, `<host> needs Tailscale login` with an "Open login link" button opening the `login` URL in a new tab without giving that tab access to the page; on `hub-outdated`, `<host>: <message>` with a "Reinstall on <host>" button, which sends `installHub`, shows `Installing on <host>…`, and on `done` opens the hub again; on any other error, `<host>: <message>` with a × that clears the line; on `hubOpened`, navigation of the tab to its `url`. A remote page SHALL never send `openHub`.

#### Scenario: Opening navigates the tab
- **WHEN** the user picks `box` in the Hubs menu and the hub replies `hubOpened` with `http://127.0.0.1:7418/#code=<code>&host=box&home=7417&hubs=box`
- **THEN** the same tab shows `box`'s hub on `http://127.0.0.1:7418/`, titled `worktree-term — box`, listing `box`'s own repos

#### Scenario: Login link while opening
- **WHEN** the hub replies `hubLogin` with `https://login.tailscale.com/a/abc123` and, after approval, `hubOpened`
- **THEN** the status line shows `box needs Tailscale login` with an "Open login link" button linking to that URL in a new tab with no opener, and then the tab navigates to the remote hub

#### Scenario: Outdated remote reinstalled from the status line
- **WHEN** the hub replies `error` with code `hub-outdated` for `box` and the user clicks "Reinstall on box"
- **THEN** the page sends `installHub` for `box`, shows `Installing on box…`, and after `done` sends `openHub` for `box` again

#### Scenario: Failure shown with its reason
- **WHEN** the hub replies `error` with code `hub-failed` and message `ssh: Could not resolve hostname box`
- **THEN** the status line shows `box: ssh: Could not resolve hostname box` with a ×, and the tab stays on the home page

#### Scenario: Later pick wins
- **WHEN** the user picks `box`, then `gpu` before `box`'s reply arrives, and `box`'s `hubOpened` arrives first
- **THEN** the tab does not navigate to `box` and the status line shows `Opening gpu…`

### Requirement: Page title
A home page's title SHALL be `worktree-term`; a remote page's title SHALL be `worktree-term — <host>`.

#### Scenario: Remote page titled by host
- **WHEN** a page is opened with a remote fragment whose `host` is `devbox`
- **THEN** its title is `worktree-term — devbox`
