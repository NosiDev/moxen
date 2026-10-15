/**
 * The transcript on disk: one JSON object per line, appended as messages are
 * made, so a crash loses at most the line being written and a restart resumes
 * from exactly what the model last saw. The file name is the session id and
 * therefore the `resumeCursor`.
 */
import fs from "node:fs";
import path from "node:path";

import type { TranscriptMessage } from "./types.js";

const FORMAT = 1;

export class HarnessTranscript {
  readonly #file: string;
  readonly #messages: TranscriptMessage[];

  private constructor(file: string, messages: TranscriptMessage[]) {
    this.#file = file;
    this.#messages = messages;
  }

  /** Load a session, or start an empty one at the same path. A cut-off last line is ignored. */
  static open(file: string): HarnessTranscript {
    const messages: TranscriptMessage[] = [];
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      text = "";
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const record = JSON.parse(line) as { v?: number; m?: TranscriptMessage };
        if (record.v === FORMAT && record.m) messages.push(record.m);
      } catch {
        // A line cut short by a crash; everything before it is intact.
      }
    }
    return new HarnessTranscript(file, messages);
  }

  static pathFor(directory: string, sessionId: string): string {
    return path.join(directory, `${sessionId}.jsonl`);
  }

  get messages(): readonly TranscriptMessage[] {
    return this.#messages;
  }

  get file(): string {
    return this.#file;
  }

  append(message: TranscriptMessage): void {
    this.#messages.push(message);
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.appendFileSync(this.#file, `${JSON.stringify({ v: FORMAT, m: message })}\n`, "utf8");
  }

  /** Replace everything (rollback, compaction). Written to a temp file and renamed so the old text survives a crash. */
  replace(messages: readonly TranscriptMessage[]): void {
    this.#messages.splice(0, this.#messages.length, ...messages);
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.tmp`;
    fs.writeFileSync(temp, this.#messages.map((m) => `${JSON.stringify({ v: FORMAT, m })}\n`).join(""), "utf8");
    fs.renameSync(temp, this.#file);
  }

  /**
   * Where turns can still be taken back from: just after what the last summary
   * already accounts for. Before it, the thread is the summary's to describe.
   */
  get rewindFloor(): number {
    const at = this.#messages.findIndex((message) => message.role === "user" && message.compactSummary);
    return at === -1 ? 0 : at + 1 + (this.#messages[at] as { compactSummary: { covers: number } }).compactSummary.covers;
  }

  /** The prompts the user sent that can still be rolled back. */
  get promptCount(): number {
    return this.#messages.filter((message, index) => index >= this.rewindFloor && message.role === "user").length;
  }

  /** How many times this session has been compacted (the number on the summary it holds). */
  get compactions(): number {
    for (const message of this.#messages) if (message.role === "user" && message.compactSummary) return message.compactSummary.n;
    return 0;
  }

  /**
   * Drop the last `count` user prompts and everything after each. Returns how
   * many were dropped. It stops at the last compaction: what the summary
   * covers cannot be taken back, so a request for more than the transcript can
   * give drops what it can and the caller sees the shortfall.
   */
  rollback(count: number): number {
    const floor = this.rewindFloor;
    let dropped = 0;
    let cut = this.#messages.length;
    for (let index = this.#messages.length - 1; index >= floor && dropped < count; index -= 1) {
      if (this.#messages[index]!.role === "user") {
        cut = index;
        dropped += 1;
      }
    }
    if (dropped > 0) this.replace(this.#messages.slice(0, cut));
    return dropped;
  }

  /** Where the messages compactions dropped are kept: one file per compaction, so the whole history can still be read. */
  get archiveDir(): string {
    return path.join(path.dirname(this.#file), "archive", path.basename(this.#file, ".jsonl"));
  }

  /** Keep what compaction number `n` is about to drop. Written before the transcript is replaced, and again if the same compaction is retried after a crash. */
  archive(n: number, dropped: readonly TranscriptMessage[]): void {
    fs.mkdirSync(this.archiveDir, { recursive: true });
    const file = path.join(this.archiveDir, `${String(n).padStart(4, "0")}.jsonl`);
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, dropped.map((m) => `${JSON.stringify({ v: FORMAT, m })}\n`).join(""), "utf8");
    fs.renameSync(temp, file);
  }

  /** Everything compactions dropped before the one the transcript holds now, oldest first. */
  archived(): TranscriptMessage[] {
    const upTo = this.compactions;
    const out: TranscriptMessage[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.archiveDir).filter((name) => /^\d+\.jsonl$/.test(name)).sort();
    } catch {
      return out;
    }
    for (const name of names) {
      if (Number.parseInt(name, 10) > upTo) continue;
      for (const line of fs.readFileSync(path.join(this.archiveDir, name), "utf8").split("\n")) {
        if (line.trim() === "") continue;
        try {
          const record = JSON.parse(line) as { v?: number; m?: TranscriptMessage };
          if (record.v === FORMAT && record.m) out.push(record.m);
        } catch {
          // A cut-off line; the rest is intact.
        }
      }
    }
    return out;
  }

  /** A copy under a new path, for forking a session. */
  copyTo(file: string): HarnessTranscript {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(this.#file, file);
    const copy = HarnessTranscript.open(file);
    if (fs.existsSync(this.archiveDir)) fs.cpSync(this.archiveDir, copy.archiveDir, { recursive: true });
    return copy;
  }
}
