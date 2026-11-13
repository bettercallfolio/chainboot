# Publishing your own system

Anyone can publish a Linux system with chainboot. You need a root file system as a tar
archive, a Solana keypair with a little SOL, and one command.

## The one command

```sh
chainboot publish rootfs.tar.gz --name mylinux --version 1.0 --keypair me.json
```

chainboot reads the archive, packs and compresses it, shows what it will cost, and asks
before sending anything. When it is done, the image is listed in **your catalog** and anyone
can run it:

```sh
chainboot run <your-address>/mylinux
```

## Step by step

### 1. A publisher key

Your publisher identity is a Solana keypair. Its address is your name on chain; images are
found under it.

```sh
chainboot keygen me.json
```

This prints the address. Keep `me.json` private and make a backup: whoever has it can
publish as you, and without it you cannot update your catalog.

On devnet, get free test SOL from https://faucet.solana.com for that address. On mainnet,
send real SOL to it. See [Networks and costs](08-networks-and-costs.md) for how much.

### 2. A root file system

A root file system is "everything below `/`" of a Linux system, as a tar archive. The archive
may be plain, gzip, xz or zstd. Here are four ways to get one.

**From a distribution's download page.** Many distributions publish ready archives:

- Ubuntu base: https://cdimage.ubuntu.com/ubuntu-base/releases/
- Alpine "mini root filesystem": https://alpinelinux.org/downloads/
- Arch Linux bootstrap, Void Linux ROOTFS, Gentoo stage3, and others

```sh
curl -LO https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/alpine-minirootfs-3.24.4-x86_64.tar.gz
chainboot publish alpine-minirootfs-3.24.4-x86_64.tar.gz --name alpine --version 3.24.4 \
  --description "Alpine Linux 3.24" --source-url https://dl-cdn.alpinelinux.org/... --keypair me.json
```

**From a machine you set up by hand.** This is the easiest way to make something of your own:

```sh
chainboot run solinux-minimal --name mybox --no-autosave
#   ... install and configure what you need, then exit ...
chainboot export mybox mybox.tar
chainboot publish mybox.tar --name mybox --version 1.0 --reuse solinux-minimal --keypair me.json
```

**From Debian's `debootstrap`:**

```sh
sudo debootstrap --variant=minbase trixie ./rootfs
sudo tar -C rootfs -cf debian.tar .
```

**From a Docker image:**

```sh
docker export $(docker create debian:stable-slim) > debian.tar
```

### 3. Publish

```sh
chainboot publish debian.tar --name debian --version 13 --description "Debian 13, minimal" --keypair me.json
```

```
image         debian:13 (amd64)
digest        4c1f…
contents      6204 entries, 78.1 MB unpacked
to upload     19.8 MB in 1 pack(s)
transactions  about 5230
cost          about 0.0262 SOL on devnet
Publisher 7xQ… holds 1.0000 SOL
Publish now? [y/N]
```

Add `--dry-run` to see these numbers without a keypair and without sending anything.

Options:

| Option | Meaning |
|---|---|
| `--name` | image name: lower-case letters, digits, `.`, `_`, `-` |
| `--version` | version text, for example `1.0` or `26.04.1` |
| `--arch` | processor type of the system: `amd64`, `arm64`, `riscv64`, ... (default: this computer's) |
| `--tag` | tags to publish under (repeatable). Default: the version and `latest` |
| `--description` | one line shown in `chainboot list` |
| `--source-url` | where the archive came from, recorded so others can check |
| `--reuse <image>` | do not store files again that this image already has on chain (repeatable) |
| `--cmd "<command>"` | what `chainboot run` starts instead of a login shell |
| `--keypair` | the publisher key that pays |
| `--dry-run`, `--yes` | only show the cost / do not ask |

If the upload is interrupted, run the same command again. It continues where it stopped and
does not pay twice for what already landed.

## Several processor types

Publish the same name and version once per architecture:

```sh
chainboot publish ubuntu-base-amd64.tar.gz --name mylinux --version 1.0 --arch amd64 --keypair me.json
chainboot publish ubuntu-base-arm64.tar.gz --name mylinux --version 1.0 --arch arm64 --keypair me.json
```

`chainboot run` picks the right one for each user.

## Reusing what is already on chain

`--reuse solinux-minimal` tells chainboot to look at that image first. Every file of your
system that is byte-for-byte identical to a file in it is referenced instead of uploaded.
A system built on top of Solinux minimal that adds 30 MB of software costs 30 MB, not 120 MB.

The reused image can belong to any publisher. Readers check its packs by hash, so they do
not have to trust that publisher.

## Updating and removing

Publishing again under the same name and tag moves the tag to the new image. Machines that
people already created keep using the image they were made from.

```sh
chainboot unlist mylinux:1.0 --keypair me.json     # remove one tag
chainboot unlist mylinux --keypair me.json         # remove the image from your catalog
```

Unlisting removes the entry from your catalog. The data stays on the ledger, and whoever
knows the manifest's signature can still fetch it. **Do not publish secrets.**

## What makes a good image

- **No secrets.** No private keys, passwords or tokens. `chainboot export` already leaves
  out SSH host keys, `~/.ssh`, shell history, logs and the machine ID.
- **Small.** Clean package caches before exporting (`apt-get clean`). Caches in the usual
  places are left out automatically.
- **Honest metadata.** Fill in `--description` and `--source-url`. The manifest also records
  the SHA-256 of the archive you published from.
- **Reproducible.** The image's digest depends only on its files. Tell people how you built
  the archive, and they can rebuild it and compare digests with `chainboot publish --dry-run`.

## Showing your catalog to others

```sh
chainboot list <your-address>
chainboot run <your-address>/mylinux
```

In the web interface, "Look at another publisher" does the same.

Next: [The SDK](06-sdk.md).
