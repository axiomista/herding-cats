# Progress

Overnight offline build on branch `overnight/build`. Source of truth: `project-plan/herding-cats-spec.md`, in the order of `project-plan/work-breakdown.md`.

## Done

- Step 0 contracts: `src/types.ts`, `src/box.ts` (BoxGateway + real CCG gateway, typechecks, never called), `src/config.ts`.
- A1 offline part: `config/people.yaml`, real `BoxGateway`.
- A2 to A6 engine: extract, verify, normalize, match, certainty, apply, cycle; `src/trackers/box-tasks.ts`.
- `seed/`: answer key and `seed_tasks.py` copied; 7 seed docs in `seed/docs/`.
- `test/fixtures/v1/`: 7 hand-written fixtures (invalid-JSON first reply on kickoff, paraphrased evidence in sync01, mislabeled idea in brainstorm, "I" owner in the email).
- Smoke run of a full apply-mode scan on the fake: recall 9/9, 1 false positive, T1 to T7 correct, 6 writes, 3 held.

- Unit tests (verify, normalize, match, certainty, audit byte-for-byte, webhook signatures) and the replay test: 80 passing.
- B2 server: every route in the spec; passcode session cookie (signed, HTTP-only, 12 hours); 409 while a cycle runs.
- B5 triggers: webhook (signature, dedupe, own-event skip, queue), sweep at startup and on a timer, full scan.
- B3 page: passcode, status, findings by bucket (low certainty first), set aside, audit with date picker, Eval behind `?dev=1`.
- `FAKE_BOX=1` dev mode, checked with curl: healthz 200; 401 then 200 after the passcode; scan 202 then 409; every bucket in state; webhook 401 on a bad signature.
- `web/mock-state.json` generated from a fake full scan.

## In progress

- B1 Dockerfile, CI and deploy workflows, Terraform; B6 `npm run eval`.

## Blocked

- Nothing yet.
