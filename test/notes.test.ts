import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  slugify,
  normalizeConceptName,
  findMatchingConcept,
  saveNotes,
  getKnownConcepts,
} from "../src/notes.js";
import type { CommitData } from "../src/git.js";
import type { CommitAnalysis } from "../src/analyze.js";

describe("slugify", () => {
  it("converts simple string to slug", () => {
    expect(slugify("React useEffect cleanup")).toBe("react-useeffect-cleanup");
  });

  it("strips Windows invalid characters (: ? * \" < > | \\ /)", () => {
    expect(slugify("Node:child_process*execFile? <safe> \"test\"|")).toBe(
      "node-child-process-execfile-safe-test"
    );
  });

  it("handles leading/trailing spaces and special characters", () => {
    expect(slugify("  --Hello World!!--  ")).toBe("hello-world");
  });

  it("falls back to 'concept' for empty string", () => {
    expect(slugify("")).toBe("concept");
    expect(slugify("???")).toBe("concept");
  });
});

describe("Duplicate Detection (3 Layers)", () => {
  const existingList = [
    "React useEffect cleanup",
    "Exponential Backoff",
    "Optimistic Locking",
  ];

  it("Layer 1: detects exact slug match", () => {
    const match = findMatchingConcept("react-useeffect-cleanup", existingList);
    expect(match).toEqual({
      match: "React useEffect cleanup",
      layer: 1,
    });
  });

  it("Layer 2: detects normalized-name match with filler words dropped and reordered", () => {
    // Drops filler words "in", "using"
    const match = findMatchingConcept(
      "cleanup in React using useEffect",
      existingList
    );
    expect(match).toEqual({
      match: "React useEffect cleanup",
      layer: 2,
    });
  });

  it("Layer 3: detects fuzzy match with typo and logs merge", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => { });
    // Typo in "Exponetial" + token overlap
    const match = findMatchingConcept("Exponetial Backoff", existingList, 0.7);

    expect(match).not.toBeNull();
    expect(match?.match).toBe("Exponential Backoff");
    expect(match?.layer).toBe(3);
    consoleSpy.mockRestore();
  });

  it("returns null for completely unrelated concepts", () => {
    const match = findMatchingConcept("Database Sharding", existingList);
    expect(match).toBeNull();
  });
});

