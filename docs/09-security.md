# Security

This page says plainly what chainboot protects you from, what it does not, and what you
have to trust.

## What you trust

| You trust | For what |
|---|---|
| The **publisher** of an image | that the system does what it claims. You run their software as root. This is the same trust as installing any operating system. |
| **chainboot itself** and Node.js | that the program does what this documentation says. The source is open and small. |
| Your own computer | your login (encryption key and vault key) is stored on it. |
| Solana's cryptography (Ed25519, SHA-256) | signatures and hashes cannot be forged. |

## What you do not have to trust

**RPC endpoints.** They are the only servers involved, and chainboot treats them as
untrusted couriers:

- Catalogs, manifests, pointers and the structure of every file are accepted only with a
  valid signature of the publisher's key (for your saves: your vault's key).
- File contents must match a SHA-256 that comes from signed data.
- Unpacked images are checked file by file against the manifest before use.

An endpoint can be slow, refuse to answer, or return garbage. chainboot then asks another
one. An endpoint cannot make you run different software.

One thing a single endpoint could do is **show you an old state**: hide the newest
transactions, so that you see an older catalog or an older save of your machine, both of
which were once valid. chainboot therefore asks up to three of your endpoints for the newest
pointer and merges their answers. One honest, up-to-date endpoint is enough to see the newest
record, and since every record is checked by signature, an endpoint cannot add one. This is
a reason to configure endpoints of more than one provider: with a single endpoint there is
nobody to compare with.

**The network path.** Because of the above, it does not matter who can see or change the
traffic between you and an endpoint, as far as integrity goes. (They can still see which
data you fetch.)

## The publisher key

`chainboot run solinux` means "the image named solinux in the catalog of the official
publisher address". That address is written into chainboot. `chainboot run <address>/<image>`
names the publisher explicitly. Anyone can publish an image called `solinux` under their own
address, but it will never be confused with another publisher's, because the address is part
of the name.

When you run an image of a publisher you do not know, you are trusting a stranger with root
on your computer. chainboot shows the publisher address in `chainboot list <address>`; check it.

## Machines are not sandboxes

A machine separates processes and files for convenience, not for defence. Root inside a
machine can reach your computer's network, and with some effort its files. Treat an image
like any software you install.

How far root inside a machine reaches depends on how machines run on your Linux computer
(`chainboot engine` shows it):

- **Without administrator rights:** root inside a machine is you. A program in it can do
  what you can do (read your files, use your network), but it cannot administer the
  computer, read other people's files or load kernel modules.
- **Through `sudo`:** root inside a machine is root on your computer.

Running without administrator rights is the safer of the two and the default where the
computer allows it. On Ubuntu it needs a small AppArmor profile that lets one program in your
home directory (`~/.chainboot/bin/userns`, a copy of `unshare`) create user namespaces.
Because that file is yours, the profile in effect lifts Ubuntu's restriction on user
namespaces for your account; chainboot adds it only when you run `chainboot engine rootless`
and tells you where it is.

On Windows and macOS, machines run inside the chainboot engine (a WSL distribution, a
privileged container, or a Lima virtual machine). That adds a layer between a machine and
your own files, but chainboot does not promise isolation there either.

## Your saves

- Encrypted on your computer with AES-256-GCM before upload: contents, file names, the list
  of your machines and the pointers. Each kind of data is bound to its purpose, so a pack
  cannot be passed off as a snapshot.
- The key is derived from your wallet's signature of the login message. **Whoever gets that
  signature gets your saves.** That is why the message warns you, and why you must never
  sign it on a website.
- The login is stored in `~/.chainboot/vault/` with permissions for your user only. Someone
  who can read your home directory can read your saves and spend the vault's balance (never
  your wallet's). Keep only a small balance in the vault.
- Every stored object (each pack, each snapshot, each manifest) is encrypted with a key of
  its own, derived from your key and a random number in the object. **Sharing** hands
  another wallet the keys of one save or one image, encrypted to their share address. They
  can read that and nothing else of yours. A share cannot be taken back, and whoever receives
  it can pass it on.
- A share address only lets people send you things. Anybody can do that, so look at the
  share address an item came from (it is proven by the encryption, not merely stated) before
  you accept and run it: a shared system is software from someone else.
- Encrypted saves stay on the ledger forever. If the key leaks later, old saves become
  readable. Do not save things that must stay secret for decades.
- Published images are **private by default**: encrypted with the same key as your saves,
  listed only in your encrypted private catalog, and readable by your wallet alone. An image
  becomes public only when you publish it with `--public`. The same warnings apply:
  it cannot be erased, and it is as safe as your wallet's signature of the login message.
  Never publish a system that contains secrets as a public image.

## The web interface

`chainboot ui` starts a web server that:

- listens on `127.0.0.1` only, so other computers cannot reach it;
- requires a random token on every request. The token is in the link chainboot prints, and
  is sent in a custom header, so other websites open in your browser cannot call it;
- checks the `Host` header, which blocks DNS-rebinding tricks;
- sends a strict Content-Security-Policy and loads no outside scripts;
- never sends RPC URLs or keys to the page, only masked names;
- only accepts a wallet's signed transaction if it is exactly the transfer from your wallet
  to your vault that the page prepared.

Text that comes from the chain (image names and descriptions) is inserted into the page as
text, never as HTML.

## The installers

`install.sh` and `install.ps1` run without administrator rights and write only into your
home directory. The Node.js they may download is checked against SHA-256 values written into
the installer. The chainboot archive is checked against the checksum published next to it,
which protects against a broken download; its authenticity rests on GitHub and HTTPS. If
you want more, build from source: `git clone`, `npm ci`, `npm run build`.

## Reporting a problem

If you find a security problem, please write to hello@chainboot.dev, or open a private
security advisory on the GitHub repository, instead of a public issue.

Next: [Ideas and roadmap](10-ideas-and-roadmap.md).
