import { useState, useEffect } from "react";
import { Text } from "ink";
import chalk from "chalk";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type ReasoningBarProps = {
  text: string;
  debug: boolean;
};

export function ReasoningBar({ text, debug }: ReasoningBarProps) {
  const [frameIdx, setFrameIdx] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIdx((prev) => (prev + 1) % SPINNER_FRAMES.length);
      setTick((prev) => prev + 1);
    }, 80);
    return () => clearInterval(interval);
  }, []);

  const spinner = chalk.cyan(SPINNER_FRAMES[frameIdx]!);
  const prefix = debug
    ? chalk.bold.magenta("[reasoning] ")
    : chalk.dim.italic("thinking: ");

  const cols = process.stdout.columns ?? 80;
  const prefixLen = stripAnsi(`${spinner} ${prefix}`).length;
  const maxText = cols - prefixLen - 1;
  const visible =
    text.length > maxText ? "…" + text.slice(-(maxText - 1)) : text;
  const animated = animateReasoning(visible, tick);

  return <Text>{`${spinner} ${prefix}${animated}`}</Text>;
}

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

function animateReasoning(text: string, tick: number): string {
  const { chars, bold } = parseBoldMarkers(text);
  const len = chars.length;
  if (len === 0) return "";

  const waveLen = Math.max(len, 20);
  const step = 0.04;
  const minGray = 100;
  const maxGray = 235;

  return chars
    .map((ch, i) => {
      const phase = (i / waveLen - tick * step) * 2 * Math.PI;
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
