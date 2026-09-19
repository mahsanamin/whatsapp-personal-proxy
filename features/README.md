# Feature briefs

`upcoming/` is the repository's implementation queue. Each file is a self-contained
brief that a developer or coding agent can implement from a fresh machine after reading
`CLAUDE.md` and `docs/ai_rules/`.

## Lifecycle

1. Add one Markdown file per unimplemented feature under `upcoming/`.
2. Keep credentials, live identifiers, machine paths, and other personal data out of it.
3. State scope, safety constraints, acceptance criteria, tests, and documentation work.
4. Implement the feature on a dedicated branch or worktree.
5. Move lasting operational guidance into the normal project documentation.
6. Delete the upcoming-feature file in the same change only after every acceptance
   criterion passes. Git history remains the record of the original brief.

A fresh agent can be pointed at a feature with:

```text
Read CLAUDE.md, docs/ai_rules/, and features/upcoming/<feature>.md completely.
Implement that feature, verify every acceptance criterion, and delete its upcoming
feature file only after the implementation, tests, and permanent documentation are
complete. Do not commit or push unless explicitly requested.
```
