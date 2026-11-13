# The on-chain format

This page describes every byte chainboot writes, so that anyone can write an independent
reader or writer in any language. Format version: **1**.

Conventions: numbers are little-endian unless said otherwise; "signature" means the 64-byte
first signature of a transaction, which is also its ID; hex is lower-case.

## 1. Data transactions

Every piece of chainboot data is the instruction data of one call to the **SPL Noop**
program, `noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV`, in a transaction paid by the
publisher. chainboot writes **v1 transactions** (SIMD-0385, up to 4096 bytes) and can read
legacy transactions too. Only transactions that succeeded (`meta.err == null`) count.

In a v1 transaction chainboot sets a compute unit limit of 20,000 and a loaded-accounts data
limit of 262,144 bytes in the transaction config (a Noop call uses about 100 units).

The instruction data always starts with the magic byte `0xCB` and a kind byte:

| Kind | Name | Layout after the two bytes | Max payload (v1) |
|---|---|---|---|
| `0x00` | leaf | raw bytes of the object | 3912 |
| `0x01` | branch | signatures, 64 bytes each | 61 signatures |
| `0x02` | head | see below | 59 signatures |
| `0x03` | inline | `version (1 byte = 1)` then the whole object | 3911 |
| `0x10` | pointer | `version (1 byte = 1)` then the record | 3878 |

Transactions of kinds 0x00 to 0x03 reference no accounts besides the payer and the Noop
program. A pointer transaction additionally references its tag address as a read-only account.

## 2. Objects

An **object** is a byte string of any length, identified by the signature of its head (or
inline) transaction.

Small objects (up to 3911 bytes) are a single **inline** transaction.

Larger objects are a tree:

- The object is cut into **leaves** of `leafSize` bytes (3912 for v1 without priority fee);
  the last leaf may be shorter.
- The leaf signatures, in order, are grouped into **branches** of up to 61. If there are
  more than 59 branches, their signatures are grouped again, and so on.
- The **head** lists the signatures of the top level.

Head layout (after `0xCB 0x02`):

| Offset | Size | Field |
|---|---|---|
| 2 | 1 | format version = 1 |
| 3 | 1 | depth: 1 means the head lists leaves, 2 means it lists branches that list leaves, ... |
| 4 | 2 | leaf size in bytes |
| 6 | 8 | object size in bytes |
| 14 | 32 | SHA-256 of the object |
| 46 | 64 | signature of the hint object, or 64 zero bytes |
| 110 | 64 × n | signatures of the top level |

All leaves are at the same depth. The number of leaves is `ceil(size / leafSize)`.

A writer must wait until the transactions of one level are final before it writes the next
level, because a signature is only known once a transaction has landed.

### Slot hints

The **hint** is itself an object (inline or a tree without a hint of its own). Its content
is a list of the slots that contain the object's leaf and branch transactions:

```
varint count, then `count` varints: the first slot, then the difference to the previous slot
```

A varint is LEB128: 7 bits per byte, low bits first, high bit set on all bytes but the last.

Readers may fetch those blocks with `getBlock` and pick out the object's transactions by
signature. The hint is an optimisation only. A reader must still verify everything as
described below and must fetch any missing transaction by signature.

### Reading and verifying

1. Fetch the head by signature. Check that the first signature of the returned transaction
   equals the requested one and is a valid Ed25519 signature of the message by the fee payer.
   If you trust specific publishers, check that the fee payer is one of them.
2. Fetch branches the same way, level by level, with the same checks.
3. Fetch the leaves. Check payload sizes (`leafSize`, except the last).
4. Concatenate the leaves and compare the SHA-256 with the head. Reject on mismatch.

chainboot skips the signature check of leaves at first and relies on step 4; if the hash
does not match, it verifies the leaf signatures to find the wrong ones and fetches them again.

## 3. Pointers and tag addresses

A **tag address** is 32 bytes:

```
SHA-256( "chainboot:v1" || 0x00 || part1 || 0x00 || part2 || ... )
```

Parts are UTF-8 strings or raw bytes. It is used as an account address but has no private key.

A **pointer** is a transaction of kind `0x10` that references a tag address. The current
record of a tag is the payload of the newest successful pointer transaction (as listed by
`getSignaturesForAddress`) whose fee payer is the expected owner. Pointer transactions by
anyone else are ignored.

| Tag parts | Owner | Record |
|---|---|---|
| `"catalog"`, publisher public key | publisher | JSON stored-reference of the catalog |
| `"state"`, vault public key, machine name | vault | encrypted JSON `{ ref, seq, time }` |
| `"machines"`, vault public key | vault | encrypted JSON `{ ref }` of the machine list |

A **stored reference** is JSON: `{ "sig", "sha256", "size", "codec", "rawSize" }`, where
`sig`, `sha256` and `size` describe the object as stored, `codec` is `"xz"`, `"zstd"` or
`"raw"`, and `rawSize` is the size after decompression.

## 4. Catalog

The catalog is a JSON document (compressed as its reference says):

```json
{
  "chainboot": 1, "kind": "catalog", "publisher": "<base58 address>", "updated": 1794604669,
  "images": {
    "solinux": {
      "description": "…",
      "tags": { "latest": { "amd64": { "sig": "…", "sha256": "…", "size": 201740, "codec": "xz", "rawSize": 887238,
                                        "digest": "…", "version": "26.04.1", "created": 1790000000,
                                        "downloadSize": 21816820, "unpackedSize": 90200000 } } }
    }
  }
}
```

