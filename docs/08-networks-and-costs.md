# Networks and costs

## Devnet, testnet, mainnet

Solana runs several separate networks. They use the same software but have different data
and different SOL.

| Network | What it is for | SOL | Data |
|---|---|---|---|
| **devnet** | trying things out | free from a faucet, worth nothing | can be reset; old data may disappear |
| **testnet** | testing the network software itself | free, worth nothing | reset from time to time |
| **mainnet-beta** | the real network | real money | permanent |

chainboot starts on devnet. Switch with:

```sh
chainboot network                  # show the current network
chainboot network mainnet-beta     # switch (also: devnet, testnet)
```

Each network has its own list of RPC endpoints, its own login and its own vault. chainboot
checks every endpoint you add and refuses one that belongs to a different network, because
mixing networks would silently break uploads.

## Other chains

chainboot is not tied to Solana's own three networks. It works on any chain that runs Solana
programs and answers Solana's RPC (these are often called SVM chains; Eclipse, Sonic and SOON
are examples). Adding one takes a name and one endpoint:

```sh
chainboot network add eclipse https://mainnetbeta-rpc.eclipse.xyz
chainboot network list
chainboot network devnet            # back to Solana's devnet
```

chainboot asks the endpoint which chain it serves and remembers the chain by its genesis
hash, so every endpoint you add later is checked against it. Then everything works as on
Solana: publish, list, run, save, share. Each chain has its own logins, vault and saves.

What is different there:

- **Transactions are smaller.** chainboot uses the transaction format every such chain has,
  1232 bytes instead of Solana's newer 4096, so the same data takes about four times as many
  transactions.
- **The carrier may be the Memo program.** On Solana the data rides in instructions for the
  Noop program, which takes any bytes. Where Noop is not deployed (chainboot checks when you
  add the chain), the Memo program carries it as base64 text, which needs a third more room
  and far more compute. Readers understand both without a setting.
- **No official catalog.** Name a publisher (`<address>/<image>`) or publish your own.
- **Fees are the chain's own**, in its own currency.

Honest status: adding chains and reading from them was tried against the public endpoints of
Eclipse, Sonic and SOON. Writing through the Memo program was tried on Solana devnet, which
has the same program; nothing has been published on another chain yet.

A chain that is not SVM (Ethereum and its relatives, for example) would need a second
implementation of four things: putting bytes into a signed transaction, fetching a
transaction by its ID, checking who signed it, and listing the transactions that name a tag.
The formats above that layer ([The on-chain format](07-format.md)) would stay as they are.

## What is where today

- **Devnet:** the official catalog with Solinux, Ubuntu, Arch Linux and Alpine. This is where chainboot was
  built and measured.
- **Mainnet:** no official catalog yet, and chainboot has not been exercised there. The
  4096-byte transaction format chainboot writes has been active on mainnet since September
  2026 according to Solana's upgrade notes. Everything works the same way with your own images:
  publish with your own key, and run with `chainboot run <your-address>/<image>`.

## What storing data costs

Solana charges a fixed fee per transaction: **5,000 lamports = 0.000005 SOL**. It does not
matter how much data the transaction carries. chainboot fills each transaction with 3,912
bytes, so:

| Amount of (compressed) data | Transactions | Fee |
|---|---|---|
| 1 kB (a note, a pointer) | 1 | 0.000005 SOL |
| 100 kB | 28 | 0.00014 SOL |
| 1 MB | 263 | 0.0013 SOL |
| 100 MB | 25,992 | 0.13 SOL |
| 1 GB | 259,888 | 1.30 SOL |

Real examples from devnet (rounded):

| What | Stored size | Transactions | Fee |
|---|---|---|---|
| Alpine Linux 3.24 | 2.9 MB | 760 | 0.0038 SOL |
| Ubuntu minimal (Ubuntu base) | 21.6 MB | 5,683 | 0.028 SOL |
| Ubuntu (adds 91 MB to minimal) | 91 MB | 23,946 | 0.12 SOL |
| A save after installing two small packages | 0.5 MB | 135 | 0.0007 SOL |
| A save after editing a few files | under 4 kB | 9 | 0.000045 SOL |

Reading is free of fees. You only need an RPC endpoint.

chainboot always shows the number of transactions and the fee before it sends anything
(`chainboot publish --dry-run`, `chainboot save`).

### On a busy mainnet

