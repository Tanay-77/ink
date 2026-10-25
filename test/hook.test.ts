import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  generateFullHookScript,
  generateHookBlock,
  installHook,
  uninstallHook,
  getPostCommitHookPath,
  HOOK_START_MARKER,
  HOOK_END_MARKER,
} from "../src/hook.js";

describe("hook script generation", () => {
  it("generates script with strict LF line endings", () => {
    const script = generateFullHookScript();
    expect(script).not.toContain("\r");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain(HOOK_START_MARKER);
    expect(script).toContain(HOOK_END_MARKER);
  });

  it("includes COMMIT_NOTES_SKIP check and Merge* check", () => {
    const block = generateHookBlock();
    expect(block).toContain('if [ "$COMMIT_NOTES_SKIP" != "1" ]; then');
    expect(block).toContain("COMMIT_MSG=$(git log -1 --pretty=%s 2>/dev/null)");
    expect(block).toContain("Merge*) ;;");
    expect(block).toContain("(ink run HEAD >> .ink.log 2>&1 &)");
  });
});

describe("installHook & uninstallHook in temp repository", () => {
  let tempRepo: string;

  beforeEach(async () => {
    tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), "ink-hook-test-"));
    // Create .git directory
    await fs.mkdir(path.join(tempRepo, ".git"), { recursive: true });
  });

  afterEach(async () => {
    if (tempRepo) {
      await fs.rm(tempRepo, { recursive: true, force: true });
    }
  });

  it("throws error if not a git repository", async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "non-git-"));
    try {
      await expect(installHook(nonGitDir)).rejects.toThrow("is not a git repository");
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it("creates new post-commit hook file if none existed", async () => {
    const result = await installHook(tempRepo);
    expect(result.action).toBe("created");

    const hookFile = getPostCommitHookPath(tempRepo);
    const content = await fs.readFile(hookFile, "utf-8");

    expect(content).toContain("#!/bin/sh");
    expect(content).toContain(HOOK_START_MARKER);
    expect(content).not.toContain("\r"); // Strict LF line endings
  });

  it("is idempotent: does not duplicate hook when called multiple times", async () => {
    await installHook(tempRepo);
    const secondResult = await installHook(tempRepo);

    expect(secondResult.action).toBe("already-installed");

    const hookFile = getPostCommitHookPath(tempRepo);
    const content = await fs.readFile(hookFile, "utf-8");

    const matches = content.match(new RegExp(HOOK_START_MARKER, "g"));
    expect(matches).toHaveLength(1);
  });

  it("safely appends to an existing post-commit hook without overwriting it", async () => {
    const hookFile = getPostCommitHookPath(tempRepo);
    await fs.mkdir(path.dirname(hookFile), { recursive: true });

    const existingCustomScript = "#!/bin/sh\necho 'running linting or test hook'\n";
    await fs.writeFile(hookFile, existingCustomScript, "utf-8");

    const result = await installHook(tempRepo);
    expect(result.action).toBe("appended");

    const updatedContent = await fs.readFile(hookFile, "utf-8");
    expect(updatedContent).toContain("echo 'running linting or test hook'");
    expect(updatedContent).toContain(HOOK_START_MARKER);
    expect(updatedContent).not.toContain("\r");
  });

  it("uninstalls hook by deleting file when it only contains ink", async () => {
    await installHook(tempRepo);
    const result = await uninstallHook(tempRepo);

    expect(result.action).toBe("removed");

    const hookFile = getPostCommitHookPath(tempRepo);
    let exists = true;
    try {
      await fs.stat(hookFile);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("uninstalls hook and preserves user's other hook script", async () => {
    const hookFile = getPostCommitHookPath(tempRepo);
    await fs.mkdir(path.dirname(hookFile), { recursive: true });

    const existingCustomScript = "#!/bin/sh\necho 'keep this line'\n";
    await fs.writeFile(hookFile, existingCustomScript, "utf-8");

    await installHook(tempRepo);
    const result = await uninstallHook(tempRepo);

    expect(result.action).toBe("cleaned");

    const remaining = await fs.readFile(hookFile, "utf-8");
    expect(remaining).toContain("echo 'keep this line'");
    expect(remaining).not.toContain(HOOK_START_MARKER);
  });

  it("returns not-installed when no hook exists to uninstall", async () => {
    const result = await uninstallHook(tempRepo);
    expect(result.action).toBe("not-installed");
  });
});
