import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  GradeSchema,
  trackUsage,
  updateProgress,
  formatSessionMarkdown,
  gradeExplanation,
  runExplainSession,
  type GradeResult,
} from "../src/explain.js";
import { saveConfig } from "../src/config.js";
import type { CommitData } from "../src/git.js";
import type { LLMProvider } from "../src/llm.js";

class FakeLLMProvider implements LLMProvider {
  private responses: string[];
  public calls: Array<{ system: string; user: string }> = [];

  constructor(responses: string[]) {
    this.responses = [...responses];
  }

  async complete(system: string, user: string): Promise<string> {
    this.calls.push({ system, user });
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error("FakeLLMProvider ran out of mock responses");
    }
    return next;
  }
}

const sampleCommit: CommitData = {
  sha: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
  author: "Tanay <tanay@example.com>",
  date: "2026-10-22T14:00:00Z",
  message: "Add rate limiting backoff to network requests",
  files: [
    {
      path: "src/net.ts",
      diff: "+ const delay = 1000 * Math.pow(2, retries);\n+ await sleep(delay);",
    },
  ],
};

describe("GradeSchema validation", () => {
  it("accepts valid grading payload (score 0-5)", () => {
    const valid = {
      score: 4,
      whatIGotRight: ["Identified exponential backoff correctly"],
      whatIMissed: ["Did not mention sleep utility implementation"],
      misconceptions: [],
      followUpQuestion: "How would you prevent the thundering herd problem?",
    };
    expect(GradeSchema.parse(valid)).toEqual(valid);
  });

  it("rejects score outside 0-5", () => {
    expect(() =>
      GradeSchema.parse({
        score: 6,
        whatIGotRight: [],
        whatIMissed: [],
        misconceptions: [],
        followUpQuestion: "Question?",
      })
    ).toThrow();

    expect(() =>
      GradeSchema.parse({
        score: -1,
        whatIGotRight: [],
        whatIMissed: [],
        misconceptions: [],
        followUpQuestion: "Question?",
      })
    ).toThrow();
  });

  it("rejects missing followUpQuestion", () => {
    expect(() =>
      GradeSchema.parse({
        score: 3,
        whatIGotRight: ["Good point"],
        whatIMissed: [],
        misconceptions: [],
        followUpQuestion: "",
      })
    ).toThrow("followUpQuestion is required");
  });
});

describe("trackUsage & updateProgress in vault", () => {
  let tempVault: string;

  beforeEach(async () => {
    tempVault = await fs.mkdtemp(path.join(os.tmpdir(), "ink-explain-test-"));
  });

  afterEach(async () => {
    if (tempVault) {
      await fs.rm(tempVault, { recursive: true, force: true });
    }
  });

  it("trackUsage logs command name and date without code or secrets", async () => {
    await trackUsage(tempVault, "explain");
    await trackUsage(tempVault, "explain");

    const usageFile = path.join(tempVault, "usage.json");
    const raw = await fs.readFile(usageFile, "utf-8");
    const usage = JSON.parse(raw);

    expect(usage).toHaveLength(2);
    expect(usage[0].command).toBe("explain");
    expect(usage[0].date).toBeDefined();
    // Verify no code or diff leaked
    expect(JSON.stringify(usage)).not.toContain("diff");
  });

  it("updateProgress logs scores and dates per concept", async () => {
    await updateProgress(tempVault, ["Exponential Backoff"], 4, "2026-10-22");
    await updateProgress(tempVault, ["Exponential Backoff"], 5, "2026-10-23");

    const progressFile = path.join(tempVault, "progress.json");
    const raw = await fs.readFile(progressFile, "utf-8");
    const progress = JSON.parse(raw);

    expect(progress).toHaveLength(1);
    expect(progress[0].concept).toBe("Exponential Backoff");
    expect(progress[0].scores).toEqual([4, 5]);
    expect(progress[0].dates).toEqual(["2026-10-22", "2026-10-23"]);
  });
});

describe("formatSessionMarkdown", () => {
  it("formats markdown with frontmatter, commit metadata, and feedback", () => {
    const grade: GradeResult = {
      score: 4,
      whatIGotRight: ["Explained retry interval growth"],
      whatIMissed: ["Missed sleep helper"],
      misconceptions: [],
      followUpQuestion: "What is jitter?",
    };

    const md = formatSessionMarkdown(
      sampleCommit,
      "This commit introduces exponential backoff to space out retries.",
      grade,
      "Jitter adds random noise to prevent synchronized retries."
    );

    expect(md).toContain("score: 4/5");
    expect(md).toContain("# Explain Session: b2c3d4e");
    expect(md).toContain("### What You Got Right\n- Explained retry interval growth");
    expect(md).toContain("### What You Missed\n- Missed sleep helper");
    expect(md).toContain("**Question:** What is jitter?");
    expect(md).toContain("Jitter adds random noise");
  });
});

