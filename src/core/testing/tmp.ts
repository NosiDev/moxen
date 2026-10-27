/**
 * Temp directories for tests that are removed when the test file finishes.
 * A bare `mkdtemp` leaked one directory per call — several hundred had
 * piled up under the OS temp dir from repeated `bun run check` runs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

const created: string[] = [];

/**
 * Remove a test directory. On Windows a folder stays locked for a moment
 * after the process using it has been told to stop, so the delete retries
 * by hand (Bun does not honour `maxRetries`).
 */
export function rmTemp(dir: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 40 || (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

afterAll(() => {
  for (const dir of created.splice(0)) rmTemp(dir);
});

/** `rmTemp` for code already running asynchronously, which should not block the event loop while it waits. */
export async function rmTempAsync(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 40 || (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** A fresh directory under the OS temp dir, named `<prefix>XXXXXX`, removed after the file's tests. */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}
