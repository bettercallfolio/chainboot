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
root@ubuntu:~# exit
Changes are saved to Solana in the background. Check with: chainboot status
```

```sh
chainboot status
```

```
machine   state    saved to chain  autosave  last save
ubuntu  stopped  saved (#12)     on        2026-11-13 21:26 UTC
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
chainboot save ubuntu
chainboot save ubuntu --note "before the upgrade"      # the note is shown by "chainboot history"
```

A save that is interrupted (a closed terminal, a lost connection) continues when you save
again: what already reached the chain is found there, also transactions that were on their
way at that moment, and is not sent or paid for a second time.

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

Extended attributes of changed files (file capabilities, ACLs, `user.*` attributes) are saved
and restored when the `getfattr`/`setfattr` tools (package `attr`) or Python 3 are available
where chainboot runs. Without either, they are left out and everything else works the same.

## Continue on another computer

```sh
chainboot rpc add <endpoint>
chainboot login
chainboot run ubuntu
```

chainboot notices that you have a saved machine named `ubuntu`, downloads the image and
your latest save, and opens it. To see everything you have saved:

```sh
chainboot restore                         # list saved machines
chainboot restore ubuntu                # bring one back without opening it
```

When you go back to the first computer and run the machine there, chainboot sees that the
chain holds a newer save and updates the machine before opening it.

## Going back in time

Every save is kept. List them and return to any one:

```sh
chainboot history ubuntu
chainboot restore ubuntu --snapshot 7
```

`history` lists the newest save and the 200 before it; older ones are still there, and
`--snapshot` reaches them too. While a machine is being restored, what it held before is set
aside, and comes back if the restore does not go through (no network, a damaged save): a
failed restore leaves the machine as it was.

## When two computers disagree

If you change a machine on computer A without saving, and meanwhile save from computer B,
there are two different versions. chainboot never picks one silently. It knows which save a
computer is in step with by that save's address on chain, not by its number, and it looks at
the chain once more just before a new save takes effect, so two computers that save at the
same moment cannot both believe they are the newest:

```
! A newer save of this machine is on chain, but this copy also has changes that were not saved.
  Take the newer one with "chainboot restore ubuntu", or keep this copy with "chainboot save ubuntu --force".
```

## Sharing a machine with someone else

You can give another wallet the newest save of a machine. Nothing is uploaded again: the
other person receives the keys of exactly that save, in a message only they can read. It
costs you one transaction.

The receiver first tells you their **share address**, which `chainboot whoami` shows:

```sh
chainboot whoami
# ...
# share address  share_7Yk3...
```

A share address is not a wallet address. A wallet can sign, but it cannot decrypt, so
chainboot gives every login a separate address for receiving. It is safe to pass around: it
lets people send you things, nothing more.

```sh
# you
chainboot share web --with share_7Yk3... --note "the demo server"

# the receiver
chainboot shared                    # what arrived, and from which share address
chainboot shared accept 1           # keep it, by its number or by its id (add --name <name> to store it under another name)
chainboot run web                   # it is brought to their computer like any saved machine
```

What to know:

- **It is a copy at this moment.** The machine becomes the receiver's own. Their later saves
  do not reach you, and yours do not reach them. To send a newer state, share again.
- **It cannot be taken back.** The data stays on the ledger and the receiver keeps the keys.
- **Only that save is opened.** Every object on chain has a key of its own; the receiver
  gets the keys of this one save. Your other machines, your earlier saves and your login
  stay closed to them.
- **A machine made from one of your private images** is shared together with that image,
  because it cannot run without it.
- **Check the sender.** The list shows the share address each item came from. That address is
  proven by the encryption; anybody can send you something, so compare it with the address
  the sender told you before you run what arrived.

Private images are shared the same way: `chainboot share me/<image> --with <share address>`
([Publishing](05-publishing.md#private-images-for-your-wallet-only)).

## Privacy

- Saves are encrypted with AES-256-GCM before they leave your computer. That covers file
  contents, file names, the list of machines and the pointers.
- Visible to everyone: that your vault account wrote data, how much, and when. When you
  share something, also that your vault account wrote one small message to an inbox; someone
  who knows the receiver's share address can tell that the inbox is theirs.
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