describe("gradeExplanation with FakeLLMProvider", () => {
  it("parses valid grade JSON response", async () => {
    const validJson = JSON.stringify({
      score: 5,
      whatIGotRight: ["Spot-on architectural analysis"],
      whatIMissed: [],
      misconceptions: [],
      followUpQuestion: "How do you handle max retry caps?",
    });

    const fakeProvider = new FakeLLMProvider([validJson]);
    const result = await gradeExplanation(
      sampleCommit,
      "It adds exponential backoff retry.",
      fakeProvider
    );

    expect(result.score).toBe(5);
    expect(result.whatIGotRight).toContain("Spot-on architectural analysis");
    expect(fakeProvider.calls).toHaveLength(1);
  });

  it("retries once when initial output is invalid JSON, then succeeds", async () => {
    const invalidJson = "Here is my grade: { invalid json }";
    const validJson = JSON.stringify({
      score: 4,
      whatIGotRight: ["Understood backoff"],
      whatIMissed: ["Missed cap"],
      misconceptions: [],
      followUpQuestion: "How to cap delay?",
    });

    const fakeProvider = new FakeLLMProvider([invalidJson, validJson]);
    const result = await gradeExplanation(
      sampleCommit,
      "It adds exponential backoff retry.",
      fakeProvider
    );

    expect(result.score).toBe(4);
    expect(fakeProvider.calls).toHaveLength(2);
    expect(fakeProvider.calls[1].user).toContain("CRITICAL: Your previous response was invalid");
  });
});

describe("runExplainSession integration", () => {
  let tempRepo: string;
  let tempVault: string;

  beforeEach(async () => {
    tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), "ink-explain-repo-"));
    tempVault = path.join(tempRepo, "vault");
    await fs.mkdir(tempVault, { recursive: true });

    // Save config pointing to tempVault
    await saveConfig(
      {
        vaultPath: tempVault,
        provider: "gemini",
        model: "gemini-1.5-pro",
        ignore: [],
        maxDiffChars: 24000,
        fuzzyThreshold: 0.75,
      },
      tempRepo
    );
  });

  afterEach(async () => {
    if (tempRepo) {
      await fs.rm(tempRepo, { recursive: true, force: true });
    }
  });

  it("orchestrates explain session, saves markdown session, updates progress and usage", async () => {
    const validGradeJson = JSON.stringify({
      score: 4,
      whatIGotRight: ["Correctly stated intent"],
      whatIMissed: ["Did not mention sleep"],
      misconceptions: [],
      followUpQuestion: "Why is exponential delay useful?",
    });

    const fakeProvider = new FakeLLMProvider([validGradeJson]);

    await runExplainSession("HEAD", tempRepo, {
      commit: sampleCommit,
      config: {
        vaultPath: tempVault,
        provider: "gemini",
        model: "gemini-1.5-pro",
        ignore: [],
        maxDiffChars: 24000,
        fuzzyThreshold: 0.75,
      },
      provider: fakeProvider,
      readExplanation: async () => "I implemented the retry logic with exponential backoff.",
      readFollowUp: async () => "It avoids DDOSing the server when it is recovering.",
    });

    // Check usage.json exists in tempVault
    const usageFile = path.join(tempVault, "usage.json");
    const usageRaw = await fs.readFile(usageFile, "utf-8");
    const usage = JSON.parse(usageRaw);
    expect(usage).toHaveLength(1);
    expect(usage[0].command).toBe("explain");

    // Check session file exists in tempVault/explain-sessions
    const sessionsDir = path.join(tempVault, "explain-sessions");
    const files = await fs.readdir(sessionsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(sampleCommit.sha.slice(0, 7));

    // Check progress.json exists in tempVault
    const progressFile = path.join(tempVault, "progress.json");
    const progressRaw = await fs.readFile(progressFile, "utf-8");
    const progress = JSON.parse(progressRaw);
    expect(progress).toHaveLength(1);
    expect(progress[0].scores).toEqual([4]);
  });
});
