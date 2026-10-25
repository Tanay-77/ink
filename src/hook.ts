import * as fs from "node:fs/promises";
import * as path from "node:path";

export const HOOK_START_MARKER = "# --- ink HOOK START ---";
export const HOOK_END_MARKER = "# --- ink HOOK END ---";

export function generateHookBlock(): string {
  return [
    HOOK_START_MARKER,
    'if [ "$COMMIT_NOTES_SKIP" != "1" ]; then',
    "  COMMIT_MSG=$(git log -1 --pretty=%s 2>/dev/null)",
    '  case "$COMMIT_MSG" in',
    "    Merge*) ;;",
    "    *)",
    "      (ink run HEAD >> .ink.log 2>&1 &)",
    "      ;;",
    "  esac",
    "fi",
    HOOK_END_MARKER,
  ].join("\n");
}

export function generateFullHookScript(): string {
  return `#!/bin/sh\n${generateHookBlock()}\n`;
}

export function getGitHooksDir(repoRoot: string = process.cwd()): string {
  return path.join(repoRoot, ".git", "hooks");
}

export function getPostCommitHookPath(repoRoot: string = process.cwd()): string {
  return path.join(getGitHooksDir(repoRoot), "post-commit");
}

export async function isGitRepo(repoRoot: string = process.cwd()): Promise<boolean> {
  const gitDir = path.join(repoRoot, ".git");
  try {
    const stat = await fs.stat(gitDir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export interface InstallHookResult {
  action: "created" | "appended" | "already-installed";
  hookPath: string;
}

export async function installHook(repoRoot: string = process.cwd()): Promise<InstallHookResult> {
  if (!(await isGitRepo(repoRoot))) {
    throw new Error(`Cannot install hook: "${repoRoot}" is not a git repository (.git folder not found).`);
  }

  const hooksDir = getGitHooksDir(repoRoot);
  const hookPath = getPostCommitHookPath(repoRoot);

  await fs.mkdir(hooksDir, { recursive: true });

  let existingContent = "";
  let exists = false;

  try {
    existingContent = await fs.readFile(hookPath, "utf-8");
    exists = true;
  } catch {
    exists = false;
  }

  if (exists) {
    if (existingContent.includes(HOOK_START_MARKER)) {
      return { action: "already-installed", hookPath };
    }

    // Append safely to existing hook with strict LF line endings
    const normalized = existingContent.replace(/\r\n/g, "\n").trimEnd();
    const updatedContent = `${normalized}\n\n${generateHookBlock()}\n`;
    await fs.writeFile(hookPath, updatedContent, { encoding: "utf-8", mode: 0o755 });
    return { action: "appended", hookPath };
  }

  // Create new hook file with strict LF line endings
  const fullScript = generateFullHookScript();
  await fs.writeFile(hookPath, fullScript, { encoding: "utf-8", mode: 0o755 });
  return { action: "created", hookPath };
}

export interface UninstallHookResult {
  action: "removed" | "cleaned" | "not-installed";
  hookPath: string;
}

export async function uninstallHook(repoRoot: string = process.cwd()): Promise<UninstallHookResult> {
  const hookPath = getPostCommitHookPath(repoRoot);

  let existingContent = "";
  try {
    existingContent = await fs.readFile(hookPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { action: "not-installed", hookPath };
    }
    throw err;
  }

  if (!existingContent.includes(HOOK_START_MARKER)) {
    return { action: "not-installed", hookPath };
  }

  const normalized = existingContent.replace(/\r\n/g, "\n");
  const regex = new RegExp(`\\n?${HOOK_START_MARKER}[\\s\\S]*?${HOOK_END_MARKER}\\n?`, "g");
  const cleaned = normalized.replace(regex, "").trim();

  // If only #!/bin/sh remains or empty, delete the file completely
  if (!cleaned || cleaned === "#!/bin/sh") {
    await fs.unlink(hookPath);
    return { action: "removed", hookPath };
  }

  // Otherwise keep the user's remaining hook code
  await fs.writeFile(hookPath, `${cleaned}\n`, { encoding: "utf-8", mode: 0o755 });
  return { action: "cleaned", hookPath };
}