Each architecture entry is the stored reference of an image manifest plus information for display.

## 5. Image manifest

A JSON document. The tree is written one node per line, in path order.

```json
{ "chainboot": 1, "kind": "image", "name": "…", "version": "…", "arch": "amd64", "os": "linux",
  "created": 1790000000, "description": "…", "source": { "url": "…", "sha256": "…" },
  "config": { "cmd": ["/bin/sh", "-c", "…"] },
  "digest": "<hex>", "rawSize": 90200000, "fileCount": 6569,
  "packs": [ { "sig": "…", "sha256": "…", "size": 21615080, "codec": "xz", "rawSha256": "…", "rawSize": 89595002 } ],
  "tree": [ … ] }
```

Tree nodes are arrays. The first element is the path (relative, `/`-separated, no `.` or
`..`, valid UTF-8), the second the type:

| Type | Array |
|---|---|
| file | `[path, "f", mode, uid, gid, mtime, size, sha256, pack, offset]` and optionally an object of extended attributes (name to base64) |
| directory | `[path, "d", mode, uid, gid, mtime]` and optionally extended attributes |
| symbolic link | `[path, "l", mode, uid, gid, mtime, target]` |
| hard link | `[path, "h", targetPath]` (the target is a file node of the same tree) |
| device | `[path, "c" or "b", mode, uid, gid, mtime, major, minor]` |
| FIFO | `[path, "p", mode, uid, gid, mtime]` |

`mode` is the permission bits (0 to 0o7777), `mtime` whole seconds. A file's content is
`size` bytes at `offset` in the decompressed pack number `pack`. Empty files have `pack` -1.
Nodes are sorted by the bytes of their UTF-8 path, and every parent directory appears as a
node before its children.

**Packs** are the contents of files, concatenated. `codec` says how a pack is compressed:
`xz` (LZMA2, optionally preceded by the x86 or ARM64 BCJ filter), `zstd`, or `raw`.

**Digest.** The image's identity, independent of packing:

```
SHA-256( "chainboot-tree-v1\n" + for every node in order: identity + "\n" )
```

where `identity` is the node as compact JSON (no spaces) without the `pack` and `offset`
elements: for a file `[path,"f",mode,uid,gid,mtime,size,sha256]` (plus the attribute object
with sorted keys, if any); other nodes unchanged.

A reader must validate a manifest before writing anything to disk: safe sorted paths,
parents that are directories of the image, hard links that point at files, pack references
within bounds, and the digest.

## 6. Saved machines

**Keys.** The wallet signs the UTF-8 text of the login message (see
[Saving to chain](04-saving.md)). With that 64-byte signature as input key material:

```
vault seed      = HKDF-SHA256(ikm = signature, salt = "chainboot-vault-v1", info = "<cluster>:signer", 32 bytes)
encryption key  = HKDF-SHA256(ikm = signature, salt = "chainboot-vault-v1", info = "<cluster>:encryption", 32 bytes)
```

`<cluster>` is `devnet`, `testnet` or `mainnet-beta`. The vault seed is an Ed25519 seed; its
public key is the vault account.

**Encryption.** AES-256-GCM. A sealed blob is:

```
0x01 || nonce (12 random bytes) || ciphertext || tag (16 bytes)
```

with a purpose string as additional authenticated data: `pack`, `snapshot`,
`snapshot-pointer`, `index`, `index-pointer`. Data is compressed first, then sealed.

**Snapshot.** A sealed, compressed JSON document:

```json
{ "chainboot": 1, "kind": "snapshot", "machine": "…", "seq": 7, "time": 1794604669,
  "image": { "publisher": "…", "name": "…", "tag": "…", "arch": "…", "digest": "…", "manifest": { stored reference } },
  "packs": [ { pack fields as in a manifest, "enc": 1 } ],
  "tree": [ nodes as in a manifest ],
  "deleted": [ "path", … ],
  "fingerprint": "<hex>",
  "history": [ { "seq": 6, "time": …, "ref": { stored reference }, "files": 140, "bytes": 1820000 }, … ] }
```

`tree` holds every object of the machine that differs from the image; `deleted` the paths of
the image that no longer exist. A pack with `"enc": 1` is sealed with purpose `pack`; a pack
with `"enc": 0` is a public pack of the image, referenced unchanged. To restore: start from
the image, remove the deleted paths, then write the tree.

## 7. Private images

A private image uses the same manifest and pack formats, with these differences:

- A pack entry may carry `"enc": 1`. Such a pack is stored as a sealed blob with purpose
  `pack` (compress first, then seal); `sha256` and `size` describe the sealed blob. Packs
  without `enc` are public packs of other images, referenced unchanged.
- The manifest object is the compressed manifest sealed with purpose `image-manifest`.
- The owner's private catalog is a sealed document with purpose `private-catalog`
  (`{ "chainboot": 1, "kind": "private-catalog", "updated": …, "images": { … } }`, entries as
  in a public catalog plus `"private": true`), found through an encrypted pointer under the
  tag `"private-images"`, vault public key.
- Every transaction is paid and signed by the vault account.

## 8. Versioning

Readers must reject head, inline and pointer transactions whose version byte they do not
know, and manifests whose `chainboot` field they do not know. New kinds and fields will get
new numbers; version 1 data stays readable.

Next: [Networks and costs](08-networks-and-costs.md).
