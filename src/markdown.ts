import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
marked.use(markedTerminal() as any);

/**
 * Streaming markdown renderer for terminal output.
 *
 * Accumulates streaming deltas until a newline, then renders each complete
 * line with terminal formatting. Code blocks are tracked across lines and
 * rendered with a gutter + syntax highlighting; everything else goes through
 * marked + marked-terminal.
 *
 * Rendered lines are delivered via the `onLine` callback instead of writing
 * directly to stdout, making this compatible with Ink's rendering model.
 */
export class MarkdownWriter {
  private buffer = "";
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
  }

  /** Return the current partial-line buffer (for live display). */
  getBuffer(): string {
    return this.buffer;
  }

  /** Reset state for a new turn. */
  reset(): void {
    this.buffer = "";
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

    // Everything else — render through marked-terminal
    let rendered: string;
    try {
      rendered = (marked.parse(line + "\n") as string).replace(/\n+$/, "");
    } catch {
      rendered = line;
    }
    this.onLine(rendered);
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
