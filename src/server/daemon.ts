/**
 * The detached server process: what a client's autostart runs (`./client.ts`).
 * Stdio is ignored, so a failure is reported through the exit code only; the
 * client that started us sees the endpoint stay silent and reports that instead.
 */
import { closeOnSignals, runServer } from "./main.js";

runServer().then(
  (handle) => {
    closeOnSignals(handle);
    void handle.closed.then(() => process.exit(0));
  },
  () => process.exit(1),
);
