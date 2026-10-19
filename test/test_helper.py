import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import predict_helper as h  # noqa: E402


SCHEMA = """
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  time_created INTEGER,
  data TEXT
);
CREATE TABLE part (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  session_id TEXT,
  time_created INTEGER,
  data TEXT
);
"""


def make_db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def add_message(conn, mid, sid, t, role, finish=None, synthetic=False, origin=None, text=None):
    data = {"role": role}
    if finish is not None:
        data["finish"] = finish
    if synthetic:
        data["synthetic"] = True
    if origin:
        data["semantics"] = {"origin": origin, "kind": "user_prompt"}
    if role == "assistant":
        data["providerId"] = "p1"
        data["modelId"] = "m1"
        data.setdefault("semantics", {"transcriptVisibility": "visible"})
    conn.execute(
        "INSERT INTO message(id, session_id, time_created, data) VALUES (?,?,?,?)",
        (mid, sid, t, json.dumps(data)),
    )
    if text is not None:
        conn.execute(
            "INSERT INTO part(id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)",
            (mid + "-part", mid, sid, t, json.dumps({"type": "text", "text": text})),
        )


class HelperTests(unittest.TestCase):
    def test_real_user_filter(self):
        self.assertTrue(h.is_real_user_message({"role": "user", "semantics": {"origin": "real_user"}}))
        self.assertFalse(
            h.is_real_user_message(
                {"role": "user", "synthetic": True, "semantics": {"origin": "agent_runtime"}}
            )
        )
        self.assertFalse(h.is_real_user_message({"role": "assistant"}))

    def test_finish_reason(self):
        self.assertEqual(h._finish_reason({"finish": "stop"}), "stop")
        self.assertEqual(h._finish_reason({"finish": {"reason": "tool-calls"}}), "tool-calls")
        self.assertEqual(h._finish_reason({}), "")

    def test_turn_status_complete(self):
        conn = make_db()
        add_message(conn, "u1", "s", 1, "user", origin="real_user", text="hello")
        add_message(conn, "a1", "s", 2, "assistant", finish="stop", text="done")
        status = h.turn_status(conn, "s")
        self.assertTrue(status["complete"])
        self.assertEqual(status["messageId"], "a1")
        self.assertEqual(status["providerId"], "p1")
        self.assertEqual(status["modelId"], "m1")

    def test_turn_status_running_on_tool_call(self):
        conn = make_db()
        add_message(conn, "u1", "s", 1, "user", origin="real_user", text="hello")
        add_message(conn, "a1", "s", 2, "assistant", finish="tool-calls", text="checking")
        add_message(conn, "a2", "s", 3, "assistant", finish=None, text="still working")
        status = h.turn_status(conn, "s")
        self.assertFalse(status["complete"])
        self.assertEqual(status["state"], "running")

    def test_synthetic_user_after_final_does_not_reset_turn(self):
        conn = make_db()
        add_message(conn, "u1", "s", 1, "user", origin="real_user", text="hello")
        add_message(conn, "a1", "s", 2, "assistant", finish="stop", text="done")
        add_message(conn, "u2", "s", 3, "user", synthetic=True, text="reminder")
        status = h.turn_status(conn, "s")
        self.assertTrue(status["complete"])
        self.assertEqual(status["messageId"], "a1")

    def test_transcript_skips_tools_and_synthetic(self):
        conn = make_db()
        add_message(conn, "u1", "s", 1, "user", origin="real_user", text="first")
        add_message(conn, "a1", "s", 2, "assistant", finish="stop", text="first answer")
        add_message(conn, "u2", "s", 3, "user", synthetic=True, text="todo reminder")
        add_message(conn, "u3", "s", 4, "user", origin="real_user", text="second")
        add_message(conn, "a2", "s", 5, "assistant", finish="tool-calls", text="checking")
        add_message(conn, "a3", "s", 6, "assistant", finish="stop", text="second answer")
        rows = h.build_transcript(conn, "s")
        self.assertEqual(
            rows,
            [
                {"role": "user", "text": "first"},
                {"role": "assistant", "text": "first answer"},
                {"role": "user", "text": "second"},
                {"role": "assistant", "text": "second answer"},
            ],
        )

    def test_normalize_url(self):
        self.assertEqual(
            h.normalize_url("http://x:1/v1", "openai-chat-completions"),
            "http://x:1/v1/chat/completions",
        )
        self.assertEqual(
            h.normalize_url("https://openrouter.ai/api", "anthropic-messages"),
            "https://openrouter.ai/api/v1/messages",
        )
        self.assertEqual(
            h.normalize_url("https://api.anthropic.com/v1/messages", "anthropic-messages"),
            "https://api.anthropic.com/v1/messages",
        )

    def test_clean_suggestion(self):
        self.assertEqual(h.clean_suggestion("SKIP", 160), "")
        self.assertEqual(h.clean_suggestion("  “帮我跑一下测试”  ", 160), "帮我跑一下测试")
        self.assertEqual(h.clean_suggestion("下一句：继续", 160), "继续")
        self.assertEqual(len(h.clean_suggestion("x" * 500, 20)), 20)

    def test_extract_openai(self):
        payload = {"choices": [{"message": {"content": " hello "}}]}
        self.assertEqual(h._extract_text(payload, "openai-chat-completions"), "hello")
        payload = {"choices": [{"message": {"content": [{"type": "text", "text": "a"}, {"text": "b"}]}}]}
        self.assertEqual(h._extract_text(payload, "openai-chat-completions"), "ab")

    def test_extract_anthropic(self):
        payload = {"content": [{"type": "text", "text": "hello "}, {"type": "tool_use"}]}
        self.assertEqual(h._extract_text(payload, "anthropic-messages"), "hello")

    def test_provider_resolution_provider_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "provider_config.json"
            path.write_text(
                json.dumps(
                    {
                        "config": {
                            "providerConfigRules": {
                                "providerRules": [
                                    {
                                        "providerId": "p1",
                                        "providerName": "Test",
                                        "config": {
                                            "access": {"apiKey": "k"},
                                            "api": {
                                                "type": "openai-chat-completions",
                                                "baseUrl": "http://localhost/v1",
                                            },
                                            "personalModelIds": ["m1"],
                                        },
                                    }
                                ]
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(h, "_provider_config_candidates", return_value=[path]):
                provider = h.resolve_provider("p1", "m1")
            self.assertEqual(provider["providerName"], "Test")
            self.assertEqual(provider["baseUrl"], "http://localhost/v1")

    def test_provider_resolution_config_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "provider": {
                            "p9": {
                                "name": "Legacy",
                                "kind": "anthropic",
                                "options": {"apiKey": "k", "baseURL": "https://x/api"},
                                "models": {"m9": {}},
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            with mock.patch.object(h, "_provider_config_candidates", return_value=[path]):
                provider = h.resolve_provider("p9", "m9")
            self.assertEqual(provider["apiType"], "anthropic-messages")
            self.assertEqual(provider["baseUrl"], "https://x/api")


if __name__ == "__main__":
    unittest.main()
