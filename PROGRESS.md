# Progress

Overnight offline build on branch `overnight/build`, now pushed: PR #1 is open and CI (`build`) passes on it. Source of truth: `project-plan/herding-cats-spec.md`, built in the order of `project-plan/work-breakdown.md`. Deviations are in `DECISIONS.md`.

## Done

- **Step 0 contracts:** `src/types.ts`, `src/box.ts` (`BoxGateway` plus the real CCG gateway on `box-node-sdk` 4.18 `sdk-gen`; it typechecks and was never called), `src/config.ts`.
- **A1 to A6 engine:** extract (prompt v1 with one retry on invalid JSON), verify, normalize, match, certainty, apply, `runCycle`; `src/trackers/box-tasks.ts`; `config/people.yaml`.
- **Seed data and fixtures:** `seed/` holds the answer key, `seed_tasks.py` and the 7 seed docs. `test/fixtures/v1/` holds 7 hand-written fixtures: an invalid-JSON first reply (kickoff), paraphrased evidence (sync01), an idea mislabeled as a commitment (brainstorm), and "I" as an email owner.
- **Tests:** 88 passing. Unit tests cover verify, normalize, match, certainty, audit (byte for byte against the spec's sample) and webhook signatures (valid primary, valid secondary, bad, stale). The replay test checks:
  - recall 9/9, with C01 counted once;
  - 1 false positive;
  - T1 to T7 in their expected buckets;
  - C03, C07 and C09 untracked;
  - dry run makes zero writes;
  - apply mode makes exactly 3 tasks and 3 comments, with an APPLIED entry for each, 3 HELD entries, and metadata written last;
  - a second run makes no duplicates;
  - a sweep makes 0 AI calls, including after a restart;
  - a new version rescans only that file;
  - an edit turns a task into an orphan.
- **B2 to B5:** every spec route; the passcode session; 409 while a cycle runs; webhook (signature, dedupe, own-event skip, queue); sweep and full scan; the page (passcode, status, findings by bucket with low certainty first, set aside, audit, Eval behind `?dev=1`).
- **`FAKE_BOX=1` (new):** checked with curl: healthz 200; 401, then 200 after the passcode; scan 202, then 409; every bucket in state; webhook 401 on a bad signature. The page was also checked in jsdom: sign-in, every bucket, Eval 9/9, a click that creates a task and writes its audit entry, and no script errors. The Chrome extension was not connected, so there is no screenshot.
- **B6:** `npm run eval` (`-- --record`) and `scripts/probe.ts`. Both typecheck; neither was run.
- **B1:** two-stage non-root `Dockerfile` (`docker build` succeeded), `ci.yml`, `deploy.yml` (OIDC), and Terraform on ECS Express Mode (`terraform validate` passed with hashicorp/aws 6.69.1).

## In progress

- Nothing.

## Blocked

- Nothing offline. Everything below needs credentials.

## Done with live Box (2026-10-17)

- Read and write probes all pass. The service account is `AutomationUser_2709912_hyMwcfM52f@boxdevedition.com` (`53096331749`); the classify model is `google__gemini_3_1_flash_lite`.
- `seed_tasks.py` created T1 to T7 (`44009257737` to `44009271657`). Box rejected the past due dates on T2, T4, T5 and T7, so those tasks have none.
- `config/people.yaml` now has Zaq's ID, `53093111490`, read from the folder's collaborators.
- `createTask` now retries without a due date that Box rejects.

- Live dry-run eval (after the restatement fix): recall 9/9, 0 false positives, T1 to T7 correct, C03/C07/C09 untracked, 16 seconds, 15 AI calls.

## Done with live AWS (2026-10-17)

- A non-root CLI profile, `herding-cats`, signs in as `arn:aws:iam::233436818035:user/vanessa` (the `admin` group, with `AdministratorAccess`). The `vanessa` profile and `AWS_PROFILE` in `~/.zshrc` still point at root, and so does the AWS MCP server; run AWS writes with `--profile herding-cats`.
- Terraform state bucket `herding-cats-tfstate-233436818035` (us-west-2): versioning on, SSE-S3, public access blocked, TLS-only policy.
- `terraform init` against that bucket. First-pass plan: 15 resources (ECR, KMS key and alias, empty secret, log group, execution/task/infrastructure roles, GitHub OIDC provider, deploy role); no changes or destroys. Nothing in the plan exists in the account yet.
- Confirmed the managed policy `AmazonECSInfrastructureRoleforExpressGatewayServices` exists (v6).
- First-pass apply done: 15 added, 0 changed, 0 destroyed. Outputs:
  - `deploy_role_arn`: `arn:aws:iam::233436818035:role/herding-cats-deploy`
  - `ecr_repository_url`: `233436818035.dkr.ecr.us-west-2.amazonaws.com/herding-cats`
  - `secret_arn`: `arn:aws:secretsmanager:us-west-2:233436818035:secret:herding-cats/env-Kyj8DE` (empty until set by hand)

## First deploy notes (2026-10-17)

- **Live:** the URL is the `service_url` Terraform output (ECS Express, 1 task, dry run); it is kept out of the repo. Deployed by hand, not yet through `deploy.yml`. `/healthz` 200, page 200, `/api/state` 401 without the passcode. The container reached Box at startup and its first sweep logged no errors.

- Image `herding-cats:b5aa1c36b36e8f1309ab43208bc9bd5c0d74efcb` pushed to ECR (linux/amd64). The running service predates the Terraform fixes in `c31c198`; the first pipeline deploy picks them up.
- A fresh account creates ECS's service-linked roles on first use (`AWSServiceRoleForECS`, `AWSServiceRoleForElasticLoadBalancing`, `AWSServiceRoleForApplicationAutoScaling_ECSService`), and the first calls fail while the roles propagate. All three exist now, so later deploys are not affected.
- The `herding-cats/env` secret must be key/value JSON with the exact key names; a malformed key name stopped every task ("did not contain json key BOX_CLIENT_ID"), and the circuit breaker failed the deployment.
- The Express endpoint already includes `https://`; `service_url` now adds the scheme only if it is missing. Secret entries are sorted to match what ECS returns, so plans show no reordering diff.
- Pipeline deploys (2026-10-17): the first `deploy.yml` run could not assume the deploy role because this repo's OIDC tokens use GitHub's immutable subject (`repo:axiomista@17440089/herding-cats@1423070714:...`); #5 fixed the trust, applied once by hand since the pipeline could not sign in to change it. A cancelled run then left a stale state lock (released with `terraform force-unlock`) and an already-pushed image tag; ECR tags are immutable, so `deploy.yml` now skips the build and push when the commit's image exists, and a re-run goes straight to Terraform. Don't cancel a run during `Terraform apply`: the service update may already have started, and state falls behind AWS until the next apply.

## Done after the review (2026-10-17, not committed)

- `scripts/reset.ts` (new): the demo reset for comments and metadata; see Box step 4 below.
- The page's AI stat now reads "AI calls since start": the count is in memory and resets on restart (DECISIONS #27).
- README status says the app runs live on Box and AWS.
- Public-repo hardening: wrong passcodes are limited to 10 per IP per 15 minutes (429 after that); personal email addresses are gone from the repo and its history; the live URL is no longer in this file. Still to do by hand: set a long random `DEMO_PASSCODE` in the secret and redeploy.

## Corpus date shift (2026-10-17)

- Box rejects past due dates, and by the demo most seed due dates had passed. Document dates moved 13 days and due dates 21 days (DECISIONS #28). Four seed files were renamed for their new dates; the answer key, the guard fixtures, the tests that read the seed docs and `web/mock-state.json` were updated to match. Fake-Box eval is unchanged: recall 9/9, 1 false positive (the brainstorm guard fixture), T1 to T7 correct.
- **Box needs the new files.** In The Corporation, replace the four renamed files and the brainstorm and email files with the versions in `seed/docs/`, then `seed_tasks.py --reset`, `npx tsx scripts/reset.ts -- --yes`, and `seed_tasks.py`. Re-run the live dry-run eval afterwards (about 15 AI calls).
- Done: the six files were uploaded as new versions of the same Box files (IDs kept, the four dated ones renamed; SHA-1 matches `seed/docs/`), `reset.ts` found nothing to remove, the tasks were reset and re-seeded with every due date.
- Live dry-run eval after the re-seed: recall 9/9, 0 false positives, 6 of 7 tasks. T4 came out matched: the model labeled the box order's cancellation a decision, which the cycle set aside. Fixed (DECISIONS #29); the live re-run gives 7 of 7, with T4 superseded at low certainty (status match 83), so apply mode holds its comment for a click.

## Next: needs Box credentials

1. Record live fixtures to a separate folder (for example `test/fixtures/v1-live/`), so the hand-written guard fixtures in `test/fixtures/v1/` are kept. `scripts/eval.ts` always writes to `test/fixtures/<prompt version>/` today, so it needs an output-directory option first; running `--record` now would overwrite the guard fixtures.
2. Untested live: global/properties metadata writes, `extracted_text` on a non-text file, assigning to people by user ID through the app.
3. The webhook on the scan folder is created, but no event has been tested. Confirm both signature keys are in the secret and the task has restarted since, then check that an upload produces a finding in under a minute, a new version rescans only that file, and a task assignment queues its file.
4. To reset the demo: `seed_tasks.py --reset` (deletes every task in the folder, including the app's), then `npx tsx scripts/reset.ts -- --yes` (deletes the app's comments and `hc*` metadata), then re-seed. Run `reset.ts` without `--yes` first to see what it would remove. Without it, the fingerprint check skips every comment on the next apply-mode run, so a rehearsal would leave the demo with no new comments. `reset.ts` typechecks but has not been run against live Box. The corpus dates were shifted forward on 2026-10-17 (DECISIONS #28), so every planted task gets its due date; the Box folder's seed files must be replaced with the renamed ones first (see the corpus date shift below).

## Next: needs AWS credentials

1. Merge PR #1; merging deploys from `main`. The GitHub `production` environment and its variables `AWS_DEPLOY_ROLE_ARN` and `TF_STATE_BUCKET` are already set (as environment variables, which `deploy.yml` reads through `environment: production`).
2. Run the gate checklist on AWS: a full scan from the live page in under 90 seconds, and Score under `?dev=1`. The live eval above ran from a laptop.
3. Restart check: in dry run, scan markers live only in memory (DECISIONS #10), so a dry-run restart rescans every file. The 0-AI-call restart check holds only after apply mode has written markers to Box.
4. The deploy role no longer has IAM write actions, so changes to roles or policies in `infra/iam.tf` must be applied by an admin (`--profile herding-cats`) before `deploy.yml` can apply. The first deploy after this change can still apply it, because the old policy allows it.
5. Point `AWS_PROFILE` (and the AWS MCP server) at the `herding-cats` IAM profile instead of root.
