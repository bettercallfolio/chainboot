# The SDK

Everything the `chainboot` command does is built from a small TypeScript library with no
dependencies. You can use the same building blocks for your own ideas: store files, publish
data that others can verify, keep encrypted state for your users.

```sh
npm install chainboot        # Node.js 22.15 or newer
```

```js
import { RpcPool, ChainStore, Keypair } from "chainboot";
```

All examples below are complete programs. They use devnet; get test SOL for your keypair at
https://faucet.solana.com.

## 1. Store a file, read it back

```js
import { RpcPool, ChainStore, Keypair, GENESIS } from "chainboot";
import fs from "node:fs";

const pool = new RpcPool(["https://your-devnet-endpoint.example/key"]);
await pool.probe(GENESIS.devnet);            // drop endpoints that are dead or on another network
const store = new ChainStore(pool);
const me = Keypair.fromFile("me.json");

// write: any size, resumable, returns the address of the file
const ref = await store.put(me, fs.readFileSync("photo.jpg"), {
  journalDir: "./journal",                   // lets an interrupted upload continue
  onProgress: (p) => console.log(p.phase, p.done, "/", p.total),
});
console.log(ref);    // { sig: "5Hk…", size: 482113, sha256: "9f2c…" }

// read: verified against the SHA-256 in `ref`; only accept data published by `me`
const data = await store.get(ref, { signers: [me.publicKey], cacheDir: "./cache" });
fs.writeFileSync("copy.jpg", data);
```

`ref.sig` alone is enough to fetch the file: `await store.get("5Hk…")`. Passing the whole
`ref`, or the option `sha256`, additionally pins the content you expect.

How much will it cost? Ask before sending:

```js
ChainStore.plan(482113);   // { transactions: 129, feeLamports: 645000, leafSize: 3912, depth: 2 }
```

## 2. A name that always points to the newest version

A file's address never changes, so "the newest version of my thing" needs a pointer. A
pointer is a small record under a **tag** that only your key can move.

```js
import { tagAddress } from "chainboot";

const tag = tagAddress("my-app", me.publicKey, "settings");

await store.putPointer(me, tag, Buffer.from(JSON.stringify({ file: ref.sig, version: 3 })));

// anyone can read it; records written by other keys under the same tag are ignored
const latest = await store.getPointer(tag, [me.publicKey]);
console.log(JSON.parse(latest.payload.toString()), latest.slot, latest.blockTime);
```

A pointer holds up to about 3.8 kB. For more, store a file and point at it.

## 3. Many endpoints, one pool

```js
const pool = new RpcPool([url1, url2, url3], { onNote: console.log });
await pool.probe(GENESIS["mainnet-beta"]);

const slot = await pool.call("getSlot");                                     // any JSON-RPC method
const balance = await pool.call("getBalance", [me.address, { commitment: "confirmed" }]);

console.table(pool.stats());   // per endpoint: learned rate, successes, rate limits, latency
```

What the pool does for you:

- learns each endpoint's speed limit: starts carefully, speeds up while requests succeed,
  backs off on "429 Too Many Requests";
- retries on another endpoint when one fails, and never on the same one twice in a row;
- **hedges**: if an endpoint is much slower than usual, the same question goes to a second
  one and the first answer wins;
- **batches**: calls made together travel in one HTTP request where the endpoint allows it
  (`pool.call(method, params, { batch: true })`);
- never prints your API keys (`pool.stats()` and notes show masked labels).

## 4. Transactions by hand

The SDK builds and parses Solana transactions itself, both the legacy format and the new
4096-byte v1 format.

```js
import { buildTransaction, transferInstruction, parseTransaction, verifyPayerSignature, sendAndConfirm, addressToBytes } from "chainboot";

const to = addressToBytes("7xQ…");
const signature = await sendAndConfirm(pool, (blockhash) =>
  buildTransaction(me, [transferInstruction(me.publicKey, to, 1_000_000)], blockhash, { version: "legacy" }));

const raw = Buffer.from((await pool.call("getTransaction", [signature, { encoding: "base64", maxSupportedTransactionVersion: 1 }])).transaction[0], "base64");
const tx = parseTransaction(raw);
console.log(tx.version, verifyPayerSignature(tx), tx.instructions.length);
```

