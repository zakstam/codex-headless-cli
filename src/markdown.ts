import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import { marked } from "marked";

// Strip ANSI escape codes for measuring visible string width.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

const headingColors = [
  chalk.bold.cyan,
  chalk.bold.green,
  chalk.bold.yellow,
  chalk.bold.magenta,
];

marked.use({
  renderer: {
    // ── Block-level ───────────────────────────────────────────────────────

    heading({ tokens, depth }) {
      const color = headingColors[Math.min(depth - 1, headingColors.length - 1)] ?? chalk.bold;
      return color(this.parser.parseInline(tokens)) + "\n";
    },
    paragraph({ tokens }) {
      return this.parser.parseInline(tokens) + "\n";
    },
    blockquote({ tokens }) {
      const inner = this.parser.parse(tokens);
      return inner
        .trimEnd()
        .split("\n")
        .map((l) => chalk.dim("  | ") + l)
        .join("\n") + "\n";
    },
    list({ ordered, items }) {
      let body = "";
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const rendered = this.parser.parse(item.tokens).trimEnd();
        const prefix = ordered ? chalk.dim((i + 1) + ".") : chalk.dim("*");
        const checkbox = item.task
          ? (item.checked ? chalk.green("[x] ") : chalk.dim("[ ] "))
          : "";
        body += "  " + prefix + " " + checkbox + rendered + "\n";
      }
      return body;
    },
    listitem(item) {
      return this.parser.parse(item.tokens).trimEnd();
    },
    checkbox({ checked }) {
      return checked ? chalk.green("[x] ") : chalk.dim("[ ] ");
    },
    table({ header, rows, align }) {
      const pad = (s: string, w: number, a: string | null) => {
        const gap = Math.max(0, w - stripAnsi(s).length);
        if (a === "right") return " ".repeat(gap) + s;
        if (a === "center") return " ".repeat(Math.floor(gap / 2)) + s + " ".repeat(Math.ceil(gap / 2));
        return s + " ".repeat(gap);
      };

      const headerCells = header.map((c) => chalk.bold.cyan(this.parser.parseInline(c.tokens)));
      const bodyRows = rows.map((row) => row.map((c) => this.parser.parseInline(c.tokens)));

      const colWidths = header.map((_, ci) => {
        const cells = [headerCells[ci]!, ...bodyRows.map((r) => r[ci]!)];
        return Math.max(...cells.map((c) => stripAnsi(c).length));
      });

      const fmtRow = (cells: string[]) =>
        "  " + cells.map((c, ci) => pad(c, colWidths[ci]!, align[ci] ?? null)).join(chalk.dim(" | "));

      let out = fmtRow(headerCells) + "\n";
      out += "  " + colWidths.map((w) => chalk.dim("─".repeat(w))).join(chalk.dim("─┼─")) + "\n";
      for (const row of bodyRows) {
        out += fmtRow(row) + "\n";
      }
      return out;
    },
    tablerow({ text }) {
      return text;
    },
    tablecell({ tokens }) {
      return this.parser.parseInline(tokens);
    },
    hr() {
      return chalk.dim("─".repeat(40)) + "\n";
    },
    // Code blocks are handled by MarkdownWriter directly (gutter + syntax
    // highlighting), so this only fires for inline code fences that slip
    // through paragraph rendering. Return raw text.
    code({ text }) {
      return text + "\n";
    },
    space() {
      return "";
    },
    html({ text }) {
      return text;
    },

    // ── Inline-level ──────────────────────────────────────────────────────

    strong({ tokens }) {
      return chalk.bold(this.parser.parseInline(tokens));
    },
    em({ tokens }) {
      return chalk.italic(this.parser.parseInline(tokens));
    },
    codespan({ text }) {
      return chalk.cyan("`" + text + "`");
    },
    del({ tokens }) {
      return chalk.strikethrough(this.parser.parseInline(tokens));
    },
    link({ tokens, href }) {
      return chalk.cyan.underline(this.parser.parseInline(tokens)) + chalk.dim(" (" + href + ")");
    },
    image({ text }) {
      return chalk.dim("[image: " + text + "]");
    },
    br() {
      return "\n";
    },
    text(token) {
      // Block-level text tokens (e.g. tight list items) carry nested inline
      // tokens that need rendering. Inline text tokens have no nested tokens.
      if ("tokens" in token && token.tokens && token.tokens.length > 0) {
        return this.parser.parseInline(token.tokens);
      }
      return token.text;
    },
  },
});

