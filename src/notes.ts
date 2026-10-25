import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CommitData } from "./git.js";
import type { CommitAnalysis, Concept } from "./analyze.js";

const FILLER_WORDS = new Set([
  "the",
  "in",
  "using",
  "a",
  "an",
  "of",
  "for",
  "with",
  "and",
  "to",
  "on",
  "at",
  "by",
  "from",
  "into",
]);

export function slugify(name: string): string {
  // Replace Windows invalid characters (: ? * " < > | \ /) with space so words don't merge
  const sanitized = name.replace(/[:?*"<>|\\/]/g, " ").trim().toLowerCase();
  const slug = sanitized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "concept";
}

export function normalizeConceptTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FILLER_WORDS.has(w))
    .sort();
}

export function normalizeConceptName(name: string): string {
  return normalizeConceptTokens(name).join(" ");
}

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

export function calculateSimilarity(nameA: string, nameB: string): number {
  const tokensA = normalizeConceptTokens(nameA);
  const tokensB = normalizeConceptTokens(nameB);

  // Token overlap with fuzzy tolerance for single-character typos
  let matchedTokens = 0;
  const usedB = new Set<number>();

  for (const tA of tokensA) {
    for (let j = 0; j < tokensB.length; j++) {
      if (usedB.has(j)) continue;
      const tB = tokensB[j];
      if (tA === tB) {
        matchedTokens++;
        usedB.add(j);
        break;
      }
      const maxTokenLen = Math.max(tA.length, tB.length);
      if (maxTokenLen > 3 && levenshteinDistance(tA, tB) <= 1) {
        matchedTokens++;
        usedB.add(j);
        break;
      }
    }
  }

  const unionSize = tokensA.length + tokensB.length - matchedTokens;
  const tokenOverlap = unionSize === 0 ? 0 : matchedTokens / unionSize;

  const normA = normalizeConceptName(nameA);
  const normB = normalizeConceptName(nameB);
  const maxLen = Math.max(normA.length, normB.length);
  const levDist = levenshteinDistance(normA, normB);
  const levSimilarity = maxLen === 0 ? 1 : 1 - levDist / maxLen;

  // Blend token overlap and string edit distance
  return Math.max(0.5 * tokenOverlap + 0.5 * levSimilarity, levSimilarity);
}

export interface MatchResult {
  match: string;
  layer: 1 | 2 | 3;
}

export function findMatchingConcept(
  candidate: string,
  existingList: string[],
  fuzzyThreshold: number = 0.75
): MatchResult | null {
  const candidateSlug = slugify(candidate);

  // Layer 1: Exact slug match
  for (const existing of existingList) {
    if (candidateSlug === slugify(existing)) {
      return { match: existing, layer: 1 };
    }
  }

  // Layer 2: Normalized-name match
  const candidateTokensStr = normalizeConceptName(candidate);
  for (const existing of existingList) {
    if (candidateTokensStr && candidateTokensStr === normalizeConceptName(existing)) {
      return { match: existing, layer: 2 };
    }
  }

  // Layer 3: Fuzzy match
  let bestMatch: string | null = null;
  let bestScore = -1;

  for (const existing of existingList) {
    const score = calculateSimilarity(candidate, existing);
    if (score >= fuzzyThreshold && score > bestScore) {
      bestScore = score;
      bestMatch = existing;
    }
  }

  if (bestMatch) {
    return { match: bestMatch, layer: 3 };
  }

  return null;
}

export async function getKnownConcepts(vaultPath: string): Promise<string[]> {
  const filePath = path.join(vaultPath, "known-concepts.json");
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

export async function saveKnownConcepts(
  vaultPath: string,
  concepts: string[]
): Promise<void> {
  const filePath = path.join(vaultPath, "known-concepts.json");
  await fs.mkdir(vaultPath, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(concepts, null, 2) + "\n", "utf-8");
}

function addAliasToFrontmatter(content: string, alias: string): string {
  if (!content.startsWith("---")) {
    return content;
  }

  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) {
    return content;
  }

  const frontmatterStr = content.substring(4, endIdx);
  const rest = content.substring(endIdx);

  // Check if alias already listed
  if (frontmatterStr.includes(alias)) {
    return content;
  }

  let updatedFrontmatter = "";
  if (/^aliases:\s*\[(.*?)\]/m.test(frontmatterStr)) {
    updatedFrontmatter = frontmatterStr.replace(
      /^aliases:\s*\[(.*?)\]/m,
      (_, current) => {
        const list = current
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean);
        list.push(`"${alias}"`);
        return `aliases: [${list.join(", ")}]`;
      }
    );
  } else if (/^aliases:/m.test(frontmatterStr)) {
    updatedFrontmatter = frontmatterStr.replace(
      /^aliases:/m,
      `aliases:\n  - "${alias}"`
    );
  } else {
    updatedFrontmatter = `${frontmatterStr}\naliases: ["${alias}"]`;
  }

  return `---\n${updatedFrontmatter}${rest}`;
}

function formatExampleBlock(
  commitFileBase: string,
  concept: Concept
): string {
  const shortExplanation = concept.explanation ? `: ${concept.explanation}` : "";
  const header = `- [[${commitFileBase}]] : ${concept.file}${shortExplanation}`;

  if (concept.codeSnippet && concept.codeSnippet.trim()) {
    return `${header}\n\`\`\`\n${concept.codeSnippet.trim()}\n\`\`\``;
  }

  return header;
}

