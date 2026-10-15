/**
 * Where the `agent-skills` mod and moxen's bundled skills live on disk, for a
 * Claude session to be started with: the mod rides in as a local plugin
 * (`plugins`), and `MOXEN_SKILLS_DIR` tells it where moxen's own skills are.
 * Both ship in the package (`mods`, `skills` in `files`); the package root is
 * found by walking up to `package.json`, so it is the same folder in source
 * and in the bundled `dist`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillsMod {
  /** The mod's plugin directory. */
  readonly path: string;
  /** Moxen's own skills, when the package carries them. */
  readonly bundledSkillsDir: string | null;
}

/** The mod and bundled skills of this install, or null when the package has no mod folder (a trimmed copy). */
export function locateSkillsMod(from: string = path.dirname(fileURLToPath(import.meta.url))): SkillsMod | null {
  let root = from;
  while (!existsSync(path.join(root, "package.json"))) {
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
  const mod = path.join(root, "mods", "agent-skills");
  if (!existsSync(path.join(mod, "hooks", "hooks.json"))) return null;
  const skills = path.join(root, "skills");
  return { path: mod, bundledSkillsDir: existsSync(skills) ? skills : null };
}
