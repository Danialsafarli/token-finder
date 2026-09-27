/**
 * Solana address primitives: base58 decoding and the on-curve test.
 *
 * ## Why an on-curve test belongs in a data backbone
 *
 * Every account that can sign is an ed25519 public key, which is a point on
 * the curve. A program-derived address (PDA) is, by construction, *not* on
 * the curve - `find_program_address` searches for a bump seed until the hash
 * lands off it - so no private key can exist for it and only its program can
 * act for it. Pools, bonding curves, vault authorities and associated token
 * accounts are PDAs; people and bots are keypairs.
 *
 * That is a cryptographic fact about an address, not an interpretation of its
 * behaviour, which is why it is computed here and stored. It lets the
 * ingestion layer tell "a wallet received tokens" from "a pool's vault
 * received tokens" without guessing, and it is exactly the distinction later
 * wallet analysis needs.
 *
 * ## The test
 *
 * It mirrors curve25519-dalek's `CompressedEdwardsY::decompress`, which is what
 * Solana's `Pubkey::is_on_curve` calls: the 32 bytes are a little-endian `y`
 * with the top bit carrying the sign of `x`. The point exists iff
 * `x^2 = (y^2 - 1) / (d*y^2 + 1)` has a solution mod p. dalek reads `y`
 * modulo p (a non-canonical encoding is accepted) and does not reject `x = 0`
 * with the sign bit set, so neither does this.
 *
 * Source: Tier 1 - Solana `Pubkey::is_on_curve` / `bytes_are_curve_point`
 * delegate to curve25519-dalek decompression. The field arithmetic is the
 * standard ed25519 definition (RFC 8032 section 5.1).
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((char, i) => [char, i]));

/** Shape check only: base58 alphabet, 32-44 characters. */
export function isAddressShape(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

/**
 * Decodes base58 into bytes. Returns null for any character outside the
 * alphabet. Leading '1's are leading zero bytes, per the Bitcoin encoding
 * Solana uses.
 */
export function base58Decode(text: string): Uint8Array | null {
  let value = 0n;
  for (const char of text) {
    const digit = INDEX.get(char);
    if (digit === undefined) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/** Decodes an address to its 32 bytes, or null when it is not one. */
export function addressBytes(address: string): Uint8Array | null {
  if (!isAddressShape(address)) return null;
  const bytes = base58Decode(address);
  return bytes !== null && bytes.length === 32 ? bytes : null;
}

const P = 2n ** 255n - 19n;

function mod(value: bigint): bigint {
  const r = value % P;
  return r < 0n ? r + P : r;
}

function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

const inverse = (value: bigint): bigint => pow(value, P - 2n);

/** Edwards curve constant d = -121665 / 121666 (RFC 8032). */
const D = mod(-121665n * inverse(121666n));

/**
 * Whether an address is a point on the ed25519 curve - that is, whether it can
 * be a keypair's public key. Null when the input is not a 32-byte address.
 */
export function isOnCurve(address: string): boolean | null {
  const bytes = addressBytes(address);
  if (bytes === null) return null;

  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i] as number);
  // The top bit is x's sign, not part of y.
  y = mod(y & ((1n << 255n) - 1n));

  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // v is never zero: that would need y^2 = -1/d, and -1/d is not a square
  // because -1 is a square mod p and d is not.
  const ratio = (u * inverse(v)) % P;
  if (ratio === 0n) return true;
  // Euler's criterion: a nonzero value is a square iff raising it to (p-1)/2
  // gives 1.
  return pow(ratio, (P - 1n) / 2n) === 1n;
}
