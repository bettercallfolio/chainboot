# Ideas and roadmap

chainboot stores operating systems because that is a demanding, concrete test: hundreds of
megabytes, tens of thousands of files, and it has to boot. But the parts it is made of are
general. This page is an invitation: here is what else you can build with them, on Solana
and on other networks.

## What chainboot really gives you

Four building blocks, each usable alone through the [SDK](06-sdk.md):

1. **Files of any size on a ledger, addressed by one signature**, verified on read, fast to
   fetch (`ChainStore.put` / `get`).
2. **Names that only their owner can move** (`putPointer` / `getPointer`).
3. **A pool that makes many RPC endpoints behave like one fast, reliable one** (`RpcPool`).
4. **Encrypted private state unlocked by a wallet signature**, with no account and no server
   (`deriveVault`, `seal`, `open`).

## Things you could build

**Software that cannot be taken down or quietly changed**

- A package repository on chain: `apt`, `npm` or `pip` packages whose bytes are verifiable
  by anyone and available as long as the ledger is. A package manager plugin could install
  straight from signatures.
- Release archives for open-source projects, with the publisher's key as the only authority.
  "Is this the binary the author published?" becomes a question with a mathematical answer.
- Firmware and update channels for devices: the device knows one public key and one tag, and
  follows the pointer.
- Reproducible-build registries: several independent builders publish the digest they got;
  agreement is visible on chain.

**Whole environments, shared with one line**

- Development environments: "run `chainboot run <address>/project-dev`" instead of a setup
  guide. Everyone gets the identical system.
- Teaching and workshops: every student starts from the same machine and keeps their own
  encrypted progress in their own wallet.
- Research artifacts: publish the exact system a paper's results were computed with.
- Capture-the-flag and puzzle machines.

**Personal data that follows your wallet**

- Encrypted settings, dotfiles, notes or password vaults that appear on any computer after
  one signature.
- Game saves and user-generated content owned by the player, not by the game's server.
- Application state for wallet-based apps without running a backend.

**Websites and media**

- Static websites whose every file is on chain and whose "current version" is a pointer
  owned by the author. A small gateway, or a browser extension, can serve them verified.
- Art, music and documents stored completely on chain, not as a link to somewhere else.
- Datasets and model weights with a verifiable origin.

**Infrastructure**

- Configuration and key registries: a tag per service, readable by anyone, writable by one key.
- Append-only logs and attestations, with pointers as the index.
- Machine images for clusters: nodes boot the image a pointer names; updating the fleet
  means moving the pointer.

## What Solana in particular makes possible

If you are new to Solana, this project touches several of its interesting properties:

- **Fixed, tiny fees per transaction**, independent of the data inside. Storing a megabyte
  costs about 0.0013 SOL. That is what makes "the ledger as storage" practical for small and
  medium data.
- **Large transactions.** The v1 format (4096 bytes) arrived in 2026 and made this almost
  four times cheaper and faster than before.
- **High throughput.** chainboot lands several hundred transactions per second from one
  laptop through free endpoints.
- **Fast finality.** A save is final a few seconds after it is sent.
- **Addresses without keys.** Any 32 bytes can be referenced by a transaction. chainboot
  uses hashes as "tag addresses" to find things, with no program of its own on chain.
- **No custom program needed.** Everything here uses the existing Noop program. There is
  nothing to deploy, audit or upgrade.

Things worth exploring that chainboot does not use, or uses only a little:

- **Accounts as storage.** Solana accounts can hold up to 10 MB each and are readable in a
  single request, forever, from every node. They cost a refundable deposit (about 5 SOL per
  MB on devnet today) instead of a fee. Good for small data that must be instantly readable. chainboot uses
  them for pointers only (`chainboot accounts on`); whole images in accounts would be a
  different trade of cost against speed.
- **Your own program** for rules that signatures cannot express: shared catalogs, paid
  downloads, votes on what is "official".
- **Compressed state and proofs** for very large collections.

## Beyond Solana

Nothing in the design is tied to one chain. The on-chain format needs four things from a
network: transactions that can carry free data, a way to fetch a transaction by its ID, a
way to list the transactions that mention an address (that is how pointers are found), and,
for speed, a way to fetch a block. Almost every chain has them; what differs is price and speed. The
image format, the verification and the encryption do not know which chain is below. A port
to another network is a new implementation of one file, the store.

## Roadmap

Honest status first: chainboot today is a working first version, built and tested on devnet
and on Linux. The list below is in rough order of importance.

**Next**

- Try and fix everything on real Windows and macOS computers and with real browser wallets.
- An official catalog on mainnet.

**Soon**

- Lazy machines that keep fetching in the background until the image is complete, and
  lazy variants of the official images for ARM64.
- Solinux for ARM64 (it is built for amd64 only today).
- Git on chain: repositories that several keys may push to, repacking a repository that
  has many small packs, texts longer than one transaction written from the browser page.

**Later**

- Chains that are not SVM (the storage layer is small; see
  [Networks and costs](08-networks-and-costs.md#other-chains)).

If one of these matters to you, open an issue or send a pull request. The code is small on
purpose.

Next: [Questions and problems](11-faq.md).
