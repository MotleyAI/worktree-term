## MODIFIED Requirements

### Requirement: Host status display
For each host that is `down` or `outdated` the page SHALL show a banner naming the host, its status and its `reason` when present, with the action the outdated host requirement states. For each host that is `needs-login` the page SHALL show a banner naming the host and saying it needs Tailscale login, with an "Open login link" button that opens the host's `login` URL in a new tab without giving that tab access to the page, and no other action; its repo tabs SHALL show the status `needs login`. A `connecting` or `reconnecting` host SHALL show its status only on its repo tabs.

#### Scenario: Down host banner
- **WHEN** a remote host `box` is `down` with reason `ssh: Could not resolve hostname box`
- **THEN** the page shows a banner naming `box`, `down` and that reason, with an "Install" action

#### Scenario: Recovered host clears the banner
- **WHEN** a `down` host becomes `connected`
- **THEN** its banner disappears

#### Scenario: Needs-login banner with link
- **WHEN** a remote host `box` with repo `/srv/app` is `needs-login` with `login` `https://login.tailscale.com/a/abc123`
- **THEN** the page shows a banner naming `box` with an "Open login link" button linking to that URL in a new tab with no opener, and the tab labelled `box:app` shows `needs login`

#### Scenario: Approved login clears the banner
- **WHEN** a `needs-login` host becomes `connected`
- **THEN** its banner disappears and its repo tabs show no status
