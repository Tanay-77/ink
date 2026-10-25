#!/usr/bin/env node
import { Command } from "commander";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { saveConfig, loadConfig, getConfigPath, type Config } from "./config.js";
import { getCommit } from "./git.js";
import { filterFiles, truncate } from "./filter.js";
import { createLLMProvider, loadEnv } from "./llm.js";
import { analyzeCommit } from "./analyze.js";
import { getKnownConcepts, saveNotes } from "./notes.js";
import { installHook, uninstallHook } from "./hook.js";
import { runExplainSession } from "./explain.js";
import { runQuizSession } from "./quiz.js";

loadEnv();

const program = new Command();

program
  .name("ink")
  .description("Turn Git commits into structured Markdown study notes")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize .ink.json configuration for the current repository")
  .action(async () => {
    const rl = readline.createInterface({ input, output });
    try {
      const rawVault = await rl.question("Enter Obsidian vault or notes directory path: ");
      const vaultPath = rawVault.trim();
      if (!vaultPath) {
        console.error("Error: vaultPath is required.");
        process.exitCode = 1;
        return;
      }

      const rawProvider = await rl.question("Choose provider (anthropic | gemini | openai) [gemini]: ");
      const providerInput = rawProvider.trim().toLowerCase();
      let provider: "anthropic" | "gemini" | "openai" = "gemini";
      if (providerInput === "anthropic" || providerInput === "openai") {
        provider = providerInput;
      }

      let defaultModel = "gemini-2.0-flash";
      if (provider === "anthropic") {
        defaultModel = "claude-3-5-sonnet-latest";
      } else if (provider === "openai") {
        defaultModel = "gpt-4o";
      }

      const rawModel = await rl.question(`Choose model name [${defaultModel}]: `);
      const model = rawModel.trim() || defaultModel;

      const config: Config = {
        vaultPath,
        provider,
        model,
        ignore: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
        maxDiffChars: 24000,
        fuzzyThreshold: 0.75,
      };

      await saveConfig(config);
      console.log(`Configuration written to ${getConfigPath()}`);
    } catch (err: unknown) {
      console.error("Failed to initialize configuration:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    } finally {
      rl.close();
    }
  });

program
  .command("run")
  .description("Generate study notes for a specific commit (default: HEAD)")
  .argument("[sha]", "Commit SHA or ref to analyze", "HEAD")
  .option("-m, --model <model>", "Override LLM model name")
  .action(async (sha: string, cmdOptions: { model?: string }) => {
    try {
      const config = await loadConfig();
      const modelToUse = cmdOptions.model || config.model;

      console.log(`Fetching commit "${sha}"...`);
      const commit = await getCommit(sha);
      console.log(`Found commit ${commit.sha.slice(0, 7)} by ${commit.author}: "${commit.message.split("\n")[0]}"`);

      const filtered = filterFiles(commit.files, config.ignore);
      if (filtered.length === 0) {
        console.log("No relevant files to analyze in this commit after filtering.");
        return;
      }

      const { files: truncatedFiles, truncated } = truncate(filtered, config.maxDiffChars);
      if (truncated) {
        console.log("Note: Diff exceeded budget and was truncated according to relevance.");
      }

      const knownConcepts = await getKnownConcepts(config.vaultPath);
      const provider = createLLMProvider(config.provider, modelToUse);

      console.log(`Analyzing diff with ${config.provider} (${modelToUse})...`);
      const analysis = await analyzeCommit(
        { ...commit, files: truncatedFiles },
        knownConcepts,
        provider
      );

      console.log(`\nCommit Summary:\n${analysis.summary}\n`);

      const result = await saveNotes(config.vaultPath, commit, analysis, {
        fuzzyThreshold: config.fuzzyThreshold,
      });

      console.log(`Success! Notes written to "${config.vaultPath}":`);
      console.log(`- Commit note: ${result.commitNotePath}`);
      console.log(`- Concepts recorded (${result.conceptsWritten.length}):`);
      for (const name of result.conceptsWritten) {
        console.log(`  * ${name}`);
      }
    } catch (err: unknown) {
      console.error("\nRun failed:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("quiz")
  .description("Generate an interactive Obsidian quiz (or review in terminal with --cli)")
  .option("-m, --model <model>", "Override LLM model name")
  .option("--cli", "Run interactive quiz directly in the terminal")
  .action(async (cmdOptions: { model?: string; cli?: boolean }) => {
    try {
      const config = await loadConfig();
      if (cmdOptions.model) {
        config.model = cmdOptions.model;
      }
      await runQuizSession(process.cwd(), {
        config,
        mode: cmdOptions.cli ? "cli" : "obsidian",
      });
    } catch (err: unknown) {
      console.error("\nQuiz session failed:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("explain")
  .description("Start an explain-back session for a commit")
  .argument("[sha]", "Commit SHA or ref to explain", "HEAD")
  .option("-m, --model <model>", "Override LLM model name")
  .action(async (sha: string, cmdOptions: { model?: string }) => {
    try {
      const config = await loadConfig();
      if (cmdOptions.model) {
        config.model = cmdOptions.model;
      }
      await runExplainSession(sha, process.cwd(), { config });
    } catch (err: unknown) {
      console.error("\nExplain session failed:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("install-hook")
  .description("Install background post-commit hook in .git/hooks/post-commit")
  .action(async () => {
    try {
      const result = await installHook();
      if (result.action === "already-installed") {
        console.log(`ink hook is already installed in "${result.hookPath}".`);
      } else if (result.action === "appended") {
        console.log(`ink hook safely appended to existing "${result.hookPath}".`);
      } else {
        console.log(`ink hook successfully created at "${result.hookPath}".`);
      }
    } catch (err: unknown) {
      console.error("Failed to install hook:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program
  .command("uninstall-hook")
  .description("Remove ink from .git/hooks/post-commit")
  .action(async () => {
    try {
      const result = await uninstallHook();
      if (result.action === "not-installed") {
        console.log("No ink hook was found to uninstall.");
      } else if (result.action === "removed") {
        console.log(`ink post-commit hook removed from "${result.hookPath}".`);
      } else {
        console.log(`ink hook removed; preserved remaining hooks in "${result.hookPath}".`);
      }
    } catch (err: unknown) {
      console.error("Failed to uninstall hook:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  });

program.parse(process.argv);

