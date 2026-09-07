"""Unit tests for the wpp CLI. Standard library only, like the CLI itself.

Run from the repository root:  python3 -m unittest discover -s tests/cli -t .
"""

import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
CLI_PATH = REPO_ROOT / "wpp"


def load_cli(config_path):
    """Import ./wpp as a module with WPP_CONFIG pointed at a scratch file."""
    os.environ["WPP_CONFIG"] = str(config_path)
    spec = importlib.util.spec_from_loader(
        "wpp_cli", importlib.machinery.SourceFileLoader("wpp_cli", str(CLI_PATH))
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config_path = Path(self.tmp.name) / "wpp" / "config.json"
        self.cli = load_cli(self.config_path)


class TestPhoneParsing(CliTestCase):
    def test_accepts_common_number_formats(self):
        for value in ("+971501234567", "971501234567", "+971 50 123-4567", "(971) 501234567"):
            self.assertEqual(
                self.cli.phone_to_jid(value),
                "971501234567@s.whatsapp.net",
                msg=value,
            )

    def test_rejects_non_numbers(self):
        for value in ("Mum", "", "12", "not a number", "+"):
            self.assertIsNone(self.cli.phone_to_jid(value), msg=repr(value))


class TestUrlNormalisation(CliTestCase):
    def test_strips_trailing_slash(self):
        self.assertEqual(self.cli.normalize_url("http://example.com:3300/"), "http://example.com:3300")

    def test_rejects_bad_urls(self):
        for value in ("example.com:3300", "ftp://host", "http://host/path", "http://host?q=1", ""):
            with self.assertRaises(self.cli.WppError, msg=repr(value)):
                self.cli.normalize_url(value)


class TestConfigStore(CliTestCase):
    def test_missing_config_is_not_an_error_unless_required(self):
        self.assertEqual(self.cli.load_config()["profiles"], {})
        with self.assertRaises(self.cli.WppError) as ctx:
            self.cli.load_config(required=True)
        self.assertEqual(ctx.exception.code, "NOT_CONNECTED")

    def test_saved_config_is_owner_only(self):
        self.cli.save_config({"version": 1, "current": "default", "profiles": {"default": {"url": "http://x:1"}}})
        mode = stat.S_IMODE(self.config_path.stat().st_mode)
        self.assertEqual(mode, 0o600, "API tokens must not be world- or group-readable")
        self.assertEqual(self.cli.load_config()["current"], "default")

    def test_corrupt_config_reports_clearly(self):
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        self.config_path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(self.cli.WppError) as ctx:
            self.cli.load_config()
        self.assertEqual(ctx.exception.code, "BAD_CONFIG")


class TestPersonalRouting(CliTestCase):
    def test_matches_personal_numbers_regardless_of_formatting(self):
        profile = {"personal_numbers": ["+15555550100", "15555550101"]}
        self.assertTrue(self.cli.is_personal(profile, "15555550100@s.whatsapp.net"))
        self.assertTrue(self.cli.is_personal(profile, "15555550101@s.whatsapp.net"))
        self.assertFalse(self.cli.is_personal(profile, "15555550199@s.whatsapp.net"))

    def test_no_cached_numbers_means_not_personal(self):
        self.assertFalse(self.cli.is_personal({}, "15555550100@s.whatsapp.net"))


class TestTargetResolution(CliTestCase):
    def setUp(self):
        super().setUp()
        self.profile = {"url": "http://server:3300", "key": "sk_test"}

    def test_jid_and_number_resolve_without_a_network_call(self):
        with mock.patch.object(self.cli, "api_call", side_effect=AssertionError("should not call the API")):
            self.assertEqual(
                self.cli.resolve_target(self.profile, "1203630001@g.us")["jid"], "1203630001@g.us"
            )
            self.assertEqual(
                self.cli.resolve_target(self.profile, "+971501234567")["jid"],
                "971501234567@s.whatsapp.net",
            )

    def test_name_resolves_via_channel_search(self):
        with mock.patch.object(self.cli, "api_call", return_value=[
            {"jid": "1203630001@g.us", "display_name": "Family", "type": "group"},
        ]):
            resolved = self.cli.resolve_target(self.profile, "Family")
        self.assertEqual(resolved["jid"], "1203630001@g.us")
        self.assertEqual(resolved["matched_by"], "name")

    def test_exact_name_wins_over_partial_matches(self):
        with mock.patch.object(self.cli, "api_call", return_value=[
            {"jid": "a@g.us", "display_name": "Family Trip", "type": "group"},
            {"jid": "b@g.us", "display_name": "Family", "type": "group"},
        ]):
            self.assertEqual(self.cli.resolve_target(self.profile, "family")["jid"], "b@g.us")

    def test_ambiguous_name_refuses_rather_than_guessing(self):
        with mock.patch.object(self.cli, "api_call", return_value=[
            {"jid": "a@g.us", "display_name": "Work Team", "type": "group"},
            {"jid": "b@g.us", "display_name": "Work Social", "type": "group"},
        ]):
            with self.assertRaises(self.cli.WppError) as ctx:
                self.cli.resolve_target(self.profile, "Work")
        self.assertEqual(ctx.exception.code, "AMBIGUOUS_TARGET")
        self.assertEqual(len(ctx.exception.details["candidates"]), 2)

    def test_unknown_name_is_a_clear_error(self):
        with mock.patch.object(self.cli, "api_call", return_value=[]):
            with self.assertRaises(self.cli.WppError) as ctx:
                self.cli.resolve_target(self.profile, "Nobody")
        self.assertEqual(ctx.exception.code, "TARGET_NOT_FOUND")


class TestSendRouting(CliTestCase):
    def setUp(self):
        super().setUp()
        self.profile = {
            "url": "http://server:3300",
            "key": "sk_test",
            "personal_numbers": ["+971501234567"],
        }
        self.parser = self.cli.build_parser()

    def send_args(self, *argv):
        return self.parser.parse_args(["send", *argv])

    def test_group_target_uses_the_group_endpoint(self):
        calls = []

        def fake(profile, method, path, params=None, body=None, auth=True):
            calls.append((method, path, body))
            return {"ok": True, "messageId": "M1"}

        with mock.patch.object(self.cli, "api_call", side_effect=fake):
            result = self.cli.do_send(self.send_args("1203630001@g.us", "hi", "--yes"), self.profile)

        self.assertEqual(calls[0][1], "/api/groups/send")
        self.assertEqual(calls[0][2], {"jid": "1203630001@g.us", "message": "hi"})
        self.assertEqual(result["data"]["route"], "group")

    def test_personal_number_uses_the_personal_endpoint(self):
        calls = []

        def fake(profile, method, path, params=None, body=None, auth=True):
            calls.append(path)
            return {"ok": True, "messageId": "M2"}

        with mock.patch.object(self.cli, "api_call", side_effect=fake):
            result = self.cli.do_send(self.send_args("+971501234567", "hi", "--yes"), self.profile)

        self.assertEqual(calls, ["/api/personal/send"])
        self.assertEqual(result["data"]["route"], "personal")

    def test_other_number_uses_the_whitelist_endpoint(self):
        calls = []

        def fake(profile, method, path, params=None, body=None, auth=True):
            calls.append(path)
            return {"ok": True, "messageId": "M3"}

        with mock.patch.object(self.cli, "api_call", side_effect=fake):
            result = self.cli.do_send(self.send_args("+441234567890", "hi", "--yes"), self.profile)

        self.assertEqual(calls, ["/api/others/send"])
        self.assertEqual(result["data"]["route"], "others")

    def test_stale_personal_cache_falls_back_to_the_whitelist_endpoint(self):
        calls = []

        def fake(profile, method, path, params=None, body=None, auth=True):
            calls.append(path)
            if path == "/api/personal/send":
                raise self.cli.WppError("nope", "NOT_PERSONAL_NUMBER", 403)
            return {"ok": True, "messageId": "M4"}

        with mock.patch.object(self.cli, "api_call", side_effect=fake):
            result = self.cli.do_send(self.send_args("+971501234567", "hi", "--yes"), self.profile)

        self.assertEqual(calls, ["/api/personal/send", "/api/others/send"])
        self.assertEqual(result["data"]["route"], "others")

    def test_explicit_route_is_not_second_guessed(self):
        def fake(profile, method, path, params=None, body=None, auth=True):
            raise self.cli.WppError("nope", "NOT_PERSONAL_NUMBER", 403)

        with mock.patch.object(self.cli, "api_call", side_effect=fake):
            with self.assertRaises(self.cli.WppError) as ctx:
                self.cli.do_send(self.send_args("+971501234567", "hi", "--yes", "--route", "personal"), self.profile)
        self.assertEqual(ctx.exception.code, "NOT_PERSONAL_NUMBER")

    def test_empty_message_is_refused(self):
        with self.assertRaises(self.cli.WppError) as ctx:
            self.cli.do_send(self.send_args("+441234567890", "", "--yes"), self.profile)
        self.assertEqual(ctx.exception.code, "BAD_ARGUMENT")


class TestConfirmationGate(CliTestCase):
    def test_non_interactive_send_requires_yes(self):
        args = self.cli.build_parser().parse_args(["send", "+441234567890", "hi"])
        with mock.patch.object(sys.stdin, "isatty", return_value=False):
            with self.assertRaises(self.cli.WppError) as ctx:
                self.cli.require_confirmation(args, "Send message?")
        self.assertEqual(ctx.exception.code, "CONFIRMATION_REQUIRED")

    def test_yes_skips_the_prompt(self):
        args = self.cli.build_parser().parse_args(["send", "+441234567890", "hi", "--yes"])
        self.cli.require_confirmation(args, "Send message?")  # must not raise


class TestErrorEnvelope(CliTestCase):
    def test_failures_are_machine_readable_json_on_stderr(self):
        import io

        buffer = io.StringIO()
        with mock.patch.object(sys, "stderr", buffer):
            self.cli.fail("boom", "SOME_CODE", status=503)
        payload = json.loads(buffer.getvalue())
        self.assertFalse(payload["success"])
        self.assertEqual(payload["error"]["code"], "SOME_CODE")
        self.assertEqual(payload["error"]["status"], 503)





class TestUnreadState(CliTestCase):
    def test_unknown_counts_are_not_reported_as_zero(self):
        result = self.cli.compact_chat({"jid": "15555550101@s.whatsapp.net", "unread_known": False, "unread_count": None, "unread_lower_bound": 2})
        self.assertIsNone(result["unread"])
        self.assertFalse(result["unread_known"])
        self.assertEqual(result["unread_at_least"], 2)

    def test_known_counts_and_marked_unread_survive_compacting(self):
        result = self.cli.compact_chat({"unread_known": True, "unread_count": 4})
        self.assertEqual(result["unread"], 4)
        result = self.cli.compact_chat({"unread_known": True, "unread_count": 0, "marked_unread": True})
        self.assertNotIn("unread", result)
        self.assertTrue(result["marked_unread"])


if __name__ == "__main__":
    unittest.main()
