// Bootable disks: a machine written out as the disk of a real computer.
//
// A machine uses the kernel of the computer it runs on. A disk needs a kernel of its own, a
// boot loader and a partition table. All of that exists as packages of the system inside the
// machine, so the disk is put together there, with the distribution's own tools and without
// administrator rights:
//
//   GPT disk
//   ├─ partition 1: EFI system partition (FAT32): systemd-boot, the kernel, the initrd
//   └─ partition 2: ext4, the machine's whole file system
//
// The result boots on a PC or a virtual machine with UEFI firmware. It is the machine as it
// is at this moment; nothing links the disk back to the chain.

/** Where the script leaves the finished disk, inside the machine. */
export const DISK_WORK = "var/tmp/chainboot-disk";
export const DISK_FILE = `${DISK_WORK}/disk.img`;

/** Exit statuses of the script that the caller explains to the user. */
export const DISK_NEEDS_PACKAGES = 3, DISK_NEEDS_PASSWORD = 4, DISK_NO_SPACE = 5;

/**
 * Runs inside the machine as root. Environment: CB_SIZE_MB (0: as small as fits), CB_NAME.
 * What it does is told on the error output, as it happens. The standard output is for the
 * caller: "MISSING:<packages>", "NOSPACE:<MiB>", "DONE:<MiB>:<kernel>", or one line that says
 * what went wrong.
 */
