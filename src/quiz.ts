import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFile } from "node:child_process";
import { z } from "zod";
import { loadConfig, type Config } from "./config.js";
import { createLLMProvider, type LLMProvider } from "./llm.js";
import { stripCodeFences } from "./analyze.js";
import { slugify } from "./notes.js";
import { trackUsage } from "./explain.js";
import {
  calculateSM2,
  createInitialSchedule,
  formatDate,
  isDue,
  type ScheduleItem,
} from "./schedule.js";
import { QUIZ_GRADE_SYSTEM_PROMPT } from "./prompts/quiz.js";

export const QuizGradeSchema = z.object({
  score: z.number().int().min(0).max(5),
  feedback: z.string().min(1, "feedback is required"),
  idealAnswer: z.string().min(1, "idealAnswer is required"),
});

export type QuizGradeResult = z.infer<typeof QuizGradeSchema>;

export interface ProgressCard extends ScheduleItem {
  concept: string;
  scores?: number[];
  dates?: string[];
}

export interface ConceptDetails {
  name: string;
  explanation: string;
  question: string;
  idealAnswer?: string;
  exampleRef?: string;
}

export interface QuizQuestionItem {
  concept: string;
  question: string;
  idealAnswer: string;
  conceptSlug: string;
  explanation?: string;
  exampleRef?: string;
}

export function formatObsidianQuizMarkdown(
  dateStr: string,
  items: QuizQuestionItem[]
): string {
  const sections = items
    .map((item, index) => {
      const refLine = item.exampleRef
        ? `\n> **Related Commit:** [[${item.exampleRef}]]`
        : "";
      return `### ${index + 1}. [[${item.conceptSlug}|${item.concept}]]

**Interview Question:**
${item.question}

> [!tip]- 💡 Click to Reveal Answer & Code Reference
> **Model Answer:**
> ${item.idealAnswer}
>
> **Reference Concept Note:** [[${item.conceptSlug}]]${refLine}
`;
    })
    .join("\n---\n\n");

  return `---
date: ${dateStr}
type: ink-quiz
totalQuestions: ${items.length}
tags: [ink, quiz]
---
# 🧠 Daily Review Quiz — ${dateStr}

*Review the questions below. Try to answer each question mentally or on paper, then click the callout box to check your understanding.*

---

${sections}
`;
}

