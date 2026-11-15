// Issues, pull requests and comments of a repository on chain.
//
// Every repository has an address that anybody may write to (repo.ts, talkTag). What is
// written there is a small record, signed by whoever sent the transaction:
//
//   issue      a title and a text
//   pr         "please take branch B of my repository into your branch A": a title, a text,
//              where the commits are (owner, repository, branch, commit) and where they should go
//   comment    a text on an issue or a pull request
//   state      open, closed or merged. Counts only from the repository's owner or from the
//              author of the issue or pull request ("merged" only from the owner).
//
// The ledger keeps them in the order they arrived, so the first issue or pull request is #1,
// the next #2, for everybody and for ever. Nobody can take a record away, the owner included:
// what a reader shows of other people's records is the reader's business.
//
// A record that fits one transaction is that transaction. A longer one is stored as an object
// and the record names it. In a private repository records are encrypted with its key.
import { addressToBytes, type Keypair } from "../solana/keys.ts";
import { open, seal } from "../state/vault.ts";
import type { ChainStore } from "../store/store.ts";
import { b58encode } from "../util/base58.ts";
import { talkTag } from "./repo.ts";
import { cleanRecord, recordObject, thread, type Found, type Item, type TalkRecord } from "./talk-core.ts";

export { cleanRecord, type Comment, type Item, type StateChange, type TalkRecord } from "./talk-core.ts";


/** Writes a record to a repository's address. Returns the signature of its transaction. */
export async function postTalk(store: ChainStore, signer: Keypair, owner: string, name: string, record: TalkRecord, key?: Uint8Array): Promise<string> {
  const clean = cleanRecord(record);
  if (!clean) throw new Error("that is not a record a repository takes (an issue and a pull request need a title, a comment needs a text)");
  const tag = talkTag(addressToBytes(owner), name);
  const wrap = (plain: Buffer) => (key ? seal(key, plain, "git-talk") : plain);
  let payload = wrap(Buffer.from(JSON.stringify(clean), "utf8"));
  if (payload.length > store.pointerCapacity()) {
    // too long for one transaction: the record becomes an object, and the transaction names it
    const o = await store.put(signer, payload);
    payload = wrap(Buffer.from(JSON.stringify({ o: { sig: o.sig, size: o.size, sha256: o.sha256 } }), "utf8"));
  }
  return store.putPointer(signer, tag, payload);
}

/**
 * Everything that was said about a repository, put together: its issues and pull requests in
 * the order they were opened, each with its comments and its state.
 */
export async function readTalk(store: ChainStore, owner: string, name: string, key?: Uint8Array): Promise<Item[]> {
  const records = (await store.listAllPointers(talkTag(addressToBytes(owner), name))).reverse();   // oldest first
  const unwrap = (data: Buffer): unknown => {
    let plain = data;
    if (data[0] !== 0x7b) {   // not "{": encrypted (a private repository)
      if (!key) return null;
      try { plain = open(key, data, "git-talk"); } catch { return null; }
    }
    try { return JSON.parse(plain.toString("utf8")); } catch { return null; }
  };
  const found: Found[] = [];
  for (const p of records) {
    let value = unwrap(p.payload);
    const o = recordObject(value);
    // (the object must be by the one who wrote the record: nobody can make a record say what somebody else stored)
    if (o) { try { value = unwrap(await store.get(o, { signers: [p.payer] })); } catch { continue; } }
    const record = cleanRecord(value);
    if (record) found.push({ id: p.signature, author: b58encode(p.payer), time: p.blockTime, record });
  }
  return thread(owner, found);
}
