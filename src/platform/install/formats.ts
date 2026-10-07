/** Window class of the Chrome app window `wtd ui` opens. */
const WM_CLASS = 'chrome-127.0.0.1__-Default';

/** Throws naming `path` unless it is an absolute Node path without NUL or line breaks. */
export const checkNodePath = (path: string): void => {
  if (!path.startsWith('/') || /[\0\n\r]/.test(path)) {
    throw new Error(`invalid Node path '${path}': it must be absolute, without NUL or line breaks`);
  }
};

const QUOTED_QUOTE = String.raw`'\''`;

/** POSIX single-quoted form of `value`. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", QUOTED_QUOTE)}'`;

/** The `~/.local/bin/wtd` shim: runs `node` with the current release's `wtd.mjs` and every argument. */
export const shimScript = (node: string): string => {
  checkNodePath(node);
  return `#!/bin/sh\nexec ${shellQuote(node)} "$HOME/.local/share/worktree-term/current/wtd.mjs" "$@"\n`;
};

/** A Desktop Entry string value. */
const desktopString = (value: string): string =>
  value
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('\n', String.raw`\n`)
    .replaceAll('\t', String.raw`\t`)
    .replaceAll('\r', String.raw`\r`);

const ESCAPED_MATCH = String.raw`\$&`;

/** One `Exec` argument, double-quoted as the Desktop Entry specification requires. */
const execArgument = (value: string): string => `"${value.replace(/["`$\\]/g, ESCAPED_MATCH)}"`.replaceAll('%', '%%');

/** The launcher: runs `shim ui` outside a terminal, matching the app window `wtd ui` opens. */
export const desktopEntry = ({ shim, icon }: { shim: string; icon: string }): string => {
  const exec = `${execArgument(shim)} ui`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=worktree-term',
    'Comment=Worktree-centric terminal manager',
    `Exec=${desktopString(exec)}`,
    `Icon=${desktopString(icon)}`,
    'Terminal=false',
    `StartupWMClass=${WM_CLASS}`,
    'Categories=Development;',
    '',
  ].join('\n');
};

/** One `ExecStart` argument, double-quoted with C escapes, `%%` and `$$`. */
const unitArgument = (value: string): string => {
  const escaped = value
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll('\n', String.raw`\n`)
    .replaceAll('\t', String.raw`\t`)
    .replaceAll('\r', String.raw`\r`)
    .replaceAll('%', '%%')
    .replaceAll('$', '$$$$');
  return `"${escaped}"`;
};

/** The daemon's systemd user unit: runs `shim daemon`, restarting it only on failure. */
export const systemdUnit = (shim: string): string =>
  [
    '[Unit]',
    'Description=worktree-term daemon',
    '',
    '[Service]',
    `ExecStart=${unitArgument(shim)} daemon`,
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