export async function parseConceptFile(filePath: string): Promise<ConceptDetails> {
  const content = await fs.readFile(filePath, "utf-8");

  // Extract Title
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const name = titleMatch ? titleMatch[1].trim() : path.basename(filePath, ".md");

  // Extract Explanation
  let explanation = "";
  const expMatch = content.split("## Explanation")[1];
  if (expMatch) {
    const expText = expMatch.split("##")[0];
    explanation = expText.trim();
  }

  // Extract Interview Question and Answer
  let question = `Explain the core concepts and trade-offs of ${name}.`;
  let idealAnswer: string | undefined;

  const qMatch = content.split("## Interview questions")[1];
  if (qMatch) {
    const qSection = qMatch.split("##")[0].trim();

    // Check for Answer: or **Answer:**
    const ansMatch = qSection.match(/(?:\*\*Answer:\*\*|Answer:)\s*([\s\S]+?)(?=\n-|\n##|$)/i);
    if (ansMatch && ansMatch[1]) {
      idealAnswer = ansMatch[1].trim();
    }

    // Check for - **Q:** or - Question
    const qLineMatch = qSection.match(/(?:- \*\*Q:\*\*|- )\s*([^\n]+)/);
    if (qLineMatch && qLineMatch[1]) {
      question = qLineMatch[1].trim();
    }
  }

  // Extract Example Commit Reference if present
  let exampleRef: string | undefined;
  const exMatch = content.match(/\[\[(\d{4}-\d{2}-\d{2}-[a-f0-9]+)\]\]/);
  if (exMatch && exMatch[1]) {
    exampleRef = exMatch[1];
  }

  return { name, explanation, question, idealAnswer, exampleRef };
}

export async function loadProgressCards(vaultPath: string): Promise<ProgressCard[]> {
  const progressPath = path.join(vaultPath, "progress.json");
  let list: ProgressCard[] = [];

  try {
    const raw = await fs.readFile(progressPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      list = parsed.map((item) => {
        if (typeof item.interval !== "number" || typeof item.easeFactor !== "number") {
          const init = createInitialSchedule();
          return {
            concept: item.concept || "Unknown",
            scores: item.scores || [],
            dates: item.dates || [],
            ...init,
          };
        }
        return item as ProgressCard;
      });
    }
  } catch {
    list = [];
  }

  // Synchronize with concepts on disk in vault/concepts/
  const conceptsDir = path.join(vaultPath, "concepts");
  try {
    const files = await fs.readdir(conceptsDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const details = await parseConceptFile(path.join(conceptsDir, file)).catch(() => null);
      if (!details) continue;

      const exists = list.some(
        (c) => c.concept.toLowerCase() === details.name.toLowerCase()
      );
      if (!exists) {
        list.push({
          concept: details.name,
          scores: [],
          dates: [],
          ...createInitialSchedule(),
        });
      }
    }
  } catch {
    // Concepts dir may not exist yet
  }

  return list;
}

export async function saveProgressCards(
  vaultPath: string,
  cards: ProgressCard[]
): Promise<void> {
  const progressPath = path.join(vaultPath, "progress.json");
  await fs.mkdir(vaultPath, { recursive: true });
  await fs.writeFile(progressPath, JSON.stringify(cards, null, 2) + "\n", "utf-8");
}

export async function gradeQuizAnswer(
  conceptName: string,
  explanation: string,
  question: string,
  userAnswer: string,
  provider: LLMProvider
): Promise<QuizGradeResult> {
  const userPrompt = [
    `Concept: ${conceptName}`,
    `Reference Context: ${explanation || "(None provided)"}`,
    `Question: ${question}`,
    `Candidate Answer: ${userAnswer}`,
  ].join("\n");

  let raw = await provider.complete(QUIZ_GRADE_SYSTEM_PROMPT, userPrompt);
  try {
    const cleaned = stripCodeFences(raw);
    return QuizGradeSchema.parse(JSON.parse(cleaned));
  } catch (firstErr: unknown) {
    const errorMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    const retryPrompt = [
      userPrompt,
      "",
      "CRITICAL: Output was invalid. Output ONLY valid JSON adhering to schema.",
      `Validation Error: ${errorMsg}`,
    ].join("\n");

    raw = await provider.complete(QUIZ_GRADE_SYSTEM_PROMPT, retryPrompt);
    const cleaned = stripCodeFences(raw);
    return QuizGradeSchema.parse(JSON.parse(cleaned));
  }
}

export interface QuizSessionOptions {
  config?: Config;
  provider?: LLMProvider;
  readAnswer?: (prompt: string) => Promise<string>;
  mode?: "obsidian" | "cli";
  openFile?: boolean;
}

export async function runQuizSession(
  repoRoot: string = process.cwd(),
  options: QuizSessionOptions = {}
): Promise<void> {
  const config = options.config ?? (await loadConfig(repoRoot));
  const cards = await loadProgressCards(config.vaultPath);

  if (cards.length === 0) {
    console.log("No concepts found in your vault. Run 'ink run' first to generate study notes.");
    return;
  }

  const todayStr = formatDate();
  const dueCards = cards.filter((c) => isDue(c, todayStr));

  if (dueCards.length === 0) {
    const futureCards = [...cards]
      .filter((c) => c.dueDate > todayStr)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

    if (futureCards.length > 0) {
      console.log(`\nGreat job! No concepts are due for review today.`);
      console.log(`Next review is scheduled on ${futureCards[0].dueDate} (${futureCards[0].concept}).`);
    } else {
      console.log("\nNo concepts are currently scheduled for review.");
    }
    return;
  }

  // Pick up to 10 concepts due today
  const sessionQueue = dueCards.slice(0, 10);
  const mode = options.mode ?? "obsidian";

  // === Option 1: Generate Interactive Quiz in Obsidian (Default) ===
  if (mode === "obsidian") {
    console.log(`\nGenerating interactive Obsidian quiz for ${sessionQueue.length} concept(s) due today...`);

    const questions: QuizQuestionItem[] = [];

    for (const card of sessionQueue) {
      const slug = slugify(card.concept);
      const conceptFilePath = path.join(config.vaultPath, "concepts", `${slug}.md`);

      let details: ConceptDetails = {
        name: card.concept,
        explanation: "",
        question: `Explain the core concepts and trade-offs of ${card.concept}.`,
      };

      try {
        details = await parseConceptFile(conceptFilePath);
      } catch {
        // Fallback
      }

      // Generate a model answer (prioritize specific interview answer if available, else explanation)
      const idealAnswer =
        details.idealAnswer ||
        details.explanation ||
        `Core concept introduced in code changes for ${card.concept}.`;

      questions.push({
        concept: details.name,
        question: details.question,
        idealAnswer,
        conceptSlug: slug,
        explanation: details.explanation,
        exampleRef: details.exampleRef,
      });

      // Advance schedule by 1 day so user isn't prompted for the exact same batch repeatedly today
      const updated = calculateSM2(card, 4);
      card.interval = updated.interval;
      card.easeFactor = updated.easeFactor;
      card.repetitions = updated.repetitions;
      card.dueDate = updated.dueDate;
    }

    const quizzesDir = path.join(config.vaultPath, "quizzes");
    await fs.mkdir(quizzesDir, { recursive: true });

    const quizFileName = `quiz-${todayStr}.md`;
    const quizFilePath = path.join(quizzesDir, quizFileName);
    const quizMarkdown = formatObsidianQuizMarkdown(todayStr, questions);

    await fs.writeFile(quizFilePath, quizMarkdown, "utf-8");
    await saveProgressCards(config.vaultPath, cards);
    await trackUsage(config.vaultPath, "quiz");

    console.log(`\n======================================================`);
    console.log(`🎉 Interactive Quiz Created in Obsidian!`);
    console.log(`======================================================`);
    console.log(`File: "${quizFilePath}"`);
    console.log(`Total questions: ${questions.length}`);
    console.log(`\nHow to use in Obsidian:`);
    console.log(`1. Open Obsidian -> click "quizzes/${quizFileName}"`);
    console.log(`2. Read each interview question.`);
    console.log(`3. Click "> [!tip]- 💡 Click to Reveal Answer" to check your understanding!\n`);

    // Optionally auto-open the quiz note on Windows
    if (options.openFile !== false && process.platform === "win32") {
      execFile("cmd", ["/c", "start", "", quizFilePath], { windowsHide: true }, () => { });
    }

    return;
  }

  // === Option 2: CLI Terminal Review Session (if --cli is passed) ===
  console.log(`\n=== Terminal Quiz Session: ${sessionQueue.length} concept(s) due today ===\n`);

  const provider = options.provider ?? createLLMProvider(config.provider, config.model);
  const readAnswerFn =
    options.readAnswer ??
    (async (p: string) => {
      const rl = readline.createInterface({ input, output });
      try {
        return (await rl.question(p)).trim();
      } finally {
        rl.close();
      }
    });

  let reviewedCount = 0;

  for (let i = 0; i < sessionQueue.length; i++) {
    const card = sessionQueue[i];
    const slug = slugify(card.concept);
    const conceptFilePath = path.join(config.vaultPath, "concepts", `${slug}.md`);

    let details: ConceptDetails = {
      name: card.concept,
      explanation: "",
      question: `Explain the core concepts and trade-offs of ${card.concept}.`,
    };

    try {
      details = await parseConceptFile(conceptFilePath);
    } catch {
      // Fallback
    }

    console.log(`[Card ${i + 1}/${sessionQueue.length}] Concept: ${details.name}`);
    console.log(`Question: ${details.question}\n`);

    const answer = await readAnswerFn("Your Answer: ");
    if (!answer) {
      console.log("Skipping card (empty answer).\n");
      continue;
    }

    console.log("Grading answer...");
    const grade = await gradeQuizAnswer(
      details.name,
      details.explanation,
      details.question,
      answer,
      provider
    );

    console.log(`\nScore: ${grade.score}/5`);
    console.log(`Feedback: ${grade.feedback}`);
    console.log(`Ideal Answer: ${grade.idealAnswer}\n`);

    // Update schedule with SM-2
    const updatedSchedule = calculateSM2(card, grade.score);
    card.interval = updatedSchedule.interval;
    card.easeFactor = updatedSchedule.easeFactor;
    card.repetitions = updatedSchedule.repetitions;
    card.dueDate = updatedSchedule.dueDate;

    if (!card.scores) card.scores = [];
    if (!card.dates) card.dates = [];
    card.scores.push(grade.score);
    card.dates.push(todayStr);

    console.log(`Next review in ${card.interval} day(s) on ${card.dueDate}.\n------------------------------------------\n`);
    reviewedCount++;
  }

  // Save updated progress
  await saveProgressCards(config.vaultPath, cards);
  await trackUsage(config.vaultPath, "quiz");

  console.log(`Session complete! Reviewed ${reviewedCount} concept(s). Progress saved to progress.json.`);
}
