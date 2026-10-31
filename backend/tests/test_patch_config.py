"""scripts/patch_config.py: sets the relay fields of a deployed config.js, keeps everything else, and refuses anything that is not a public address / model id."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("patch_config", Path(__file__).resolve().parents[2] / "scripts" / "patch_config.py")
pc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pc)

OLD = "window.QZ_CONFIG = {\n  supabaseUrl: 'https://abc.supabase.co',\n  supabaseAnonKey: 'anon-123',\n  llm: [],\n};\n"
NEW = ("window.QZ_CONFIG = {\n  supabaseUrl: '', relayNote: 1,\n  relay: '',\n  relayModel: 'claude-opus-5-5',\n  relayRpm: 20,\n  llm: [],\n};\n")


def test_adds_missing_fields_and_keeps_the_rest():
    out = pc.patch(OLD, {"relay": "https://quizzy-ai.me.workers.dev/", "relayModel": "claude-haiku-5-5", "relayRpm": "30"})
    assert "supabaseUrl: 'https://abc.supabase.co'" in out and "supabaseAnonKey: 'anon-123'" in out and "llm: []," in out
    assert 'relay: "https://quizzy-ai.me.workers.dev",' in out and 'relayModel: "claude-haiku-5-5",' in out and "relayRpm: 30," in out


def test_replaces_existing_fields_in_place():
    out = pc.patch(NEW, {"relay": "https://r.example.workers.dev", "relayModel": "claude-sonnet-5-5"})
    assert out.count("relay:") == 1 and 'relay: "https://r.example.workers.dev",' in out and 'relayModel: "claude-sonnet-5-5",' in out and "relayRpm: 20," in out
    assert pc.patch(out, {"relay": ""}).count('relay: "",') == 1                      # switching the relay off


@pytest.mark.parametrize("key,val", [("relay", "http://insecure.example"), ("relay", "https://x.example/path/with?q=1"), ("relay", "https://x.example'; alert(1);//"), ("relay", "javascript:alert(1)"),
                                     ("relayModel", "gpt-4o"), ("relayModel", "claude-x'; evil()"), ("relayRpm", "0"), ("relayRpm", "99999"), ("llm", "[{key:'sk-ant-secret'}]"), ("apiKey", "sk-ant-secret")])
def test_refuses_anything_but_an_address_and_a_model_name(key, val):
    with pytest.raises(SystemExit):
        pc.patch(OLD, {key: val})
