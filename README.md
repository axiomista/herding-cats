# 🐈‍⬛ Herding Cats 🐈

Teams make promises in meetings and documents, then forget to put them on the to-do list. Using sweeps and webhooks, Herding Cats reads each document as it lands in a Box folder, lists every promise (who, what, by when, and the exact sentence), and checks it against the Box Tasks meant to track it.

It flags:

- **Untracked** promises nobody is tracking
- **Orphan** tasks that no document explains
- **Conflicts** where a task's owner or due date disagrees with the document
- **Superseded** tasks the plan has since cancelled or completed
- **Misfiled** tasks attached to a file that never mentions them

Every finding cites the sentence it came from. Certain fixes can be applied automatically; uncertain ones wait for a person; every change is recorded in an audit log in Box.

<img width="2588" height="1566" alt="image" src="https://github.com/user-attachments/assets/b5c545ac-254b-4b38-8e3e-85b81670ed79" />

> **Status:** Box AI hackathon project. The app runs live on Box and on AWS (ECS Express Mode, dry run, behind a passcode), and end to end against a fake Box (`FAKE_BOX=1`) for local work. See `PROGRESS.md` and `DECISIONS.md`.

## How it works

1. A **trigger** picks the files to check: a Box webhook (uploads and task changes), a sweep at startup and every 15 minutes, or a full scan on demand.
2. For each file, Box AI **classifies** the document and **extracts** commitments, decisions, ideas, open questions and status changes.
3. The code **verifies** each evidence quote against the file text and drops anything it can't find, the main guard against invented commitments.
4. Owners are mapped to Box users through `config/people.yaml`, and dates are resolved against the document date.
5. Commitments are **matched** against every task in the folder with fuzzy text similarity, then sorted into buckets.
6. **Certainty** comes from the code's checks, not from the model's opinion of itself. In apply mode, high-certainty findings are written to Box; low-certainty ones wait for review.

Box is the only data store: tasks, comments, file metadata and the audit log hold everything durable.

<img width="2770" height="1558" alt="image" src="https://github.com/user-attachments/assets/faa96c0c-dc76-4050-8cee-9918b862919e" />

## Modes

| Mode | What the app writes |
| --- | --- |
| Dry run (default) | Nothing. Findings appear on the page. |
| Apply | High-certainty tasks and comments automatically; low-certainty findings are held for review. |

The app only creates tasks and comments. It never edits or deletes existing content.

## Stack

- TypeScript on Node.js 22 with Express
- [`box-node-sdk`](https://github.com/box/box-node-sdk) v4, authenticating as a service account via Client Credentials Grant
- Box AI for classification and extraction
- One static page, no front-end framework
- AWS: one container on Amazon ECS Express Mode in `us-west-2`, defined in Terraform; secrets in AWS Secrets Manager
- GitHub Actions for CI and deploys (OIDC, no stored keys)

## Getting started

Requires Node.js 22 and a Box Platform app using Client Credentials Grant.

```sh
npm install
cp .env.example .env   # fill in Box credentials and folder IDs
npm run dev            # http://localhost:3000
```

To try it with no Box account, run on the seed documents and recorded fixtures:

```sh
npm run build
FAKE_BOX=1 DEMO_PASSCODE=meow npm start   # open http://localhost:3000, passcode "meow"; add ?dev=1 for Eval
```

| Command | Does |
| --- | --- |
| `npm run dev` | Server with reload; browser script in watch mode |
| `npm run build` | Compile server and browser script to `dist/` |
| `npm start` | Run `dist/server.js` |
| `npm run typecheck` | Type-check everything |
| `npm test` | Unit and replay tests; never calls Box AI |
| `npm run eval` | Scan the live folder and score it against the answer key |

## Configuration

| Variable | Purpose |
| --- | --- |
| `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`, `BOX_ENTERPRISE_ID` | Box CCG credentials |
| `BOX_SCAN_FOLDER_ID` | Folder to watch |
| `BOX_AUDIT_FOLDER_ID` | Folder for audit files; must not be inside the scan folder |
| `BOX_WEBHOOK_PRIMARY_KEY`, `BOX_WEBHOOK_SECONDARY_KEY` | Webhook signature keys |
| `MODE` | `dry-run` (default) or `apply` |
| `SWEEP_INTERVAL_MINUTES` | Default `15` |
| `SWEEPS_ENABLED` | Default `true`; `false` turns off the startup and timed sweeps (webhooks and Scan now still run). On AWS it is set by the Terraform variable `sweeps_enabled`, not the secret |
| `ORG_NAME` | Organization name used in the extraction prompt |
| `DEMO_PASSCODE`, `SESSION_SECRET` | Page access |
| `PORT` | Default `3000` |

Locally these live in `.env` (git-ignored). On AWS they come from the `herding-cats/env` secret.

## Repo layout

```text
src/          server, config, Box client, engine (cycle steps), triggers, trackers
web/          static page
prompts/      versioned extraction prompts
config/       people.yaml (names in documents -> Box user IDs)
seed/         answer key, seed documents, task seed script
test/         unit and replay tests, recorded fixtures
infra/        Terraform
```
