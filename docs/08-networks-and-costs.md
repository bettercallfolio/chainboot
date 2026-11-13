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

## What is where today

- **Devnet:** the official catalog with Solinux and Alpine. This is where chainboot was
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
| 100 kB | 27 | 0.00014 SOL |
| 1 MB | 261 | 0.0013 SOL |
| 100 MB | 26,100 | 0.13 SOL |
| 1 GB | 267,000 | 1.34 SOL |

Real examples from devnet (rounded):

| What | Stored size | Transactions | Fee |
|---|---|---|---|
| Alpine Linux 3.24 | 2.9 MB | 760 | 0.0038 SOL |
| Solinux minimal (Ubuntu base) | 21.6 MB | 5,683 | 0.028 SOL |
| Solinux (adds 91 MB to minimal) | 91 MB | 23,946 | 0.12 SOL |
| A save after installing two small packages | 0.5 MB | 135 | 0.0007 SOL |
| A save after editing a few files | under 4 kB | 9 | 0.000045 SOL |

Reading is free of fees. You only need an RPC endpoint.

chainboot always shows the number of transactions and the fee before it sends anything
(`chainboot publish --dry-run`, `chainboot save`).

### On a busy mainnet

When many people use the network, transactions with a small extra tip (a "priority fee") are
included first. The SDK supports this (`priorityFeeLamports` per transaction); the
command-line tool sends without a tip. Without a tip, uploads still complete, because
chainboot re-sends transactions that did not land, but they can take longer.

## How fast is it

Downloading depends mostly on your RPC endpoints. Measured with Solinux minimal (21.6 MB):

| Endpoints | Time to download and verify |
|---|---|
| 13 endpoints of several providers | about 1 second |
| one endpoint of a provider with an API key (two were tried) | 0.7 to 1.5 seconds |
| only the public `api.devnet.solana.com` | about 100 seconds |

The public endpoints are meant for light use and limit requests strictly. A free account at
any provider is the single biggest speed-up.

Uploading runs at several hundred transactions per second with a handful of endpoints:
Solinux minimal takes about 20 seconds, plus 40 seconds to compress it.

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
