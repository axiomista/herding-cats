# Progress

Overnight offline build on branch `overnight/build`. Source of truth: `project-plan/herding-cats-spec.md`, in the order of `project-plan/work-breakdown.md`.

## Done

- Step 0 contracts: `src/types.ts`, `src/box.ts` (BoxGateway + real CCG gateway, typechecks, never called), `src/config.ts`.
- A1 offline part: `config/people.yaml`, real `BoxGateway`.
- A2 to A6 engine: extract, verify, normalize, match, certainty, apply, cycle; `src/trackers/box-tasks.ts`.
- `seed/`: answer key and `seed_tasks.py` copied; 7 seed docs in `seed/docs/`.
- `test/fixtures/v1/`: 7 hand-written fixtures (invalid-JSON first reply on kickoff, paraphrased evidence in sync01, mislabeled idea in brainstorm, "I" owner in the email).
- Smoke run of a full apply-mode scan on the fake: recall 9/9, 1 false positive, T1 to T7 correct, 6 writes, 3 held.

## In progress

- Unit and replay tests.

## Next

- B2 server and API, B5 triggers, B3 page, B6 eval, B1 Dockerfile, CI and Terraform.

## Blocked

- Nothing yet.
