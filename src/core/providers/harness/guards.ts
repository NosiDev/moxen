/**
 * Guards for the failures weaker models have and stronger ones mostly do not:
 * calling the same tool with the same arguments over and over, and replying
 * with nothing after a tool result. Both are the harness's problem to catch,
 * because a prompt asking the model not to is not a guarantee.
 */

/** What the model is allowed to repeat before the harness steps in. A profile can change each. */
export interface LoopGuardSettings {
  /** The same tool call this many times in one turn gets a warning in its result. */
  readonly repeatWarn: number;
  /** …and this many ends the turn. */
  readonly repeatStop: number;
  /** A reply repeating one 50-character stretch this many times is cut off. */
  readonly textRepeats: number;
  /** Watch for repeated tool calls at all. */
  readonly calls: boolean;
  /** Watch the streamed text and reasoning for a loop at all. */
  readonly text: boolean;
}

export const DEFAULT_LOOP_GUARD: LoopGuardSettings = { repeatWarn: 4, repeatStop: 6, textRepeats: 10, calls: true, text: true };

export type LoopVerdict = "ok" | "warn" | "stop";

/** Cycles of A,B,A,B… (or A,B,C,A,B,C…) before a warning, and before the turn ends. */
const CYCLES_WARN = 3;
const CYCLES_STOP = 5;
const HISTORY = 40;

/**
 * Counts what the model does within one turn: the same call again and again,
 * and the same few calls in a rotation (read, edit, read, edit, … each
 * different on its own, together a loop).
 */
export class LoopGuard {
  readonly #seen = new Map<string, number>();
  readonly #recent: string[] = [];
  readonly #settings: LoopGuardSettings;

  constructor(settings: Partial<LoopGuardSettings> = {}) {
    const merged = { ...DEFAULT_LOOP_GUARD, ...settings };
    // A stop that comes before the warning would never be warned about.
    this.#settings = { ...merged, repeatStop: Math.max(merged.repeatStop, merged.repeatWarn) };
  }

  record(name: string, rawArguments: string): LoopVerdict {
    if (!this.#settings.calls) return "ok";
    const key = `${name}\u0000${rawArguments.replace(/\s+/g, "")}`;
    const count = (this.#seen.get(key) ?? 0) + 1;
    this.#seen.set(key, count);
    this.#recent.push(key);
    if (this.#recent.length > HISTORY) this.#recent.shift();
    if (count >= this.#settings.repeatStop) return "stop";
    const cycles = this.#cycles();
    if (cycles >= CYCLES_STOP) return "stop";
    return count >= this.#settings.repeatWarn || cycles >= CYCLES_WARN ? "warn" : "ok";
  }

  /** How many full times the newest calls have gone round a cycle of two or three different calls. */
  #cycles(): number {
    let best = 0;
    for (const period of [2, 3]) {
      const tail = this.#recent.slice(-period);
      if (tail.length < period || new Set(tail).size < 2) continue;
      let length = 0;
      for (let i = this.#recent.length - 1; i >= 0; i -= 1) {
        if (this.#recent[i] !== this.#recent[this.#recent.length - 1 - ((this.#recent.length - 1 - i) % period)]) break;
        length += 1;
      }
      best = Math.max(best, Math.floor(length / period));
    }
    return best;
  }
}

const WINDOW = 50;
/** How much of the newest text is searched for repeats. */
const SCAN = 20_000;

/** Watches the text a model streams for one stretch coming round again and again (a degenerate loop). */
export class RepeatWatch {
  #text = "";
  #checkedAt = 0;
  readonly #limit: number;

  constructor(limit: number = DEFAULT_LOOP_GUARD.textRepeats) {
    this.#limit = Math.max(2, limit);
  }

  /** Feed the next piece of text; true when the stream has gone into a loop. */
  push(piece: string): boolean {
    this.#text += piece;
    if (this.#text.length > SCAN * 2) {
      this.#checkedAt = Math.max(0, this.#checkedAt - (this.#text.length - SCAN));
      this.#text = this.#text.slice(-SCAN);
    }
    let looped = false;
    while (this.#text.length - this.#checkedAt >= WINDOW) {
      this.#checkedAt += WINDOW;
      const end = this.#checkedAt;
      const window = this.#text.slice(end - WINDOW, end);
      // A rule of dashes or a run of spaces is layout, not a loop.
      if (new Set(window.replace(/\s/g, "")).size < 8) continue;
      const previous = this.#text.lastIndexOf(window, end - WINDOW - 1);
      if (previous === -1) continue;
      // The stretch has to come round at one steady period, back to back: a table whose rows share wording is not a loop.
      const period = end - WINDOW - previous;
      if (period * this.#limit > end) continue;
      let steady = true;
      for (let at = end - period * this.#limit; at < end - period; at += 1) {
        if (this.#text[at] !== this.#text[at + period]) {
          steady = false;
          break;
        }
      }
      if (steady) looped = true;
    }
    return looped;
  }
}

export const EMPTY_REPLY_REMINDER =
  "Your last reply was empty. After a tool result you must either call another tool or tell the user what you found and what happens next. Do one of those now.";

export const OUTPUT_LIMIT_REMINDER =
  "Your last reply ran out of output space while you were still thinking and produced no answer or tool call. Think less, act in smaller steps, and make a tool call or give the answer now.";

export const LOOP_WARNING =
  "You have made this exact tool call several times in this turn with the same result. Repeating it will not change the outcome. Step back, say what you have learned, and try a different approach.";
