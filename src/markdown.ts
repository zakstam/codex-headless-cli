import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { stdout } from "node:process";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
marked.use(markedTerminal() as any);

/**
 * Streaming markdown renderer for terminal output.
 *
 * Accumulates streaming deltas until a newline, then renders each complete
 * line. Code blocks are tracked across lines and rendered with a gutter;
 * everything else is rendered through marked + marked-terminal.
 */
export class MarkdownWriter {
  private buffer = "";
  private inCodeBlock = false;
  private codeBlockFenceChar = "";
  private codeBlockFenceLen = 0;
  private codeBlockLang = "";

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
    stdout.write("\n");
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
        stdout.write(chalk.dim("  ┌──") + label + "\n");
        return;
      }

      if (char === this.codeBlockFenceChar && len >= this.codeBlockFenceLen) {
        this.inCodeBlock = false;
        stdout.write(chalk.dim("  └──") + "\n");
        return;
      }
    }

    // Inside code block — syntax highlight + gutter
    if (this.inCodeBlock) {
      const highlighted = highlightLine(line, this.codeBlockLang);
      stdout.write(chalk.dim("  │ ") + highlighted + "\n");
      return;
    }

    // Everything else — render through marked-terminal
    const rendered = (marked.parse(line + "\n") as string).replace(/\n+$/, "");
    if (rendered.length > 0) {
      stdout.write(rendered + "\n");
    } else {
      stdout.write("\n");
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
