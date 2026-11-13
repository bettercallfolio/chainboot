# chainboot

**Store, share and boot whole operating systems from a blockchain.**

chainboot puts a complete Linux system on the Solana ledger and runs it on your own
computer, in your own terminal, at full native speed. There is no server in between. The
program reads the chain through the RPC endpoints you give it, checks every byte against its
hash, and starts the system.

The example system is **Solbuntu**: Ubuntu 26.04 LTS, stored on Solana. But chainboot is not
about one system. Any Linux distribution, and in fact any file, can be published the same
way, by anyone.

```
$ chainboot run solbuntu
✔ solbuntu:latest is ready (114 MB verified)
✔ created machine solbuntu from solbuntu:latest
root@solbuntu:~# apt install nginx        # a normal Ubuntu, with the internet of your computer
root@solbuntu:~# exit
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
  (22 MB) downloads in about one second, even through a single free endpoint.
- **Yours.** Your machines are encrypted with a key that only your wallet can make. No
  account, no company, no server that can be switched off.
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
chainboot run solbuntu         # Ubuntu 26.04 LTS: SSH, sudo, git, editors, the standard tools
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
chainboot run solbuntu         # brings your machine back and opens it
```

## What is on chain right now (devnet)

| Image | What it is | Download | On disk | Cost to publish |
|---|---|---|---|---|
| `solbuntu` | Ubuntu 26.04.1 LTS server system, 419 packages (amd64, arm64) | 114 MB | 504 MB | 0.12 SOL |
| `solbuntu-minimal` | Ubuntu 26.04.1 LTS base system (amd64, arm64) | 22 MB | 90 MB | 0.028 SOL |
| `alpine` | Alpine Linux 3.24 (amd64, arm64) | 3 MB | 8 MB | 0.004 SOL |

Measured on a cloud machine with 13 RPC endpoints, from an empty cache to a shell prompt:
Alpine 5 s, Solbuntu minimal 7 s, Solbuntu 16 s. Every later start takes 0.2 s.

## What works today

| | |
|---|---|
| Publish, list, download and verify images | Works. Tested on devnet. |
| Run machines on Linux | Works. Tested (Ubuntu host, amd64; arm64 images through emulation). |
| Save, restore, history, automatic saving, continue on another computer | Works. Tested on devnet. |
| Web interface, wallet sign-in | Works. Tested with a simulated wallet; **not yet tried with a real browser wallet.** |
| macOS (through Docker, OrbStack, Podman or Lima) | The Docker path is tested on Linux. **Not yet tried on a real Mac.** |
| Windows (through WSL 2) | Written, **not yet tried on a real Windows computer.** |
| Mainnet | Same code and commands. No official images are published there yet. |

Known limits, so nothing surprises you:

- A machine is not a security sandbox. Root inside a machine is root on your computer.
- A machine uses your computer's Linux kernel. It cannot load its own kernel modules, and it
  does not start systemd as its first process. Services are started by hand or by a start-up
  script ([Machines](docs/03-machines.md)).
- Data written to a ledger cannot be erased. Saves are encrypted, but they stay.
- Devnet is a test network. It can be reset, and old data may disappear from RPC nodes.

## Documentation

1. [Getting started](docs/01-getting-started.md): install, endpoints, first run, each platform
2. [How it works](docs/02-how-it-works.md): the whole idea in plain words, with pictures
3. [Machines](docs/03-machines.md): running, keeping one up, services, exporting
4. [Saving to chain](docs/04-saving.md): wallet, vault, encryption, restore, conflicts, cost
5. [Publishing your own system](docs/05-publishing.md): any distribution, step by step
6. [The SDK](docs/06-sdk.md): store files, build your own tools
7. [The on-chain format](docs/07-format.md): every byte, so anyone can write a reader
8. [Networks and costs](docs/08-networks-and-costs.md): devnet, mainnet, what it costs
9. [Security](docs/09-security.md): what you trust and what you do not have to
10. [Ideas and roadmap](docs/10-ideas-and-roadmap.md): what else this can become
11. [Questions and problems](docs/11-faq.md)
12. [Thank you](docs/12-thanks.md)

## Thank you

chainboot stands on the work of many people: the engineers who built Solana and made large
transactions possible, the RPC providers who serve the ledger, Canonical and the Ubuntu,
Debian and Alpine communities, the Linux kernel developers, and the authors of xz, Zstandard,
Node.js and TypeScript. The full list is in [docs/12-thanks.md](docs/12-thanks.md).

## License and names

MIT, see [LICENSE](LICENSE).

Solbuntu is an unofficial packaging of Ubuntu made for this project. It is not affiliated
with or endorsed by Canonical. Ubuntu is a registered trademark of Canonical Ltd. Alpine
Linux, Solana and all other names belong to their owners.
