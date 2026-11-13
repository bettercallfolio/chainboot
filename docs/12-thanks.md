# Thank you

chainboot is a small program standing on an enormous amount of other people's work. This
page is for them.

## Solana

- **Anatoly Yakovenko, Raj Gokal** and everyone who has built Solana since: at Solana Labs,
  Anza, the Solana Foundation, Jump's Firedancer team, Jito, and in the validator community.
  A network that is fast and cheap enough to hold an operating system is your work.
- **The authors of SIMD-0385, "Transaction V1 Format"** (jacobcreech and apfitzge on GitHub),
  and everyone who reviewed and implemented it. Raising the transaction size from 1232 to
  4096 bytes made this project almost four times cheaper and faster overnight.
- **The authors of the SPL Noop program.** A program that does nothing turned out to be
  exactly what was needed.
- **Every validator operator.** You keep the ledger this data lives in.

## RPC providers

Helius, QuickNode, Alchemy, Triton, Ankr, Sonic, and the team behind the public Solana
endpoints: thank you for free plans and for serving ledger history. Reading the chain without
running a validator is only possible because of you.

## Operating systems

- **Canonical and the Ubuntu community** for Ubuntu and for publishing a clean base archive
  that anyone may build on. **The Debian project**, on whose shoulders Ubuntu stands.
- **The Alpine Linux developers**, for a complete Linux system in three megabytes.
- **Linus Torvalds and the thousands of Linux kernel developers.** Namespaces and overlayfs
  are the reason a machine can start in a fifth of a second.
- **The util-linux maintainers** for `unshare`, `nsenter`, `mount` and `flock`.

## Compression and cryptography

- **Igor Pavlov** for LZMA and **Lasse Collin** for xz. The best compression ratio decided
  how many transactions an operating system needs.
- **Yann Collet** for Zstandard.
- **Daniel J. Bernstein and co-authors** for Ed25519, and everyone behind SHA-2, AES-GCM and
  HKDF.

## Tools

- **The Node.js project**, whose built-in crypto and compression allowed a tool with no
  dependencies. **The TypeScript and esbuild teams.**
- **The Wallet Standard authors** and the wallet teams (Phantom, Solflare, Backpack and
  others) for a common way to talk to wallets.
- **Microsoft's WSL team, Docker, OrbStack, Podman and Lima**, who make a Linux kernel
  available on every desktop.
- **The v86 authors and contributors.** An earlier attempt of this project ran Linux
  in the browser on v86; it taught us what should run natively instead.

## And you

Thank you for reading this far. If chainboot is useful to you, build something with it, and
tell the people above that their work mattered.
