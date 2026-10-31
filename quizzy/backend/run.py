"""Production entrypoint: python run.py

* honours $PORT (Render/Railway/Koyeb/Heroku-style) and trusts X-Forwarded-* from the platform proxy, so per-IP rate
  limits see the real client instead of one shared proxy address;
* when started as root (typical for a mounted volume) fixes ownership of the data dir once, then drops to an
  unprivileged user before serving.
Single worker by design: background jobs and rate limiting live in process memory (see docs/DEPLOY.md)."""
from __future__ import annotations

import os
import pwd


def _drop_privileges(data_dir: str) -> None:
    if os.getuid() != 0 or os.environ.get("QUIZZY_RUN_AS_ROOT") == "1":
        return
    try:
        user = pwd.getpwnam("app")
    except KeyError:
        return
    os.makedirs(data_dir, exist_ok=True)
    if os.stat(data_dir).st_uid != user.pw_uid:      # first start on a fresh root-owned volume
        for root, dirs, files in os.walk(data_dir):
            for name in [root, *[os.path.join(root, n) for n in dirs + files]]:
                try:
                    os.chown(name, user.pw_uid, user.pw_gid)
                except OSError:
                    pass
    os.setgroups([])
    os.setgid(user.pw_gid)
    os.setuid(user.pw_uid)
    os.environ["HOME"] = user.pw_dir


def main() -> None:
    data_dir = os.environ.get("QUIZZY_DATA_DIR", "/data")
    _drop_privileges(data_dir)
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8000")),
                proxy_headers=True, forwarded_allow_ips="*", workers=1, log_level=os.environ.get("QUIZZY_LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()
