#!/usr/bin/env python3
"""
Seed (or reset) the planted Box Tasks for the Nyanland-Meowtani demo corpus.

Reads the "files", "owners" and "tasks" sections of answer_key.json, finds each
target file by name in the Box folder, creates the task, and assigns it.

Usage:
  pip install requests
  export BOX_TOKEN=...            # developer token (Developer Console > your app > Configuration); expires after ~60 min
  export VANESSA_LOGIN=vanessa@example.com  # Vanessa's Box login
  export ZAQ_LOGIN=zaq@example.com          # Zaq's Box login
  python seed_tasks.py --plan     # offline: print what would be created, no network
  python seed_tasks.py            # create tasks + assignments
  python seed_tasks.py --reset    # DELETE every task on every file in the folder, then exit

Notes:
  - Zaq must be a collaborator on the folder (invite accepted) before his assignments will succeed.
  - The script is not idempotent: run --reset before re-seeding, or you'll get duplicate tasks.
  - If Box rejects a past due_at, the task is retried without a due date and the fallback is logged.
"""
import argparse
import json
import os
import sys

API = "https://api.box.com/2.0"


def load_key(path):
    with open(path) as f:
        return json.load(f)


def session(token):
    import requests  # imported here so --plan works without requests installed

    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return s


def check(resp, what):
    if not resp.ok:
        raise RuntimeError(f"{what} failed: HTTP {resp.status_code} {resp.text[:300]}")
    return resp.json() if resp.content else {}


def list_folder_files(s, folder_id):
    files, offset = {}, 0
    while True:
        r = check(s.get(f"{API}/folders/{folder_id}/items",
                        params={"fields": "id,name,type", "limit": 1000, "offset": offset}),
                  "list folder")
        for e in r.get("entries", []):
            if e["type"] == "file":
                files[e["name"]] = e["id"]
        offset += len(r.get("entries", []))
        if offset >= r.get("total_count", 0):
            return files


def due_at(date_str):
    # 5pm Pacific on the due date
    return f"{date_str}T17:00:00-07:00"


def create_task(s, file_id, t):
    body = {"item": {"type": "file", "id": file_id}, "action": t["action"],
            "message": t["message"], "completion_rule": "any_assignee", "due_at": due_at(t["due"])}
    r = s.post(f"{API}/tasks", json=body)
    if not r.ok and r.status_code == 400:
        body.pop("due_at")
        print(f"  ! {t['id']}: Box rejected due_at ({r.text[:120]}); retrying without due date")
        r = s.post(f"{API}/tasks", json=body)
    return check(r, f"create {t['id']}")


def assign(s, task_id, login):
    return check(s.post(f"{API}/task_assignments",
                        json={"task": {"type": "task", "id": task_id}, "assign_to": {"login": login}}),
                 f"assign task {task_id} to {login}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default="answer_key.json")
    ap.add_argument("--folder", help="override Box folder id")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--plan", action="store_true", help="print the plan; no network")
    g.add_argument("--reset", action="store_true", help="delete all tasks on files in the folder")
    args = ap.parse_args()

    key = load_key(args.key)
    folder_id = args.folder or key["box_folder"]["id"]
    logins = {"vanessa": os.environ.get("VANESSA_LOGIN"), "zaq": os.environ.get("ZAQ_LOGIN")}

    if args.plan:
        for t in key["tasks"]:
            print(f"{t['id']}: [{key['files'][t['file']]}] '{t['message']}' "
                  f"-> {t['assignee']} ({logins[t['assignee']] or 'login not set'}), due {t['due']}  # {t['expected']}")
        return

    token = os.environ.get("BOX_TOKEN")
    if not token:
        sys.exit("Set BOX_TOKEN")
    s = session(token)
    files = list_folder_files(s, folder_id)

    if args.reset:
        n = 0
        for name, fid in files.items():
            for task in check(s.get(f"{API}/files/{fid}/tasks"), f"list tasks on {name}").get("entries", []):
                check(s.delete(f"{API}/tasks/{task['id']}"), f"delete task {task['id']}")
                n += 1
        print(f"Deleted {n} task(s).")
        return

    missing = [r for r, l in logins.items() if not l]
    if missing:
        sys.exit(f"Set login env vars for: {', '.join(r.upper() + '_LOGIN' for r in missing)}")

    for t in key["tasks"]:
        fname = key["files"][t["file"]]
        if fname not in files:
            print(f"  ! {t['id']}: file not found in folder: {fname}")
            continue
        task = create_task(s, files[fname], t)
        try:
            assign(s, task["id"], logins[t["assignee"]])
            print(f"  + {t['id']} -> task {task['id']} on '{fname}', assigned {t['assignee']}")
        except RuntimeError as e:
            print(f"  ! {t['id']}: task {task['id']} created but assignment failed: {e}")


if __name__ == "__main__":
    main()
