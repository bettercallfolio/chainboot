// Base58 (Bitcoin alphabet), the text form Solana uses for addresses and signatures.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET.charCodeAt(i)] = i;

export function b58encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // repeated division of the big-endian number by 58
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}

export function b58decode(text: string): Buffer {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let carry = code < 128 ? INDEX[code]! : -1;
    if (carry < 0) throw new Error(`invalid base58 character "${text[i]}"`);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + bytes.length - 1 - i] = bytes[i]!;
  return out;
}

/** Decode a base58 string that must be exactly `len` bytes (32 for addresses, 64 for signatures). */
export function b58decodeFixed(text: string, len: number, what = "value"): Buffer {
  // (checked before decoding: the work grows with the square of the length, and the text may come from an endpoint)
  if (typeof text !== "string" || text.length > Math.ceil(len * 1.38) + 1) throw new Error(`${what} must be ${len} bytes`);
  const b = b58decode(text);
  if (b.length !== len) throw new Error(`${what} must be ${len} bytes, got ${b.length}`);
  return b;
}
