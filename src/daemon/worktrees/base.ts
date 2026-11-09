const CREATED_FROM = 'branch: Created from ';
const PREFIXES = ['refs/heads/', 'refs/remotes/origin/', 'origin/'];
// eslint-disable-next-line no-control-regex -- control characters are among what a branch name must not contain
const FORBIDDEN = /[\u0000- \u007f~^:?*[\\]|\.\.|@\{|\/\/|^[-./]|[./]$|\/\.|\.lock(?:\/|$)/;

/** The start point recorded by the oldest entry of a `git reflog --format=%gs` listing, or null when that is not a creation. */
export const createdFrom = (reflog: string): string | null => {
  const lines = reflog.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const oldest = lines.at(-1);
  if (oldest?.startsWith(CREATED_FROM) !== true) return null;
  const ref = oldest.slice(CREATED_FROM.length);
  return ref === '' ? null : ref;
};

/** The branch `ref` names, without a `refs/heads/`, `refs/remotes/origin/` or `origin/` prefix; null when not a valid branch name. */
export const branchCandidate = (ref: string): string | null => {
  const prefix = PREFIXES.find((p) => ref.startsWith(p));
  const name = prefix === undefined ? ref : ref.slice(prefix.length);
  if (name === '' || name === 'HEAD' || name === '@' || FORBIDDEN.test(name)) return null;
  return name;
};
