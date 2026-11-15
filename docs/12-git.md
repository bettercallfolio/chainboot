# Git on chain

A git repository can live on the chain, the same way a system does. You keep using git:
`git clone`, `git push`, `git pull`. The remote is not a server; it is the ledger.

```sh
git remote add origin sol://me/notes
git push -u origin main
```

This guide covers repositories, private and public ones, issues and pull requests, and the
page that shows a repository in a browser.

## How it works

chainboot brings a small program, `git-remote-sol`. git starts it whenever it meets an
address that begins with `sol://`. Nothing else about git changes.

- **A push** makes one git pack file of the commits and files the chain does not have yet,
  and stores it the way chainboot stores everything: in transactions, checked by hash.
- **The list of branches** is a small record that says which commit each branch and tag
  points at, and which packs make up the repository. Each push stores a new one.
- **A pointer** under an address made from the owner's key and the repository's name says
  which list is the newest. Only the owner's key can move it. That is what makes `main`
  the owner's `main`: nobody else can push to it, and no endpoint can pass off another list.
- **A clone or a fetch** reads the pointer, then the list, then the packs it does not have.

A repository's address is `sol://<owner>/<name>`. The owner is an address, a name you saved
with `chainboot publisher add`, or `me` for the wallet you are signed in with.

## A private repository

Private is the default, as everywhere in chainboot. Sign in once, give your vault a little
SOL, and push:

```sh
chainboot login
chainboot fund 0.05

cd my-project
git remote add origin sol://me/my-project
git push -u origin main          # the first push creates it
```

The packs and the list of branches are encrypted with a key that comes from your wallet's
key and the repository's name. On another computer: `chainboot login`, then
`git clone sol://me/my-project`.

To let somebody else read it, send them its key. They tell you their share address
(`chainboot whoami` shows it):

```sh
chainboot git share my-project --with share_7y31WZ…
```

They run `chainboot git shared`, keep it with `chainboot git shared accept 1`, and clone it
with the address that command prints. They can read what you push later, too. This cannot be
taken back: the ledger keeps the data, and they keep the key.

## A public repository

A repository that everybody can read is created on purpose:

```sh
chainboot git create my-project --public --description "What it is"
```

Its owner is the wallet you are signed in with. Or a keypair file, for a project that is
not tied to one person's wallet:

```sh
chainboot git create my-project --public --keypair project.json
git config chainboot.keypair /path/to/project.json     # in your clone: the key that pushes
```

Then `git remote add origin sol://<address>/my-project` and push. Anybody clones it with
`git clone sol://<address>/my-project`; they need chainboot installed and an RPC endpoint,
nothing else.

**Think before you push to a public repository.** Data on a ledger cannot be erased. A
password that was committed stays readable for ever, also after the branch is deleted or
pushed over with `git push --force`.

## Everyday git

Everything that goes through a remote works as you know it:

```sh
git push                         # refused when the chain has commits you do not have: git pull first
git push --force origin topic    # replaces the branch (the old commits stay on the ledger)
git push origin --delete topic
git push origin v1.0             # tags
git pull, git fetch, git clone
chainboot git info               # branches, size on chain, last push
chainboot git list               # your repositories
```

## Working together: forks, pull requests, issues

Only the owner's key moves a repository's branches. Everybody else works the way open
source works: in a repository of their own, and by asking.

```sh
git clone sol://<their-address>/project && cd project
chainboot git create project --public            # your own copy on chain
git remote rename origin upstream
git remote add origin sol://me/project
git switch -c fix-typo
# ... commit ...
git push -u origin fix-typo
chainboot git pr new --title "Fix a typo in the README" --body "Found while reading."
```

The owner sees it, looks at it, and merges it:

```sh
chainboot git pr list
chainboot git pr show 4
chainboot git pr fetch 4         # the commits, as the local branch pr-4
chainboot git pr merge 4         # merges into its branch, pushes, marks it merged
```

Issues work the same way:

```sh
chainboot git issue new --title "It does not build on ARM" --body-file report.txt
chainboot git issue list
chainboot git issue show 3
chainboot git issue comment 3 --body "Which compiler version?"
chainboot git issue close 3
```

These commands use the repository of the directory you are in (the remote `upstream`, or
`origin`). Anywhere else, name it: `--repo sol://<owner>/<name>`.

What happens on chain: every repository has an address that anybody may write to. An issue,
a pull request, a comment or a change of state is one small transaction there, signed by
whoever wrote it. The ledger keeps them in the order they arrived, so the first one is #1
for everybody. A change of state counts only when it comes from the repository's owner or
from the author of the issue; "merged" only from the owner. Nobody can delete what somebody
else wrote, the owner included, and anybody can write: a program that shows the records
decides what to show.

## In a browser

[chainboot.dev/git](https://chainboot.dev/git/) shows a public repository: files, the
README, history, what a commit changed, issues and pull requests. It reads the chain itself,
in your browser, through the RPC endpoints you give it, and checks what it reads. A link to
a repository looks like this:

```
https://chainboot.dev/git/#r=<owner's address>/<name>
```

With a wallet in the browser you can open an issue, comment, and close what is yours. The
wallet signs one small transaction; the page sends it. One transaction holds about a
thousand characters; longer texts are written with `chainboot git issue new --body-file`.

The page is a few static files (`dist/git/` after a build), so anybody can host it, or open
it from their own disk.

## What it costs

A push pays for the pack it stores: about 0.0013 SOL per megabyte, plus a fraction of a
cent for the list of branches and the pointer. git compresses well, so source code is
cheap: a project with a megabyte of history costs about 0.0013 SOL to put on chain, and
later pushes only pay for what is new. An issue or a comment is one transaction (0.000005
SOL).

## Limits, honestly

- **Nothing can be deleted.** See above.
- **Large files are expensive and slow**, as they are in git itself. There is no LFS.
- **One writer per repository.** Shared write access for a team (several keys that may move
  the same branches) is not there yet. Teams use pull requests.
- **Every push adds a pack.** After hundreds of pushes a clone fetches hundreds of small
  packs. Repacking a repository on chain is not there yet.
- **Anybody can open issues**, so anybody can write nonsense under a repository. The page
  and the command show everything.
- **The browser page reads public repositories only**, and has been tried with a simulated
  wallet, not yet with a real one.
- git on Windows starts `git-remote-sol` through Git for Windows' own shell. This is
  written but not yet tried on a real Windows computer.

Next: [Thank you](13-thanks.md).
