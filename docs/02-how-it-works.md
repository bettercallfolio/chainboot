# How it works

This page explains the whole idea in plain words. No blockchain knowledge is needed.

## The short version

1. A blockchain is a list of transactions that thousands of computers keep and agree on.
2. A Solana transaction can carry a few kilobytes of free data.
3. Cut a file into small pieces, put every piece into a transaction, and the file is on chain.
4. To read it back, fetch the transactions and glue the pieces together.
5. An operating system is just a set of files. Do this with all of them and the operating
   system is on chain.

Everything else in chainboot is there to make this **safe** (you get exactly the bytes that
were published), **fast** (seconds, not hours) and **pleasant** (one command).

## Part 1: a file on a blockchain

### Transactions carry data

A Solana transaction is a small signed message, at most 4096 bytes long. It says who pays,
which programs to call, and what data to give them. Solana has a tiny program called
**Noop** ("no operation") that accepts any data and does nothing with it. The data is still
recorded in the ledger forever, because every transaction is.

chainboot fills each transaction with as much file data as fits: **3912 bytes**. The fee for
a transaction is fixed (0.000005 SOL), no matter how much data is inside.

> Until 2026 a Solana transaction could only be 1232 bytes. The new "v1" transaction format
> raised this to 4096 bytes. chainboot uses v1, so it needs almost four times fewer
> transactions than would have been possible before.

### One address for a whole file

A 22 MB file becomes about 5,600 transactions. How do you find them again? Every transaction
has a unique name: its **signature**. chainboot stores lists of signatures the same way it
stores data, and builds a small tree:

```
                    head                 <- its signature is the address of the file
                 /    |    \
           branch  branch  branch        <- each lists up to 61 signatures
           /  |  \
        leaf leaf leaf ...               <- each carries 3912 bytes of the file
```

The **head** also records the size of the file and its SHA-256 hash. So one signature, 88
characters long, is enough to find and check a file of any size.

### Reading fast: whole blocks instead of single transactions

Asking an RPC endpoint for 5,600 transactions one by one is slow, and free endpoints only
allow a few requests per second. But Solana groups transactions into **blocks**, and one
request can return a whole block. When chainboot uploads a file, hundreds of its transactions
land in the same block. So the head also points to a short **hint**: the list of blocks that
contain the file.

A reader then needs a few dozen requests instead of 5,600. That is why even a single free
endpoint downloads Ubuntu minimal in a second or two. If a block cannot be fetched, chainboot falls
back to fetching the missing transactions one by one. The hint only makes things faster; it
is never needed for correctness.

### Why you can trust what you get

RPC endpoints are run by companies you may not know. chainboot does not trust them:

- The head and the branches are checked with the publisher's **signature**. An endpoint
  cannot invent them, because it does not have the publisher's private key.
- The assembled file must match the **SHA-256** recorded in the head. If any piece is wrong,
  chainboot finds the bad pieces by their signatures and fetches them again elsewhere.

A dishonest endpoint can refuse to answer, or answer slowly. It cannot make you run something
else.

## Part 2: an operating system as files

### Images

An **image** is a complete root file system: every program, library and configuration file
of a Linux system. chainboot stores an image as two kinds of objects:

- **Packs.** The contents of all files, glued together and compressed into one stream. Solid
  compression of similar files is very effective: Ubuntu's 90 MB become 21.6 MB with xz.
  Identical files are stored once.
- **A manifest.** A list with one line per file, directory and link: its path, owner,
  permissions, time, hash, and where its content sits inside the packs.

The manifest has a **digest**: a hash over all those lines. It depends only on the files,
not on how they were packed. Anyone who packages the same system gets the same digest, and
anyone can recompute it from an unpacked system.

A second image can reuse the packs of the first. The Solbuntu server image refers to the
pack of Solbuntu minimal and adds only what is new.

### The catalog

How does `chainboot run solbuntu` find the right signature? Every publisher has a
**catalog**: a small file on chain that lists their images, versions and processor
architectures. A **pointer transaction** always names the newest catalog.

```
publisher's pointer  ->  catalog  ->  manifest  ->  packs
     (signed)            (signed)     (signed)      (hash from the manifest)
```

Only the publisher can move their pointer, because readers ignore pointer transactions that
were not signed by the publisher's key. The name `solbuntu` without a publisher means "from
the official chainboot publisher". For anybody else you write `<their-address>/<image>`.

## Part 3: running it

### Machines

Downloading gives you an image. Running needs more: a place for your changes. chainboot
uses a feature of the Linux kernel called **overlayfs**:

```
   what you see inside the machine
   ───────────────────────────────
   your changes   (new files, changed files, notes about deleted files)
   ───────────────────────────────
   the image      (read-only, shared by all machines made from it)
```

The image is never modified. Two machines made from the same image share it and only store
their own differences.

To make the machine feel like a separate computer, chainboot starts it in its own
**namespaces**: its own process list, hostname and mounts. The network is shared with your
computer, so the internet simply works. No emulation is involved; programs run directly on
your processor. (On Windows and macOS there is one thin layer in between, the WSL or
container environment that provides a Linux kernel.)

### Saving your changes back to the chain

The "your changes" layer is exactly what needs saving. When you are signed in, chainboot
looks at that layer after each session, packs only the content that is not on chain yet,
encrypts it with a key derived from your wallet, and stores it like any other file. A pointer
transaction names your newest save. On another computer, chainboot reads the pointer,
downloads the image and your save, and puts the layer back.

How the key is made, and why your wallet is asked only once, is explained in
[Saving to chain](04-saving.md).

## The whole picture

```
 publish                                         run
 ───────                                         ───
 root file system                                chainboot run solbuntu
      │ pack + compress                               │ read pointer, catalog, manifest
      ▼                                               ▼
 packs + manifest ── transactions ──▶ Solana ──▶ fetch blocks, verify signatures and hashes
      │                               ledger          │ unpack once
      ▼                                               ▼
 catalog + pointer                               image + your layer = machine  ◀─▶ encrypted saves
```

Next: [Machines](03-machines.md). For the exact bytes, see [The on-chain format](07-format.md).
