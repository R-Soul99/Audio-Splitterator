# Instructions for AI Coding Agents

These standing instructions apply throughout this repository.

Read `PROJECT_CONTEXT.md` before working on the task. Always inspect the current implementation before proposing or modifying code.

## Authority

Follow the sources-of-truth hierarchy in `PROJECT_CONTEXT.md`: current `main` code; current task; project context; existing approved behaviour to preserve; informal/potentially stale `Next_Up.txt`; ideas in `SEEDS.md`; historical `Prompts/`; screenshots, mockups and old plans as reference only.

Current `main` describes the baseline; explicit current requirements authorise the intended changes. Do not treat implementation as proof of approval, or historical instructions as permission to bypass these working rules.

## Git workflow

- Start each development pass from up-to-date `main`; fetch and inspect the current remote baseline first.
- Create a fresh branch for the task. Preserve any existing unrelated local work.
- Never push experimental work directly to `main`.
- Keep unrelated changes out of the task and use scoped commits.
- Keep work on its development branch until reviewed and approved for merging.

## Implementation

- Preserve existing behaviour unless the task explicitly changes it.
- Prefer the smallest clean change that satisfies the requirement.
- Do not implement items merely because they appear in `SEEDS.md`, `Next_Up.txt`, screenshots or historical prompts.
- Treat `Prompts/` as development history, not standing requirements. Read the explicitly selected brief for the current task against the current implementation and authority hierarchy.
- Do not silently redesign adjacent UI or restructure unrelated code.
- Respect agreed review stages and distinguish discussion-only ideas from approved implementation work.

## Audio

Changes involving sample positions, timing, encoding, splitting, zero-crossings, looping or recording require particular care. Preserve channel alignment, sample-rate correctness and precise region/export boundaries. Avoid lossy intermediate processing and unnecessary alteration of the source recording.

## UI

Preserve the fixed device/workspace layout and as much waveform space as possible. Opening controls, panels or information overlays, or adjusting values, must not unexpectedly resize or move the waveform or unrelated controls.

Maintain the established vintage laboratory/audio-equipment aesthetic.

## Validation and reporting

After implementation:

- Run TypeScript checking (`npm run lint`, currently `tsc --noEmit`).
- Run relevant tests. The current audio utility tests use Node's test runner through `tsx`: `npx tsx --test src/utils/*.test.ts`. Check current scripts and test files before choosing commands; there is currently no `npm test` script.
- Run the production build (`npm run build`); validate Electron packaging when desktop changes require it.
- Add/update focused tests where appropriate for meaningful behaviour changes.
- For documentation-only changes, inspect the documents, run `git diff --check` and verify that the diff contains only the intended documentation. Application checks may be omitted; state that explicitly.
- Report exactly what changed, branch/commit details, checks performed and anything that could not be verified. Describe interactive testing needed for changed audio/UI behaviour.

Do not describe a feature as user-approved merely because automated validation passes. Leroy performs final interactive approval; merge only after the required human review and approval.
