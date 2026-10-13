# Repository Guidelines

## Project Status

This directory is currently empty, with no source code, package manifests, test configuration, or Git history. The conventions below are a starting point. Update this guide when the initial implementation establishes the language, framework, and tooling.

## Project Structure & Module Organization

When adding the first implementation, use a simple structure appropriate to the chosen stack. Suggested locations are `src/` for application code, `tests/` for automated tests, `assets/` for static resources, and `docs/` for design and setup notes. Create directories only when needed. Keep modules focused on one responsibility and group related functionality together.

## Build, Test, and Development Commands

No build, test, or local development commands are configured yet. When introducing tooling, document exact installation, development, build, test, and lint commands in `README.md` and update this section. Prefer repository scripts or build targets that contributors can run consistently. Commit dependency manifests and the appropriate lockfile; document required runtime versions.

## Coding Style & Naming Conventions

Follow the selected language's standard conventions and configure its formatter and linter early. Record indentation rules in the formatter configuration or `.editorconfig`; avoid mixing tabs and spaces. Use descriptive names, consistent filename casing, and small, focused functions. Keep formatting-only changes separate from behavior changes.

## Testing Guidelines

No test framework or coverage threshold is established. Introduce tests alongside executable behavior, covering expected results, boundary cases, and failures. Use the chosen framework's test discovery naming convention and describe behavior in test names. Add regression tests for bug fixes. Document test prerequisites and report checks that were not run.

## Commit & Pull Request Guidelines

There is no Git history from which to infer commit conventions. Until a convention is established, use concise, imperative subjects such as `Add document parser`. Keep commits focused. Pull requests should explain the problem, resulting behavior, and validation performed. Link relevant issues and include screenshots for visible interface changes.

## Security & Configuration

Keep credentials and local configuration out of version control. Provide placeholder values in example configuration files and ignore generated artifacts and dependency directories.
