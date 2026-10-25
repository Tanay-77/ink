import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ConfigSchema, loadConfig, saveConfig, getConfigPath } from "../src/config.js";

describe("ConfigSchema", () => {
  it("validates valid config with defaults applied", () => {
    const parsed = ConfigSchema.parse({
      vaultPath: "C:\\Notes\\Vault",
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
    });

    expect(parsed.vaultPath).toBe("C:\\Notes\\Vault");
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.model).toBe("claude-3-5-sonnet-latest");
    expect(parsed.ignore).toEqual([]);
    expect(parsed.maxDiffChars).toBe(24000);
  });

  it("accepts openai provider", () => {
    const parsed = ConfigSchema.parse({
      vaultPath: "/notes",
      provider: "openai",
      model: "gpt-4o",
    });
    expect(parsed.provider).toBe("openai");
  });

  it("rejects invalid provider", () => {
    expect(() =>
      ConfigSchema.parse({
        vaultPath: "/notes",
        provider: "unsupported-provider",
        model: "model-x",
      })
    ).toThrow();
  });

  it("rejects missing vaultPath", () => {
    expect(() =>
      ConfigSchema.parse({
        vaultPath: "",
        provider: "gemini",
        model: "gemini-1.5-pro",
      })
    ).toThrow();
  });
});

describe("saveConfig & loadConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ink-test-"));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("saves and loads configuration correctly", async () => {
    const config = {
      vaultPath: path.join("D:", "vault"),
      provider: "gemini" as const,
      model: "gemini-1.5-pro",
      ignore: ["package-lock.json"],
      maxDiffChars: 30000,
      fuzzyThreshold: 0.75,
    };

    await saveConfig(config, tempDir);
    const loaded = await loadConfig(tempDir);

    expect(loaded).toEqual(config);
  });

  it("throws clear error when config file does not exist", async () => {
    await expect(loadConfig(tempDir)).rejects.toThrow("Run \"ink init\" first");
  });
});