## 5. Images

```js
import { readTar, decompressAuto, buildImage, publishImage, readCatalog, pullImage } from "chainboot";

// build: nothing touches the network here
const entries = readTar(decompressAuto(fs.readFileSync("rootfs.tar.gz")));
const built = buildImage(entries, { name: "mylinux", version: "1.0", arch: "amd64", description: "My Linux" });
console.log(built.manifest.digest, built.manifest.fileCount);

// publish: packs, manifest, catalog entry
await publishImage(store, me, built, { journalDir: "./journal", onProgress: (p) => console.log(p.phase, p.done, p.total) });

// find and download, fully verified
const catalog = await readCatalog(store, me.address);
const ref = catalog.images.mylinux.tags.latest.amd64;
const image = await pullImage(store, me.address, ref, { cacheDir: "./cache" });
const firstPack = image.pack(0);             // decompressed and checked file by file
```

`extractImage(manifest, pack, directory)` writes an image to disk. `entriesFromImage` and
`writeTar` turn it back into an archive.

## 6. Encrypted state for a wallet

```js
import { vaultFromKeypair, deriveVault, LOGIN_MESSAGE, seal, open } from "chainboot";

// from a keypair file ...
const vault = vaultFromKeypair(me, "devnet");
// ... or from a browser wallet's signature of LOGIN_MESSAGE:
// const vault = deriveVault(walletAddress, signatureBytes, "devnet");

const secret = seal(vault.encKey, Buffer.from("only I can read this"), "note");
const ref2 = await store.put(vault.signer, secret);        // the vault account pays and signs
const back = open(vault.encKey, await store.get(ref2, { signers: [vault.signer.publicKey] }), "note");
```

`saveSnapshot`, `readHead`, `readSnapshot`, `loadPacks` and `applySnapshot` are the functions
behind `chainboot save` and `chainboot restore`; `scanMachine` finds what changed in a machine.

## 7. Compression

```js
import { compress, decompress, xzDecode } from "chainboot";

const packed = compress(data, { arch: "amd64" });   // xz when the tool is installed, otherwise zstd
const again = decompress(packed.codec, packed.data, data.length);
```

The SDK contains a complete xz decoder written in TypeScript, so reading never depends on
installed tools.

## Reference at a glance

| Area | Exports |
|---|---|
| Keys | `Keypair` (`generate`, `fromFile`, `fromSeed`, `fromSecretKey`, `sign`, `address`), `verifySignature`, `addressToBytes`, `b58encode`, `b58decode` |
| Transactions | `buildTransaction`, `buildNoopTransaction`, `parseTransaction`, `verifyPayerSignature`, `compileMessage`, `compileMessageV1`, `noopCapacity`, `noopInstruction`, `transferInstruction`, `computeBudgetInstructions` |
| RPC | `RpcPool` (`call`, `broadcast`, `probe`, `stats`), `RpcError`, `GENESIS`, `clusterName`, `maskRpcUrl` |
| Storage | `ChainStore` (`put`, `get`, `putPointer`, `getPointer`, `plan`), `tagAddress`, `capacity`, `TxSender`, `sendAndConfirm`, `TrustError` |
| Images | `readTar`, `writeTar`, `decompressAuto`, `buildImage`, `entriesFromImage`, `verifyPack`, `extractImage`, `parseManifest`, `serializeManifest`, `validateManifest`, `treeDigest` |
| Registry | `publishImage`, `pullImage`, `readCatalog`, `unlistImage`, `parseImageName` |
| State | `LOGIN_MESSAGE`, `deriveVault`, `vaultFromKeypair`, `seal`, `open`, `scanMachine`, `saveSnapshot`, `readHead`, `readSnapshot`, `readIndex`, `loadPacks`, `applySnapshot` |
| Compression | `compress`, `decompress`, `xzDecode`, `xzUncompressedSize` |

Every export has type declarations and a comment in the source. The sources are short and
meant to be read: start with `src/store/store.ts`.

Next: [The on-chain format](07-format.md).
