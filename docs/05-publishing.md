# Publishing your own system

Anyone can publish a Linux system with chainboot. You need a root file system as a tar
archive and one command.

**Images are private by default.** `chainboot publish` encrypts the system for your wallet
alone, because what is written to a ledger can never be erased and a mistake must not expose
anything. Publishing for everyone is a deliberate step: you add `--public` and a publisher
key. This page explains the public case first, then [private images](#private-images-for-your-wallet-only).

## The one command (public)

```sh
chainboot publish rootfs.tar.gz --name mylinux --version 1.0 --public --keypair me.json
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
  --description "Alpine Linux 3.24" --source-url https://dl-cdn.alpinelinux.org/... --public --keypair me.json
```

**From a machine you set up by hand.** This is the easiest way to make something of your own:

```sh
chainboot run solinux-minimal --name mybox --no-autosave
#   ... install and configure what you need, then exit ...
chainboot export mybox mybox.tar
chainboot publish mybox.tar --name mybox --version 1.0 --reuse solinux-minimal --public --keypair me.json
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
chainboot publish debian.tar --name debian --version 13 --description "Debian 13, minimal" --public --keypair me.json
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

Add `--dry-run` to see these numbers without a keypair and without sending anything. The
summary also states the visibility, and a public upload asks once more before it starts.

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
| `--public` | publish for everyone, unencrypted (without it the image is private) |
| `--keypair` | with `--public`: the publisher key that pays |
| `--dry-run`, `--yes` | only show the cost / do not ask |

If the upload is interrupted, run the same command again. It continues where it stopped and
does not pay twice for what already landed.

## Several processor types

Publish the same name and version once per architecture:

```sh
chainboot publish ubuntu-base-amd64.tar.gz --name mylinux --version 1.0 --arch amd64 --public --keypair me.json
chainboot publish ubuntu-base-arm64.tar.gz --name mylinux --version 1.0 --arch arm64 --public --keypair me.json
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

## Private images: for your wallet only

Without `--public`, an image is published for you alone:

```sh
chainboot login                                   # once: your wallet signs one message
chainboot fund 0.05                               # your vault pays for the upload
chainboot export mybox mybox.tar
chainboot publish mybox.tar --name mybox --version 1.0 --reuse solinux
chainboot run me/mybox                            # on any computer where you are signed in
chainboot list me                                 # your private images
chainboot unlist me/mybox
```

What "private" means exactly:

- **Encrypted before upload.** The contents of your files, and the manifest with every file
  name, size and hash, are encrypted with AES-256-GCM. The key is derived from your wallet's
  signature of the login message, the same key that protects your saves.
- **Not listed anywhere public.** The image goes into a private catalog that is itself
  encrypted. `chainboot list` of your address shows nothing; only `chainboot list me` does,
  and only when you are signed in with the same wallet.
- **Signed by your vault.** Readers of your private catalog accept nothing that another key
  wrote, so nobody can slip an image into it.
- **Only what is new is uploaded.** With `--reuse`, files that are identical to files of a
  public image (the Ubuntu base, for example) are referenced from that image. They are public
  anyway, and nothing on chain links your private image to them. A private system built on
  Solinux costs only what you added.

No `--keypair` is used: a private image is paid and signed by your vault, so the vault needs
enough SOL (`chainboot fund`, `chainboot whoami`).

What it does not mean:

- **Only your wallet can read it, until you share it.** `chainboot share me/<image> --with
  <share address>` gives one other wallet the keys of that image (and of nothing else of
  yours). They keep it with `chainboot shared accept` and run it as `me/<name>`. A share
  cannot be taken back. See [Sharing](04-saving.md#sharing-a-machine-with-someone-else).
- **It cannot be erased.** The encrypted data stays on the ledger. If your wallet's signature
  of the login message ever leaks, the image can be read. `unlist` only removes the entry.
- **On your computer it is plain.** After downloading, the system is unpacked on your disk
  like any other, so that it can run. The download cache keeps the encrypted form.
- **Size and timing are visible.** Anyone can see that your vault account stored some
  amount of data at some time, as with saves.

Machines made from a private image are saved and restored like all others; restoring one
needs the same wallet, because the image itself has to be fetched again. A public image
cannot reuse files of a private one (`--reuse`): that would publish their keys.

## Lists: a catalog that several publishers keep together

A catalog is signed by one key. Everybody who runs images from it trusts whoever holds that
key. A **list** spreads this over several keys. It names its publishers and how many of
them must agree:

```
list:2:<address of A>,<address of B>,<address of C>        two of these three
```

An image is part of the list when that many of its publishers have the same image (the same
content, compared by its digest) under the same name, tag and architecture in their own
catalogs. Nothing extra is stored for a list; it is a way of reading catalogs that exist.
More than half of the publishers must agree, so two different images can never both
qualify, and one lost or stolen key can neither add an image nor replace one.

Using a list:

```sh
chainboot publisher add team list:2:9xQe...,4Zb7...,Hk3P...   # save it under a short name
chainboot list team                                           # what it contains, and who agreed
chainboot run team/solinux
```

Keeping a list, as one of its publishers:

```sh
# publisher A uploads the image as usual
chainboot publish rootfs.tar --name mydistro --version 1.0 --public --keypair a.json

# publishers B and C look at it, then add it to their own catalogs. Nothing is uploaded again.
chainboot pull 9xQe.../mydistro:1.0             # download and verify, inspect it as you see fit
chainboot endorse 9xQe.../mydistro:1.0 --keypair b.json
chainboot endorse 9xQe.../mydistro --keypair b.json           # the "latest" tag, separately
```

`chainboot list team` shows each publisher's catalog, the images enough of them agree on,
and the ones still waiting for more publishers.

Updates need the same agreement. A tag that moves, such as `latest`, changes for the users
of the list only when enough publishers have moved it to the same new image. While they
disagree, the tag is held back, so move it in a set order, or keep one publisher more than
the list needs. Tags that name a version do not move and are not affected.

`chainboot publisher add <name> <address>` also saves a single publisher under a short name.

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
