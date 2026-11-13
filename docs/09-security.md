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

One thing an endpoint can do: **show you an old state**. If it hides the newest transactions,
you see an older catalog or an older save of your machine, both of which were once valid.
Today chainboot asks one endpoint for the newest pointer; asking several and taking the
newest answer is on the roadmap. If freshness matters to you, use endpoints you have reason
to trust.

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
- Encrypted saves stay on the ledger forever. If the key leaks later, old saves become
  readable. Do not save things that must stay secret for decades.
- Publishing an image is different: images are **public**. Never publish a system that
  contains secrets.

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

If you find a security problem, please open a private security advisory on the GitHub
repository instead of a public issue.

Next: [Ideas and roadmap](10-ideas-and-roadmap.md).
