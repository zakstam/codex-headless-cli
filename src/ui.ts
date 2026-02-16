import chalk from "chalk";
import ora, { type Ora } from "ora";
import { stdout } from "node:process";

export function printWelcome(threadId: string): void {
  console.log(
    chalk.bold.cyan("\n  zz") + chalk.gray(` — thread ${threadId}\n`),
  );
  console.log(chalk.gray("  Type a message and press Enter."));
  console.log(chalk.gray("  Commands: /interrupt, /help, /exit\n"));
}

export function writeAssistantDelta(text: string): void {
  stdout.write(text);
}

export function finishAssistantOutput(): void {
  stdout.write("\n");
}

export function printError(msg: string): void {
  console.error(chalk.red(`error: ${msg}`));
}

export function printApproval(details: string): void {
  console.log(chalk.yellow(`\n[approval required] ${details}`));
}

export function writeCommandOutput(text: string): void {
  stdout.write(chalk.dim(text));
}

export function writeDebugTag(tag: string): void {
  stdout.write(chalk.bold.magenta(`[${tag}] `));
}

export function createSpinner(text: string): Ora {
  return ora({ text, color: "cyan" });
}

// ---------------------------------------------------------------------------
// Animated reasoning display — sticky status bar
//
// Uses a terminal scroll region to pin the reasoning line to the bottom row.
// All normal output scrolls within rows 1..(rows-1), while the reasoning
// line renders on the last row via save/restore cursor sequences.
// Cleared when the turn ends.
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class ReasoningDisplay {
  private text = "";
  private frameIdx = 0;
  private tick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private readonly prefix: string;
  private rows = 0;
  private resizeHandler: (() => void) | null = null;

  constructor(debug = false) {
    this.prefix = debug
      ? chalk.bold.magenta("[reasoning] ")
      : chalk.dim.italic("thinking: ");
  }

  /** Start the animated reasoning status bar on the last terminal row. */
  start(): void {
    this.text = "";
    this.active = true;
    this.rows = stdout.rows ?? 24;

    // Reserve last row: save cursor, set scroll region, restore cursor.
    // Setting a scroll region homes the cursor (VT100 spec), so we must
    // save/restore around it to keep the output position intact.
    stdout.write("\x1b7");
    stdout.write(`\x1b[1;${this.rows - 1}r`);
    stdout.write("\x1b8");
    stdout.write("\x1b[?25l"); // hide cursor

    this.resizeHandler = () => {
      // Clear old reasoning line, update scroll region (save/restore around it)
      stdout.write(`\x1b7\x1b[${this.rows};1H\x1b[K\x1b8`);
      this.rows = stdout.rows ?? 24;
      stdout.write("\x1b7");
      stdout.write(`\x1b[1;${this.rows - 1}r`);
      stdout.write("\x1b8");
      this.render();
    };
    stdout.on("resize", this.resizeHandler);

    this.tick = 0;
    this.timer = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % SPINNER_FRAMES.length;
      this.tick++;
      this.render();
    }, 80);
  }

  /** Add a reasoning delta. Newlines reset the display so each new line
   *  of reasoning replaces the previous one. */
  addDelta(delta: string): void {
    this.text += delta;
    const nl = this.text.lastIndexOf("\n");
    if (nl !== -1) {
      this.text = this.text.slice(nl + 1);
    }
    this.render();
  }

  /** Section break — start a new reasoning segment, clearing the old. */
  sectionBreak(): void {
    this.text = "";
    this.render();
  }

  /** Temporarily suspend the status bar so interactive prompts can work.
   *  Stops the timer, clears the reasoning line, resets the scroll region,
   *  and shows the cursor. Call resume() to restart. */
  pause(): void {
    if (!this.active) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Clear reasoning line
    stdout.write(`\x1b7\x1b[${this.rows};1H\x1b[K\x1b8`);
    // Reset scroll region
    stdout.write("\x1b7");
    stdout.write(`\x1b[1;${this.rows}r`);
    stdout.write("\x1b8");
    stdout.write("\x1b[?25h"); // show cursor
  }

  /** Re-enable the status bar after a pause(). */
  resume(): void {
    if (!this.active) return;
    this.rows = stdout.rows ?? 24;
    stdout.write("\x1b7");
    stdout.write(`\x1b[1;${this.rows - 1}r`);
    stdout.write("\x1b8");
    stdout.write("\x1b[?25l"); // hide cursor
    this.timer = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % SPINNER_FRAMES.length;
      this.tick++;
      this.render();
    }, 80);
  }

  /** Clear the reasoning status bar and restore the full terminal. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.resizeHandler) {
      stdout.off("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    // Clear reasoning line
    stdout.write(`\x1b7\x1b[${this.rows};1H\x1b[K\x1b8`);
    // Reset scroll region to full terminal (save/restore around it
    // because setting a scroll region homes the cursor per VT100 spec)
    stdout.write("\x1b7");
    stdout.write(`\x1b[1;${this.rows}r`);
    stdout.write("\x1b8");
    stdout.write("\x1b[?25h"); // show cursor
  }

  private render(): void {
    if (!this.active) return;
    const cols = stdout.columns ?? 80;
    const spinner = chalk.cyan(SPINNER_FRAMES[this.frameIdx]!);
    const pfx = `${spinner} ${this.prefix}`;
    const prefixLen = stripAnsi(pfx).length;
    const maxText = cols - prefixLen - 1;
    const visible = this.text.length > maxText
      ? "…" + this.text.slice(-(maxText - 1))
      : this.text;
    // Save cursor, jump to last row, clear & write reasoning, restore cursor
    const animated = animateReasoning(visible, this.tick);
    stdout.write(
      `\x1b7\x1b[${this.rows};1H\x1b[K${pfx}${animated}\x1b8`,
    );
  }
}

/** Strip markdown **bold** markers from text, returning plain chars and
 *  a parallel boolean array marking which chars were bold. */
