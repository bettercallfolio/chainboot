# The first start of a machine prepares pacman's keyring in the background (a few seconds).
# A shell that opens meanwhile waits for it, so that the first "pacman -S" just works.
if [ -e /run/pacman-keyring-in-progress ]; then
  printf 'Preparing pacman (first start only) '
  _n=0
  while [ -e /run/pacman-keyring-in-progress ] && [ "$_n" -lt 120 ]; do printf '.'; sleep 0.5; _n=$((_n + 1)); done
  printf ' ready\n'
  unset _n
fi