function appendExampleToMarkdown(
  existingContent: string,
  commitFileBase: string,
  concept: Concept
): string {
  // Idempotency: Check if this commit example already exists for this file
  const marker = `- [[${commitFileBase}]] : ${concept.file}`;
  if (existingContent.includes(marker)) {
    return existingContent;
  }

  const exampleBlock = formatExampleBlock(commitFileBase, concept);

  const examplesHeader = "## Examples";
  const examplesIdx = existingContent.indexOf(examplesHeader);

  if (examplesIdx === -1) {
    // Append Examples section if missing
    return `${existingContent.trim()}\n\n## Examples\n${exampleBlock}\n`;
  }

  // Find next section after Examples
  const searchStart = examplesIdx + examplesHeader.length;
  const nextSectionMatch = existingContent.substring(searchStart).match(/\n##\s+/);

  if (nextSectionMatch && nextSectionMatch.index !== undefined) {
    const insertPoint = searchStart + nextSectionMatch.index;
    const before = existingContent.substring(0, insertPoint).trimEnd();
    const after = existingContent.substring(insertPoint);
    return `${before}\n${exampleBlock}\n${after}`;
  }

  // No next section, append to end
  return `${existingContent.trimEnd()}\n${exampleBlock}\n`;
}

export function createConceptMarkdown(
  name: string,
  concept: Concept,
  commitFileBase: string,
  dateStr: string,
  aliases: string[] = []
): string {
  const difficulty = concept.difficulty ?? "intermediate";
  const aliasLine =
    aliases.length > 0
      ? `aliases: [${aliases.map((a) => `"${a}"`).join(", ")}]\n`
      : "";

  const exampleBlock = formatExampleBlock(commitFileBase, concept);
  const explanation = concept.explanation ?? "Concept introduced in commit.";
  let interviewQuestion = "- Explain how this concept applies in this context.";
  if (concept.interviewQuestion) {
    if (concept.interviewAnswer) {
      interviewQuestion = `- **Q:** ${concept.interviewQuestion}\n  **Answer:** ${concept.interviewAnswer}`;
    } else {
      interviewQuestion = `- ${concept.interviewQuestion}`;
    }
  }

  return `---
tags: [ink, ${difficulty}]
created: ${dateStr}
${aliasLine}---
# ${name}

## Explanation
${explanation}

## Examples
${exampleBlock}

## Interview questions
${interviewQuestion}
`;
}

export async function saveNotes(
  vaultPath: string,
  commit: CommitData,
  analysis: CommitAnalysis,
  options: { fuzzyThreshold?: number } = {}
): Promise<{ conceptsWritten: string[]; commitNotePath: string }> {
  const fuzzyThreshold = options.fuzzyThreshold ?? 0.75;
  const conceptsDir = path.join(vaultPath, "concepts");
  const commitsDir = path.join(vaultPath, "commits");

  await fs.mkdir(conceptsDir, { recursive: true });
  await fs.mkdir(commitsDir, { recursive: true });

  const knownList = await getKnownConcepts(vaultPath);
  const updatedKnown = [...knownList];

  const shortSha = commit.sha.slice(0, 7);
  const dateStr = commit.date
    ? commit.date.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const commitFileBase = `${dateStr}-${shortSha}`;
  const commitNotePath = path.join(commitsDir, `${commitFileBase}.md`);

  const conceptsWritten: string[] = [];

  for (const concept of analysis.concepts) {
    const match = findMatchingConcept(concept.name, updatedKnown, fuzzyThreshold);

    let targetName = concept.name;
    let aliasToAdd: string | null = null;

    if (match) {
      targetName = match.match;
      if (match.layer === 3) {
        console.log(`merged '${concept.name}' into '${match.match}'`);
        aliasToAdd = concept.name;
      }
    } else {
      updatedKnown.push(concept.name);
    }

    const conceptSlug = slugify(targetName);
    const conceptFilePath = path.join(conceptsDir, `${conceptSlug}.md`);

    let fileExists = false;
    let existingContent = "";

    try {
      existingContent = await fs.readFile(conceptFilePath, "utf-8");
      fileExists = true;
    } catch {
      fileExists = false;
    }

    if (fileExists) {
      let contentToSave = appendExampleToMarkdown(
        existingContent,
        commitFileBase,
        concept
      );
      if (aliasToAdd) {
        contentToSave = addAliasToFrontmatter(contentToSave, aliasToAdd);
      }
      await fs.writeFile(conceptFilePath, contentToSave, "utf-8");
    } else {
      const aliases = aliasToAdd ? [aliasToAdd] : [];
      const newContent = createConceptMarkdown(
        targetName,
        concept,
        commitFileBase,
        dateStr,
        aliases
      );
      await fs.writeFile(conceptFilePath, newContent, "utf-8");
    }

    conceptsWritten.push(targetName);
  }

  // Update known-concepts.json
  await saveKnownConcepts(vaultPath, updatedKnown);

  // Write Commit Note
  const conceptWikilinks = conceptsWritten
    .map((name) => `- [[${slugify(name)}|${name}]]`)
    .join("\n");

  const commitNoteContent = `---
sha: ${commit.sha}
author: ${commit.author}
date: ${commit.date}
---
# Commit ${shortSha}

## Summary
${analysis.summary}

## Concepts
${conceptWikilinks}
`;

  await fs.writeFile(commitNotePath, commitNoteContent, "utf-8");

  return {
    conceptsWritten,
    commitNotePath,
  };
}