describe("saveNotes integration & idempotency in temp directory", () => {
  let tempVault: string;

  beforeEach(async () => {
    tempVault = await fs.mkdtemp(path.join(os.tmpdir(), "ink-vault-"));
  });

  afterEach(async () => {
    if (tempVault) {
      await fs.rm(tempVault, { recursive: true, force: true });
    }
  });

  const sampleCommit: CommitData = {
    sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    author: "Tanay <tanay@example.com>",
    date: "2026-10-22T10:00:00Z",
    message: "Add exponential backoff",
    files: [{ path: "src/llm.ts", diff: "+ retry logic" }],
  };

  const sampleAnalysis: CommitAnalysis = {
    summary: "Implements exponential backoff retry. Prevents 429 rate limit errors.",
    concepts: [
      {
        name: "Exponential Backoff",
        existing: false,
        explanation: "Spreads out retry intervals to avoid overwhelming the server.",
        file: "src/llm.ts",
        codeSnippet: "const delay = Math.pow(2, attempt);",
        difficulty: "intermediate",
        interviewQuestion: "Why is exponential backoff preferred over fixed delay?",
      },
    ],
  };

  it("writes concept note and commit note on first run", async () => {
    const result = await saveNotes(tempVault, sampleCommit, sampleAnalysis);
    expect(result.conceptsWritten).toEqual(["Exponential Backoff"]);

    // Check concept file
    const conceptFile = path.join(tempVault, "concepts", "exponential-backoff.md");
    const conceptContent = await fs.readFile(conceptFile, "utf-8");
    expect(conceptContent).toContain("# Exponential Backoff");
    expect(conceptContent).toContain("## Explanation");
    expect(conceptContent).toContain("## Examples");
    expect(conceptContent).toContain("[[2026-10-22-a1b2c3d]]");
    expect(conceptContent).toContain("Math.pow(2, attempt)");
    expect(conceptContent).toContain("## Interview questions");

    // Check commit note
    const commitFile = path.join(tempVault, "commits", "2026-10-22-a1b2c3d.md");
    const commitContent = await fs.readFile(commitFile, "utf-8");
    expect(commitContent).toContain("# Commit a1b2c3d");
    expect(commitContent).toContain("[[exponential-backoff|Exponential Backoff]]");

    // Check known concepts
    const known = await getKnownConcepts(tempVault);
    expect(known).toEqual(["Exponential Backoff"]);
  });

  it("is idempotent: running the same commit twice does not duplicate examples", async () => {
    await saveNotes(tempVault, sampleCommit, sampleAnalysis);
    await saveNotes(tempVault, sampleCommit, sampleAnalysis);

    const conceptFile = path.join(tempVault, "concepts", "exponential-backoff.md");
    const content = await fs.readFile(conceptFile, "utf-8");

    // Must have exactly one example line for this commit
    const matches = content.match(/\[\[2026-10-22-a1b2c3d\]\]/g);
    expect(matches).toHaveLength(1);
  });

  it("appends new example under Examples without overwriting existing explanation or questions", async () => {
    // First commit
    await saveNotes(tempVault, sampleCommit, sampleAnalysis);

    // Second commit with different sha using same concept
    const secondCommit: CommitData = {
      sha: "f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5",
      author: "Tanay <tanay@example.com>",
      date: "2026-10-23T11:00:00Z",
      message: "Reuse exponential backoff in git fetch",
      files: [{ path: "src/git.ts", diff: "+ retry git" }],
    };

    const secondAnalysis: CommitAnalysis = {
      summary: "Reuses backoff for network git calls. Improves reliability.",
      concepts: [
        {
          name: "Exponential Backoff",
          existing: true,
          file: "src/git.ts",
          codeSnippet: "retryGit()",
        },
      ],
    };

    await saveNotes(tempVault, secondCommit, secondAnalysis);

    const conceptFile = path.join(tempVault, "concepts", "exponential-backoff.md");
    const content = await fs.readFile(conceptFile, "utf-8");

    // Both commit examples must be present
    expect(content).toContain("[[2026-10-22-a1b2c3d]]");
    expect(content).toContain("[[2026-10-23-f6e5d4c]]");

    // Original explanation and interview question remain untouched
    expect(content).toContain("Spreads out retry intervals to avoid overwhelming the server.");
    expect(content).toContain("Why is exponential backoff preferred over fixed delay?");
  });

  it("adds alias in frontmatter when Layer 3 merges concept name", async () => {
    await saveNotes(tempVault, sampleCommit, sampleAnalysis);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => { });

    // Commit with typo in concept name
    const typoCommit: CommitData = {
      sha: "1111222233334444555566667777888899990000",
      author: "Tanay <tanay@example.com>",
      date: "2026-10-24T12:00:00Z",
      message: "Refactor backoff",
      files: [{ path: "src/net.ts", diff: "+ backoff" }],
    };

    const typoAnalysis: CommitAnalysis = {
      summary: "Refactors backoff helper. Improves timing.",
      concepts: [
        {
          name: "Exponetial Backoff", // typo
          existing: false,
          explanation: "Handles timing.",
          file: "src/net.ts",
          codeSnippet: "backoff()",
          difficulty: "intermediate",
          interviewQuestion: "Explain backoff.",
        },
      ],
    };

    await saveNotes(tempVault, typoCommit, typoAnalysis, { fuzzyThreshold: 0.7 });

    expect(consoleSpy).toHaveBeenCalledWith(
      "merged 'Exponetial Backoff' into 'Exponential Backoff'"
    );

    const conceptFile = path.join(tempVault, "concepts", "exponential-backoff.md");
    const content = await fs.readFile(conceptFile, "utf-8");
    expect(content).toContain('aliases: ["Exponetial Backoff"]');

    consoleSpy.mockRestore();
  });
});
