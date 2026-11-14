#!/bin/sh
# chainboot installer for Linux, macOS and WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/bettercallfolio/chainboot/main/install.sh | sh
#
# What it does, all inside your home directory and without administrator rights:
#   1. finds Node.js 22.15 or newer, or downloads the official Node.js build and checks its SHA-256
#   2. downloads the chainboot program (one small file plus its web page) and checks its SHA-256
#   3. creates the `chainboot` command in ~/.local/bin
# Run it again at any time to update. Remove everything with:  sh install.sh --uninstall
#
# Options:
#   --from <chainboot.tar.gz>   install from a file instead of downloading
#   --uninstall                 remove the program (your machines and settings are kept unless you add --purge)
#   --purge                     with --uninstall: also delete ~/.chainboot (machines, settings, logins)
set -eu

# Everything happens inside one function that is called on the last line: a download of this
# script that was cut off half-way then runs nothing at all, instead of the first half.
main() {

NODE_VERSION="v24.22.3"
NODE_SHA_linux_x64="061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2"
NODE_SHA_linux_arm64="261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8"
NODE_SHA_darwin_x64="977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7"
NODE_SHA_darwin_arm64="ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd"
RELEASE_URL="${CHAINBOOT_RELEASE_URL:-https://github.com/bettercallfolio/chainboot/releases/latest/download}"

HOME_DIR="${CHAINBOOT_HOME:-$HOME/.chainboot}"
APP_DIR="$HOME_DIR/app"
RUNTIME_DIR="$HOME_DIR/runtime"
BIN_DIR="${CHAINBOOT_BIN_DIR:-$HOME/.local/bin}"

# never operate on a directory that is not clearly ours
case "$HOME_DIR" in
  ""|"/"|"$HOME"|"$HOME/") echo "refusing to use \"$HOME_DIR\" as the chainboot directory" >&2; exit 1 ;;
esac

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then G='\033[32m'; R='\033[31m'; Y='\033[33m'; D='\033[2m'; B='\033[1m'; N='\033[0m'; else G=''; R=''; Y=''; D=''; B=''; N=''; fi
say() { printf '%b\n' "$*"; }
ok() { say "${G}✔${N} $*"; }
warn() { say "${Y}!${N} $*"; }
die() { say "${R}✖${N} $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
chainboot installer for Linux, macOS and WSL.

  curl -fsSL https://raw.githubusercontent.com/bettercallfolio/chainboot/main/install.sh | sh
  curl -fsSL <the same address> | sh -s -- --uninstall

It works inside your home directory, without administrator rights: it finds Node.js 22.15 or
newer (or downloads the official build and checks its SHA-256), downloads chainboot and checks
its SHA-256, and creates the `chainboot` command in ~/.local/bin. Run it again to update.

Options:
  --from <chainboot.tar.gz>   install from a file instead of downloading
  --uninstall                 remove the program (machines and settings are kept unless you add --purge)
  --purge                     with --uninstall: also delete ~/.chainboot (machines, settings, logins)

Environment: CHAINBOOT_HOME (default ~/.chainboot), CHAINBOOT_BIN_DIR (default ~/.local/bin),
CHAINBOOT_RELEASE_URL (where chainboot.tar.gz and its .sha256 are fetched from).
USAGE
}

FROM=""; UNINSTALL=0; PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --from) [ $# -ge 2 ] || die "--from needs a file"; FROM="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done
[ "$PURGE" = 0 ] || [ "$UNINSTALL" = 1 ] || die "--purge goes with --uninstall (it deletes your machines, settings and logins)"

if [ "$UNINSTALL" = 1 ]; then
  rm -f "$BIN_DIR/chainboot"
  rm -rf "$APP_DIR" "$RUNTIME_DIR"
  ok "removed the chainboot program"
  if [ "$PURGE" = 1 ]; then
    if [ -d "$HOME_DIR/machines" ] && [ "$(id -u)" != 0 ]; then
      say "Machines hold files of the system's users. Removing them needs administrator rights:"
      say "  sudo rm -rf \"$HOME_DIR\""
      if [ -e "$HOME_DIR/bin/userns" ]; then
        say "An AppArmor profile was added for running machines without administrator rights:"
        say "  sudo rm -f /etc/apparmor.d/chainboot-userns-$(id -u)-*"
      fi
    else
      rm -rf "$HOME_DIR"; ok "removed $HOME_DIR"
    fi
  else
    say "${D}Your machines, settings and logins are still in $HOME_DIR (add --purge to delete them).${N}"
  fi
  exit 0
fi

have() { command -v "$1" >/dev/null 2>&1; }
fetch() { # fetch <url> <file>
  if have curl; then curl -fsSL --retry 3 -o "$2" "$1"
  elif have wget; then wget -q -O "$2" "$1"
  else die "curl or wget is needed to download files. Install one of them and run this again."; fi
}
sha256() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "sha256sum (or shasum) is needed to check downloads."; fi
}

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "this installer supports Linux, macOS and WSL. On Windows use install.ps1 in PowerShell." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported processor: $(uname -m). chainboot needs a 64-bit x86 or ARM computer." ;;
esac
# a terminal that runs under Rosetta on Apple silicon says x86_64: the computer is ARM
if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then ARCH=arm64; fi

say "${B}Installing chainboot${N} ${D}($OS $ARCH, into $HOME_DIR)${N}"
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t chainboot)"
# (what a failed run leaves half made is removed with it)
trap 'rm -rf "$TMP" "$APP_DIR.new" "$RUNTIME_DIR.new"' EXIT INT TERM
mkdir -p "$HOME_DIR" "$BIN_DIR"

