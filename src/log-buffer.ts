/** Incremental UTF-8 log for the jobs output ring (0.1.7: registry-owned). */

export class LineLog {
  private readonly lines: string[] = [];
  private ringSink: ((chunk: string) => void) | undefined;

  /** 接线注册表输出环（run(job) 内调用一次；此后每行追加即进环）。 */
  ring(sink: (chunk: string) => void): void {
    this.ringSink = sink;
  }

  append(line: string): void {
    const cleaned = line.replace(/\s+$/u, "");
    this.lines.push(cleaned);
    this.ringSink?.(`${cleaned}\n`);
  }

  /** 进程内全量快照（调试/测试用；注册表侧另有 job_output 游标读）。 */
  snapshot(): string {
    return this.lines.join("\n");
  }
}
