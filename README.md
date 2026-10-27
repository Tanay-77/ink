<p align="center">
  <img src="logo.png" alt="ink logo" width="120" />
</p>

<h1 align="center">ink</h1>

<p align="center">
  Turn everyday Git commits into Obsidian study notes and interview flashcards.
</p>

<p align="center">
  <a href="https://github.com/Tanay-77/ink">GitHub</a> · 
  <a href="https://github.com/Tanay-77/ink/issues">Issues</a> ·
  <a href="#commands">Commands</a>
</p>

---

## What is ink?

ink is a command-line tool that reads your Git diffs and turns them into clean Markdown notes inside your Obsidian vault. It pulls out the key concepts, architecture decisions, and trade-offs from every commit you make.

It also generates spaced-repetition quiz cards using the SM-2 algorithm so you actually remember what you built — useful for code reviews, technical interviews, or just staying sharp.

No frameworks. No browser. Just your terminal, Git, and Obsidian.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/Tanay-77/ink.git
cd ink
npm install
npm run build
npm link
```

`npm link` registers `ink` as a global command. After this, you can run `ink` from any project folder on your machine.

### 2. Add your API key

ink uses an LLM to analyze your diffs. Save your key once and it works everywhere.

Create a file at `~/.ink/.env` (on Windows: `C:\Users\<you>\.ink\.env`):

```
API_KEY=your_key_here
```

Or set it as a system environment variable:

```bash
# macOS / Linux
export API_KEY="your_key_here"
```

```powershell
# Windows PowerShell
[System.Environment]::SetEnvironmentVariable('API_KEY', 'your_key_here', 'User')
```

You do not need to copy `.env` files into each project. ink finds the key automatically.

### 3. Initialize in any project

Go to any Git repo and run:

```bash
ink init
```

It asks for:
- Your Obsidian vault path (e.g. `~/Documents/MyVault`)
- LLM provider (`gemini`, `anthropic`, or `openai`)
- Model name (e.g. `gemini-2.0-flash`)

This creates a small `.ink.json` config in that project folder.

---

<h2 id="commands">Commands</h2>

| Command | What it does |
| :--- | :--- |
| `ink init` | Set up ink for the current project |
| `ink run [sha]` | Generate a study note for a commit (defaults to HEAD) |
| `ink install-hook` | Auto-generate notes on every `git commit` in the background |
| `ink uninstall-hook` | Remove the auto hook |
| `ink quiz` | Review today's spaced-repetition flashcards |
| `ink explain [sha]` | Practice explaining a commit out loud, scored 0-5 |

### Generate a note

```bash
ink run HEAD
ink run a1b2c3d
```

### Auto-generate on every commit

```bash
ink install-hook
```

After this, every time you run `git commit`, ink generates a note silently in the background. Your commit finishes instantly.

### Daily quiz

```bash
ink quiz
```

Shows concepts due for review today based on the SM-2 spaced repetition algorithm.

### Interview practice

```bash
ink explain HEAD
```

You explain what you changed and why. ink scores your answer from 0 to 5 on clarity, architecture reasoning, and edge cases.

---

## Vault structure

All your notes go into one central Obsidian vault. You can run `ink init` in as many repos as you want — they all write to the same vault.

```
MyVault/
  commits/
    2026-10-24-feat-auth-middleware.md
    2026-10-25-refactor-database-queries.md
  concepts/
    JWT-Blacklisting.md
    Connection-Pool-Exhaustion.md
  quizzes/
    2026-10-24-daily-quiz.md
```

Concepts are linked with `[[wikilinks]]` so they form a connected knowledge graph across all your projects.

---

## Who is this for?

If you code with AI and ship fast but then struggle to explain what you built in interviews or code reviews — ink is for you. It makes sure you deeply understand every commit, not just ship it.

---

## License

MIT License. Built by [Tanay Mahajan](https://github.com/Tanay-77).