When many people use the network, transactions with a small extra tip (a "priority fee") are
included first. Turn it on with one setting:

```sh
chainboot priority-fee 2000      # lamports added to every transaction
chainboot priority-fee           # show the setting
chainboot priority-fee off
```

The tip applies to publishing and saving and is included in every cost estimate. A tip of
1,000 to 10,000 lamports is usually plenty; with 2,000 lamports, storing 1 MB costs 0.0018 SOL
instead of 0.0013. Without a tip, uploads still complete, because chainboot sends again
whatever did not land, but they can take longer. In the SDK: `new ChainStore(pool, {
priorityFeeLamports })`, or per call.

### Accounts: a deposit instead of a fee

Everything above is about transactions: you pay once and the data is in the ledger. Solana
has a second kind of storage, **accounts**. An account holds only a current value, every
endpoint keeps it in memory, and one request reads it. It is not paid for but backed by a
deposit ("rent"), which comes back when the account is closed. The network sets the rate;
on devnet it is about 5 SOL per megabyte at the time of writing (ask an endpoint:
`getMinimumBalanceForRentExemption`).

That makes accounts wrong for systems (Ubuntu would need about 600 SOL) and right for the few
small records that are read all the time: the pointers that say "this is my newest catalog"
or "this is the newest save of this machine". chainboot can keep them in accounts as well:

```sh
chainboot accounts on            # from now on, pointers you write are also kept in accounts
chainboot accounts               # show the setting
chainboot accounts close         # close them and get the deposits back
```

Each pointer account holds a deposit of about 0.0033 SOL. Readers need no setting: they look
for the account first, check the owner's signature inside it, and read the transactions as
before if there is none. The pointer is still written to the ledger too, in the same
transaction, so nothing depends on the account staying open. chainboot deploys no program
for this; it uses the SPL Record program, which is on devnet and mainnet.

## How fast is it

Downloading depends mostly on your RPC endpoints. Measured with Ubuntu minimal (21.6 MB):

| Endpoints | Time to download |
|---|---|
| 14 endpoints of several providers | 1.3 seconds |
| one endpoint of a provider with an API key (four providers were tried) | 1 to 3 seconds with three of them, 6 to 14 with the fourth |
| only the public `api.devnet.solana.com` | about 100 seconds |

Checking the download (unpacking it and hashing every file) takes another 1.6 seconds, and
connecting to 14 endpoints about 2 seconds the first time.

The public endpoints are meant for light use and limit requests strictly. A free account at
any provider is the single biggest speed-up.

A [lazy machine](03-machines.md#lazy-machines-start-before-the-download-is-done) does not
wait for the download at all: the full Ubuntu (114 MB on chain, 504 MB of files) answers
its first command about 4 seconds after `chainboot run ubuntu:lazy --lazy` on a computer that
has nothing yet, against about 15 seconds the ordinary way.

Finding the newest pointer (the first step of every `list`, `run` and `restore`) takes one
request when its owner keeps it in an account, instead of a history lookup and a second
request: on devnet about 0.3 seconds instead of 0.6.

Uploading runs at several hundred transactions per second with a handful of endpoints:
Ubuntu minimal takes about 20 seconds, plus 40 seconds to compress it.

## How long does data stay

This is the honest part.

- The **ledger** is permanent in the sense that the network agreed on it and it cannot be
  changed. chainboot data is part of the ledger.
- But a validator does not need old transactions to do its work, and most keep only recent
  ones. Reading old transactions depends on **RPC providers that keep the full history**
  ("archive" nodes). On mainnet the large providers do. On devnet history is kept less
  carefully and the whole network can be reset.
- chainboot can only read what your endpoints can serve. If an endpoint has no history,
  chainboot notices ("no data") and uses your other endpoints.

For anything you care about: use mainnet, use providers with archive access, and keep in
mind that you rely on at least one of them continuing to serve history. Your own archive is
`~/.chainboot/cache`: everything you downloaded is there, verified, and you could publish it
again.

## Moving from devnet to mainnet

1. `chainboot network mainnet-beta`
2. `chainboot rpc add <a mainnet endpoint>`
3. Publish your images again with a funded mainnet keypair. Images do not move between
   networks by themselves, but the same archive gives the same digest, so anyone can check
   that the mainnet image is the one from devnet.
4. Sign in again (`chainboot login`). Your mainnet vault is a different account than your
   devnet vault; fund it with real SOL.

Next: [Security](09-security.md).
