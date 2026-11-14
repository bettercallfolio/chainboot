// A small command-line parser: positionals, --flag, --name value, --name=value, repeatable options.
export interface Args { _: string[]; flags: Map<string, string[]> }

export function parseArgs(argv: string[], booleans: string[] = [], known?: string[]): Args {
  const out: Args = { _: [], flags: new Map() };
  const push = (k: string, v: string) => { const l = out.flags.get(k) ?? []; l.push(v); out.flags.set(k, l); };
  // with `known` (every option of the command), an option that is not a yes/no option needs a value
  const needsValue = (key: string) => !!known && known.includes(key) && !booleans.includes(key);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) push(key, a.slice(eq + 1));
      else if (booleans.includes(key)) push(key, "true");
      else if (i + 1 >= argv.length || argv[i + 1]!.startsWith("--")) {
        // (a value that itself begins with two dashes is written as --option=value)
        if (needsValue(key)) throw new UsageError(`--${key} needs a value: --${key} <value>`);
        push(key, "true");
      } else push(key, argv[++i]!);
    } else if (a === "-h") push("help", "true");
    else if (a === "-y") push("yes", "true");
    // a single dash followed by letters is an option chainboot does not have (a number such as -1 is a value)
    else if (known && /^-[A-Za-z]/.test(a)) throw new UsageError(`unknown option ${a}`);
    else out._.push(a);
  }
  return out;
}

export function flag(a: Args, name: string): string | undefined { return a.flags.get(name)?.at(-1); }
export function flags(a: Args, name: string): string[] { return a.flags.get(name) ?? []; }
export function has(a: Args, name: string): boolean { const v = flag(a, name); return v !== undefined && !["false", "0", "no", "off"].includes(v.toLowerCase()); }

/** Rejects options the command does not know, so a typo never passes silently. */
export function allow(a: Args, known: string[]): void {
  for (const k of a.flags.keys()) {
    if (!known.includes(k) && k !== "help") throw new UsageError(`unknown option --${k}`);
  }
}

export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = "UsageError"; }
}
