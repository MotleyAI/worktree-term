import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git, makeRepo } from '../../../test/support/daemon-host.js';
import { normalizeOrigin, readOrigin } from './origin.js';

describe('normalizeOrigin', () => {
  it('gives equivalent GitHub URLs one origin', () => {
    for (const url of ['git@github.com:Acme/App.git', 'ssh://git@GitHub.com/Acme/App', 'https://github.com/Acme/App.git/']) {
      expect(normalizeOrigin(url), url).toBe('github.com/Acme/App');
    }
  });

  it.each([
    ['ssh://git@host:22/x', 'host/x'],
    ['ssh://git@host:2222/x', 'host:2222/x'],
    ['https://host:443/x', 'host/x'],
    ['https://host:80/x', 'host:80/x'],
    ['http://host:80/x', 'host/x'],
    ['http://host:443/x', 'host:443/x'],
    ['git://host:9418/x', 'host/x'],
    ['git://host:9419/x', 'host:9419/x'],
    ['git+ssh://git@host:22/x', 'host/x'],
    ['ssh+git://git@host:22/x', 'host/x'],
    ['git+ssh://host:2222/x', 'host:2222/x'],
    ['ssh+git://host/x', 'host/x'],
  ])('keeps the port of %s only when it is not the scheme default', (url, origin) => {
    expect(normalizeOrigin(url)).toBe(origin);
  });

  it('keeps the case of the path', () => {
    const upper = normalizeOrigin('https://example.com/Org/Repo');
    const lower = normalizeOrigin('https://example.com/org/repo');
    expect(upper).toBe('example.com/Org/Repo');
    expect(lower).toBe('example.com/org/repo');
    expect(upper).not.toBe(lower);
  });

  it.each([
    ['a user and password', 'https://user:secret@github.com/acme/app', 'github.com/acme/app'],
    ['a user over http', 'http://me@host/x', 'host/x'],
    ['a user in the scp-like form', 'Me@Host.example:x', 'host.example/x'],
  ])('drops %s', (_name, url, origin) => {
    expect(normalizeOrigin(url)).toBe(origin);
  });

  it.each([
    ['with a port', 'ssh://git@[FE80::1]:2222/srv/app.git', '[fe80::1]:2222/srv/app'],
    ['with the default port', 'ssh://[::1]:22/x', '[::1]/x'],
    ['without a port', 'https://[2001:DB8::1]/x', '[2001:db8::1]/x'],
    ['in the scp-like form', 'git@[2001:DB8::1]:org/app.git', '[2001:db8::1]/org/app'],
  ])('keeps an IPv6 host bracketed and lowercased, %s', (_name, url, origin) => {
    expect(normalizeOrigin(url)).toBe(origin);
  });

  it.each([
    ['the scp-like form', 'git@host:acme/app.git', 'host/acme/app'],
    ['an absolute scp-like path', 'git@host:/srv/app.git', 'host/srv/app'],
    ['a home-relative scp-like path', 'git@host:~/app.git', 'host/app'],
    ['a home-relative URL path', 'ssh://git@host/~/app.git', 'host/app'],
    ['a doubled leading slash', 'ssh://host//srv/app', 'host/srv/app'],
    ['a scp-like path looking like a port', 'host:2222/x', 'host/2222/x'],
    ['a trailing slash', 'https://host/x/', 'host/x'],
    ['a trailing .git then slash', 'https://host/x.git/', 'host/x'],
    ['only one trailing .git', 'https://host/x.git.git', 'host/x.git'],
    ['a .git inside the path', 'https://host/x.git/y', 'host/x.git/y'],
  ])('normalizes %s', (_name, url, origin) => {
    expect(normalizeOrigin(url)).toBe(origin);
  });

  it.each([
    ['an absolute local path', '/srv/app.git'],
    ['a relative local path', '../app'],
    ['a scp-like form whose host part holds a slash', './a:b'],
    ['a scp-like form whose host part is a path', 'srv/app:x'],
    ['a file URL', 'file:///srv/app'],
    ['a file URL with a host', 'file://localhost/srv/app'],
    ['another scheme', 'ftp://host/app'],
    ['rsync', 'rsync://host/app'],
    ['a query', 'https://host/app?x=1'],
    ['a fragment', 'https://host/app#readme'],
    ['a space', 'https://host/my app'],
    ['a leading space', ' https://host/app'],
    ['a tab', 'https://host/a\tb'],
    ['a newline', 'https://host/app\n'],
    ['a NUL', 'https://host/a\u0000b'],
    ['a control character', 'https://host/a\u001fb'],
    ['a DEL', 'https://host/a\u007fb'],
    ['an empty host', 'ssh:///x'],
    ['an empty host with a port', 'https://:443/x'],
    ['an empty scp-like host', 'git@:x'],
    ['a missing path', 'https://host'],
    ['an empty path', 'https://host/'],
    ['an empty scp-like path', 'git@host:'],
    ['a non-numeric port', 'ssh://host:abc/x'],
    ['an empty string', ''],
  ])('gives null for %s', (_name, url) => {
    expect(normalizeOrigin(url)).toBeNull();
  });

  it('gives null when the result would exceed 4096 characters', () => {
    expect(normalizeOrigin(`https://host/${'a'.repeat(4091)}.git/`)).toBe(`host/${'a'.repeat(4091)}`);
    expect(normalizeOrigin(`https://host/${'a'.repeat(4092)}.git/`)).toBeNull();
  });
});

