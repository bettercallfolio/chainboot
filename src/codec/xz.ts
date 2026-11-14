// The .xz decoder for Node: the portable decoder (xz-core.ts) with Node's SHA-256 and buffers.
import { createHash } from "node:crypto";
import { xzDecodeBytes, xzUncompressedSize } from "./xz-core.ts";

export { xzUncompressedSize };

/** Decodes a whole .xz file and verifies its integrity check. */
export function xzDecode(input: Uint8Array): Buffer {
  const out = xzDecodeBytes(input, (data) => createHash("sha256").update(data).digest());
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}
