# Machines

A **machine** is an image plus everything you changed in it. This page covers daily use.

## Create and open

```sh
chainboot run solinux                  # first time: download, create, open. Later: just open.
chainboot run solinux -- uname -a      # run one command instead of a shell
chainboot run solinux --name web       # another machine from the same image
chainboot run web                       # open a machine by its name
```

The machine is named after the image unless you choose a name. Inside, you are `root`.
The shell starts in `/root`, like a fresh SSH session.

Options of `run`:

| Option | Meaning |
|---|---|
| `--name <machine>` | name of the machine to create or open |
| `--arch <arch>` | take the image for another processor type (see "Other processor types") |
| `--no-autosave` | create the machine with automatic saving turned off |
| `--fresh` | when signed in: do not bring back a saved machine with this name |
| `-- <command>` | run this command instead of a shell; its exit status becomes chainboot's |

## Several terminals, one machine

Open a second terminal and run the same command: you are in the same machine, and both
terminals see the same files and processes. The machine stops by itself a moment after the
last terminal leaves.

## Keep a machine running

For something that should stay up without an open terminal, such as a web server:

```sh
chainboot start web        # stays up until you stop it
chainboot run web -- service nginx start
chainboot stop web
```

### Starting services automatically

A machine does not boot the way a physical computer does: there is no systemd running as the
first process. If a machine contains an executable file `/etc/chainboot/start`, chainboot
runs it every time the machine starts. Put your service starts there:

```sh
cat > /etc/chainboot/start <<'SH'
#!/bin/sh
service nginx start
cd /srv/app && nohup ./my-server --port 8080 >/var/log/my-server.log 2>&1 &
SH
chmod +x /etc/chainboot/start
```

Its output goes to `~/.chainboot/machines/<name>/start.log` on your computer.

## What a machine is, exactly

- **Your processor, your kernel.** Programs run natively. There is no emulation and no
  virtual hardware, so speed is that of your computer.
- **Its own file system.** The image is mounted read-only with your changes on top.
- **Its own process list and hostname.** `ps` shows only the machine's processes.
- **Your network.** The machine shares your computer's network connection. A server that
  listens on port 8080 inside the machine is reachable on port 8080 of your computer.
  The other side of this: a port that your computer already uses is taken. If your computer
  runs its own SSH server on port 22, an SSH server inside the machine must use another
  port (set `Port 2222` in `/etc/ssh/sshd_config`). On macOS with a container engine, the
  machine's ports are reachable inside the engine only.
- **Fresh `/tmp` and `/run` at every start**, like after a reboot.
- **Its own SSH host keys and machine ID**, created at first start (images do not carry them).

What a machine is **not**:

- **Not a security sandbox.** Root inside a machine is root on your computer (on Windows and
  macOS: root inside the chainboot engine). Run only images you trust, like you would only
  install software you trust.
- **Not a virtual machine.** It cannot load kernel modules or run a different kernel.
- **Not booted by systemd.** `systemctl` cannot start services; use `service <name> start`
  or call the program directly.

## Other processor types

Images are published per processor type (`amd64` for Intel/AMD, `arm64` for ARM such as
Apple silicon or Raspberry Pi). chainboot picks the one that fits your computer.

On Linux you can also run an image built for a different processor if QEMU user emulation is
installed (`sudo apt install qemu-user-static binfmt-support` on Debian and Ubuntu):

```sh
chainboot run solinux-minimal --arch arm64 --name armbox
```

This is emulation, so it is much slower. It is useful for building and testing.

## Housekeeping

```sh
chainboot machines              # all machines and whether they run
chainboot stop <machine>        # stop a running machine (open terminals in it are closed)
chainboot rm <machine>          # delete a machine and all its changes on this computer
chainboot images                # downloaded images and which machines use them
chainboot rmi <image>           # delete a downloaded image
```

Deleting a machine here does not touch its saves on chain.

## Turning a machine into an image

When a machine is set up the way you like it, you can make it an image and publish it:

```sh
chainboot export web web.tar
chainboot publish web.tar --name web --version 1.0 --reuse solinux --keypair me.json
```

`export` writes the machine's complete file system as a tar archive. It leaves out what
must not be shared or is rebuilt anyway: SSH host keys, `~/.ssh`, shell history, logs, the
machine ID, temporary files and package caches. Details are in
[Publishing your own system](05-publishing.md).

Next: [Saving to chain](04-saving.md).