describe('readOrigin', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'wtd-origin-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A repository whose `.git/config` holds `config`; returns its path. */
  const repoWithConfig = (name: string, config: string): string => {
    const path = join(root, name);
    mkdirSync(join(path, '.git'), { recursive: true });
    writeFileSync(join(path, '.git', 'config'), config);
    return path;
  };

  /** A bare repository whose `config` holds `config`; returns its path. */
  const bareWithConfig = (name: string, config: string): string => {
    const path = join(root, name);
    mkdirSync(join(path, 'objects'), { recursive: true });
    mkdirSync(join(path, 'refs'));
    writeFileSync(join(path, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(path, 'config'), config);
    return path;
  };

  it('reads the origin of a repository set up by git', async () => {
    const repo = makeRepo(join(root, 'repo'));
    git(repo, 'remote', 'add', 'origin', 'git@github.com:Acme/App.git');
    expect(await readOrigin(repo)).toBe('github.com/Acme/App');
  });

  it('reads the origin of a bare repository set up by git', async () => {
    const bare = join(root, 'bare.git');
    git(root, 'init', '-q', '--bare', bare);
    git(bare, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    expect(await readOrigin(bare)).toBe('github.com/acme/app');
  });

  it('reads a hand-written bare config', async () => {
    const bare = bareWithConfig('b.git', '[core]\n\tbare = true\n[remote "origin"]\n\turl = ssh://git@host:2222/srv/b.git\n');
    expect(await readOrigin(bare)).toBe('host:2222/srv/b');
  });

  it('takes the first url of [remote "origin"]', async () => {
    const repo = repoWithConfig('r', '[remote "origin"]\n\turl = https://a.example/x\n\turl = https://b.example/x\n');
    expect(await readOrigin(repo)).toBe('a.example/x');
  });

  it('takes the first url across repeated [remote "origin"] sections', async () => {
    const repo = repoWithConfig(
      'r',
      '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[core]\n\tbare = false\n[remote "origin"]\n\turl = https://a.example/x\n',
    );
    expect(await readOrigin(repo)).toBe('a.example/x');
  });

  it('ignores other remotes, pushurl and url keys outside the origin section', async () => {
    const repo = repoWithConfig(
      'r',
      [
        '[remote "upstream"]',
        '\turl = https://up.example/x',
        '[remote "Origin"]',
        '\turl = https://wrong-case.example/x',
        '[remote "origin"]',
        '\tpushurl = https://push.example/x',
        '\turl = https://right.example/x',
        '',
      ].join('\n'),
    );
    expect(await readOrigin(repo)).toBe('right.example/x');
  });

  it('reads the section name and key case-insensitively, with any spacing', async () => {
    const repo = repoWithConfig('r', '[Remote "origin"]\n  URL=https://case.example/x\n');
    expect(await readOrigin(repo)).toBe('case.example/x');
  });

  it.each([
    ['a quoted value', '\turl = "https://quoted.example/x"\n', 'quoted.example/x'],
    ['a comment after the value', '\turl = https://commented.example/x ; mirror\n', 'commented.example/x'],
    ['comment lines before the key', '\t# the main remote\n\t; really\n\turl = https://after.example/x\n', 'after.example/x'],
    ['a value continued on the next line', '\turl = https://cont.example/org/\\\napp.git\n', 'cont.example/org/app'],
    ['an escaped backslash ending a line', '\turl = https://esc.example/x\\\\\n\tpushurl = y\n', 'esc.example/x\\'],
  ])('reads %s', async (_name, body, origin) => {
    const repo = repoWithConfig('r', `[remote "origin"]\n${body}`);
    expect(await readOrigin(repo)).toBe(origin);
  });

  it('reads a url on the line of its section header', async () => {
    const repo = repoWithConfig('r', '[core]\n\tbare = false\n[remote "origin"] url = https://inline.example/x\n');
    expect(await readOrigin(repo)).toBe('inline.example/x');
  });

  it('ignores included files', async () => {
    writeFileSync(join(root, 'extra.config'), '[remote "origin"]\n\turl = https://included.example/x\n');
    const repo = repoWithConfig(
      'r',
      `[include]\n\tpath = ${join(root, 'extra.config')}\n[includeIf "gitdir:${root}/"]\n\tpath = ${join(root, 'extra.config')}\n`,
    );
    expect(await readOrigin(repo)).toBeNull();
  });

  it('ignores insteadOf rewrites', async () => {
    const repo = repoWithConfig(
      'r',
      '[url "https://github.com/"]\n\tinsteadOf = https://mirror.example/\n[remote "origin"]\n\turl = https://mirror.example/acme/app\n',
    );
    expect(await readOrigin(repo)).toBe('mirror.example/acme/app');
  });

  it('reads .git/config of a repository, not a config file in its worktree', async () => {
    const repo = repoWithConfig('r', '[core]\n\tbare = false\n');
    writeFileSync(join(repo, 'config'), '[remote "origin"]\n\turl = https://worktree-file.example/x\n');
    expect(await readOrigin(repo)).toBeNull();
  });

  it.each([
    ['no origin remote', '[remote "upstream"]\n\turl = https://up.example/x\n'],
    ['an origin without a url', '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'],
    ['an empty url', '[remote "origin"]\n\turl =\n'],
    ['a local path', '[remote "origin"]\n\turl = /srv/app.git\n'],
    ['a relative path', '[remote "origin"]\n\turl = ../app\n'],
    ['a file URL', '[remote "origin"]\n\turl = file:///srv/app\n'],
    ['an unsupported scheme', '[remote "origin"]\n\turl = ftp://host/app\n'],
    ['a query', '[remote "origin"]\n\turl = https://host/app?x=1\n'],
    ['an empty config', ''],
  ])('gives null for %s', async (_name, config) => {
    expect(await readOrigin(repoWithConfig('r', config))).toBeNull();
  });

  it('gives null when the config file is missing', async () => {
    const path = join(root, 'r');
    mkdirSync(join(path, '.git'), { recursive: true });
    expect(await readOrigin(path)).toBeNull();
  });

  it('gives null for a missing directory', async () => {
    expect(await readOrigin(join(root, 'missing'))).toBeNull();
  });
});
