## MODIFIED Requirements

### Requirement: Editing presets
The preset picker and a worktree's preset choices SHALL offer "+ Add preset", opening a form for a name and a command; submitting SHALL trim both, treat an empty command as the login shell (`command` null) and send `addPreset`, closing the form on `done` and showing the refusal in the form otherwise. A blank name, a name of more than 64 characters, a name already taken, or a command of more than 4096 characters SHALL be refused in the form without sending anything; Escape SHALL close the form without sending anything and without closing the picker. While more than one preset exists, each SHALL offer a remove control sending `removePreset` for it; a refusal SHALL be shown on the page. While more than one preset exists, each SHALL be draggable to another position, the gap it would be dropped into marked while dragging, and dropping it elsewhere SHALL send `movePreset` with its new position; Alt+Up and Alt+Down SHALL move the highlighted preset one position, which stays highlighted and focused; until the new order arrives, or the move fails, further keyboard moves SHALL be ignored, so each moves the preset that is highlighted. Every list SHALL show the presets the hub last sent, and the picker SHALL stay open while presets are edited.

#### Scenario: Preset added from the choices
- **WHEN** the user adds a preset `echo` with a command in a worktree's preset choices while another page is open
- **THEN** `addPreset` is sent once, both pages list `echo` last, `config.json` lists it, and choosing it runs its command

#### Scenario: Preset added in the picker
- **WHEN** the user adds a preset in the new-tab picker
- **THEN** the picker stays open, lists the new preset, and choosing it opens a terminal running it

#### Scenario: Preset removed
- **WHEN** the user removes one of two presets
- **THEN** `removePreset` is sent, every page lists only the other preset, `config.json` lists only it, and no remove control is offered any more

#### Scenario: Taken name refused in the form
- **WHEN** the user submits a name that a preset already has, or a blank name
- **THEN** the form says why, nothing is sent, and Escape then closes the form

#### Scenario: Preset dragged to the front
- **WHEN** the user drags the second of two presets onto the upper half of the first in a worktree's choices while another page is open
- **THEN** `movePreset` is sent with position 0, and both pages and `config.json` list the dragged preset first

#### Scenario: Quick keyboard moves
- **WHEN** the first of three presets is highlighted and the user presses Alt+Down twice in quick succession
- **THEN** only that preset moves, by one or two positions

#### Scenario: Preset moved with the keyboard
- **WHEN** the second preset is highlighted in the new-tab picker and the user presses Alt+Up and then Enter
- **THEN** it is listed first, still highlighted and focused, and a terminal running it opens
