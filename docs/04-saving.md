# Saving to chain

Sign in with a wallet and chainboot saves your machines to Solana: encrypted, automatically,
and in a way that lets you continue on any computer.

## The idea in four sentences

Your wallet signs one fixed message. From that signature chainboot derives an encryption key
and a small helper account, the **vault**. Everything saved is encrypted with the key, and
the vault pays the tiny fees and signs the saves, so your wallet is not asked again. On
another computer the same wallet produces the same signature, therefore the same key and the
same vault, and your machines are there.

## Sign in

With a browser wallet (Phantom, Solflare, Backpack, or any wallet that supports the Wallet
Standard):

```sh
chainboot login
```

A page opens in your browser. Choose your wallet. It shows you the message; approve it. The
message is not a transaction and costs nothing. This is the text:

```
chainboot: unlock my saved machines

Signing this message creates the key that encrypts and restores your machines on Solana.
Only sign it inside chainboot. A website that asks for this signature could read your saved machines.

This is not a transaction and costs nothing.
Version: 1
```

On a server without a browser, sign in with a keypair file instead:

```sh
chainboot login --keypair ~/my-wallet.json
```

**Take the warning in the message seriously.** That signature is the master key to your
saved machines. Never sign this text on a website.

## Put a little SOL into the vault

Saving costs transaction fees. The vault pays them, so it needs a small balance:

```sh
chainboot fund 0.05                          # from your browser wallet
chainboot fund 0.05 --keypair wallet.json    # from a keypair file
chainboot whoami                             # wallet, vault address, vault balance
```

0.05 SOL pays for about 39 MB of saved data (after compression). A typical session that
installs a few packages costs well under 0.001 SOL.

## Automatic saving

Once you are signed in, nothing more is needed. When a session ends, chainboot checks in the
background what changed and saves it. A machine that stays up for a long time is also saved
every 10 minutes while it runs (a save with nothing new sends nothing and costs nothing).

```
root@solinux:~# exit
Changes are saved to Solana in the background. Check with: chainboot status
```

```sh
chainboot status
```

```
machine   state    saved to chain  autosave  last save
solinux  stopped  saved (#12)     on        2026-11-13 21:26 UTC
```

Rules of automatic saving:

- Only content that is not on chain yet is uploaded. Files that an earlier save already
  stored, or that are identical to files of the image, are referenced, not repeated.
- A save that would cost more than **0.05 SOL** is not made automatically. `chainboot status`
  then says "waiting for you", and `chainboot save <machine>` shows the cost and asks.
- If the vault does not hold enough SOL, nothing is sent and `status` tells you.
- Turn it off or on per machine: `chainboot autosave <machine> off`.

Save by hand at any time:

```sh
chainboot save solinux
chainboot save solinux --note "before the upgrade"
```

## What is saved, and what is not

Saved: everything that differs from the image. Installed and removed packages, your files,
configuration, users, deletions.

Not saved, on purpose:

| Left out | Why |
|---|---|
| `/tmp`, `/run`, `/var/tmp`, `/proc`, `/sys`, `/dev` | temporary or provided by the system at start |
| package manager caches (`/var/lib/apt/lists`, `/var/cache/apt`, and the same for apk, dnf, pacman, zypper) | large, and rebuilt by the next `apt update` |
| `~/.cache` | rebuilt by the programs that use it |
| `/etc/resolv.conf`, `/etc/hosts`, `/etc/hostname` | provided by chainboot at start |
| single files larger than 1 GiB | a transaction ledger is the wrong place for them |
| files whose name is not valid UTF-8 | cannot be listed in the manifest |

Not preserved yet: extended attributes of changed files (rarely used; file capabilities are
the main example).

## Continue on another computer

```sh
chainboot rpc add <endpoint>
chainboot login
chainboot run solinux
```

chainboot notices that you have a saved machine named `solinux`, downloads the image and
your latest save, and opens it. To see everything you have saved:

```sh
chainboot restore                         # list saved machines
chainboot restore solinux                # bring one back without opening it
```

When you go back to the first computer and run the machine there, chainboot sees that the
chain holds a newer save and updates the machine before opening it.

## Going back in time

Every save is kept. List them and return to any one:

```sh
chainboot history solinux
chainboot restore solinux --snapshot 7
```

## When two computers disagree

If you change a machine on computer A without saving, and meanwhile save from computer B,
there are two different versions. chainboot never picks one silently:

```
! A newer save of this machine is on chain, but this copy also has changes that were not saved.
  Take the newer one with "chainboot restore solinux", or keep this copy with "chainboot save solinux --force".
```

## Privacy

- Saves are encrypted with AES-256-GCM before they leave your computer. That covers file
  contents, file names, the list of machines and the pointers.
- Visible to everyone: that your vault account wrote data, how much, and when.
- Files that are identical to files of the public image are not uploaded at all.
- Your wallet address is never written to the chain by chainboot. The vault is a different
  account. The only public link between them is the transfer you make when you fund the vault.

## Things to know before you rely on it

- **Ledger data cannot be erased.** Deleting a file and saving again removes it from the new
  save, but the old encrypted save stays on chain. If your wallet's signature of the login
  message ever leaks, old saves can be read.
- **The login lives in `~/.chainboot/vault/`.** Anyone who can read that folder can read
  your saves and spend the vault's balance. `chainboot logout` deletes it from this computer.
- **Use the same wallet app everywhere.** The key comes from the signature. Software
  wallets (Phantom, Solflare, Backpack, a keypair file) all sign the plain message and agree
  with each other. A hardware wallet may sign in a different format and then leads to a
  different vault.
- **Devnet is not permanent.** Use it to try things out.

Next: [Publishing your own system](05-publishing.md).
