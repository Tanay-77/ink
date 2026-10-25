import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

export const CONFIG_FILE_NAME = ".ink.json";

export const ConfigSchema = z.object({
  vaultPath: z.string().min(1, "vaultPath is required"),
  provider: z.enum(["anthropic", "gemini", "openai"]),
  model: z.string().min(1, "model is required"),
  ignore: z.array(z.string()).default([]),
  maxDiffChars: z.number().int().positive().default(24000),
  fuzzyThreshold: z.number().min(0).max(1).default(0.75),
});

export type Config = z.infer<typeof ConfigSchema>;

export function getConfigPath(repoRoot: string = process.cwd()): string {
  return path.join(repoRoot, CONFIG_FILE_NAME);
}

export async function loadConfig(repoRoot: string = process.cwd()): Promise<Config> {
  const configPath = getConfigPath(repoRoot);
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return ConfigSchema.parse(parsed);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Configuration file not found at "${configPath}". Run "ink init" first.`);
    }
    throw error;
  }
}

export async function saveConfig(config: Config, repoRoot: string = process.cwd()): Promise<void> {
  const configPath = getConfigPath(repoRoot);
  const validated = ConfigSchema.parse(config);
  const content = JSON.stringify(validated, null, 2) + "\n";
  await fs.writeFile(configPath, content, "utf-8");
}
