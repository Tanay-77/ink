import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function parseEnvContent(content: string): void {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

function tryLoadEnvFile(envPath: string): void {
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      parseEnvContent(content);
    }
  } catch {
    // ignore
  }
}

export function loadEnv(root: string = process.cwd()): void {
  // 1. Current working directory / project .env (highest priority)
  tryLoadEnvFile(path.join(root, ".env"));

  // 2. Global user home directory fallbacks (~/.ink/.env, ~/.ink.env, ~/.env)
  try {
    const homeDir = os.homedir();
    tryLoadEnvFile(path.join(homeDir, ".ink", ".env"));
    tryLoadEnvFile(path.join(homeDir, ".ink.env"));
    tryLoadEnvFile(path.join(homeDir, ".env"));
  } catch {
    // ignore home directory resolution errors
  }
}

export interface LLMProvider {
  complete(system: string, user: string): Promise<string>;
}

/** Maps each provider name to its expected environment variable. */
const PROVIDER_ENV_KEYS: Record<string, string> = {
  gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * Resolves the API key for a given provider.
 * Checks (in order): explicit key → provider-specific env var → generic API_KEY.
 * Throws a clear, provider-specific error if nothing is found.
 */
export function resolveApiKey(
  provider: "gemini" | "anthropic" | "openai",
  explicitKey?: string
): string {
  if (!explicitKey) {
    loadEnv();
  }

  const envVarName = PROVIDER_ENV_KEYS[provider] ?? "API_KEY";
  const key = explicitKey ?? process.env[envVarName] ?? process.env.API_KEY;

  if (!key || key.trim() === "") {
    throw new Error(
      `Missing ${envVarName} environment variable. Please set ${envVarName} (or API_KEY) in your system environment, in ~/.ink/.env, or in a local .env file.`
    );
  }

  return key.trim();
}

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
  maxRetries?: number;
  baseDelayMs?: number;
}

export class GeminiProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;

  constructor(options: GeminiProviderOptions = {}) {
    this.apiKey = resolveApiKey("gemini", options.apiKey);
    this.model = options.model ?? "gemini-3.5-flash-lite";
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
  }

  async complete(system: string, user: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.model
    )}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const payload = {
      system_instruction: {
        parts: [{ text: system }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: user }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          const data = (await response.json()) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ text?: string }>;
              };
            }>;
          };

          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            throw new Error("Gemini returned an empty response with no content parts.");
          }
          return text;
        }

        const isRateLimit = response.status === 429 || response.status === 503;
        const errorText = await response.text();

        if (isRateLimit && attempt < this.maxRetries) {
          const delay = this.baseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw new Error(`Gemini API error (${response.status}): ${errorText}`);
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Only retry network errors or rate limit errors
        if (attempt < this.maxRetries && (lastError.message.includes("429") || lastError.message.includes("503") || lastError.message.includes("fetch failed"))) {
          const delay = this.baseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw lastError;
      }
    }

    throw lastError ?? new Error("Gemini API request failed after retries.");
  }
}

export function createLLMProvider(
  provider: "gemini" | "anthropic" | "openai" = "gemini",
  model?: string
): LLMProvider {
  // Validate the API key early so the error message is provider-specific
  // (e.g. "Missing OPENAI_API_KEY" instead of a generic message)
  resolveApiKey(provider);

  if (provider === "gemini") {
    return new GeminiProvider({ model });
  }

  throw new Error(
    `Provider "${provider}" is not implemented yet. Currently active provider: "gemini".`
  );
}
