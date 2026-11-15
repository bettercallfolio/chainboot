// chainboot SDK: everything the command-line tool is built from.
//
//   import { RpcPool, ChainStore, Keypair } from "chainboot";
//   const store = new ChainStore(new RpcPool(["https://your-endpoint"]));
//   const ref = await store.put(Keypair.fromFile("me.json"), Buffer.from("hello, chain"));
//   console.log((await store.get(ref)).toString());

// Solana basics: keys, transactions, a pool of RPC endpoints
export { Keypair, verifySignature, addressToBytes } from "./solana/keys.ts";
export {
  buildTransaction, buildNoopTransaction, parseTransaction, verifyPayerSignature, compileMessage, compileMessageV1, noopCapacity,
  noopInstruction, transferInstruction, computeBudgetInstructions, MAX_TX_SIZE_LEGACY, MAX_TX_SIZE_V1, NOOP_PROGRAM, SYSTEM_PROGRAM,
  type Instruction, type AccountMeta, type ParsedTx, type SignedTx, type TxConfig, type TxVersion,
} from "./solana/tx.ts";
export { RpcPool, RpcError, GENESIS, clusterName, maskRpcUrl, type Cluster, type RpcPoolOptions, type CallOptions, type EndpointStats } from "./solana/rpc.ts";
export { b58encode, b58decode } from "./util/base58.ts";

// Storage: files of any size on the ledger, pointers to find the newest version of something
export { ChainStore, TrustError, tagAddress, capacity, encodeSlots, decodeSlots, type ObjectRef, type PutOptions, type GetOptions, type PointerRecord } from "./store/store.ts";
export { TxSender, sendAndConfirm, type Commitment } from "./store/sender.ts";

// Compression
export { compress, decompress, type Codec } from "./codec/index.ts";
export { xzDecode, xzUncompressedSize } from "./codec/xz.ts";

// Images: root file systems as manifests + packs, and the catalog that lists them
export { readTar, writeTar, decompressAuto, type Entry } from "./image/tar.ts";
export { buildImage, normalizeEntries, entriesFromImage, verifyPack, type BuiltImage, type ImageMeta } from "./image/build.ts";
export { parseManifest, serializeManifest, validateManifest, treeDigest, configIdentity, type ImageManifest, type ImageConfig, type TreeNode, type PackInfo } from "./image/manifest.ts";
export { extractImage } from "./image/extract.ts";
export { publishImage, pullImage, readCatalog, unlistImage, endorseImage, parseImageName, type Catalog, type ImageRef } from "./registry/registry.ts";
export { parseList, formatList, isList, readList, type ListSpec, type ListView, type ListEntry } from "./registry/lists.ts";
export { publishPrivateImage, readPrivateCatalog, unlistPrivateImage, type PrivateCatalog } from "./registry/private.ts";

// Saving machines: wallet-derived keys, encrypted snapshots
export {
  LOGIN_MESSAGE, deriveVault, vaultFromKeypair, seal, sealWithKey, open, openWithKey, objectKey,
  shareKeys, shareAddress, parseShareAddress, sealTo, openFrom, type Vault, type ShareKeys,
} from "./state/vault.ts";
export { shareImage, shareMachine, listShares, acceptImage, acceptMachine, cleanShareRecord, myShareAddress, type ShareRecord, type Received } from "./share/share.ts";
export { scanMachine, type ScanResult, type Change } from "./state/scan.ts";
export { saveSnapshot, readHead, readSnapshot, snapshotBySeq, checkSnapshot, readIndex, loadPacks, applySnapshot, type Snapshot, type Head } from "./state/snapshot.ts";

// Git repositories on chain: the index and packs of a repository, issues and pull requests,
// and a reader for git's pack files that needs no git
export { readRepo, writeRepo, putPack, getPack, listRepos, noteRepo, repoKey, emptyIndex, checkRepoName, PrivateRepoError, type Repo, type RepoIndex, type PackEntry } from "./git/repo.ts";
export { postTalk, readTalk, cleanRecord, type Item, type TalkRecord } from "./git/talk.ts";
export { Objects, inflateAt, diffLines, asText, type Commit, type TreeEntry, type Change as FileChange, type DiffLine } from "./git/pack.ts";
