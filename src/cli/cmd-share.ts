// `chainboot share` and `chainboot shared`: giving a private image or a saved machine to another wallet.
import path from "node:path";
import { hostArch, loadConfig, openStore, paths, networkLabel } from "../local/home.ts";
import { parseImageName } from "../registry/registry.ts";
import { acceptImage, acceptMachine, listShares, myShareAddress, shareImage, shareMachine, type Received } from "../share/share.ts";
import { loadVault, parseShareAddress, type Vault } from "../state/vault.ts";
import { UsageError, flag, type Args } from "./args.ts";
import { PRIVATE_PREFIX, confirm } from "./cmd-image.ts";
import { bold, dim, info, ok, out, table } from "./term.ts";

export const SHARE_HELP = `Usage:
  chainboot share <machine> --with <share address> [--note <text>]
  chainboot share me/<image>[:tag] --with <share address> [--arch <arch>] [--note <text>]

  chainboot shared                              What others shared with you
  chainboot shared accept <number or id> [--name <name>] [--yes]

Gives another wallet one of your private images, or the newest save of one of your machines.
Nothing is uploaded again: the receiver gets the keys of exactly that image or that save, in
a small message only they can read. It costs one transaction.

The receiver tells you their share address first. Everyone finds their own with:

  chainboot whoami            # the line "share address"

A share address is not a wallet address: a wallet can sign, but it cannot decrypt, so
chainboot gives every login a separate address for receiving.

  chainboot share web --with share_7Yk...        # the newest save of machine "web"
  chainboot share me/mybox --with share_7Yk...   # your private image "mybox"

The receiver then runs:

  chainboot shared                    # lists it, with the share address it came from
  chainboot shared accept 1           # keeps it: an image as me/<name>, a machine under its name
  chainboot run me/mybox              # or: chainboot run web

What to know before sharing:
  - It is a copy at this moment. A shared machine becomes the receiver's own; later saves on
    either side do not reach the other.
  - It cannot be taken back. The data stays on the ledger and the receiver keeps the keys.
  - A machine made from one of your private images is shared together with that image.`;

function login(): Vault {
  const c = loadConfig();
  const v = loadVault(paths.vault(), c.cluster);
  if (!v) throw new Error(`sharing belongs to a wallet, and you are not signed in on ${networkLabel(c)}. Sign in first: chainboot login`);
  return v;
}

const note = (t: string) => info(dim(t));
const when = (seconds: number | null) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : dim("-"));
const short = (address: string) => (address.length > 22 ? `${address.slice(0, 14)}…${address.slice(-6)}` : address);

export async function cmdShare(a: Args): Promise<void> {
  const what = a._[0];
  const to = flag(a, "with");
  if (!what || !to) throw new UsageError("say what to share and with whom: chainboot share <machine | me/image> --with <share address>");
  parseShareAddress(to); // fail early, before anything is fetched
  const v = login();
  const store = await openStore(loadConfig(), note);
  const cacheDir = path.join(paths.cache(), "objects");
  const text = flag(a, "note");
  if (what.startsWith(`${PRIVATE_PREFIX}/`)) {
    const n = parseImageName(what);
    const arch = flag(a, "arch") ?? hostArch();
    if (!(await confirm(`Share your private image "${n.name}:${n.tag}" (${arch}) with ${short(to)}? This cannot be taken back.`, a))) { info("cancelled"); return; }
    const id = await shareImage(store, v, n.name, n.tag, arch, to, { note: text, cacheDir });
    ok(`shared image ${bold(n.name)}:${n.tag} with ${short(to)}`);
    info(dim(`They see it with "chainboot shared" and keep it with "chainboot shared accept". (${id})`));
    return;
  }
  if (what.includes("/")) throw new UsageError(`only your own things can be shared: a machine name, or a private image as ${PRIVATE_PREFIX}/<image>. Public images need no sharing.`);
  if (!(await confirm(`Share the newest save of machine "${what}" with ${short(to)}? This cannot be taken back.`, a))) { info("cancelled"); return; }
  const r = await shareMachine(store, v, what, to, { note: text, cacheDir });
  ok(`shared machine ${bold(what)} (save #${r.seq} of ${when(r.saved)}) with ${short(to)}`);
  info(dim(`They see it with "chainboot shared" and keep it with "chainboot shared accept". (${r.id})`));
}

function describe(r: Received): string {
  const rec = r.record;
  if (rec.what === "image") return `image ${rec.name}:${rec.image!.tag} (${rec.image!.arch})`;
  return `machine ${rec.name} (${rec.machine!.image.name}:${rec.machine!.image.tag}, ${rec.machine!.image.arch}${rec.machine!.boot ? ", boots" : ""})`;
}

export async function cmdShared(a: Args): Promise<void> {
  const v = login();
  const store = await openStore(loadConfig(), note);
  const cacheDir = path.join(paths.cache(), "objects");
  // oldest first: a share that arrives later gets a higher number and does not change the others'
  const list = (await listShares(store, v, { cacheDir })).reverse();
  const [verb, which] = a._;
  if (!verb) {
    if (!list.length) {
      info("Nothing was shared with you yet.");
      info(dim(`Give people your share address, and they can: ${myShareAddress(v)}`));
      return;
    }
    out(table(list.map((r, i) => [bold(String(i + 1)), r.id.slice(0, 8), describe(r), short(r.from), when(r.record.time), r.record.note || dim("-")]), ["#", "id", "what", "from (share address)", "sent", "note"]));
    info(dim('Keep one with: chainboot shared accept <number or id>. Check the "from" address with the sender if you did not expect it.'));
    return;
  }
  if (verb !== "accept") throw new UsageError('use: chainboot shared, or chainboot shared accept <number> [--name <name>]');
  const byId = which && which.length >= 6 ? list.filter((x) => x.id.startsWith(which)) : [];
  if (byId.length > 1) throw new Error(`"${which}" is the start of several ids; give more of it`);
  const r = byId[0] ?? (/^\d{1,4}$/.test(which ?? "") ? list[Number(which) - 1] : undefined);
  if (!r) throw new Error(which ? `there is no share "${which}". See the list with: chainboot shared` : "say which one: chainboot shared accept <number or id>");
  const name = flag(a, "name") ?? r.record.name;
  if (!(await confirm(`Keep ${describe(r)} from ${r.from}${name !== r.record.name ? ` as "${name}"` : ""}?`, a))) { info("cancelled"); return; }
  if (r.record.what === "image") {
    // (naming it yourself is how you say that it may be added to an image you already have under that name)
    await acceptImage(store, v, r.record, name, { merge: flag(a, "name") !== undefined });
    ok(`${bold(name)} is now one of your private images`);
    info(dim(`Run it with: chainboot run ${PRIVATE_PREFIX}/${name}`));
  } else {
    await acceptMachine(store, v, r.record, name, { cacheDir });
    ok(`${bold(name)} is now one of your saved machines`);
    info(dim(`Bring it to this computer with: chainboot run ${name}`));
  }
}
