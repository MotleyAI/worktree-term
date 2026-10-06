/** The credential an upgrade offers in `Sec-WebSocket-Protocol`. */
export interface Credential {
  kind: 'token' | 'code';
  secret: string;
}

export const SUBPROTOCOL = 'wtd';

const CREDENTIAL = /^wtd\.(token|code)\.([0-9a-f]{64})$/;
const OPTIONAL_WHITESPACE = /^[ \t]+|[ \t]+$/g;

/** Parses the offered subprotocols: exactly `wtd` and one credential, or null. */
export const parseCredential = (header: string | undefined): Credential | null => {
  if (header === undefined) return null;
  let protocol = false;
  let credential: Credential | null = null;
  for (const token of header.split(',').map((t) => t.replace(OPTIONAL_WHITESPACE, ''))) {
    if (token === SUBPROTOCOL && !protocol) {
      protocol = true;
      continue;
    }
    const match = CREDENTIAL.exec(token);
    if (match?.[2] === undefined || credential !== null) return null;
    credential = { kind: match[1] === 'token' ? 'token' : 'code', secret: match[2] };
  }
  return protocol ? credential : null;
};
