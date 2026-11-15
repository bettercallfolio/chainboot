#!/bin/bash
# Builds the Arch Linux example image: Arch's official bootstrap archive, and with its own
# pacstrap a fresh system of base, base-devel and the tools people reach for every day.
#
#   images/arch/build.sh <archlinux-bootstrap-…-x86_64.tar.zst>      result: $WORK/arch.tar
#
# Get the archive and its checksum from https://archlinux.org/download/ and check both the
# SHA-256 and the signature before using it. Needs sudo (mounts, chroot) and zstd.
# The result is published with:
#   chainboot publish arch.tar --name arch --version <date of the archive> --lazy --public --keypair <file>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
archive=${1:?usage: build.sh <archlinux-bootstrap-…-x86_64.tar.zst>}
WORK=${WORK:-$HOME/arch}
B=$WORK/bootstrap/root.x86_64          # the bootstrap system (only used to run pacstrap)
T=$WORK/rootfs                         # the system that becomes the image
PACKAGES="base base-devel sudo openssh git vim nano curl wget man-db man-pages texinfo bash-completion
  less which tree htop lsof strace rsync tar zip unzip tmux jq python iproute2 iputils inetutils bind
  pacman-contrib fastfetch"

[ ! -e "$T" ] && [ ! -e "$WORK/bootstrap" ] || { echo "$T or $WORK/bootstrap exists already: move them away first"; exit 1; }
mkdir -p "$WORK/bootstrap"
sudo tar --zstd -xpf "$archive" -C "$WORK/bootstrap" --numeric-owner
sudo mkdir -p "$T"

# Everything mounted for the build is private: nothing mounted or unmounted here shows in this
# computer's own mounts.
down() {
  for d in "$B/mnt" "$B/dev" "$B/sys" "$B/proc" "$B"; do
    if mountpoint -q "$d"; then sudo umount -R "$d" || sudo umount -R -l "$d"; fi
  done
}
trap down EXIT
sudo mount --bind "$B" "$B";            sudo mount --make-private "$B"      # (pacstrap wants its root to be a mount point)
sudo mount -t proc proc "$B/proc"
sudo mount --rbind /sys "$B/sys";       sudo mount --make-rprivate "$B/sys"
sudo mount --rbind /dev "$B/dev";       sudo mount --make-rprivate "$B/dev"
sudo mount --bind "$T" "$B/mnt";        sudo mount --make-private "$B/mnt"
sudo cp -L /etc/resolv.conf "$B/etc/resolv.conf"
MIRRORS='Server = https://geo.mirror.pkgbuild.com/$repo/os/$arch
Server = https://mirrors.kernel.org/archlinux/$repo/os/$arch
Server = https://mirror.rackspace.com/archlinux/$repo/os/$arch'
echo "$MIRRORS" | sudo tee "$B/etc/pacman.d/mirrorlist" > /dev/null

inside() { sudo chroot "$B" /usr/bin/env -i HOME=/root TERM=xterm PATH=/usr/local/sbin:/usr/local/bin:/usr/bin "$@"; }
inside pacman-key --init
inside pacman-key --populate archlinux
# shellcheck disable=SC2086
inside pacstrap -K /mnt $PACKAGES

# ---- the image's own settings
echo "$MIRRORS" | sudo tee "$T/etc/pacman.d/mirrorlist" > /dev/null
sudo sed -i 's/^#en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' "$T/etc/locale.gen"
inside chroot /mnt locale-gen
echo 'LANG=en_US.UTF-8' | sudo tee "$T/etc/locale.conf" > /dev/null
sudo install -Dm755 "$HERE/start" "$T/etc/chainboot/start"
sudo install -Dm644 "$HERE/profile.sh" "$T/etc/profile.d/chainboot-pacman.sh"

# ---- what an image must not carry
# pacman's keyring holds a private key that signs for this one installation: every machine
# makes its own at its first start (etc/chainboot/start). Caches, logs and the machine's
# identity go as well.
inside chroot /mnt sh -c 'rm -rf /etc/pacman.d/gnupg /var/cache/pacman/pkg/* /var/log/pacman.log /var/log/journal/* /etc/machine-id /root/.bash_history /root/.gnupg; rm -f /var/lib/pacman/sync/*.sig'
# (the keyring's helper programs would keep the mounts busy)
inside sh -c 'gpgconf --homedir /etc/pacman.d/gnupg --kill all' || true
down; trap - EXIT

sudo tar -C "$T" --numeric-owner --xattrs --sort=name -cf "$WORK/arch.tar" .
sudo chown "$(id -u):$(id -g)" "$WORK/arch.tar"
echo "image archive: $WORK/arch.tar ($(du -h "$WORK/arch.tar" | cut -f1)), $(sudo du -sh "$T" | cut -f1) unpacked"
