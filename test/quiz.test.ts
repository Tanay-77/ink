import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  QuizGradeSchema,
  parseConceptFile,
  loadProgressCards,
  saveProgressCards,
  gradeQuizAnswer,
  runQuizSession,
} from "../src/quiz.js";
import { formatDate } from "../src/schedule.js";
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

describe("QuizGradeSchema validation", () => {
  it("validates correct quiz grade payload", () => {
    const valid = {
      score: 5,
      feedback: "Clear explanation with good trade-offs.",
      idealAnswer: "Exponential backoff delays retries exponentially.",
    };
    expect(QuizGradeSchema.parse(valid)).toEqual(valid);
  });

  it("rejects score < 0 or > 5", () => {
    expect(() =>
      QuizGradeSchema.parse({
        score: -1,
        feedback: "Bad",
        idealAnswer: "Correct",
      })
    ).toThrow();

    expect(() =>
      QuizGradeSchema.parse({
        score: 6,
        feedback: "Bad",
        idealAnswer: "Correct",
      })
    ).toThrow();
  });
});

describe("parseConceptFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ink-concept-test-"));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("extracts title, explanation, and interview question", async () => {
    const filePath = path.join(tempDir, "exponential-backoff.md");
    const content = `---
tags: [ink, intermediate]
created: 2026-10-22
---
# Exponential Backoff

## Explanation
Spreads out retry intervals to avoid overwhelming the server.

## Examples
- [[commit-1]] : file.ts

## Interview questions
- How does exponential backoff prevent the thundering herd problem?
`;
    await fs.writeFile(filePath, content, "utf-8");

    const details = await parseConceptFile(filePath);
    expect(details.name).toBe("Exponential Backoff");
    expect(details.explanation).toBe("Spreads out retry intervals to avoid overwhelming the server.");
    expect(details.question).toBe("How does exponential backoff prevent the thundering herd problem?");
  });

  it("extracts interview question and answer when QA format is present", async () => {
    const filePath = path.join(tempDir, "zod-schema.md");
    const content = `---
tags: [ink, basic]
created: 2026-10-22
---
# Zod Schema Validation

## Explanation
Checks data shape before using it.

## Examples
- [[commit-1]] : file.ts

## Interview questions
- **Q:** What is Zod and what happens when validation fails?
  **Answer:** Zod checks if data matches a schema. If invalid, it throws an error or returns details so the app doesn't crash.
`;
    await fs.writeFile(filePath, content, "utf-8");

    const details = await parseConceptFile(filePath);
    expect(details.name).toBe("Zod Schema Validation");
    expect(details.question).toBe("What is Zod and what happens when validation fails?");
    expect(details.idealAnswer).toBe("Zod checks if data matches a schema. If invalid, it throws an error or returns details so the app doesn't crash.");
  });
});

describe("loadProgressCards and sync", () => {
  let tempVault: string;

  beforeEach(async () => {
    tempVault = await fs.mkdtemp(path.join(os.tmpdir(), "ink-quiz-vault-"));
    await fs.mkdir(path.join(tempVault, "concepts"), { recursive: true });
  });

  afterEach(async () => {
    if (tempVault) {
      await fs.rm(tempVault, { recursive: true, force: true });
    }
  });

  it("discovers concept files and initializes SM-2 schedules", async () => {
    const conceptPath = path.join(tempVault, "concepts", "optimistic-locking.md");
    await fs.writeFile(
      conceptPath,
      "# Optimistic Locking\n\n## Explanation\nUses version numbers.\n\n## Interview questions\n- When to use optimistic locking?\n",
      "utf-8"
    );

    const cards = await loadProgressCards(tempVault);
    expect(cards).toHaveLength(1);
    expect(cards[0].concept).toBe("Optimistic Locking");
    expect(cards[0].interval).toBe(0);
    expect(cards[0].easeFactor).toBe(2.5);
    expect(cards[0].repetitions).toBe(0);
    expect(cards[0].dueDate).toBe(formatDate());
  });
});

