// Terminal output: colours when the terminal supports them, one live progress line, plain text otherwise.
import { fmtBytes, fmtDuration } from "../util/bytes.ts";

const tty = process.stderr.isTTY === true;
const color = tty && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = wrap("1"), dim = wrap("2"), green = wrap("32"), red = wrap("31"), yellow = wrap("33"), cyan = wrap("36");

let liveShown = false;
function clearLive(): void {
  if (liveShown) { process.stderr.write("\r\x1b[2K"); liveShown = false; }
}

/** A normal line on stdout (results the user may pipe elsewhere). */
export function out(text = ""): void { clearLive(); process.stdout.write(text + "\n"); }
/** A status line on stderr. */
export function info(text = ""): void { clearLive(); process.stderr.write(text + "\n"); }
export function ok(text: string): void { info(`${green("✔")} ${text}`); }
export function warn(text: string): void { info(`${yellow("!")} ${text}`); }
export function fail(text: string): void { info(`${red("✖")} ${text}`); }

/** A progress line that overwrites itself on a terminal and stays quiet when output is redirected. */
export class ProgressLine {
  #label = "";
  #started = Date.now();
  #lastDraw = 0;
  #lastPlain = 0;
  #samples: [number, number][] = [];

  start(label: string): void { this.#label = label; this.#started = Date.now(); this.#samples = []; this.#lastDraw = 0; }

  update(done: number, total: number, unit: "bytes" | "count" = "bytes", label?: string): void {
    if (label !== undefined && label !== this.#label) this.start(label);
    const now = Date.now();
    if (now - this.#lastDraw < 100 && done < total) return;
    this.#lastDraw = now;
    this.#samples.push([now, done]);
    while (this.#samples.length > 2 && now - this.#samples[0]![0] > 5000) this.#samples.shift();
    const [t0, d0] = this.#samples[0]!;
    const speed = now > t0 ? ((done - d0) * 1000) / (now - t0) : 0;
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    const fmt = unit === "bytes" ? fmtBytes : (n: number) => String(Math.round(n));
    const eta = speed > 0 && done < total ? ` · ${fmtDuration((total - done) / speed)} left` : "";
    const rate = speed > 0 ? ` · ${fmt(speed)}/s` : "";
    if (tty) {
      const width = 24, filled = Math.round((pct / 100) * width);
      const bar = cyan("█".repeat(filled)) + dim("░".repeat(width - filled));
      process.stderr.write(`\r\x1b[2K${this.#label} ${bar} ${pct.toFixed(0).padStart(3)}% · ${fmt(done)} / ${fmt(total)}${rate}${eta}`);
      liveShown = true;
    } else if (now - this.#lastPlain > 5000 || done >= total) {
      this.#lastPlain = now;
      process.stderr.write(`${this.#label}: ${pct.toFixed(0)}% (${fmt(done)} / ${fmt(total)})\n`);
    }
  }

  done(text?: string): void {
    clearLive();
    if (text) ok(`${text} ${dim(`(${fmtDuration((Date.now() - this.#started) / 1000)})`)}`);
  }
}

export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const widths: number[] = [];
  for (const r of all) r.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, strip(c).length); });
  const line = (r: string[]) => r.map((c, i) => c + " ".repeat(widths[i]! - strip(c).length)).join("  ").trimEnd();
  return [...(header ? [bold(line(header))] : []), ...rows.map(line)].join("\n");
}