/**
 * Streaming markdown renderer for terminal output.
 *
 * Accumulates streaming deltas and groups them into paragraphs (text between
 * blank lines). Each completed paragraph is rendered as a unit through
 * marked with a custom chalk renderer, which gives marked full context for
 * multi-line constructs like lists, tables, and blockquotes.
 *
 * Code blocks are tracked across lines and rendered with a gutter + syntax
 * highlighting, bypassing marked entirely.
 *
 * During streaming, `getBuffer()` returns the raw text of the current
 * in-progress paragraph plus any partial line, so the UI can show live output
 * while the paragraph is still building.
 */
export class MarkdownWriter {
  private buffer = "";
  private paragraphBuffer: string[] = [];
  private inCodeBlock = false;
  private codeBlockFenceChar = "";
  private codeBlockFenceLen = 0;
  private codeBlockLang = "";
  private readonly onLine: (rendered: string) => void;

  constructor(onLine: (rendered: string) => void) {
    this.onLine = onLine;
  }

  /** Append streaming delta text, rendering complete lines as they arrive. */
  addDelta(text: string): void {
    this.buffer += text;
    let nlIdx: number;
    while ((nlIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);
      this.processLine(line);
    }
  }

  /** Flush remaining buffer (call at end of turn). */
  flush(): void {
    if (this.buffer.length > 0) {
      this.processLine(this.buffer);
      this.buffer = "";
    }
    this.flushParagraph();
  }

  /**
   * Return the current in-progress text for live display.
   * Includes accumulated paragraph lines plus the partial line buffer.
   */
  getBuffer(): string {
    const parts = [...this.paragraphBuffer];
    if (this.buffer) parts.push(this.buffer);
    return parts.join("\n");
  }

  /** Reset state for a new turn / response segment. */
  reset(): void {
    this.buffer = "";
    this.paragraphBuffer = [];
    this.inCodeBlock = false;
    this.codeBlockFenceChar = "";
    this.codeBlockFenceLen = 0;
    this.codeBlockLang = "";
  }

  private processLine(line: string): void {
    // Check for code fences (``` or ~~~)
    const fenceMatch = line.match(/^(\s*)((`{3,})|(~{3,}))\s*(.*)$/);
    if (fenceMatch) {
      const char = fenceMatch[3] ? "`" : "~";
      const len = (fenceMatch[3] ?? fenceMatch[4])!.length;

      if (!this.inCodeBlock) {
        this.flushParagraph();
        this.inCodeBlock = true;
        this.codeBlockFenceChar = char;
        this.codeBlockFenceLen = len;
        this.codeBlockLang = fenceMatch[5]?.trim() ?? "";
        const label = this.codeBlockLang
          ? chalk.dim.italic(` ${this.codeBlockLang} `)
          : "";
        this.onLine(chalk.dim("  ┌──") + label);
        return;
      }

      if (char === this.codeBlockFenceChar && len >= this.codeBlockFenceLen) {
        this.inCodeBlock = false;
        this.onLine(chalk.dim("  └──"));
        return;
      }
    }

    // Inside code block — syntax highlight + gutter
    if (this.inCodeBlock) {
      const highlighted = highlightLine(line, this.codeBlockLang);
      this.onLine(chalk.dim("  │ ") + highlighted);
      return;
    }

    // Outside code block — accumulate into paragraph buffer.
    // A blank line marks a paragraph boundary.
    if (line.trim() === "") {
      this.flushParagraph();
    } else {
      this.paragraphBuffer.push(line);
    }
  }

  /** Render the accumulated paragraph through marked as a unit. */
  private flushParagraph(): void {
    if (this.paragraphBuffer.length === 0) return;
    const text = this.paragraphBuffer.join("\n") + "\n";
    this.paragraphBuffer = [];
    try {
      const rendered = (marked.parse(text) as string).replace(/\n+$/, "");
      this.onLine(rendered);
    } catch (err) {
      // Log rendering failures so they're visible during development.
      // The fallback ensures raw text is still shown to the user.
      if (process.env["DEBUG"]) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[md] render error: ${msg}\n`);
      }
      this.onLine(text.trimEnd());
    }
  }
}

/** Syntax-highlight a single code line. Falls back to plain text on error
 *  or when the language isn't recognized. */
function highlightLine(line: string, lang: string): string {
  try {
    const opts = lang && supportsLanguage(lang) ? { language: lang } : {};
    return highlight(line, opts);
  } catch {
    return line;
  }
}
