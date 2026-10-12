"""Generate a runner-only config targeting existing resources, never create a DB."""
import json
import os
import re
from pathlib import Path


def main():
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    database = os.environ.get("CLOUDFLARE_D1_DATABASE_ID", "")
    worker = os.environ.get("CLOUDFLARE_WORKER_NAME", "")
    if not re.fullmatch(r"[a-fA-F0-9]{32}", account):
        raise SystemExit("Set CLOUDFLARE_ACCOUNT_ID to the existing account ID")
    if not re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", database):
        raise SystemExit("Set CLOUDFLARE_D1_DATABASE_ID to the existing D1 UUID")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", worker):
        raise SystemExit("Set CLOUDFLARE_WORKER_NAME to the existing Worker name")
    # wrangler.jsonc intentionally uses the JSON subset of JSONC.
    config = json.loads(Path("wrangler.jsonc").read_text())
    config["account_id"] = account
    config["name"] = worker
    databases = config["d1_databases"]
    if len(databases) != 1 or databases[0]["binding"] != "DB":
        raise SystemExit("Expected exactly one D1 binding named DB")
    databases[0]["database_id"] = database
    Path(".release-wrangler.json").write_text(json.dumps(config, indent=2) + "\n")


if __name__ == "__main__":
    main()