// (in the script, ${"$"}{NAME} is how a shell ${"$"}{NAME} is written inside this template)
export const DISK_SCRIPT = String.raw`
set -eu
W=/${DISK_WORK}
case "$(uname -m)" in
  x86_64) LOADER=systemd-bootx64.efi; BOOT=BOOTX64.EFI ;;
  aarch64) LOADER=systemd-bootaa64.efi; BOOT=BOOTAA64.EFI ;;
  *) echo "a bootable disk can be made for x86-64 and ARM64 systems, not for $(uname -m)"; exit 1 ;;
esac

# ---- what the system must contain
pk=""
ls /boot/vmlinuz-* >/dev/null 2>&1 || pk="$pk linux-image-virtual"
command -v update-initramfs >/dev/null 2>&1 || pk="$pk initramfs-tools"
[ -e "/usr/lib/systemd/boot/efi/$LOADER" ] || pk="$pk systemd-boot-efi"
command -v mcopy >/dev/null 2>&1 || pk="$pk mtools"
command -v mkfs.vfat >/dev/null 2>&1 || pk="$pk dosfstools"
command -v sfdisk >/dev/null 2>&1 || pk="$pk fdisk"
command -v mke2fs >/dev/null 2>&1 || pk="$pk e2fsprogs"
if [ -n "$pk" ]; then echo "MISSING:$pk"; exit ${DISK_NEEDS_PACKAGES}; fi
K=$(ls /boot/vmlinuz-* | sort -V | tail -1); V=${"$"}{K#/boot/vmlinuz-}; I=/boot/initrd.img-$V
if [ ! -e "$I" ]; then echo "making the initrd for kernel $V" >&2; update-initramfs -c -k "$V" >/dev/null 2>&1 || true; fi
[ -e "$I" ] || { echo "kernel $V has no initrd ($I) and none could be made"; exit 1; }

# ---- somebody must be able to log in on the new computer
if ! awk -F: '$2 ~ /^\$/ { found = 1 } END { exit !found }' /etc/shadow; then exit ${DISK_NEEDS_PASSWORD}; fi

X="$W/.cb-disk-files"
rm -rf "$W"; mkdir -p "$X/etc"
trap 'rm -f "$W/root.img" "$W/esp.img" "$W/disk.img.tmp"; rm -rf "$X" "$W/root" "$W/boot"' EXIT

# ---- files that differ on the disk: its own mount table, its own identity, name resolution of its own
printf 'LABEL=chainboot-root / ext4 defaults,errors=remount-ro 0 1\n' > "$X/etc/fstab"
: > "$X/etc/machine-id"
if [ -e /usr/lib/systemd/systemd-resolved ]; then ln -s ../run/systemd/resolve/stub-resolv.conf "$X/etc/resolv.conf"; else printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "$X/etc/resolv.conf"; fi
if command -v netplan >/dev/null 2>&1 && ! ls /etc/netplan/*.yaml >/dev/null 2>&1; then
  mkdir -p "$X/etc/netplan"
  printf 'network:\n  version: 2\n  ethernets:\n    wired:\n      match:\n        name: "e*"\n      dhcp4: true\n      dhcp6: true\n' > "$X/etc/netplan/01-chainboot.yaml"
  chmod 600 "$X/etc/netplan/01-chainboot.yaml"
fi

# ---- sizes (MiB)
used=$(du -sxm / 2>/dev/null | cut -f1)
kb=$(( $(stat -c %s "$K") + $(stat -c %s "$I") ))
ESP=$(( kb / 1048576 * 2 + 64 )); [ "$ESP" -ge 128 ] || ESP=128
ROOT=$(( used * 13 / 10 + 512 ))
if [ "${"$"}{CB_SIZE_MB:-0}" -gt 0 ]; then
  want=$(( CB_SIZE_MB - ESP - 2 ))
  if [ "$want" -lt "$ROOT" ]; then echo "the system needs a disk of at least $(( ROOT + ESP + 2 )) MiB"; exit 1; fi
  ROOT=$want
fi
free=$(df -Pm /var/tmp | awk 'NR==2 { print $4 }')
if [ "$free" -lt $(( used + ESP + 256 )) ]; then echo "NOSPACE:$(( used + ESP + 256 ))"; exit ${DISK_NO_SPACE}; fi

# ---- the root file system: every file of the machine, with the files above in place of the machine's own
echo "copying the system ($used MiB) into an ext4 file system" >&2
# (the machine's own copies of those files are left out by name; the replacements come from a
# second directory whose entries are renamed into place, so the exclusions do not hit them)
pack() {
  tar --one-file-system --numeric-owner --xattrs --xattrs-include='*' --acls --sparse -cf - --anchored \
    --transform='s,^\./\.cb-disk-files,.,' \
    -C / --exclude=./${DISK_WORK} --exclude=./etc/fstab --exclude=./etc/machine-id --exclude=./etc/resolv.conf --exclude='./etc/ssh/ssh_host_*' --exclude='./var/cache/apt/archives/*.deb' --exclude='./var/lib/apt/lists/*' . \
    -C "$W" ./.cb-disk-files
}
if ! { pack | mke2fs -q -F -t ext4 -L chainboot-root -m 1 -d - "$W/root.img" "${"$"}{ROOT}M"; } >/dev/null 2>"$W/mke2fs.log"; then
  # this e2fsprogs cannot read an archive: unpack it first, then build from the directory
  rm -f "$W/root.img"; mkdir -p "$W/root"
  pack | tar --numeric-owner --xattrs --xattrs-include='*' --acls -xpf - -C "$W/root"
  mke2fs -q -F -t ext4 -L chainboot-root -m 1 -d "$W/root" "$W/root.img" "${"$"}{ROOT}M" >/dev/null
  rm -rf "$W/root"
fi
rm -f "$W/mke2fs.log"

# ---- the EFI system partition: boot loader, kernel, initrd
echo "writing the boot partition (kernel $V)" >&2
mkfs.vfat -C -F 32 -n CB-ESP "$W/esp.img" $(( ESP * 1024 )) >/dev/null
export MTOOLS_SKIP_CHECK=1
mmd -i "$W/esp.img" ::/EFI ::/EFI/BOOT ::/loader ::/loader/entries
mcopy -i "$W/esp.img" "/usr/lib/systemd/boot/efi/$LOADER" "::/EFI/BOOT/$BOOT"
mcopy -i "$W/esp.img" "$K" ::/vmlinuz
mcopy -i "$W/esp.img" "$I" ::/initrd.img
title=$(. /etc/os-release 2>/dev/null; echo "${"$"}{PRETTY_NAME:-Linux}")
mkdir -p "$W/boot"
printf 'default chainboot.conf\ntimeout 3\n' > "$W/boot/loader.conf"
printf 'title   %s (%s)\nlinux   /vmlinuz\ninitrd  /initrd.img\noptions root=LABEL=chainboot-root rw console=ttyS0,115200 console=tty0\n' "$title" "${"$"}{CB_NAME:-chainboot}" > "$W/boot/entry.conf"
mcopy -i "$W/esp.img" "$W/boot/loader.conf" ::/loader/loader.conf
mcopy -i "$W/esp.img" "$W/boot/entry.conf" ::/loader/entries/chainboot.conf

# ---- the disk: a partition table and the two file systems at their places
echo "putting the disk together" >&2
truncate -s $(( 1 + ESP + ROOT + 1 ))M "$W/disk.img.tmp"
printf 'label: gpt\nstart=1MiB, size=%sMiB, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, name="EFI"\nstart=%sMiB, size=%sMiB, type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name="chainboot-root"\n' "$ESP" $(( 1 + ESP )) "$ROOT" | sfdisk -q "$W/disk.img.tmp" >/dev/null
dd if="$W/esp.img" of="$W/disk.img.tmp" bs=1M seek=1 conv=notrunc status=none
dd if="$W/root.img" of="$W/disk.img.tmp" bs=1M seek=$(( 1 + ESP )) conv=notrunc,sparse status=none
rm -f "$W/root.img" "$W/esp.img"; rm -rf "$X" "$W/boot"
mv "$W/disk.img.tmp" "$W/disk.img"
trap - EXIT
echo "DONE:$(( 1 + ESP + ROOT + 1 )):$V"
`;
