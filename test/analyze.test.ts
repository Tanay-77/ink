import { describe, it, expect, vi } from "vitest";
import {
  analyzeCommit,
  buildAnalysisUserPrompt,
  stripCodeFences,
  CommitAnalysisSchema,
} from "../src/analyze.js";
import { GeminiProvider, type LLMProvider } from "../src/llm.js";
import type { CommitData } from "../src/git.js";

const sampleCommit: CommitData = {
  sha: "1234567890abcdef1234567890abcdef12345678",
  author: "Alice Developer <alice@example.com>",
  date: "2026-10-22T10:00:00Z",
  message: "Add exponential backoff retry mechanism to LLM client",
  files: [
    {
      path: "src/llm.ts",
      diff: "+ const delay = baseDelayMs * Math.pow(2, attempt);\n+ await new Promise(r => setTimeout(r, delay));",
    },
  ],
};

class FakeLLMProvider implements LLMProvider {
  public calls: Array<{ system: string; user: string }> = [];
  private responses: string[];

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

describe("stripCodeFences", () => {
  it("removes markdown json code fences", () => {
    const raw = "```json\n{\"summary\": \"Test summary\"}\n```";
    expect(stripCodeFences(raw)).toBe("{\"summary\": \"Test summary\"}");
  });

  it("extracts json amidst surrounding commentary", () => {
    const raw = "Here is the result:\n```\n{\"summary\": \"Clean result\"}\n```\nHope this helps!";
    expect(stripCodeFences(raw)).toBe("{\"summary\": \"Clean result\"}");
  });
});

describe("buildAnalysisUserPrompt", () => {
  it("caps known concepts to the 200 most recent", () => {
    const hugeConcepts = Array.from({ length: 250 }, (_, i) => `Concept_${i}`);
    const prompt = buildAnalysisUserPrompt(sampleCommit, hugeConcepts);

    expect(prompt).toContain("Known existing concepts in vault (200):");
    expect(prompt).not.toContain('"Concept_0"');
    expect(prompt).toContain('"Concept_249"');
  });
});

describe("CommitAnalysisSchema validation", () => {
  it("accepts valid new concept with explanation and interview question", () => {
    const validData = {
      summary: "Added retry backoff to LLM client. Handled network glitches cleanly.",
      concepts: [
        {
          name: "Exponential Backoff",
          existing: false,
          explanation: "Used to handle transient rate limit responses gracefully.",
          file: "src/llm.ts",
          codeSnippet: "baseDelayMs * Math.pow(2, attempt)",
          difficulty: "intermediate" as const,
          interviewQuestion: "What is the purpose of adding jitter to exponential backoff?",
        },
      ],
    };
    expect(() => CommitAnalysisSchema.parse(validData)).not.toThrow();
  });

  it("accepts existing concept without explanation or interview question", () => {
    const validExisting = {
      summary: "Reused existing concept in new file.",
      concepts: [
        {
          name: "Singleton Pattern",
          existing: true,
          file: "src/service.ts",
          codeSnippet: "getInstance()",
        },
      ],
    };
    expect(() => CommitAnalysisSchema.parse(validExisting)).not.toThrow();
  });

  it("rejects new concept missing required interview question", () => {
    const invalid = {
      summary: "Invalid new concept.",
      concepts: [
        {
          name: "Circuit Breaker",
          existing: false,
          explanation: "Stops cascading failures.",
          file: "src/net.ts",
          codeSnippet: "break;",
          difficulty: "advanced" as const,
          // Missing interviewQuestion
        },
      ],
    };
    expect(() => CommitAnalysisSchema.parse(invalid)).toThrow("interviewQuestion is required");
  });

  it("rejects duplicate concept names in same commit", () => {
    const duplicates = {
      summary: "Duplicate concepts.",
      concepts: [
        {
          name: "Memoization",
          existing: true,
          file: "src/a.ts",
          codeSnippet: "memo()",
        },
        {
          name: "memoization",
          existing: true,
          file: "src/b.ts",
          codeSnippet: "memo()",
        },
      ],
    };
    expect(() => CommitAnalysisSchema.parse(duplicates)).toThrow("Duplicate concept names");
  });
});

describe("analyzeCommit with FakeLLMProvider", () => {
  it("succeeds on valid canned JSON response", async () => {
    const validJson = JSON.stringify({
      summary: "Adds exponential retry logic. Protects against 429 rate limits.",
      concepts: [
        {
          name: "Exponential Backoff",
          existing: false,
          explanation: "Spreads out retry attempts exponentially to reduce server pressure.",
          file: "src/llm.ts",
          codeSnippet: "Math.pow(2, attempt)",
          difficulty: "intermediate",
          interviewQuestion: "How does backoff mitigate the thundering herd problem?",
        },
      ],
    });

    const fakeProvider = new FakeLLMProvider([validJson]);
    const result = await analyzeCommit(sampleCommit, [], fakeProvider);

    expect(result.summary).toContain("exponential retry");
    expect(result.concepts).toHaveLength(1);
    expect(result.concepts[0].name).toBe("Exponential Backoff");
    expect(fakeProvider.calls).toHaveLength(1);
  });

  it("retries once when first response is invalid JSON, then succeeds", async () => {
    const invalidResponse = "Oops, I forgot valid JSON formatting { invalid }";
    const validResponse = JSON.stringify({
      summary: "Corrected summary. Fixed the JSON formatting.",
      concepts: [
        {
          name: "Error Recovery",
          existing: true,
          file: "src/llm.ts",
          codeSnippet: "try { ... } catch",
        },
      ],
    });

    const fakeProvider = new FakeLLMProvider([invalidResponse, validResponse]);
    const result = await analyzeCommit(sampleCommit, ["Error Recovery"], fakeProvider);

    expect(fakeProvider.calls).toHaveLength(2);
    expect(fakeProvider.calls[1].user).toContain("CRITICAL: Your previous response was invalid");
    expect(result.concepts[0].existing).toBe(true);
  });

  it("throws error when both initial attempt and retry fail", async () => {
    const invalid1 = "{ not json at all";
    const invalid2 = "{ still bad json";

    const fakeProvider = new FakeLLMProvider([invalid1, invalid2]);
    await expect(analyzeCommit(sampleCommit, [], fakeProvider)).rejects.toThrow();
    expect(fakeProvider.calls).toHaveLength(2);
  });
});

describe("GeminiProvider missing key check", () => {
  it("throws clear error when GEMINI_API_KEY is not set", () => {
    const originalGemini = process.env.GEMINI_API_KEY;
    const originalApi = process.env.API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.API_KEY;

    try {
      expect(() => new GeminiProvider({ apiKey: "" })).toThrow(
        "Missing GEMINI_API_KEY environment variable"
      );
    } finally {
      if (originalGemini) {
        process.env.GEMINI_API_KEY = originalGemini;
      }
      if (originalApi) {
        process.env.API_KEY = originalApi;
      }
    }
  });
});
