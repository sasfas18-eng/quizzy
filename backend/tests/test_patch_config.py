"""scripts/patch_config.py: sets the PUBLIC fields of a deployed config.js (the Supabase URL and its public key, the Chrome origin-trial token), keeps everything else, and refuses anything that is not public."""
import base64
import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("patch_config", Path(__file__).resolve().parents[2] / "scripts" / "patch_config.py")
pc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pc)

OLD = "window.QZ_CONFIG = {\n  supabaseUrl: 'https://abc.supabase.co',\n  supabaseAnonKey: 'anon-123',\n  llm: [],\n};\n"
NEW = ("window.QZ_CONFIG = {\n  supabaseUrl: '', otherNote: 1,\n  chromeAiToken: '',\n  keepMe: 20,\n  llm: [],\n};\n")
TOKEN = "A" * 30 + "b+c/d" * 10 + "=="


def test_adds_missing_fields_and_keeps_the_rest():
    out = pc.patch(OLD, {"chromeAiToken": TOKEN})
    assert "supabaseUrl: 'https://abc.supabase.co'" in out and "supabaseAnonKey: 'anon-123'" in out and "llm: []," in out
    assert f'chromeAiToken: "{TOKEN}",' in out


def test_replaces_existing_fields_in_place():
    out = pc.patch(NEW, {"chromeAiToken": TOKEN})
    assert out.count("chromeAiToken:") == 1 and f'chromeAiToken: "{TOKEN}",' in out and "keepMe: 20," in out
    assert pc.patch(out, {"chromeAiToken": ""}).count('chromeAiToken: "",') == 1      # switching the token off


@pytest.mark.parametrize("key,val", [("chromeAiToken", "short"), ("chromeAiToken", "x'; alert(1);//" * 4), ("chromeAiToken", "<script>" * 10),
                                     ("relay", "http://quizzy-ai.me.workers.dev"), ("relay", "https://quizzy-ai.me.workers.dev/v1"), ("relay", "javascript:alert(1)"),
                                     ("relayModel", "bad model!"), ("relayModel", "x"), ("llm", "[{key:'sk-ant-secret'}]"), ("apiKey", "sk-ant-secret")])
def test_refuses_anything_but_the_public_fields(key, val):
    with pytest.raises(SystemExit):
        pc.patch(OLD, {key: val})


def test_the_ai_relay_address_and_model_are_public_and_accepted():
    out = pc.patch(NEW, {"relay": "https://quizzy-ai.me.workers.dev", "relayModel": "gemini-2.0-flash"})
    assert 'relay: "https://quizzy-ai.me.workers.dev",' in out and 'relayModel: "gemini-2.0-flash",' in out and "keepMe: 20," in out
    assert 'relay: "",' in pc.patch(out, {"relay": ""}), "empty switches the AI relay off (every quiz is then built locally)"


def _jwt(role, ref="abcd"):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return enc({"alg": "HS256", "typ": "JWT"}) + "." + enc({"iss": "supabase", "ref": ref, "role": role}) + "." + "s" * 43


def test_the_supabase_url_and_the_public_key_are_set_and_the_rest_is_kept():
    out = pc.patch(NEW, {"supabaseUrl": "https://abcd.supabase.co/", "supabaseAnonKey": _jwt("anon")})
    assert 'supabaseUrl: "https://abcd.supabase.co",' in out and f'supabaseAnonKey: "{_jwt("anon")}",' in out, "the trailing slash goes, both are written"
    assert "keepMe: 20," in out and "llm: []," in out and out.count("supabaseUrl:") == 1
    out = pc.patch(OLD, {"supabaseAnonKey": "sb_publishable_" + "A1b2C3d4" * 3})
    assert 'supabaseAnonKey: "sb_publishable_' in out and "supabaseUrl: 'https://abc.supabase.co'" in out
    assert 'supabaseUrl: "",' in pc.patch(OLD, {"supabaseUrl": ""}) and 'supabaseAnonKey: "",' in pc.patch(OLD, {"supabaseAnonKey": ""}), "empty switches accounts off"


@pytest.mark.parametrize("secret", [_jwt("service_role"), _jwt("authenticated"), _jwt(None), "sb_secret_" + "a" * 30, "not-a-key", "eyJ.eyJ.sig", _jwt("anon") + "." + "x" * 10, "a" * 3000])
def test_a_secret_or_unreadable_key_is_refused_and_never_echoed(secret, capsys):
    with pytest.raises(SystemExit) as e:
        pc.patch(OLD, {"supabaseAnonKey": secret})
    assert secret not in str(e.value) and "PUBLIC" in str(e.value), "the refusal says why and never prints the value (it could be a secret)"


@pytest.mark.parametrize("url", ["http://abcd.supabase.co", "https://abcd.supabase.co/rest/v1", "https://abcd.supabase.co'; alert(1);//", "javascript:alert(1)", "abcd.supabase.co"])
def test_the_supabase_url_must_be_a_plain_https_address(url):
    with pytest.raises(SystemExit):
        pc.patch(OLD, {"supabaseUrl": url})


def test_the_cli_prints_a_secret_field_only_as_its_last_characters(tmp_path, capsys, monkeypatch):
    cfg = tmp_path / "config.js"
    cfg.write_text(OLD)
    key = _jwt("anon")
    monkeypatch.setattr("sys.argv", ["patch_config.py", str(cfg), "supabaseUrl=https://abcd.supabase.co", f"supabaseAnonKey={key}"])
    runpy = importlib.util.spec_from_file_location("__main__", Path(pc.__file__))
    mod = importlib.util.module_from_spec(runpy)
    runpy.loader.exec_module(mod)
    out = capsys.readouterr().out
    assert "supabaseUrl=https://abcd.supabase.co" in out and key not in out and "supabaseAnonKey=…" in out
    assert key in cfg.read_text()


def test_a_deploy_carries_only_the_public_values_into_the_new_template():
    template = (Path(__file__).resolve().parents[2] / "static-edition" / "config.js").read_text()
    old = ("window.QZ_CONFIG = {\n  supabaseUrl: 'https://abcd.supabase.co',\n  supabaseAnonKey: \"" + _jwt("anon") + "\",\n"
           "  relay: 'https://quizzy-ai.me.workers.dev',\n  relayModel: 'gemini-2.0-flash',\n  relayRpm: 20,\n  llm: [{ key: 'AIza-secret' }],\n};\n")
    out = pc.carry(old, template)
    assert 'supabaseUrl: "https://abcd.supabase.co",' in out and f'supabaseAnonKey: "{_jwt("anon")}",' in out, "the accounts keep working"
    assert 'relay: "https://quizzy-ai.me.workers.dev",' in out and 'relayModel: "gemini-2.0-flash",' in out, "the AI relay address + model (public) carry over"
    assert "relayRpm" not in out and "AIza-secret" not in out and "llm" not in out, "nothing that could hold a key is carried"
    assert "chromeAiToken: ''," in out, "the new field is there, empty"
    bad = old.replace(_jwt("anon"), _jwt("service_role"))
    assert _jwt("service_role") not in pc.carry(bad, template) and "supabaseAnonKey: ''," in pc.carry(bad, template), "a value that fails its check is not carried"
