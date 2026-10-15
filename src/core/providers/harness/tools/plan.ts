/**
 * Plan mode as a flow the model can walk itself. The user turns plan mode on
 * (the tool set shrinks to reading, asking and `exit_plan_mode`), or the model
 * asks for it with `enter_plan_mode` before a change worth thinking through.
 * Leaving it is always `exit_plan_mode` with the plan: for a plan the user
 * asked for, the turn ends there so they read it before anything happens; for
 * one the model started itself nobody is waiting, so the work goes on.
 */
import type { HarnessTool } from "./types.js";

export interface PlanHooks {
  /** Whether the session is in plan mode right now. Both tools are always offered (a list that changes mid-turn breaks the server's prompt cache, and a reply that calls both in a row needs both), so each checks. */
  planning(): boolean;
  /** Switch the session to plan mode for the rest of this turn. */
  enter(): void;
  /** Show the plan to the user. Says whether the turn ends here. */
  propose(plan: string): { endTurn: boolean };
}

interface ExitArgs {
  plan: string;
}

export function enterPlanModeTool(hooks: Pick<PlanHooks, "enter" | "planning">): HarnessTool<Record<string, never>> {
  return {
    readOnly: false,
    definition: {
      name: "enter_plan_mode",
      description: [
        "Switches to plan mode: from now on you can only read, search and ask the user questions, until you present a plan with exit_plan_mode.",
        "",
        "Use it before a change that is large, touches many files, has more than one reasonable design, or that you would not want to get wrong. Do not use it for a small fix or when the user told you exactly what to do.",
      ].join("\n"),
      parameters: { type: "object", properties: {} },
    },
    intent: () => ({ action: "read", paths: [] }),
    async run() {
      if (hooks.planning()) return { content: "Plan mode is already on. Finish the plan and call exit_plan_mode with it." };
      hooks.enter();
      return {
        content:
          "Plan mode is on. Read and search to understand the task, ask the user about anything only they can decide, then call exit_plan_mode with the plan. Nothing can be changed until then.",
      };
    },
  };
}

export function exitPlanModeTool(hooks: Pick<PlanHooks, "propose" | "planning">): HarnessTool<ExitArgs> {
  return {
    readOnly: false,
    allowedInPlan: true,
    definition: {
      name: "exit_plan_mode",
      description: [
        "Presents your plan to the user and leaves plan mode. Call it when you know enough to say how you would do the work; do not write the plan as an ordinary reply, and do not call it through the shell.",
        "",
        "The plan is Markdown: the goal in a sentence, the changes (files and what happens in each), how you will check the result, and any decision or risk the user should know about. Keep it as short as the task allows.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: { plan: { type: "string", description: "The plan, in Markdown." } },
        required: ["plan"],
      },
    },
    intent: () => ({ action: "read", paths: [] }),
    async run(args) {
      if (!hooks.planning()) return { content: "Plan mode is not on, so there is nothing to exit. Call enter_plan_mode first if you want to plan before changing anything.", isError: true };
      const plan = args.plan.trim();
      if (plan === "") return { content: "The plan is empty. Write the plan and call exit_plan_mode again.", isError: true };
      const { endTurn } = hooks.propose(plan);
      return endTurn
        ? { content: "The plan was shown to the user. Stop here: they will read it and tell you whether to go ahead.", endTurn: { answer: plan } }
        : { content: "The plan was shown to the user and plan mode is off. You can change files and run commands again; go ahead with it." };
    },
  };
}
