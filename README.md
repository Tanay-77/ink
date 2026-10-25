# ink 🧠⚡

> **Turn Everyday Git Commits into Obsidian Study Notes & Interactive Technical Interview Quizzes.**

`ink` is an open-source CLI companion that parses your Git diffs and automatically generates structured Markdown study notes in your local [Obsidian](https://obsidian.md) vault. It extracts architectural decisions, trade-offs, and spaced-repetition flashcards (SM-2 algorithm) so you retain what you build and can articulate your choices effortlessly in system design interviews.

---

## ⚡ Quickstart (Set Up in Under 2 Minutes)

### 1. Install & Link Globally
Clone this repository to your computer, compile the TypeScript source, and register the global CLI symlink:

```bash
git clone https://github.com/Tanay-77/ink.git
cd ink
npm install
npm run build
npm link
```

> **Why `npm link`?**  
> Running `npm link` registers `ink` as a global command in your system `$PATH`. You can now open any terminal and run `ink` in **any** project repository across your machine.

---

### 2. Set Your API Key Once (No `.env` Copying)
You **never** have to copy a `.env` file into your individual coding repositories. Save your API key once in your user home folder:

#### Option A: User Home Config (Recommended)
Create `~/.ink/.env` (Windows: `C:\Users\<YourUser>\.ink\.env`):

```bash
# macOS / Linux
mkdir -p ~/.ink
echo "GEMINI_API_KEY=your_gemini_api_key_here" > ~/.ink/.env

# Windows (PowerShell)
mkdir ~/.ink -Force
Set-Content ~/.ink/.env "GEMINI_API_KEY=your_gemini_api_key_here"
```

#### Option B: System Environment Variable
- **Windows (PowerShell)**:
  ```powershell
  [System.Environment]::SetEnvironmentVariable('GEMINI_API_KEY', 'your_key_here', 'User')
  ```
- **macOS / Linux**:
  Add to `~/.bashrc` or `~/.zshrc`:
  ```bash
  export GEMINI_API_KEY="your_key_here"
  ```

---

### 3. Initialize in Any Project
Navigate into **any Git repository** you want to take study notes for, and run:

```bash
cd ~/my-favorite-project
ink init
```

The interactive wizard will ask for:
1. **Obsidian Vault Path**: (e.g., `~/Documents/ObsidianVault` or `C:/Users/name/ObsidianVault`)
2. **Provider**: `gemini` (default), `anthropic`, or `openai`
3. **Model**: `gemini-2.0-flash` (or `claude-3-5-sonnet`, `gpt-4o`)

It writes a lightweight `.ink.json` in that project root.

---

## 🛠️ CLI Commands Guide

| Command | Mode | Description |
| :--- | :--- | :--- |
| `ink init` | Setup | Configures `.ink.json` pointing to your Obsidian vault |
| `ink run [sha]` | On-Demand | Generates a study note for `HEAD` or a specific commit hash |
| `ink install-hook` | Automation | Installs background post-commit hook for 100% silent automation |
| `ink uninstall-hook` | Automation | Removes the background Git post-commit hook |
| `ink quiz` | Study | Reviews today's spaced-repetition (SM-2) concept quiz |
| `ink explain [sha]` | Interview | Practice technical interview explain-back mode (graded 0-5) |

### On-Demand Note Generation
```bash
# Generate study note for the latest commit
ink run HEAD

# Generate study note for a past commit
ink run a1b2c3d
```

### 100% Automated Background Hook
Don't want to run commands manually? Turn on the silent Git hook:
```bash
ink install-hook
```
Every time you run `git commit -m "..."`, note generation runs as an asynchronous background worker. Your Git commit finishes in milliseconds without waiting.

### Daily Active Recall (Spaced Repetition)
```bash
ink quiz
```
Pulls concepts due for review today according to the SuperMemo-2 (SM-2) algorithm. Answers are hidden until clicked/revealed.

### Technical Interview Simulator
```bash
ink explain HEAD
```
Puts you on the spot to articulate why you made changes in your latest commit. Evaluates your explanation from 0 to 5 on clarity, architectural intent, and potential edge cases.

---

## 🗂️ Multi-Repository & Obsidian Vault Structure

You can run `ink init` across all your separate coding repositories. They all funnel clean Markdown notes into your central Obsidian vault:

```text
MyObsidianVault/
├── commits/
│   ├── 2026-10-24-feat-auth-middleware.md
│   └── 2026-10-25-refactor-database-queries.md
├── concepts/
│   ├── JWT-Blacklisting.md
│   └── Connection-Pool-Exhaustion.md
└── quizzes/
    └── 2026-10-24-daily-quiz.md
```

Inside Obsidian, concepts are connected via `[[wikilinks]]`, creating an interconnected knowledge graph of everything you've ever built across different codebases!

---

## 🌐 Web Showcase & Full Documentation

This repository includes a Next.js web application and interactive documentation:

```bash
cd web
npm install
npm run dev
```

Visit:
- **Landing Page & Action Demo**: [http://localhost:3000](http://localhost:3000)
- **Interactive Documentation**: [http://localhost:3000/docs](http://localhost:3000/docs)

---

## 📄 License
MIT License. Created by [Tanay Mahajan](https://github.com/Tanay-77).
