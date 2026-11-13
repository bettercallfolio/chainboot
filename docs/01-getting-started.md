# Getting started

This page takes you from nothing to a running system. It should take about five minutes.

## What you need

| Your computer | What chainboot needs | Notes |
|---|---|---|
| Linux (x86-64 or ARM64) | `sudo`, and the tools `unshare`, `nsenter`, `mount`, `chroot`, `flock` | These are part of the `util-linux` and `coreutils` packages that every mainstream distribution installs by default. |
| Windows 10 or 11 | WSL 2 | If it is not enabled yet, run `wsl --install --no-distribution` once in an administrator PowerShell and restart. |
| macOS (Intel or Apple silicon) | One Linux engine: OrbStack, Docker Desktop, Podman, or Lima | macOS cannot run Linux programs by itself. Any one of these is enough. |

You also need an **RPC endpoint** for Solana. More about that below.

Optional: the `xz` tool. With it, large systems unpack several times faster.

## Install

Linux, macOS and WSL:

```sh
curl -fsSL https://raw.githubusercontent.com/bettercallfolio/chainboot/main/install.sh | sh
```

Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/bettercallfolio/chainboot/main/install.ps1 | iex
```

What the installer does:

1. It looks for Node.js 22.15 or newer. If you do not have it, it downloads the official
   Node.js build from nodejs.org, checks its SHA-256 against a value written into the
   installer, and keeps it in a private folder. Your system is not changed.
2. It downloads chainboot (one program file of about 250 kB and a small web page) and checks
   its SHA-256.
3. It creates the `chainboot` command in `~/.local/bin` (on Windows: in
   `%LOCALAPPDATA%\chainboot\bin`, added to your PATH).

Nothing needs administrator rights. Run the installer again to update. To remove chainboot:

```sh
sh install.sh --uninstall            # keep machines and settings
sh install.sh --uninstall --purge    # delete everything
```

If the installer says `~/.local/bin is not on your PATH`, add the line it prints to your
shell profile and open a new terminal.

## Add an RPC endpoint

Solana is a network of computers. Programs do not talk to "the network" directly; they talk
to one computer of the network that answers questions over the internet. That computer is
called an **RPC endpoint**, and its address looks like a web address.

chainboot does not come with an endpoint. You bring your own, for two reasons: nobody can
switch off "the chainboot server", because there is none, and you decide whom you ask.

Where to get one (all have a free plan):

- Helius: https://www.helius.dev
- QuickNode: https://www.quicknode.com
- Alchemy: https://www.alchemy.com
- Triton: https://triton.one
- Ankr: https://www.ankr.com

Create an account, create an endpoint for **Solana devnet**, copy its URL, and add it:

```sh
chainboot rpc add https://devnet.helius-rpc.com/?api-key=YOUR-KEY
```

chainboot checks that the endpoint answers and that it really is a devnet endpoint.

There is also a public endpoint that needs no account: `https://api.devnet.solana.com`. It
works, but it is strictly rate-limited. Downloading Ubuntu through it alone takes minutes
instead of seconds.

**Add several endpoints if you can.** chainboot spreads its requests over all of them, learns
how fast each one may be used, moves work away from one that is slow or failing, and asks a
second endpoint when the first takes too long. One endpoint is enough; three make it smooth.

```sh
chainboot rpc list        # API keys are never shown
chainboot rpc test        # which ones answer
chainboot rpc remove 2    # remove number 2 of the list
```

The endpoints are stored in `~/.chainboot/config.json`, readable only by you. Instead of
saving them you can set the environment variable `CHAINBOOT_RPC` to a comma-separated list.

## Run your first system

```sh
chainboot list
```

```
image             tag      arch   download  on disk  description
alpine            latest   amd64  2.89 MB   8.43 MB  Alpine Linux 3.24, minimal root file system
solbuntu          latest   amd64  114 MB    504 MB   Ubuntu 26.04.1 LTS server system: SSH, sudo, git, editors and the standard tools
solbuntu-minimal  latest   amd64  21.8 MB   90.2 MB  Ubuntu 26.04.1 LTS, minimal base system
```

This list is itself read from the chain. Now run one:

```sh
chainboot run solbuntu
```

What happens:

1. chainboot finds the newest `solbuntu` in the publisher's catalog on chain.
2. It downloads the system and checks every file against its SHA-256.
3. It unpacks the system once and creates a **machine**: the system plus a place for
   everything you will change.
4. It opens a shell inside the machine. On Linux this step asks for your password (`sudo`),
   because mounting a file system is something only the administrator may do.

You are now root in a real Ubuntu. `apt update`, `apt install`, edit files, use the network.
Type `exit` to leave. Run the same command again and you are back in the same machine, with
everything you did, in a fraction of a second.

```sh
chainboot run solbuntu -- apt-get update     # run one command and return
chainboot run solbuntu --name test           # a second, separate machine from the same image
chainboot machines                           # list your machines
chainboot rm test                            # delete one
```

## Prefer a window?

```sh
chainboot ui
```

A page opens in your browser: add endpoints, pick a system, open your machines, connect your
wallet. The page is served by chainboot on your own computer (`127.0.0.1`) and can only be
reached from it.

## Platform notes

**Linux.** Machines run directly on your kernel. This is the fastest and simplest case.

**Windows.** chainboot creates a small WSL 2 distribution named `chainboot` and runs your
machines inside it. The first run downloads the Ubuntu base archive from Canonical (35 MB)
and Node.js for Linux (about 50 MB), both checked against pinned SHA-256 values. After that,
commands are passed through automatically; you keep typing `chainboot ...` in PowerShell or
Windows Terminal.

**macOS.** The same idea with a container: chainboot creates one named `chainboot` in
OrbStack, Docker Desktop or Podman, or a Lima virtual machine if you use Lima. Your machines
live inside it.

On Windows and macOS, `chainboot engine` shows where machines run, and `chainboot engine
reset` removes that environment with all machines in it (saves on chain are not affected).

## Where things are

| Path | What |
|---|---|
| `~/.chainboot/config.json` | network and RPC endpoints |
| `~/.chainboot/cache/` | downloaded data (safe to delete; it is fetched again) |
| `~/.chainboot/images/` | unpacked systems |
| `~/.chainboot/machines/` | your machines and their changes |
| `~/.chainboot/vault/` | your login (encryption key and vault key); keep it private |

Next: [How it works](02-how-it-works.md), or go straight to [Saving to chain](04-saving.md).
