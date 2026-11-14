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
| `0x10` | pointer | `version (1 byte = 2)`, `sequence (u64 LE)`, then the record | 3870 |

Transactions of kinds 0x00 to 0x03 reference no accounts besides the payer and the Noop
program. A pointer transaction additionally references its tag address as a read-only account.

**On chains without the Noop program** the same bytes travel in an instruction for the Memo
program (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`), as base64 text, in a legacy-format
transaction that also asks for the compute units a long memo needs. The Memo program accepts
no accounts that have not signed, so a tag address (section 3) is named by a second
instruction in the same transaction: a System transfer of 0 lamports from the payer to the
tag address. A reader takes the data from whichever of the two programs carries it.

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

Before anything is fetched or set aside, a reader checks what the head claims: the size must
be the one the reference states (or, for an object read by signature alone, at most 1 GiB),
`leafSize` at least 64, and the branches may not list more leaves than the size needs. A
SHA-256 that comes with a reference must be 64 hex digits before it is used for anything.

## 3. Pointers and tag addresses

A **tag address** is 32 bytes:

```
SHA-256( "chainboot:v1" || 0x00 || part1 || 0x00 || part2 || ... )
```

Parts are UTF-8 strings or raw bytes. It is used as an account address but has no private key.

A **pointer** is a transaction of kind `0x10` that references a tag address:

```
0xCB || 0x10 || version (1 byte = 2) || sequence (u64 LE) || record
```

The **sequence** says which of an owner's pointers under a tag is the newest. It is the
writer's clock in milliseconds, and always larger than the sequence of the newest pointer
the writer could find (so a computer whose clock is behind still writes a newer one). It is
part of the transaction, so it is covered by the owner's signature: which record is the
newest is said by the owner, not by an RPC endpoint. Version 1 pointers (`0xCB 0x10 0x01`
followed by the record, written by the first releases) have no sequence; readers treat it as 0.

The current record of a tag is found like this:

1. Ask several endpoints for the newest transactions that reference the tag address
   (`getSignaturesForAddress`) and merge their lists. Where a transaction lies in the chain
   (its slot) is taken as true when two endpoints say the same; a transaction that only one
   endpoint lists, or about whose slot they disagree, is unconfirmed and is looked at first.
2. Fetch the candidates from the newest on. A candidate counts only if its transaction
   succeeded, verifies, is paid by the expected owner, **references the tag address itself**,
   and carries a pointer. Transactions by anyone else are ignored.
3. The first confirmed candidate that counts ends the search. Among it and the unconfirmed
   ones before it, the record with the highest sequence is the current one.
4. If a full page holds no record of the owner, continue with the next page (`before`), up
   to 12,000 transactions. A reader that still has found none reports an error; it never
   concludes "there is no record" from an address buried under other people's transactions.

"There is no record" is also not concluded from one endpoint's empty answer when a second
endpoint can be asked.

| Tag parts | Owner | Record |
|---|---|---|
| `"catalog"`, publisher public key | publisher | JSON stored-reference of the catalog |
| `"state"`, vault public key, machine name | vault | encrypted JSON `{ ref, seq, time }` |
| `"machines"`, vault public key | vault | encrypted JSON `{ ref }` of the machine list |

**Pointers in accounts.** The owner of a pointer may keep it in an account as well, so that
one `getAccountInfo` reads it. The account belongs to the SPL Record program
(`recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5`) and sits at an address anyone can compute:

```
seed    = "cb" || hex(first 15 bytes of the tag address)                    (32 characters)
address = SHA-256( owner public key || seed || Record program id )          (as created by createAccountWithSeed)
```

Its data is the Record program's header (1 byte version, 32 bytes authority) followed by:

```
0xCB || 0x11 || version (1) || flags || sequence (u64 LE) || length (u16 LE) || payload || Ed25519 signature (64)

signature = owner's signature of "chainboot:account-record:v1" || tag address || flags || sequence || payload
```

`payload` is the record that the pointer transaction carries (at most 400 bytes; longer
pointers are not kept in accounts) and `sequence` is the same number as in that transaction.
Flag bit 0 means "the newest pointer is in the transactions only". A reader accepts a record
only with a valid signature of the expected owner and prefers the highest sequence among the
endpoints it asked. When those endpoints disagree on whether the account exists, the reader
also looks at the pointer transactions and takes whichever record has the higher sequence;
without a valid record it reads the transactions. Writers update the account in the same
transaction that carries the pointer, and before writing they ask several endpoints whether
an account exists, so that one endpoint that is behind cannot make them leave it stale.

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

An entry may also carry `"publisher": "<address>"`: the account that stored the image, when
that is not the catalog's owner. This is how a publisher **endorses** an image somebody else
uploaded: their catalog, which they sign, names the same manifest object. Readers check the
manifest's transactions against that account; the content is bound by the entry's hashes.

**Lists.** A list is not stored anywhere. It is written `list:<k>:<address>,<address>,…`
(2 to 16 distinct addresses, `k` more than half of them) and read by fetching each member's
catalog: an entry (name, tag, architecture) belongs to the list when at least `k` members
have an entry there with the same `digest`. Each agreeing entry names a stored copy of the
image's manifest; a reader takes the copy that most of them name (the manifest is checked
against the digest in any case). A reader needs at least `k` readable catalogs; with fewer
there is no list. Entries of a catalog that are not well formed are left out, they do not
make the catalog unreadable.

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
SHA-256( "chainboot-tree-v1\n" + for every node in order: identity + "\n" [ + "config " + configuration + "\n" ] )
```

where `identity` is the node as compact JSON (no spaces) without the `pack` and `offset`
elements: for a file `[path,"f",mode,uid,gid,mtime,size,sha256]` (plus the attribute object
with sorted keys, if any); other nodes unchanged. The last line is there only for an image
whose manifest has a `config` with a start command or environment: `configuration` is then
the compact JSON `{"cmd":[…],"env":{…}}` with the keys of `env` sorted and absent parts left
out. What an image runs when it starts is part of what the image is: the same files with
another command are another image, and nobody can change the command of an image that a
list's publishers agreed on. (An image without a configuration has the digest of its files alone.)

A reader must validate a manifest before using it: safe sorted paths, parents that are
directories of the image, hard links that point at files, pack references within bounds, a
well-formed configuration, and the digest, computed again from the tree. The digest written
in the manifest proves nothing by itself.

## 6. Saved machines

**Keys.** The wallet signs the UTF-8 text of the login message (see
[Saving to chain](04-saving.md)). With that 64-byte signature as input key material:

```
vault seed      = HKDF-SHA256(ikm = signature, salt = "chainboot-vault-v1", info = "<cluster>:signer", 32 bytes)
encryption key  = HKDF-SHA256(ikm = signature, salt = "chainboot-vault-v1", info = "<cluster>:encryption", 32 bytes)
```

`<cluster>` is `devnet`, `testnet` or `mainnet-beta`, or, for another chain, its genesis hash
(base58). The vault seed is an Ed25519 seed; its public key is the vault account.

**Encryption.** AES-256-GCM, with a key per object. A sealed blob is:

```
0x02 || key id (16 bytes) || nonce (12 bytes) || ciphertext || tag (16 bytes)

key id || nonce = HKDF-SHA256(ikm = encryption key, salt = SHA-256(plaintext), info = "chainboot-object-id-v2:" + purpose, 28 bytes)
object key      = HKDF-SHA256(ikm = encryption key, salt = key id, info = "chainboot-object-v2:" + purpose, 32 bytes)
```

Key id and nonce come from the content, not from chance: sealing the same content for the
same purpose gives the same bytes, so an upload that was interrupted continues instead of
being paid for again. Different content gets a different key id and therefore a different
key, so no key is ever used with two different texts. (A reader does not care how they were
chosen; blobs with random ones, as earlier versions wrote, open the same way.)

The purpose string is also the additional authenticated data: `pack`, `snapshot`,
`snapshot-pointer`, `index`, `index-pointer`, `image-manifest`, `private-catalog`,
`private-catalog-pointer`. Data is compressed first, then sealed. The owner opens every
object with the encryption key; anyone who is given an object key can open that one object.

Blobs written by the first releases start with `0x01` (`0x01 || nonce || ciphertext || tag`)
and use the encryption key directly. Readers accept both; such objects cannot be shared.

**Snapshot.** A sealed, compressed JSON document:

```json
{ "chainboot": 1, "kind": "snapshot", "machine": "…", "seq": 7, "time": 1794604669,
  "image": { "publisher": "…", "name": "…", "tag": "…", "arch": "…", "digest": "…", "manifest": { stored reference } },
  "packs": [ { pack fields as in a manifest, "enc": 1 } ],
  "tree": [ nodes as in a manifest ],
  "deleted": [ "path", … ],
  "fingerprint": "<hex>",
  "history": [ { "seq": 6, "time": …, "ref": { stored reference }, "files": 140, "bytes": 1820000, "note": "…" }, … ],
  "note": "what the user wrote about this save" }
```

`tree` holds every object of the machine that differs from the image; `deleted` the paths of
the image that no longer exist. A pack with `"enc": 1` is sealed with purpose `pack` and
carries `"key"`, its object key in base64 (a pack without `key` was written by a first
release and opens with the encryption key); a pack with `"enc": 0` is a public pack of the
image, referenced unchanged. `history` lists the 200 saves before this one, newest first;
older saves are reached through the oldest of them, whose own `history` goes further back.

To restore: start from the image, remove the deleted paths, then write the tree. A snapshot
may have been written by somebody else (a shared machine) and is applied with full rights,
so a reader checks all of it first: every path is relative, without `.` or `..`, and there
once; numbers are numbers; every file lies inside its pack; a hard link names a path of the
tree. While applying, a parent that is not a real directory stops the restore, a hard link is
made to a regular file only, a directory's attributes are set only while it still is a
directory, and each file's content is compared with its hash before it is written.

## 7. Private images

A private image uses the same manifest and pack formats, with these differences:

- A pack entry may carry `"enc": 1` and `"key"` (the pack's object key, base64). Such a pack
  is stored as a sealed blob with purpose `pack` (compress first, then seal); `sha256` and
  `size` describe the sealed blob. Packs without `enc` are public packs of other images,
  referenced unchanged. A public manifest never names a pack with `enc`.
- The manifest object is the compressed manifest sealed with purpose `image-manifest`.
- The owner's private catalog is a sealed document with purpose `private-catalog`
  (`{ "chainboot": 1, "kind": "private-catalog", "updated": …, "images": { … } }`, entries as
  in a public catalog plus `"private": true`), found through an encrypted pointer under the
  tag `"private-images"`, vault public key.
- Every transaction is paid and signed by the vault account.
- A catalog entry for an image that another wallet shared also has `"publisher"` (the
  account that stored it) and `"key"` (the object key of its manifest).

## 8. Sharing

**Share address.** Each login has an X25519 key pair:

```
share secret  = HKDF-SHA256(ikm = encryption key, salt = "chainboot-share-v1", info = "<cluster>:x25519", 32 bytes)
share address = "share_" + base58(public key || first 4 bytes of SHA-256("chainboot-share-address" || public key))
```

**Message.** What is sent to a share address is sealed like this:

```
0x01 || one-time public key (32) || sender's share public key (32) || nonce (12) || ciphertext || tag (16)

key = HKDF-SHA256(ikm = X25519(one-time, receiver) || X25519(sender, receiver),
                  salt = one-time public || sender public || receiver public,
                  info = "chainboot-share-v1:" + purpose, 32 bytes)        AES-256-GCM, AAD = purpose
```

The one-time key keeps outsiders from linking messages; the sender's static key in the mix
proves to the receiver which share address a message came from.

**Inbox.** A share is one pointer transaction under the tag `"inbox"`, receiver's share
public key, paid by the sender's vault. Its payload is a message with purpose `share` holding
JSON: `{ "r": base64(compressed record), "c": codec, "n": raw size }`, or, for a record too
long for one transaction, `{ "o": { object reference }, "by": sender's vault account, "c", "n" }`
where the object is a message with purpose `share-record`. Anybody may write under an inbox
tag; a reader keeps what opens with its own key, and of two messages with the same sender
and the same record (anybody can post a message again) only the first.

**Record.**

```json
{ "chainboot": 1, "kind": "share", "what": "image" | "machine", "name": "…", "time": 1794604669,
  "wallet": "<sender's wallet address, as stated by the sender>", "note": "…",
  "image":   { "tag": "…", "arch": "…", "description": "…",
               "ref": { catalog entry, "private": true, "publisher": "<account>", "key": "<manifest object key>" } },
  "machine": { "image": { as in a snapshot; "manifest" has "key" for a private image }, "created": …, "boot": true,
               "seq": 7, "saved": …, "snapshot": { stored reference }, "signer": "<account>", "key": "<snapshot object key>",
               "keys": { "<pack sha256>": "<object key>" } } }
```

A receiver uses only the fields above, each checked for its form (names, hashes, keys,
addresses, numbers); anything else in a record is dropped, and text is shown without control
characters. Accepting an image adds its entry to the receiver's private catalog (not into an
image the receiver already has under that name, unless they name it themselves). Accepting a
machine checks the snapshot the way a restore does (section 6), stores it again under the
receiver's vault (with the pack keys filled in, sequence number 1 and an empty history) and
adds the machine to the receiver's list. The packs stay where the sender stored them.

## 9. Versioning

Readers must reject head, inline and pointer transactions whose version byte they do not
know, and manifests whose `chainboot` field they do not know. New kinds and fields will get
new numbers; older data stays readable (pointers of version 1 next to those of version 2,
sealed blobs that start with `0x01` next to those with `0x02`).

Next: [Networks and costs](08-networks-and-costs.md).
