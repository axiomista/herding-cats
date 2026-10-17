# Progress

Overnight offline build on branch `overnight/build` (not pushed). Source of truth: `project-plan/herding-cats-spec.md`, built in the order of `project-plan/work-breakdown.md`. Deviations are in `DECISIONS.md`.

## Done

- **Step 0 contracts:** `src/types.ts`, `src/box.ts` (`BoxGateway` plus the real CCG gateway on `box-node-sdk` 4.18 `sdk-gen`; it typechecks and was never called), `src/config.ts`.
- **A1 to A6 engine:** extract (prompt v1 with one retry on invalid JSON), verify, normalize, match, certainty, apply, `runCycle`; `src/trackers/box-tasks.ts`; `config/people.yaml`.
- **Seed data and fixtures:** `seed/` holds the answer key, `seed_tasks.py` and the 7 seed docs. `test/fixtures/v1/` holds 7 hand-written fixtures: an invalid-JSON first reply (kickoff), paraphrased evidence (sync01), an idea mislabeled as a commitment (brainstorm), and "I" as an email owner.
- **Tests:** 80 passing. Unit tests cover verify, normalize, match, certainty, audit (byte for byte against the spec's sample) and webhook signatures (valid primary, valid secondary, bad, stale). The replay test checks:
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

- **Live:** `https://he-000852457d22485680a02826503b39ed.ecs.us-west-2.on.aws` (ECS Express, 1 task, dry run). `/healthz` 200, page 200, `/api/state` 401 without the passcode. The container reached Box at startup and its first sweep logged no errors.

- Image `herding-cats:b5aa1c36b36e8f1309ab43208bc9bd5c0d74efcb` pushed to ECR (linux/amd64).
- A fresh account creates ECS's service-linked roles on first use (`AWSServiceRoleForECS`, `AWSServiceRoleForElasticLoadBalancing`, `AWSServiceRoleForApplicationAutoScaling_ECSService`), and the first calls fail while the roles propagate. All three exist now, so later deploys are not affected.
- The `herding-cats/env` secret must be key/value JSON with the exact key names; a malformed key name stopped every task ("did not contain json key BOX_CLIENT_ID"), and the circuit breaker failed the deployment.
- The Express endpoint already includes `https://`; `service_url` now adds the scheme only if it is missing. Secret entries are sorted to match what ECS returns, so plans show no reordering diff.

## Next: needs Box credentials

1. Record live fixtures to a separate folder (for example `npm run eval -- --record` writing to `test/fixtures/v1-live/`), so the hand-written guard fixtures in `test/fixtures/v1/` are kept.
2. Untested live: global/properties metadata writes, `extracted_text` on a non-text file, assigning to people by user ID through the app.
3. Create the webhook on the scan folder (`FILE.UPLOADED`, `TASK_ASSIGNMENT.CREATED`, `TASK_ASSIGNMENT.UPDATED`) once the AWS URL exists, and put both signature keys in the secret.
4. To reset the demo: `seed_tasks.py --reset`, then re-seed. Box rejects past due dates, so move T2, T4, T5 and T7's dates forward in the answer key if they matter.

## Next: needs AWS credentials

1. In GitHub, create the `production` environment and the repository variables `AWS_DEPLOY_ROLE_ARN` (`arn:aws:iam::233436818035:role/herding-cats-deploy`) and `TF_STATE_BUCKET` (`herding-cats-tfstate-233436818035`). Then open the PR; merging deploys from `main`.
2. Create the Box webhook pointing at `<service_url>/webhooks/box`, then put its two signature keys in the secret and redeploy.
3. Narrow the deploy role's `ManageStack` permissions once the stack is stable.
4. Point `AWS_PROFILE` (and the AWS MCP server) at the `herding-cats` IAM profile instead of root.
