## MODIFIED Requirements

### Requirement: Attention indicators
Each terminal tab, and each pane of a split, SHALL show one mark for its terminal, the first that applies of: needs input (`state` `input`); exited with failure (the terminal has exited, which only a failed exit leaves visible); done (`unseen` with `state` `idle`); new output (`unseen` with `state` `working`); none otherwise. A tab holding several panes SHALL show the first-ranked mark of its terminals. Each worktree row and each repo tab SHALL show the first-ranked mark among the terminals of that worktree or of that repo's worktrees, counting an exited terminal only while it is `unseen`, with the number of terminals per mark on hover. A worktree row whose worktree has at least one terminal, exited ones included, and shows no mark SHALL show a hollow ring in the mark's place, with `open: <N>` on hover, `<N>` being the number of its terminals; a worktree row without terminals SHALL show neither a mark nor a ring. Repo tabs, terminal tabs and pane headers SHALL show no ring. Marks and rings SHALL follow `activity`, `termExited` and terminal list changes without user action.

#### Scenario: Agent waiting in a hidden worktree
- **WHEN** a terminal in a non-selected worktree of a non-selected repo rings the bell
- **THEN** its worktree row and its repo tab show the needs-input mark

#### Scenario: Viewing clears new output
- **WHEN** a hidden terminal prints output and its worktree is then selected
- **THEN** its new-output mark disappears from the tab, the worktree row and the repo tab

#### Scenario: Failed exit
- **WHEN** a hidden terminal's process exits with code 1
- **THEN** its tab shows the failed-exit mark and its worktree row shows it until the terminal is viewed

#### Scenario: Killed terminal marked failed
- **WHEN** a terminal's shell is killed by a signal sent from outside the daemon
- **THEN** its tab shows the failed-exit mark

#### Scenario: Quiet terminals show a ring
- **WHEN** a worktree has two terminals, neither of them needing input, exited or `unseen`
- **THEN** its worktree row shows a hollow ring titled `open: 2` and no mark, and its repo tab shows neither

#### Scenario: Mark replaces the ring
- **WHEN** one terminal of a worktree whose row shows a ring prints output while hidden
- **THEN** the row shows the new-output mark and no ring, and shows the ring again once the terminal is viewed

#### Scenario: No terminals, no ring
- **WHEN** a worktree's last terminal closes
- **THEN** its worktree row shows neither a mark nor a ring

#### Scenario: Viewed failed exit keeps the ring
- **WHEN** a terminal whose process failed has been viewed and its tab is still open
- **THEN** its worktree row shows a hollow ring and no mark

## ADDED Requirements

### Requirement: Open in editor
The tab bar SHALL offer an "Open in editor" control at its right end, after the split controls, titled `Open in editor (right-click to change the command)`; when the tabs overflow the tab bar it SHALL stay fully visible and usable. It SHALL be disabled, its title then giving the reason, while no worktree is selected, the selected worktree is prunable or gone, the selected worktree's host is remote, the page is a remote page, no `editor` has been received, or a request it sent has not been answered. Choosing it SHALL send `openEditor{req, worktree}` with the selected worktree's path and show nothing on `done`. An `error` answer SHALL open a dialog with a Close control: for `editor-missing` it SHALL say "Could not find `<program>`. Install it, or right-click the editor button to set the command of the editor you prefer.", `<program>` being the first word of the editor command the page shows; for any other code it SHALL say "Could not open the editor: <message>" with the error's message, shown as text.

#### Scenario: Control at the right end
- **WHEN** a worktree with three tabs is selected
- **THEN** the "Open in editor" control is the last control of the tab bar, after split right and split down

#### Scenario: Control stays visible on overflow
- **WHEN** the tabs overflow the tab bar
- **THEN** the "Open in editor" control is fully visible and choosing it sends `openEditor`

#### Scenario: Opening the selected worktree
- **WHEN** a local worktree at `/r/feat x` is selected and the control is chosen
- **THEN** the page sends `openEditor` with `worktree` `/r/feat x`, and the control is disabled until the answer arrives

#### Scenario: Disabled without a worktree
- **WHEN** no worktree is selected
- **THEN** the control is disabled and its title says no worktree is selected

#### Scenario: Disabled for remote worktrees
- **WHEN** a worktree of a remote host is selected on a home page, or any worktree is selected on a remote page
- **THEN** the control is disabled and its title says only worktrees on this machine can be opened

#### Scenario: Disabled for prunable and gone worktrees
- **WHEN** a prunable worktree, or a gone worktree with live terminals, is selected
- **THEN** the control is disabled

#### Scenario: Missing editor
- **WHEN** the editor command is `kate` and the answer is `error` with code `editor-missing`
- **THEN** a dialog says "Could not find `kate`. Install it, or right-click the editor button to set the command of the editor you prefer."

#### Scenario: Other launch failure
- **WHEN** the answer is `error` with code `editor-failed` and message `<b>no</b>`
- **THEN** a dialog says "Could not open the editor: <b>no</b>" with the markup shown as text

### Requirement: Editing the editor command
Right-clicking the "Open in editor" control, enabled or disabled, SHALL open a form beside it, except on a remote page and before `editor` has been received. The form SHALL hold a text field with the editor command the page shows, focused and selected, the hint "{path} stands for the worktree path; without it, the path is added at the end.", and the controls Save, Reset to default and Cancel. Save, or Enter in the field, SHALL trim the text and refuse it in the form without sending anything when it is blank, longer than 4096 characters or not a valid editor command; it SHALL close the form without sending anything when the text equals the shown command; otherwise it SHALL send `setEditor{req, command}`. Reset to default SHALL send `setEditor{req, command: null}`. `done` SHALL close the form; an `error` SHALL be shown in the form. Cancel, Escape or a press outside the form SHALL close it without sending anything. The page SHALL show the editor command the hub last sent.

#### Scenario: Command saved
- **WHEN** the form is opened, `code {path}` is entered and saved
- **THEN** the page sends `setEditor` with `command` `code {path}`, closes the form on `done`, and shows `code {path}` once `editor` arrives

#### Scenario: Reset to default
- **WHEN** the command is `code {path}` and Reset to default is chosen
- **THEN** the page sends `setEditor` with `command` null and, once `editor` arrives, the form shows `kate`

#### Scenario: Invalid command refused in the form
- **WHEN** a blank text, a text of 4097 characters or `code "{path}` is saved
- **THEN** the form shows a refusal and nothing is sent

#### Scenario: Unchanged command not sent
- **WHEN** the form is saved with the command it opened with
- **THEN** the form closes and nothing is sent

#### Scenario: Escape closes without saving
- **WHEN** the command is edited and Escape is pressed
- **THEN** the form closes, nothing is sent and the command is unchanged

#### Scenario: Right-click on a disabled control
- **WHEN** no worktree is selected and the control is right-clicked on a home page
- **THEN** the form opens

#### Scenario: No form on a remote page
- **WHEN** the control is right-clicked on a remote page
- **THEN** no form opens

#### Scenario: Refusal shown in the form
- **WHEN** a saved command is answered with `error` code `internal`
- **THEN** the form stays open and shows the error's message
