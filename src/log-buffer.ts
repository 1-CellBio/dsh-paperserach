/** Incremental UTF-8 log for `job_output` (one consuming cursor). */

export class LineLog {
  private readonly lines: string[] = [];
  private cursor = 0;
  private onAppend?: (line: string) => void;

  constructor(onAppend?: (line: string) => void) {
    this.onAppend = onAppend;
  }

  /** Attach (or replace) the live tap; sees each line as it is appended. */
  tap(listener: (line: string) => void): void {
    this.onAppend = listener;
  }

  append(line: string): void {
    const cleaned = line.replace(/\s+$/u, "");
    this.lines.push(cleaned);
    this.onAppend?.(cleaned);
  }

  readOutput(): string {
    if (this.cursor >= this.lines.length) {
      return "";
    }
    const chunk = this.lines.slice(this.cursor).join("\n");
    this.cursor = this.lines.length;
    return `${chunk}\n`;
  }

  snapshot(): string {
    return this.lines.join("\n");
  }
}
