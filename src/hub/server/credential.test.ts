import { describe, expect, it } from 'vitest';
import { parseCredential } from './credential.js';

const HEX = '0123456789abcdef'.repeat(4);
const OTHER = 'f'.repeat(64);

describe('parseCredential', () => {
  it.each([
    ['a token', `wtd, wtd.token.${HEX}`, { kind: 'token', secret: HEX }],
    ['a code', `wtd, wtd.code.${HEX}`, { kind: 'code', secret: HEX }],
    ['the credential first', `wtd.token.${HEX}, wtd`, { kind: 'token', secret: HEX }],
    ['no space after the comma', `wtd,wtd.token.${HEX}`, { kind: 'token', secret: HEX }],
    ['spaces and tabs around the comma', `wtd \t,\t wtd.code.${HEX}`, { kind: 'code', secret: HEX }],
  ])('accepts %s', (_name, header, credential) => {
    expect(parseCredential(header)).toEqual(credential);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['only wtd', 'wtd'],
    ['no wtd', `wtd.token.${HEX}`],
    ['wtd twice', `wtd, wtd, wtd.token.${HEX}`],
    ['the same credential twice', `wtd, wtd.token.${HEX}, wtd.token.${HEX}`],
    ['two tokens', `wtd, wtd.token.${HEX}, wtd.token.${OTHER}`],
    ['a token and a code', `wtd, wtd.token.${HEX}, wtd.code.${OTHER}`],
    ['an unknown credential kind', `wtd, wtd.secret.${HEX}`],
    ['a prefix before wtd', `xwtd, wtd.token.${HEX}`],
    ['a prefix before the credential', `wtd, xwtd.token.${HEX}`],
    ['a suffix after the credential', `wtd, wtd.token.${HEX}x`],
    ['a suffix after wtd', `wtdx, wtd.token.${HEX}`],
    ['an uppercase protocol', `WTD, wtd.token.${HEX}`],
    ['an uppercase kind', `wtd, wtd.TOKEN.${HEX}`],
    ['uppercase hex', `wtd, wtd.token.${HEX.toUpperCase()}`],
    ['63 hex digits', `wtd, wtd.token.${HEX.slice(1)}`],
    ['65 hex digits', `wtd, wtd.token.${HEX}0`],
    ['an empty secret', 'wtd, wtd.token.'],
    ['whitespace inside the credential', `wtd, wtd.token. ${HEX}`],
    ['a semicolon separator', `wtd; wtd.token.${HEX}`],
    ['an extra unknown protocol', `wtd, chat, wtd.token.${HEX}`],
  ])('refuses %s', (_name, header) => {
    expect(parseCredential(header)).toBeNull();
  });
});