# ---- 1. Node.js
node_ok() { [ -x "$1" ] && "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=15)?0:1)' 2>/dev/null; }
NODE=""
# a Node.js that an earlier run of this installer downloaded is kept up to date with the version named above
if [ -x "$RUNTIME_DIR/bin/node" ] && node_ok "$RUNTIME_DIR/bin/node" && [ "$("$RUNTIME_DIR/bin/node" --version)" = "$NODE_VERSION" ]; then NODE="$RUNTIME_DIR/bin/node"
elif [ ! -e "$RUNTIME_DIR/bin/node" ] && have node && node_ok "$(command -v node)"; then NODE="$(command -v node)"; fi
if [ -n "$NODE" ]; then
  ok "using Node.js $("$NODE" --version) at $NODE"
else
  # the official builds need the GNU C library; a system built on musl (Alpine) has its own package
  if [ "$OS" = linux ] && { ldd --version 2>&1 || true; } | grep -qi musl; then
    die "this system uses the musl C library, which the official Node.js builds do not run on. Install Node.js 22.15 or newer with your package manager (Alpine: apk add nodejs) and run this again."
  fi
  say "Downloading Node.js $NODE_VERSION (official build from nodejs.org)"
  eval "WANT=\$NODE_SHA_${OS}_${ARCH}"
  NAME="node-$NODE_VERSION-$OS-$ARCH"
  fetch "https://nodejs.org/dist/$NODE_VERSION/$NAME.tar.gz" "$TMP/node.tar.gz"
  GOT="$(sha256 "$TMP/node.tar.gz")"
  [ "$GOT" = "$WANT" ] || die "the Node.js download does not match its expected SHA-256 (got $GOT). Nothing was installed."
  rm -rf "$RUNTIME_DIR.new"; mkdir -p "$RUNTIME_DIR.new"
  tar -xzf "$TMP/node.tar.gz" -C "$RUNTIME_DIR.new" --strip-components=1 "$NAME/bin/node" "$NAME/LICENSE"
  rm -rf "$RUNTIME_DIR"; mv "$RUNTIME_DIR.new" "$RUNTIME_DIR"
  NODE="$RUNTIME_DIR/bin/node"
  node_ok "$NODE" || die "the downloaded Node.js does not run on this system."
  ok "installed Node.js $("$NODE" --version) for chainboot only (in $RUNTIME_DIR)"
fi

# ---- 2. the program
if [ -n "$FROM" ]; then
  [ -f "$FROM" ] || die "no such file: $FROM"
  cp "$FROM" "$TMP/chainboot.tar.gz"
else
  say "Downloading chainboot"
  fetch "$RELEASE_URL/chainboot.tar.gz" "$TMP/chainboot.tar.gz" || die "could not download chainboot from $RELEASE_URL"
  fetch "$RELEASE_URL/chainboot.tar.gz.sha256" "$TMP/chainboot.sha256" || die "could not download the checksum of chainboot"
  WANT="$(cut -d' ' -f1 "$TMP/chainboot.sha256")"; GOT="$(sha256 "$TMP/chainboot.tar.gz")"
  [ "$GOT" = "$WANT" ] || die "the chainboot download does not match its SHA-256. Nothing was installed."
fi
rm -rf "$APP_DIR.new"; mkdir -p "$APP_DIR.new"
tar -xzf "$TMP/chainboot.tar.gz" -C "$APP_DIR.new"
[ -f "$APP_DIR.new/chainboot.mjs" ] && [ -f "$APP_DIR.new/web/index.html" ] || die "the chainboot archive is incomplete."
VERSION="$("$NODE" "$APP_DIR.new/chainboot.mjs" --version 2>/dev/null)" || die "the downloaded chainboot does not start."
rm -rf "$APP_DIR"; mv "$APP_DIR.new" "$APP_DIR"

# ---- 3. the command
# The command starts chainboot with the Node.js found above. A Node.js from a version manager
# (nvm, fnm, asdf) can disappear with its version; then the one on the PATH is used instead.
cat > "$BIN_DIR/chainboot" <<EOF
#!/bin/sh
for node in "$NODE" "$RUNTIME_DIR/bin/node" node; do
  if command -v "\$node" >/dev/null 2>&1; then exec "\$node" "$APP_DIR/chainboot.mjs" "\$@"; fi
done
echo "chainboot: Node.js was not found any more. Run the chainboot installer again." >&2
exit 127
EOF
chmod 755 "$BIN_DIR/chainboot"
ok "installed chainboot $VERSION"

# ---- what is still needed
if [ "$OS" = linux ]; then
  MISSING=""
  for t in unshare nsenter mount chroot flock; do have "$t" || MISSING="$MISSING $t"; done
  [ -z "$MISSING" ] || warn "these system tools are missing:$MISSING. Install the util-linux and coreutils packages to run machines."
  have xz || say "${D}Tip: with the xz package installed, large systems unpack several times faster.${N}"
else
  if have docker || have podman || have limactl; then :; else
    warn "macOS needs a Linux engine to run machines. Install one of: OrbStack, Docker Desktop, Podman, or Lima (brew install lima)."
  fi
fi
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH yet. Add this line to your shell profile (~/.bashrc, ~/.zshrc) and open a new terminal:"
     say "    export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

say ""
say "${B}Next steps${N}"
say "  chainboot rpc add <your RPC endpoint URL>     ${D}# free from Helius, QuickNode, Alchemy, ...${N}"
say "  chainboot run solinux                        ${D}# Ubuntu 26.04 LTS, straight from Solana${N}"
say "  chainboot ui                                  ${D}# or use the point-and-click interface${N}"
}

main "$@"
