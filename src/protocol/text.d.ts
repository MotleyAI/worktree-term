// The WHATWG text codecs common to Node and browsers; protocol compiles without Node or DOM types.
declare class TextEncoder {
  encode(input?: string): Uint8Array<ArrayBuffer>;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}
