# Questions and problems

## Questions

**Is the operating system really on the blockchain?**
Yes. Every byte of every file is inside Solana transactions. There is no link to a file
server, no IPFS, no cloud bucket. You can check: `chainboot pull solinux` talks only to the
RPC endpoints you configured.

**Then what do I download when I install chainboot?**
The program that reads the chain: one JavaScript file of about 250 kB, plus Node.js if you
do not have it. On Windows and macOS also a small Linux environment to run machines in. The
systems you run come from the chain.

**Why do I need my own RPC endpoint?**
Because there is no chainboot server, and that is the point. An endpoint is your door to the
network. Free plans are enough.

**Is it slow?**
No. Programs run directly on your processor. Download speed depends on your endpoints:
about a second for Ubuntu minimal with one keyed endpoint.

**What does it cost?**
Running and reading: nothing. Publishing or saving: 0.000005 SOL per transaction, about
0.0013 SOL per megabyte. See [Networks and costs](08-networks-and-costs.md).

**Can I delete something I published or saved?**
You can remove it from your catalog or stop pointing at it. You cannot erase it from the
ledger. Saves are encrypted; images are public.

**Is Solinux an official Ubuntu?**
No. It is Canonical's official Ubuntu base archive, unchanged, plus for the larger edition
packages installed from Ubuntu's own repositories. The packaging on chain is this project's
and is not affiliated with Canonical.

**Can I run graphical programs?**
A machine is a command-line system. Programs that offer a web interface work (the machine
shares your network).

**Does it work offline?**
Machines you already have start without any network. Downloading, saving and restoring need
your endpoints.

**Which wallets work?**
Any wallet that supports the Wallet Standard with message signing: Phantom, Solflare,
Backpack and others. Or a keypair file.

**I lost access to my wallet. Can I get my saves back?**
Only with the wallet's key, or with the folder `~/.chainboot/vault` from a computer where
you were signed in. There is no recovery service, because nobody else has your key.

## Problems

**`No RPC endpoint is configured yet`**
Add one: `chainboot rpc add <url>`. See [Getting started](01-getting-started.md).

**`none of the configured RPC endpoints is usable`**
Run `chainboot rpc test`. It shows for each endpoint whether it answers and which network it
serves. Typical causes: a typo in the API key, a mainnet URL while chainboot is on devnet,
or a used-up free quota ("rate limited").

**Downloads are slow**
You are probably using only a public endpoint. Add an endpoint with an API key, or several.

**`image "…" was not found in the catalog of …`**
Check the name with `chainboot list`. Images of other publishers need the address:
`chainboot run <address>/<image>`. Also check `chainboot network`: images live on one network.

**`these tools are needed but not installed: unshare …`**
Install `util-linux` and `coreutils` with your package manager.

**`sudo` asks for my password every time**
Starting a machine mounts a file system, which normally needs administrator rights. Run
`chainboot engine rootless` once: it sets your computer up to run machines without them, and
no password is asked after that ([Machines](03-machines.md#with-or-without-administrator-rights)).
If you stay with `sudo`, it remembers the password for a few minutes.

**A server inside the machine cannot use port 80 or 22**
Without administrator rights, programs cannot listen on ports below 1024. Use a higher port
(8080, 2222), or run machines through `sudo` (`chainboot engine sudo`).

**I have no administrator rights on this computer at all**
Machines then need the rootless way to be ready: `chainboot engine` tells you what is
missing. On most distributions nothing is; on Debian and Ubuntu an administrator has to
install the `uidmap` package once (and, on recent Ubuntu, allow user namespaces).

**`systemctl` says "System has not been booted with systemd"**
An ordinary machine starts with a shell only. Create one that boots
(`chainboot run solinux --boot --name server`), or turn it on for an existing machine with
`chainboot boot <machine> on` ([Machines](03-machines.md#machines-that-boot)).

**Can I run it on a real computer, without chainboot?**
Yes. `chainboot disk <machine> disk.img` writes a machine out as a bootable disk with its own
kernel, for a PC or a virtual machine with UEFI firmware
([Machines](03-machines.md#from-a-machine-to-the-disk-of-a-real-computer)).

**A server inside the machine does not start**
The machine shares your computer's network. If the port is already used by your computer
(port 22 by its own SSH server, for example), choose another port inside the machine.

**`chainboot status` says "vault needs SOL"**
`chainboot fund 0.05` (or with `--keypair`). `chainboot whoami` shows the balance.

**`chainboot status` says "waiting for you"**
The save would cost more than automatic saves may spend. `chainboot save <machine>` shows the
cost and asks.

**`… was saved from another computer after this one last synced`**
Two computers changed the same machine. Take the version on chain with `chainboot restore
<machine>`, or keep the local one with `chainboot save <machine> --force`.

**`could not decrypt: wrong wallet, or the data was changed`**
You are signed in with a different wallet than the one that made the save, or with a wallet
app that signs messages in a different format. Sign in with the same wallet app.

**The page of `chainboot ui` says it is "not connected any more"**
Each start of `chainboot ui` creates a new secret link. Use the link it just printed.

**On Windows: `chainboot needs WSL 2`**
Open PowerShell as administrator, run `wsl --install --no-distribution`, restart.

**On macOS: `needs a Linux engine`**
Install OrbStack, Docker Desktop, Podman or Lima and run the command again.

**Something else**
Run the command with the environment variable `CHAINBOOT_DEBUG=1` to see where the error
comes from, and open an issue with that output or write to hello@chainboot.dev. Never paste
your endpoint URLs or key files.

Next: [Thank you](12-thanks.md).
