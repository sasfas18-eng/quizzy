#!/usr/bin/env python3
"""Set the PUBLIC fields of a site's config.js WITHOUT touching anything else in it.

    python3 scripts/patch_config.py <config.js> chromeAiToken=<a Chrome origin-trial token for the site's address>
    python3 scripts/patch_config.py <config.js> supabaseUrl=https://abcd.supabase.co supabaseAnonKey=eyJ...      (accounts: the project's URL and its PUBLIC anon / publishable key)
    python3 scripts/patch_config.py --carry <old config.js> <new config.js>     (deploy: the new template keeps the old file's public values and nothing else)

Only these fields are accepted and each is validated (an https address with no path; a Supabase PUBLIC key; an origin-trial token) so nothing but public values can ever be written.
Empty (`supabaseUrl=`, `chromeAiToken=`) switches the thing off. A secret never goes in here: the Supabase key must be the `anon` / publishable one - a `service_role` or `sb_secret_` key (which would hand the
whole database to every visitor of a static site) is REFUSED, and a refused value is never printed."""
import base64
import json
import re
import sys

HTTPS_ADDRESS = r"https://[A-Za-z0-9.-]+(:\d{2,5})?/?"


def jwt_role(token: str):
    """the `role` claim of a Supabase JWT key ("anon", "service_role"...), or None when it is not a readable JWT"""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    except Exception:
        return None
    return payload.get("role") if isinstance(payload, dict) else None


def public_supabase_key(v: str) -> bool:
    """empty (off), a publishable key (sb_publishable_...) or an anon JWT - never a service_role / secret key"""
    if v == "":
        return True
    if re.fullmatch(r"sb_publishable_[A-Za-z0-9_-]{16,200}", v):
        return True
    return len(v) < 2000 and re.fullmatch(r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", v) is not None and jwt_role(v) == "anon"


SECRET_FIELDS = {"supabaseAnonKey"}          # a value that was refused (or applied) is never echoed
RULES = {
    "chromeAiToken": (lambda v: v == "" or re.fullmatch(r"[A-Za-z0-9+/=]{40,4000}", v) is not None, str),      # a Chrome origin-trial token (public by nature)
    "supabaseUrl": (lambda v: v == "" or re.fullmatch(HTTPS_ADDRESS, v) is not None, str),
    "supabaseAnonKey": (public_supabase_key, str),
}


def patch(text: str, updates: dict) -> str:
    for key, raw in updates.items():
        if key not in RULES:
            raise SystemExit(f"unknown field: {key} (allowed: {', '.join(RULES)})")
        ok, cast = RULES[key]
        if not ok(raw):
            if key in SECRET_FIELDS:
                raise SystemExit(f"refusing {key}: it must be the project's PUBLIC key (anon JWT or sb_publishable_...). A service_role / secret key is never allowed in a public site.")
            raise SystemExit(f"refusing {key}={raw!r}: not a valid value")
        value = json.dumps(cast(raw).rstrip("/") if cast is str and key == "supabaseUrl" else cast(raw))
        line = re.compile(rf"^([ \t]*){key}[ \t]*:[^\n]*$", re.M)
        if line.search(text):
            text = line.sub(lambda m: f"{m.group(1)}{key}: {value},", text, count=1)
        else:
            head = re.search(r"window\.QZ_CONFIG\s*=\s*\{[ \t]*\n", text)
            if not head:
                raise SystemExit("config.js has no `window.QZ_CONFIG = {` block to extend")
            text = text[: head.end()] + f"  {key}: {value},\n" + text[head.end():]
    return text


def carry(old: str, template: str) -> str:
    """the new template with the OLD config's values of the public fields only (anything else in the old file - fields that no longer exist - is left behind).
    A value that does not pass its check is not carried (the template's empty value stays) and is never printed."""
    updates = {}
    for key in RULES:
        m = re.search(rf"^[ \t]*{key}[ \t]*:[ \t]*(['\"])(.*?)\1", old, re.M)
        if m and m.group(2) and RULES[key][0](m.group(2)):
            updates[key] = m.group(2)
    return patch(template, updates)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--carry":
        with open(sys.argv[2], encoding="utf-8") as f:
            old_text = f.read()
        with open(sys.argv[3], encoding="utf-8") as f:
            new_text = carry(old_text, f.read())
        with open(sys.argv[3], "w", encoding="utf-8") as f:
            f.write(new_text)
        print("config.js: the public values were carried into the new template")
        raise SystemExit(0)
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    path = sys.argv[1]
    updates = dict(a.split("=", 1) for a in sys.argv[2:])
    with open(path, encoding="utf-8") as f:
        src = f.read()
    with open(path, "w", encoding="utf-8") as f:
        f.write(patch(src, updates))
    print("config.js updated:", ", ".join(f"{k}=…{v[-4:]}" if k in SECRET_FIELDS and v else f"{k}={v}" for k, v in updates.items()))