describe("runQuizSession integration", () => {
  let tempVault: string;

  beforeEach(async () => {
    tempVault = await fs.mkdtemp(path.join(os.tmpdir(), "ink-quiz-session-"));
    await fs.mkdir(path.join(tempVault, "concepts"), { recursive: true });
  });

  afterEach(async () => {
    if (tempVault) {
      await fs.rm(tempVault, { recursive: true, force: true });
    }
  });

  it("runs quiz session for due concept, updates schedule and progress.json", async () => {
    // 1. Create a concept file
    const conceptPath = path.join(tempVault, "concepts", "react-useeffect.md");
    await fs.writeFile(
      conceptPath,
      "# React useEffect\n\n## Explanation\nManages side effects.\n\n## Interview questions\n- Why is cleanup needed in useEffect?\n",
      "utf-8"
    );

    // 2. Initialize progress with due date today
    const today = formatDate();
    await saveProgressCards(tempVault, [
      {
        concept: "React useEffect",
        interval: 0,
        easeFactor: 2.5,
        repetitions: 0,
        dueDate: today,
        scores: [],
        dates: [],
      },
    ]);

    const fakeLLM = new FakeLLMProvider([
      JSON.stringify({
        score: 5,
        feedback: "Accurately noted memory leak prevention.",
        idealAnswer: "Cleanup aborts subscriptions and clears timers.",
      }),
    ]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runQuizSession(tempVault, {
      config: {
        vaultPath: tempVault,
        provider: "gemini",
        model: "gemini-1.5-pro",
        ignore: [],
        maxDiffChars: 24000,
        fuzzyThreshold: 0.75,
      },
      provider: fakeLLM,
      mode: "cli",
      readAnswer: async () => "It cleans up timers and listeners to prevent memory leaks.",
    });

    consoleSpy.mockRestore();

    // Verify progress.json was updated with SM-2 advancement
    const updatedCards = await loadProgressCards(tempVault);
    expect(updatedCards).toHaveLength(1);
    expect(updatedCards[0].repetitions).toBe(1);
    expect(updatedCards[0].interval).toBe(1);
    expect(updatedCards[0].easeFactor).toBe(2.6);
    expect(updatedCards[0].scores).toEqual([5]);

    // Verify usage.json was tracked
    const usageRaw = await fs.readFile(path.join(tempVault, "usage.json"), "utf-8");
    const usage = JSON.parse(usageRaw);
    expect(usage[0].command).toBe("quiz");
  });

  it("generates interactive Obsidian quiz note with reveal callouts in default mode", async () => {
    const conceptPath = path.join(tempVault, "concepts", "sm-2-algorithm.md");
    await fs.writeFile(
      conceptPath,
      "# SM-2 Algorithm\n\n## Explanation\nExpands review intervals.\n\n## Interview questions\n- How does SM-2 work?\n",
      "utf-8"
    );

    const today = formatDate();
    await saveProgressCards(tempVault, [
      {
        concept: "SM-2 Algorithm",
        interval: 0,
        easeFactor: 2.5,
        repetitions: 0,
        dueDate: today,
      },
    ]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runQuizSession(tempVault, {
      config: {
        vaultPath: tempVault,
        provider: "gemini",
        model: "gemini-1.5-pro",
        ignore: [],
        maxDiffChars: 24000,
        fuzzyThreshold: 0.75,
      },
      openFile: false,
    });

    consoleSpy.mockRestore();

    const quizFile = path.join(tempVault, "quizzes", `quiz-${today}.md`);
    const content = await fs.readFile(quizFile, "utf-8");

    expect(content).toContain("# 🧠 Daily Review Quiz");
    expect(content).toContain("How does SM-2 work?");
    expect(content).toContain("> [!tip]- 💡 Click to Reveal Answer");
    expect(content).toContain("Expands review intervals.");
  });

  it("notifies when no concepts are due today and displays next scheduled review", async () => {
    const futureDate = "2099-01-01";
    await saveProgressCards(tempVault, [
      {
        concept: "Future Concept",
        interval: 30,
        easeFactor: 2.5,
        repetitions: 3,
        dueDate: futureDate,
      },
    ]);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runQuizSession(tempVault, {
      config: {
        vaultPath: tempVault,
        provider: "gemini",
        model: "gemini-1.5-pro",
        ignore: [],
        maxDiffChars: 24000,
        fuzzyThreshold: 0.75,
      },
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Next review is scheduled on ${futureDate}`)
    );

    consoleSpy.mockRestore();
  });
});
