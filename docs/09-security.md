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
transactions, or list an old record as if it were the newest, so that you see an older
catalog or an older save of your machine, both of which were once valid. chainboot does
three things about it:

- It asks up to three of your endpoints for the newest pointer and merges their answers, so
  one that hides something is filled in by the others.
- Every pointer carries a sequence number that its writer signed. Between two genuine
  records, that number says which is the newer one; where an endpoint claims a record lies
  in the chain does not. A record must also name, in its own signed transaction, the address
  it is listed under, so a genuine record from somewhere else cannot be passed off either.
- "There is no record" is never a guess. An empty answer is believed only from two
  endpoints (where you have two), and when the history of an address cannot be read,
  chainboot stops with an error. A publish or a save that started from a wrong "nothing
  there" would write a catalog or a list without your earlier entries.

One honest, up-to-date endpoint is therefore enough to see the newest record, and since
every record is checked by signature, an endpoint cannot add one. This is a reason to
configure endpoints of more than one provider: with a single endpoint there is nobody to
compare with.

**Strangers writing under your address.** The address a pointer is found under is public,
and anybody can send transactions that mention it. They are never taken for yours (they are
not signed by your key), but thousands of them push your own record further back in the
history, which makes it slower to find; chainboot searches the newest 12,000 transactions
and stops with an error beyond that, it does not conclude that you have nothing. A pointer
kept in an account (`chainboot accounts on`) is not affected at all: nobody else can write
to your account. Publishers of catalogs that others depend on should turn it on.

**Pointers in accounts.** A publisher or a vault may also keep its newest pointer in an
account ([Networks and costs](08-networks-and-costs.md#accounts-a-deposit-instead-of-a-fee)).
What an endpoint says about an account cannot be checked the way a transaction can, so the
record in the account carries the owner's signature and names its tag: an endpoint can show
an older record, as it can hide a newer transaction, but it cannot make one up or move one
to another name. Anything that does not verify is ignored and the transactions are read;
when your endpoints disagree on whether the account exists at all, both the account and the
transactions are read and the record with the higher sequence number is taken.

**The network path.** Because of the above, it does not matter who can see or change the
traffic between you and an endpoint, as far as integrity goes. (They can still see which
data you fetch.)

## What comes from other people

Three kinds of data on your computer were written by somebody else, and chainboot treats
each as possibly hostile:

- **An image** from a publisher you chose to run. Its files run inside the machine, which is
  the point; what must not happen is that the image reaches outside of it while the machine
  is being set up or unpacked. Paths are checked (no absolute paths, no `..`, no parent that
  is a symbolic link), and an image in which `/etc`, `/proc`, `/sys`, `/dev`, `/run` or `/tmp`
  is a symbolic link is refused, because chainboot itself creates and mounts things there
  before the machine has a root directory of its own. The command an image starts with is
  part of its digest: nobody can attach another command to an image you (or a list's
  publishers) agreed on.
- **A machine or an image that another wallet shared with you.** The record is rebuilt from
  fields that were each checked, and nothing else of it is kept. A shared save is checked as
  a whole before it becomes yours, and again when it is restored: every path once, inside
  the machine, every file inside its pack and matching its hash. Restoring runs with full
  rights over the machine's files, so this is where a save could otherwise set the mode of
  a file outside the machine, or write through a link.
- **A catalog** of a publisher, or of the members of a list. Entries that are not well formed
  are left out; they cannot make a list unreadable or put anything into your terminal that
  is not plain text.

## The publisher key

`chainboot run ubuntu` means "the image named ubuntu in the catalog of the official
publisher address". That address is written into chainboot. `chainboot run <address>/<image>`
names the publisher explicitly. Anyone can publish an image called `ubuntu` under their own
address, but it will never be confused with another publisher's, because the address is part
of the name.

When you run an image of a publisher you do not know, you are trusting a stranger with root
on your computer. chainboot shows the publisher address in `chainboot list <address>`; check it.

Saving a name for a publisher (`chainboot publisher add`) says that you trust it a little
more: machines from its images are told your RPC endpoints
([What a machine is](03-machines.md#what-a-machine-is-exactly)). Machines from publishers
without a saved name are not.

A catalog depends on one key. A **list** ([Publishing](05-publishing.md#lists-a-catalog-that-several-publishers-keep-together))
depends on several: an image counts only when more than half of the list's publishers have
the same content under the same name. Someone who steals one of the keys can then neither
add a system nor swap one. What a list does not protect against is its publishers agreeing
on something bad, or enough of their keys being taken at once.

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

- runs only a fixed set of chainboot commands for the page, and never one that names a
  keypair file.

Text that comes from the chain (image names and descriptions, the notes of shares) is
inserted into the page as text, never as HTML.

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
