# chainboot

**Store, share and boot whole operating systems from a blockchain.**

chainboot puts a complete Linux system on the Solana ledger and runs it on your own
computer, in your own terminal, at full native speed. There is no server in between. The
program reads the chain through the RPC endpoints you give it, checks every byte against its
hash, and starts the system.

The example system is **Solinux**: Ubuntu 26.04 LTS, stored on Solana. But chainboot is not
about one system. Any Linux distribution, and in fact any file, can be published the same
way, by anyone.

```
$ chainboot run solinux
✔ solinux:latest is ready (114 MB verified)
✔ created machine solinux from solinux:latest
root@solinux:~# apt install nginx        # a normal Ubuntu, with the internet of your computer
root@solinux:~# exit
Changes are saved to Solana in the background.
```

Sign in with your wallet and everything you change is saved back to the chain, encrypted.
Sit down at another computer, sign in, type the same command, and continue where you stopped.

> **Status: early.** It works end to end on Solana **devnet** today. Mainnet works with the
> same commands but has no official images yet. Read [what works and what does not](#what-works-today).

## Why this is interesting

- **A blockchain as a hard disk.** A 114 MB operating system lives in about 30,000 ordinary
  Solana transactions. One transaction signature is its address.
- **No trust in the middle.** RPC endpoints only deliver bytes. chainboot verifies signatures
  and hashes, so a wrong or dishonest endpoint cannot change what you run.
- **Fast.** One request can return hundreds of transactions (a whole block). Ubuntu minimal
  (22 MB) downloads in one to three seconds through a single endpoint with an API key.
- **Yours.** Your machines are encrypted with a key that only your wallet can make. No
  account, no company, no server that can be switched off.
- **Private by default.** `chainboot publish` stores a whole system that only your wallet can
  list, fetch or read. Sharing it with everyone takes an explicit `--public`.
- **Shareable.** Give one other wallet a saved machine or a private image with
  `chainboot share`: they receive the keys of exactly that, nothing is uploaded again.
- **A toolkit.** The command-line tool is built on a small TypeScript SDK with no
  dependencies. Use it to store your own data, or build something we did not think of.

## Quick start

### 1. Install

Linux, macOS, WSL:

```sh
curl -fsSL https://raw.githubusercontent.com/bettercallfolio/chainboot/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/bettercallfolio/chainboot/main/install.ps1 | iex
```

The installer works inside your home directory and needs no administrator rights. It uses
your Node.js if it is new enough (22.15+), otherwise it downloads the official build and
checks its SHA-256. See [Getting started](docs/01-getting-started.md) for what each system needs.

From source:

```sh
git clone https://github.com/bettercallfolio/chainboot && cd chainboot
npm ci && npm run build
node dist/chainboot.mjs help
```

### 2. Add an RPC endpoint

chainboot talks to Solana through RPC endpoints, and you bring your own. A free one takes a
minute to get from Helius, QuickNode, Alchemy, Triton or Ankr. Add as many as you like:
chainboot spreads the work over all of them.

```sh
chainboot rpc add https://your-endpoint.example/your-key
```

### 3. Run a system

```sh
chainboot list                 # what is on chain
chainboot run solinux         # Ubuntu 26.04 LTS: SSH, sudo, git, editors, the standard tools
chainboot run alpine           # Alpine Linux, 3 MB
```

Prefer buttons? `chainboot ui` opens a small page in your browser that does the same things.

### 4. Save your work to the chain (optional)

```sh
chainboot login                # sign one message with Phantom, Solflare, Backpack, ...
chainboot fund 0.05            # put a little SOL into your vault to pay for saves
```

From now on your changes are saved after every session. On another computer:

```sh
chainboot login
chainboot run solinux         # brings your machine back and opens it
```

## What is on chain right now (devnet)

| Image | What it is | Download | On disk | Cost to publish |
|---|---|---|---|---|
| `solinux` | Ubuntu 26.04.1 LTS server system, 419 packages (amd64, arm64) | 114 MB | 504 MB | 0.12 SOL |
| `solinux-minimal` | Ubuntu 26.04.1 LTS base system (amd64, arm64) | 22 MB | 90 MB | 0.028 SOL |
| `alpine` | Alpine Linux 3.24 (amd64, arm64) | 3 MB | 8 MB | 0.004 SOL |

Measured on a cloud machine with 14 RPC endpoints, from an empty cache to a running system:
Alpine 3 s, Solinux minimal 4 s, Solinux 15 s (4 s as a lazy machine, `--lazy`). Every later
start takes 0.2 s.

## What works today

| | |
|---|---|
| Publish, list, download and verify images | Works. Tested on devnet. |
| Run machines on Linux, with `sudo` or without administrator rights | Works. Tested (Ubuntu host, amd64; arm64 images through emulation). |
| Machines that boot systemd (`--boot`), with their own network | Works. Tested with Solinux, both with `sudo` and without administrator rights. |
| Save, restore, history, automatic saving, continue on another computer | Works. Tested on devnet. |
| Private images (the default of `publish`; `run me/<image>`) | Works. Tested on devnet with two wallets. |
| Sharing a saved machine or a private image with another wallet | Works. Tested on devnet with two wallets. |
| Reader for browsers ([chainboot.dev/reader](https://chainboot.dev/reader/), `dist/reader/`): catalog, download, verify, look into files | Works. Tested in Chrome against devnet. |
| Lists that several publishers keep together (`list:2:A,B,C`, `chainboot endorse`) | Works. Tested on devnet with three keys. |
| Pointers in accounts (`chainboot accounts on`): one request finds the newest catalog or save | Works. Tested on devnet. |
| Lazy machines (`chainboot run <image> --lazy`): start at once, fetch files when they are first read | Works. Tested with Solinux, with `sudo` and without administrator rights, also with `--boot`. |
| Bootable disks (`chainboot disk`): a machine as a UEFI disk with its own kernel | Works. Solinux was built and booted in QEMU with UEFI firmware; **not yet tried on real hardware.** |
| Web interface, wallet sign-in | Works. Tested with a simulated wallet; **not yet tried with a real browser wallet.** |
| macOS (through Docker, OrbStack, Podman or Lima) | The Docker path is tested on Linux. **Not yet tried on a real Mac.** |
| Windows (through WSL 2) | Written, **not yet tried on a real Windows computer.** |
| Mainnet | Same code and commands. No official images are published there yet. |
| Other SVM chains (`chainboot network add <name> <rpc-url>`) | Adding and reading tried on Eclipse, Sonic and SOON; writing through the Memo program tried on devnet. **Nothing published on another chain yet.** |

Known limits, so nothing surprises you:

- A machine is not a security sandbox. Root inside a machine is you (when machines run
  without administrator rights) or root on your computer (through `sudo`).
- A machine uses your computer's Linux kernel and cannot load its own kernel modules. It
  starts systemd as its first process only when created with `--boot`; otherwise services
  are started by hand or by a start-up script ([Machines](docs/03-machines.md)).
- Data written to a ledger cannot be erased. Saves are encrypted, but they stay.
- Devnet is a test network. It can be reset, and old data may disappear from RPC nodes.

## Documentation

1. [Getting started](docs/01-getting-started.md): install, endpoints, first run, each platform
2. [How it works](docs/02-how-it-works.md): the whole idea in plain words, with pictures
3. [Machines](docs/03-machines.md): running, keeping one up, services, booting systemd, exporting
4. [Saving to chain](docs/04-saving.md): wallet, vault, encryption, restore, sharing, conflicts, cost
5. [Publishing your own system](docs/05-publishing.md): any distribution, step by step
6. [The SDK](docs/06-sdk.md): store files, build your own tools, read images in a browser
7. [The on-chain format](docs/07-format.md): every byte, so anyone can write a reader
8. [Networks and costs](docs/08-networks-and-costs.md): devnet, mainnet, what it costs
9. [Security](docs/09-security.md): what you trust and what you do not have to
10. [Ideas and roadmap](docs/10-ideas-and-roadmap.md): what else this can become
11. [Questions and problems](docs/11-faq.md)
12. [Thank you](docs/12-thanks.md)

## Website

The project's website is the static page in [`site/`](site/), and can be hosted anywhere. Its
documentation pages are made from `docs/` by `npm run site`; the result is committed, so
hosting it needs no build step.

## Thank you

chainboot stands on the work of many people: the engineers who built Solana and made large
transactions possible, the RPC providers who serve the ledger, Canonical and the Ubuntu,
Debian and Alpine communities, the Linux kernel developers, and the authors of xz, Zstandard,
Node.js and TypeScript. The full list is in [docs/12-thanks.md](docs/12-thanks.md).

## Contact

Website: https://chainboot.dev · Mail: hello@chainboot.dev

## License and names

MIT, see [LICENSE](LICENSE).

Solinux is this project's name for its packaging of Ubuntu on Solana. It is built only from Canonical's Ubuntu
26.04 LTS base archive and packages, and is not affiliated with or endorsed by Canonical. Ubuntu is a
registered trademark of Canonical Ltd. Linux is a registered trademark of Linus Torvalds.
Alpine Linux, Solana and all other names belong to their owners.
