/** Malformed wire data, or a value that cannot be put on the wire. */
export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
}
