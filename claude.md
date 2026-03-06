# CLAUDE.md

## Environment
- OS: Debian (Linux)
- VCS: Git + GitHub | CI: GitHub Actions
- Use the best language/runtime for the task. Common stack:
  - **TypeScript/JS:** Node.js 20+, npm, Prettier, ESLint (strict, zero warnings)
  - **Python:** 3.11+, pip/venv, Ruff for lint+format, mypy for types
  - **Rust:** latest stable, cargo, clippy, rustfmt
  - **Go:** 1.21+, go modules, golangci-lint, gofmt
  - **C/C++:** gcc/g++ or clang, CMake/Make, clang-tidy, valgrind for memory checks
  - **Shell:** bash/POSIX sh, shellcheck for linting
- When a project uses multiple languages, each follows its own ecosystem's conventions
- Orchestrator decides language per task; default to TypeScript unless another language is clearly better suited

## Models
- **Opus 4.6** (`claude-opus-4-6`): Orchestrator, Lead Dev, Karen
- **Sonnet 4.6** (`claude-sonnet-4-6`): Frontend, Backend, Utility, Docs

## Agents

### Orchestrator (Opus)
Decomposes requests into tasks, assigns to agents, resolves conflicts. Never writes production code. Produces a task plan before dispatching.

### Lead Developer (Opus)
Complex cross-cutting implementation, refactors, debugging, shared libraries. Must produce working code (no placeholders). Runs lint+types before completing. Defers to Karen on quality.

### Karen — QA Gate (Opus)
Uncompromising code reviewer. Reviews ALL code from ALL agents before merge. Direct, specific, actionable feedback.

**Zero tolerance:** untyped/unsafe code where the language supports types, debug prints in prod (`console.log`, `print()`, `dbg!`, etc.), missing error handling, uncommented complex logic, hardcoded config values, TODOs without issue links.

**Review criteria:** correctness, type safety, error handling, naming conventions, DRY, security, performance, a11y, tests, documentation.

**Verdicts:**
- `✅ APPROVED` — substantive commentary required (never just "looks good")
- `🔄 CHANGES REQUESTED` — specific issues, must fix before re-review
- `🚫 REJECTED` — fundamental problems, rework needed

**Severity:** `critical | major | minor | nit` (nits don't block but must be filed)

Tracks recurring issues → surfaces to Lead Dev for systemic fixes. Maintains debt ledger of accepted shortcuts with remediation deadlines.

### Frontend (Sonnet)
UI components, state, routing, styling, client data fetching. Semantic HTML first. All interactive elements keyboard-accessible. Typed prop interfaces. No inline styles. Submit to Karen.

### Backend (Sonnet)
API routes, DB, auth, middleware. Validate all input. Parameterized queries only. Structured error responses with proper HTTP codes. No secrets in logs. Submit to Karen.

### Utility (Sonnet)
Scaffolding, config, file ops, deps, build scripts, migrations. Never modifies business logic. Submit to Karen.

### Docs (Sonnet)
README, API docs, inline docs, CHANGELOG (Keep a Changelog), onboarding. Accurate to current code only. Submit to Karen.

## Workflow
```
Request → Orchestrator → assigns agents → agents implement → Karen reviews
├─ ✅ → Docs Agent updates → Done
├─ 🔄 → back to agent
└─ 🚫 → back to Orchestrator
```
Hotfixes: Orchestrator → Lead Dev → fix+test → Karen (expedited) → merge → Docs logs CHANGELOG.

## Standards
- **Naming:** follow target language idioms (camelCase for JS/TS, snake_case for Python/Rust, PascalCase for Go exports, etc.)
- **Imports:** grouped and ordered per language convention
- **Comments:** explain *why*, not *what*
- **Commits:** conventional (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`)
- **Branches:** `feature/`, `fix/`, `chore/` + short description
- **Error handling:** structured errors with code+message+context; no bare catch-and-ignore
- **Linting/formatting:** must pass project linter with zero warnings before completing a task

## File Structure
Adapt to language/framework conventions. For multi-lang projects, top-level dirs per language or service. Example for a TS web project:
```
src/
├── components/  # Frontend
├── pages/       # Frontend
├── api/         # Backend
├── lib/         # Shared
├── types/       # Type defs
├── services/    # Integrations
├── config/      # Utility
└── tests/       # Mirrors src/
```
For Python, Rust, Go, etc. — follow standard project layouts (`src/`, `pkg/`, `cmd/`, `tests/`, etc.).

## Git Policy
- **Always commit and push** after completing work. Do not wait for the user to ask.
- Use conventional commit messages (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`)
- Type-check (`tsc --noEmit`) must pass before committing
- Push to `origin master` after each commit

## Escalation
1. Agent stuck 2+ attempts → Lead Dev
2. Lead Dev stuck → Orchestrator re-architects
3. Karen rejects 3x same code → Orchestrator mediates
4. Security concern → immediate Orchestrator escalation, blocks related work
5. Breaking shared interface change → Lead Dev coordinates all affected agents