function parseBoldMarkers(text: string): { chars: string[]; bold: boolean[] } {
  const chars: string[] = [];
  const bold: boolean[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (const ch of text.slice(last, m.index)) {
      chars.push(ch);
      bold.push(false);
    }
    for (const ch of m[1]!) {
      chars.push(ch);
      bold.push(true);
    }
    last = m.index + m[0].length;
  }
  for (const ch of text.slice(last)) {
    chars.push(ch);
    bold.push(false);
  }
  return { chars, bold };
}

/** Render reasoning text with a seamless shimmer wave and markdown **bold**.
 *  `tick` is a continuously incrementing counter (never wraps). */
function animateReasoning(text: string, tick: number): string {
  const { chars, bold } = parseBoldMarkers(text);
  const len = chars.length;
  if (len === 0) return "";

  // A sine wave of brightness spans the text and drifts rightward.
  // `waveLen` sets how many characters one full sine cycle covers.
  // The phase offset (`tick * step`) shifts the wave each frame.
  const waveLen = Math.max(len, 20);
  const step = 0.04;
  const minGray = 100;
  const maxGray = 235;

  return chars
    .map((ch, i) => {
      const phase = ((i / waveLen) - tick * step) * 2 * Math.PI;
      const t = (Math.sin(phase) + 1) / 2;
      const gray = Math.floor(minGray + (maxGray - minGray) * t);
      const color = chalk.rgb(gray, gray, gray);
      return bold[i] ? color.bold(ch) : color(ch);
    })
    .join("");
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Waiting spinner — shown between sending a turn and receiving the first token
// ---------------------------------------------------------------------------

export class WaitingSpinner {
  private spinner: Ora | null = null;

  start(): void {
    this.spinner = ora({ text: chalk.dim("Waiting for response..."), color: "cyan", discardStdin: false }).start();
  }

  stop(): void {
    if (this.spinner) {
      this.spinner.stop();
      // Clear the spinner line completely
      stdout.write("\r\x1b[K");
      this.spinner = null;
    }
  }
}
