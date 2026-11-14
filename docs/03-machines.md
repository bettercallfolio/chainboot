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

An ordinary machine does not boot the way a physical computer does: there is no systemd
running as the first process. (A machine can also boot for real: see
[Machines that boot](#machines-that-boot) below.) If a machine contains an executable file
`/etc/chainboot/start`, chainboot runs it every time the machine starts. Put your service
starts there:

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

- **Not a security sandbox.** Root inside a machine is you (without administrator rights),
  root on your computer (through `sudo`), or root inside the chainboot engine (Windows and
  macOS). Run only images you trust, like you would only install software you trust.
- **Not a virtual machine.** It cannot load kernel modules or run a different kernel.
- **Not booted by systemd, unless you ask.** In an ordinary machine `systemctl` cannot start
  services; use `service <name> start` or call the program directly. A machine created with
  `--boot` starts systemd and behaves like a server ([Machines that boot](#machines-that-boot)).

## Machines that boot

An ordinary machine starts with a shell and nothing else, which is fast and enough for most
work. A machine that **boots** starts the image's own init system, systemd, as its first
process, the way a server does:

```sh
chainboot run solinux --boot --name server
root@server:~# systemctl status                 # a whole system is up
root@server:~# apt install -y nginx             # the service starts by itself
root@server:~# systemctl status nginx
root@server:~# journalctl -u nginx
```

Services start in the right order, `systemctl` and `journalctl` work, timers run, and
packages that bring a service have it running after installation. For an existing machine,
`chainboot boot <machine> on` (or `off`) changes how it starts next time.

What is different from an ordinary machine:

- **It keeps running after you leave**, like a server, until `chainboot stop <machine>`,
  which shuts the system down in an orderly way. `chainboot machines` shows what is up.
- **Each session is a service of the machine's systemd.** Programs you leave in the
  background end with the session. Make long-running work a service:
  `systemd-run --unit myjob ./my-server`, or a unit file.
- **The first session takes about two seconds longer**, because a whole system starts.
- **The system log stays in memory.** `journalctl` works, but the journal is not written to
  disk, so that saves do not upload a log again and again. `/var/log` text logs are kept.
- **The network.** Without administrator rights and with `pasta` installed (package `passt`),
  the machine has a network of its own: its services can use every port, also 22 and 80,
  without getting in the way of this computer's. A port opened in the machine is opened on
  this computer too when that is allowed (ports from 1024 up, if they are free), so a server
  on port 8080 inside is reachable on port 8080 of your computer as before. In every other
  case the machine shares this computer's network, as ordinary machines do.
- **It is kept away from this computer's own settings.** The system inside cannot set the
  clock, load kernel modules or change kernel settings, and when it shares this computer's
  network it cannot reconfigure it. Its firewall service, for example, starts but changes
  nothing outside.

What it needs: an image with an init system (Solinux has systemd; `solinux-minimal` and
`alpine` do not), cgroup v2 (every current distribution), and, without administrator rights,
a systemd user session, which a normal login gives you. Saving, restoring and exporting work
the same; a restore stops the machine first.

## From a machine to the disk of a real computer

A machine borrows the kernel of the computer it runs on. A real computer, or a virtual
machine, needs a disk with a kernel of its own, a boot loader and a partition table.
`chainboot disk` writes a machine out as such a disk:

```sh
chainboot run solinux --name pc
root@pc:~# apt install -y linux-image-virtual systemd-boot-efi mtools dosfstools fdisk
root@pc:~# passwd                     # somebody must be able to log in on the new computer
root@pc:~# exit

chainboot disk pc pc.img              # about 20 seconds
```

`pc.img` is a complete disk: a GPT partition table, an EFI system partition with systemd-boot,
the kernel and its initrd, and an ext4 partition with the machine's whole file system. It
boots wherever there is UEFI firmware:

```sh
# in a virtual machine (QEMU; the package "ovmf" has the firmware)
qemu-system-x86_64 -m 2G -bios /usr/share/ovmf/OVMF.fd -drive file=pc.img,format=raw,if=virtio -nic user

# on a real computer: write it to a USB stick or a disk. This erases that device.
sudo dd if=pc.img of=/dev/sdX bs=4M conv=fsync status=progress
```

Good to know:

- **Nothing is installed on your computer.** The disk is put together inside the machine,
  with the distribution's own tools (`mke2fs`, `mtools`, `sfdisk`). If something is missing
  there, chainboot names the packages. It needs no administrator rights.
- **It is a copy of the machine as it is now.** The disk gets its own machine ID and its own
  SSH host keys, its own `/etc/fstab`, and takes its network settings by DHCP. Nothing links
  it back to the chain or to the machine.
- **Size.** By default the disk is as small as the system allows (about 2.3 GB for Solinux
  with a kernel). `--size 8G` makes it larger; on the new computer the root partition can be
  grown to fill a bigger disk (`growpart` and `resize2fs`).
- **Which kernel.** `linux-image-virtual` is small and right for virtual machines.
  `linux-image-generic` brings the drivers for real hardware.
- **Firmware.** UEFI only. Computers that can only boot in the old BIOS way are not supported.

## With or without administrator rights

Building a machine means mounting file systems and giving files their owners. On Linux there
are two ways to be allowed to do that, and `chainboot engine` shows which one your computer
uses:

```sh
chainboot engine              # show the current way
chainboot engine rootless     # run machines without administrator rights
chainboot engine sudo         # run machines through sudo
```

**Without administrator rights ("rootless").** chainboot stays an ordinary program of yours
and uses a Linux feature named *user namespaces*: inside the machine you are root and every
user of the system (`root`, `_apt`, `www-data`, your own accounts) has its own files; outside,
all of it belongs to you. No password is asked, and root inside the machine can do nothing on
your computer that you cannot do yourself. A new installation chooses this way by itself when
the computer has what it needs:

- the tools `newuidmap` and `newgidmap` (package `uidmap` on Debian and Ubuntu, part of
  `shadow-utils` or `shadow` elsewhere),
- a range of 65,536 user IDs reserved for you in `/etc/subuid` and `/etc/subgid` (most
  systems add one when your account is created),
- on Ubuntu 23.10 and later, permission from AppArmor, which by default stops ordinary
  programs from using user namespaces.

`chainboot engine rootless` checks these, tells you what is missing and adds it. That takes
your administrator password once: to install the package, to reserve the IDs, or to add a
small AppArmor profile that allows one program, chainboot's own copy of `unshare` in
`~/.chainboot/bin/userns`, to create user namespaces.

Two things differ from running through `sudo`: programs inside a machine cannot listen on
ports below 1024 (use 8080 instead of 80, 2222 instead of 22), and a machine has the user IDs
0 to 65,536, which is all a normal system uses.

**Through `sudo`.** Every start and stop of a machine runs as the administrator. `sudo` asks
for your password and remembers it for a few minutes. This works on every Linux system.

**Switching.** The two ways store file owners differently, so a home directory uses one of
them. To switch, the home directory must hold no machines: save the ones you want to keep
(`chainboot save <machine>`), remove them (`chainboot rm <machine>`), switch, and run them
again. They come back from the chain exactly as they were, whichever way they were saved.

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
chainboot publish web.tar --name web --version 1.0 --reuse solinux --public --keypair me.json
```

`export` writes the machine's complete file system as a tar archive. It leaves out what
must not be shared or is rebuilt anyway: SSH host keys, `~/.ssh`, shell history, logs, the
machine ID, temporary files and package caches. Details are in
[Publishing your own system](05-publishing.md).

Next: [Saving to chain](04-saving.md).
