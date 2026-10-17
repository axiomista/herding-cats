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

## Next: needs Box credentials

1. Invite the service account (`AutomationUser_…@boxdevedition.com`) as Editor on The Corporation (`428423214478`) and Herding Cats Audit (`428424620757`). Zaq accepts his invitation.
2. Replace `REPLACE_WITH_ZAQ_BOX_USER_ID` in `config/people.yaml` with Zaq's Box user ID.
3. Create `.env` from `.env.example`.
4. Run `npx tsx scripts/probe.ts`, then `-- --write`. These calls have never run against live Box:
   - classify field types `enum` and `date`;
   - the `extracted_text` representation URL;
   - global/properties metadata create or update (JSON Patch `add`);
   - the `uploadFile` response shape;
   - the task `dueAt` round trip.
   Note the AI units each call uses.
5. Run `seed/seed_tasks.py` (from `seed/`, with `BOX_TOKEN`, `VANESSA_LOGIN` and `ZAQ_LOGIN`).
6. Run `npm run eval`. It runs in dry run and scores live results. Before recording with `-- --record`, decide where recordings go. The replay test's guard checks (paraphrase, mislabel, retry) assert on the hand-written fixtures in `test/fixtures/v1/`, and recording would overwrite them. Either record to a separate folder or keep the hand-written set for the guard test.
7. Create the webhook on the scan folder (`FILE.UPLOADED`, `TASK_ASSIGNMENT.CREATED`, `TASK_ASSIGNMENT.UPDATED`) once the AWS URL exists, and put both signature keys in the secret.

## Next: needs AWS credentials

1. Use a non-root IAM identity; the CLI is currently signed in as root.
2. Create the Terraform state bucket by hand (name it `*-tfstate*` to match the deploy role's S3 permission).
3. Run the first `terraform apply` locally. It creates the OIDC deploy role that `deploy.yml` needs, so it can't come from CI. Then set the `herding-cats/env` secret's JSON values by hand in the console.
4. In GitHub, create the `production` environment and the repository variables `AWS_DEPLOY_ROLE_ARN` and `TF_STATE_BUCKET`.
5. Check during the first apply:
   - the managed policy name `AmazonECSInfrastructureRoleforExpressGatewayServices`;
   - whether `ingress_paths[0].endpoint` already includes `https://` (the `service_url` output adds it);
   - that the container starts with the secret injected.
6. Narrow the deploy role's `ManageStack` permissions once the stack is stable.
