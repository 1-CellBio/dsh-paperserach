/**
 * Hand-off of freshly staged PDFs to an ingest consumer.
 *
 * Plugins are published and loaded separately, so papersearch never imports
 * dsh-okf. After a tool run leaves PDFs on disk it dispatches the
 * `papersearch/staged` event with `ctx.serial`; dsh-okf answers it by starting
 * an `okf-ingest` job owned by the same agent. With no listener (okf not
 * loaded) or a declined hand-off the tool result keeps the manual
 * `okf_ingest` instruction.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import path from "node:path";
import type { LineLog } from "./log-buffer";
import type { DownloadOutcome } from "./registry";

/** PDFs a papersearch tool run left on disk; the payload of `papersearch/staged`. */
export interface StagedPdfs {
  /** Agent whose tool call staged the files; a consumer owns the jobs it starts by it. */
  agent?: ToolRunContext["agent"];
  /** Tool that staged the files (job label, log lines). */
  origin: string;
  /** Absolute paths of PDFs on disk: downloaded, replaced, or unchanged (`exists`). */
  files: string[];
}

/** How the consumer answered a {@link StagedPdfs} event. */
export type IngestHandoff =
  | { status: "started"; jobId: string; files: number }
  | { status: "not-started"; reason: string };

declare module "@deepseek-ai/cordis" {
  interface Events {
    /**
     * PDFs were staged on disk by a papersearch tool. A consumer that takes
     * them over (dsh-okf starts an ingest job) returns an {@link IngestHandoff};
     * returning `undefined` passes the event to the next listener.
     * @param event - the staged files and the agent whose tool call staged them.
     * @mode serial
     */
    "papersearch/staged"(event: StagedPdfs): Promise<IngestHandoff | undefined>;
  }
}

/** Outcomes that leave a PDF on disk the consumer should look at. */
function leavesFile(outcome: DownloadOutcome): boolean {
  return outcome.status === "downloaded" || outcome.status === "replaced" || outcome.status === "exists";
}

/**
 * Absolute, de-duplicated paths of the PDFs a result set left on disk.
 * @param outcomes - per-paper outcomes of one tool run.
 * @returns the staged file paths (empty when nothing was saved or found unchanged).
 */
export function stagedFiles(outcomes: readonly DownloadOutcome[]): string[] {
  const files = new Set<string>();
  for (const outcome of outcomes) {
    if (leavesFile(outcome) && outcome.path) files.add(path.resolve(outcome.path));
  }
  return [...files];
}

/**
 * Announce staged PDFs to the ingest consumer and report what it did.
 * A consumer that throws is reported as `not-started`; no listener answering
 * (or none installed) yields `undefined`.
 * @param ctx - plugin context that dispatches the event.
 * @param exec - tool execution whose agent owns the consumer's job.
 * @param origin - tool name, shown in the consumer's job label.
 * @param outcomes - per-paper outcomes of the tool run.
 * @param log - optional job log that records the hand-off.
 * @returns the consumer's answer, or `undefined` when nothing was staged or nobody answered.
 */
export async function handOffStaged(
  ctx: Context,
  exec: Pick<ToolRunContext, "agent">,
  origin: string,
  outcomes: readonly DownloadOutcome[],
  log?: LineLog,
): Promise<IngestHandoff | undefined> {
  const files = stagedFiles(outcomes);
  if (files.length === 0 || typeof ctx.serial !== "function") return undefined;
  let answer: IngestHandoff | undefined;
  try {
    answer = await ctx.serial("papersearch/staged", { agent: exec.agent, origin, files });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log?.append(`auto-ingest hand-off failed: ${reason}`);
    return { status: "not-started", reason };
  }
  if (answer === undefined) {
    log?.append(`auto-ingest: no ingest consumer answered for ${files.length} staged file(s)`);
    return undefined;
  }
  log?.append(
    answer.status === "started"
      ? `auto-ingest started: job ${answer.jobId} for ${answer.files} file(s)`
      : `auto-ingest not started: ${answer.reason}`,
  );
  return answer;
}

/** Manual instruction kept for results where the consumer did not take the files. */
const MANUAL_INGEST = "Call okf_ingest with the downloaded paths (relative names resolve against the download dir) to compile them into the OKF library";

/**
 * `nextStep` text for a finished tool run.
 * @param staged - number of PDFs the run left on disk.
 * @param handoff - the consumer's answer, if any.
 * @param tail - what to do once the library holds the papers.
 * @returns one instruction for the model.
 */
export function ingestNextStep(staged: number, handoff: IngestHandoff | undefined, tail: string): string {
  if (staged === 0) return "No PDF was staged, so there is nothing to ingest.";
  if (handoff?.status === "started") {
    return `okf ingest started automatically for ${handoff.files} staged file(s) as job ${handoff.jobId} — do NOT call okf_ingest on them again. You are notified in-session when the job finishes; ${tail}`;
  }
  if (handoff?.status === "not-started") {
    return `Automatic ingest did not start (${handoff.reason}). ${MANUAL_INGEST}; ${tail}`;
  }
  return `${MANUAL_INGEST}; ${tail}`;
}

/**
 * Job-detail clause that tells the notified model whether ingest is underway.
 * @param staged - number of PDFs the run left on disk.
 * @param handoff - the consumer's answer, if any.
 * @returns a ` — …` suffix for the completion detail, or `""` when nothing was staged.
 */
export function ingestDetailClause(staged: number, handoff: IngestHandoff | undefined): string {
  if (staged === 0) return "";
  if (handoff?.status === "started") {
    return ` — okf ingest started automatically as job ${handoff.jobId} (${handoff.files} file(s)); wait for its completion notice and do NOT call okf_ingest on these files`;
  }
  if (handoff?.status === "not-started") {
    return ` — automatic ingest did NOT start (${handoff.reason}): call okf_ingest on the staged files`;
  }
  return " — no ingest consumer answered: call okf_ingest on the staged files";
}
