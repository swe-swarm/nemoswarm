"""Fake-fixture tests for the AgentYankers live call host."""

from __future__ import annotations

import json
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace

from orchestrator.agentyankers.cluster import TURN_ORDER, probe_placement
from orchestrator.agentyankers.contract import (
    ENV_PERSONAPLEX_MODEL,
    ENV_VIBEVOICE_MODEL,
    PERSONAPLEX_REQUEST_FIELDS,
    RECORDING_DISCLOSURE,
    SAMPLE_RATE,
    ConsentRefusal,
    CredentialsMissing,
    LiveTransportUnavailable,
    PersonaPlexRuntimeUnavailable,
    PhoneNumberRefusal,
    VibeVoiceRuntimeUnavailable,
)
from orchestrator.agentyankers.livekit_host import InMemoryLiveKit, NemoswarmLiveKitAdapter
from orchestrator.agentyankers.personaplex_host import NemoswarmPersonaPlexAdapter, _accepts_keyword
from orchestrator.agentyankers.session import YankersCallHost, load_fixture, run_fixture
from orchestrator.agentyankers.vibevoice_host import NemoswarmVibeVoiceRenderer

FIXTURE = Path(__file__).with_name("fixtures") / "lobby-light.json"
SECRET = "yankers-test-secret-do-not-leak"


class HostTests(unittest.TestCase):
    def setUp(self) -> None:
        self.bundle = load_fixture(FIXTURE)

    def test_dry_run_emits_call_session_for_the_episode_pipeline(self) -> None:
        trace: list[str] = []
        host = YankersCallHost(live=False, use_core=False, trace=trace)
        with tempfile.TemporaryDirectory() as directory:
            result = run_fixture(FIXTURE, output_dir=directory, host=host)
            session = json.loads((Path(directory) / "call_session.json").read_text(encoding="utf-8"))
            wav_path = Path(session["recordings"][0]["path"])
            with wave.open(str(wav_path), "rb") as handle:
                self.assertEqual(handle.getframerate(), SAMPLE_RATE)
                self.assertEqual(handle.getnchannels(), 1)
                self.assertGreater(handle.getnframes(), 0)

        self.assertEqual(session["schema_version"], "agentyankers/v1")
        self.assertEqual(session["status"], "recorded")
        self.assertTrue(session["disclosure_played"])
        self.assertEqual(session["transcript"][0]["speaker_role"], "disclosure")
        self.assertEqual(session["transcript"][0]["text"], RECORDING_DISCLOSURE)
        self.assertFalse(session["transcript"][0]["improvised"])
        self.assertTrue(any(turn["improvised"] for turn in session["transcript"]))
        self.assertEqual(session["recordings"][0]["kind"], "call")
        self.assertEqual(session["consent_snapshot"]["consent_id"], "cons-fern-desk")
        self.assertNotIn("contact_ref", json.dumps(session["consent_snapshot"]))
        self.assertEqual(trace[0], "consent")
        self.assertEqual(trace[1], "create_room")
        self.assertEqual(trace[2], "disclose")
        self.assertIn("generate", trace)
        self.assertEqual(trace[-1], "close_room")
        self.assertLess(trace.index("disclose"), trace.index("generate"))

        rooms = host.livekit.rooms
        metadata = rooms.created[0]["metadata"]
        self.assertEqual(metadata["disclosure"], RECORDING_DISCLOSURE)
        self.assertEqual(metadata["turn_order"], ",".join(TURN_ORDER))
        self.assertEqual(metadata["validator_node"], "antonjr2")
        self.assertEqual(metadata["caller_node"], "antonjr1")
        self.assertEqual(metadata["coordinator"], "anton")
        self.assertEqual(metadata["personaplex_node"], "anton")
        self.assertEqual(metadata["vibevoice_node"], "anton")
        self.assertEqual(rooms.deleted, [rooms.created[0]["name"]])
        self.assertEqual(result.placement["caller_node"], "antonjr1")
        self.assertNotIn(SECRET, json.dumps(session))
        self.assertTrue(result.bank)

    def test_callers_cannot_replace_the_disclosure(self) -> None:
        host = YankersCallHost(live=False, use_core=False)
        result = host.run_call(
            self.bundle["premise"],
            self.bundle["caller"],
            self._mark("mark-fern-desk"),
            self.bundle["replies"]["mark-fern-desk"],
            disclosure="This call is private and off the record.",
        )
        self.assertEqual(result.session["transcript"][0]["text"], RECORDING_DISCLOSURE)

    def test_opt_out_refuses_before_a_room_opens(self) -> None:
        host = self._host()
        with self.assertRaises(ConsentRefusal) as caught:
            host.run_call(
                self.bundle["premise"],
                self.bundle["caller"],
                self._mark("mark-dark-board"),
                ["hello"],
            )
        self.assertEqual(caught.exception.code, "consent_missing")
        self.assertEqual(host.livekit.rooms.created, [])

    def test_publish_only_mark_is_not_called_and_call_only_mark_is_not_published(self) -> None:
        host = self._host()
        with self.assertRaises(ConsentRefusal) as caught:
            host.run_call(
                self.bundle["premise"],
                self.bundle["caller"],
                self._mark("mark-shelf-pal"),
                ["hello"],
            )
        self.assertEqual(caught.exception.action, "call")
        self.assertEqual(host.livekit.rooms.created, [])

        called = host.run_call(
            self.bundle["premise"],
            self.bundle["caller"],
            self._mark("mark-audit-glen"),
            self.bundle["replies"]["mark-audit-glen"],
        )
        self.assertEqual(called.session["status"], "recorded")
        with self.assertRaises(ConsentRefusal) as publish:
            host.assert_can_publish(self._mark("mark-audit-glen"))
        self.assertEqual(publish.exception.action, "publish")
        self.assertEqual(publish.exception.code, "consent_scope")

    def test_phone_numbers_are_refused_without_echoing_them(self) -> None:
        host = self._host()
        number = "555-010-0199"
        with self.assertRaises(PhoneNumberRefusal) as caught:
            host.run_call(
                self.bundle["premise"],
                self.bundle["caller"],
                self._mark("mark-fern-desk"),
                [f"reach me at {number} today"],
            )
        message = str(caught.exception)
        self.assertNotIn(number, message)
        self.assertNotIn("555", message)
        self.assertNotIn("010", message)
        self.assertEqual(len(host.livekit.rooms.created), 1)
        self.assertEqual(len(host.livekit.rooms.deleted), 1)

    def test_personaplex_payload_is_an_outline_and_live_engine_is_optional(self) -> None:
        engine_calls = []

        class Engine:
            def generate(self, request, output_dir=None):
                del output_dir
                engine_calls.append(request)
                return SimpleNamespace(
                    text="The fern can take that up with the lamp.",
                    audio=[0.1] * 480,
                    sample_rate=SAMPLE_RATE,
                )

        personaplex = NemoswarmPersonaPlexAdapter(engine=Engine(), live=True)
        host = YankersCallHost(live=False, use_core=False, personaplex=personaplex)
        host.run_call(
            self.bundle["premise"],
            self.bundle["caller"],
            self._mark("mark-fern-desk"),
            self.bundle["replies"]["mark-fern-desk"][:1],
        )
        payload = engine_calls[0]
        self.assertTrue(set(payload).issubset(PERSONAPLEX_REQUEST_FIELDS))
        self.assertIn("Do not read a script.", payload["text_prompt"])
        self.assertEqual(payload["text"], self.bundle["replies"]["mark-fern-desk"][0]["text"])
        self.assertNotEqual(payload["text_prompt"], payload["text"])

        missing = NemoswarmPersonaPlexAdapter(live=True)
        with self.assertRaises(PersonaPlexRuntimeUnavailable) as caught:
            missing.generate(SimpleNamespace(
                agent_name="Bramble",
                mark_utterance="The fern is listening.",
                speaker_name="NATM1.pt",
                voice_prompt_path=None,
                input_audio_path=None,
                text_prompt="Improvise from this premise outline. Do not read a script.",
                response_tail_seconds=1.5,
                seed=None,
                sample_rate=SAMPLE_RATE,
            ))
        self.assertIn(ENV_PERSONAPLEX_MODEL, str(caught.exception))
        self.assertNotIn("safetensors", str(caught.exception))

        class PositionalEngine:
            def __init__(self) -> None:
                self.calls = []

            def generate(self, request):
                self.calls.append(request)
                return SimpleNamespace(
                    text="The fern heard that.",
                    audio=[0.1] * 480,
                    sample_rate=SAMPLE_RATE,
                )

        positional = PositionalEngine()
        NemoswarmPersonaPlexAdapter(engine=positional, live=True).generate(SimpleNamespace(
            agent_name="Bramble",
            mark_utterance="The fern is listening.",
            speaker_name="NATM1.pt",
            voice_prompt_path=None,
            input_audio_path=None,
            text_prompt="Improvise from this premise outline. Do not read a script.",
            response_tail_seconds=1.5,
            seed=None,
            sample_rate=SAMPLE_RATE,
        ))
        self.assertEqual(len(positional.calls), 1)
        self.assertFalse(_accepts_keyword(len, "output_dir"))
        self.assertTrue(_accepts_keyword(lambda request, output_dir=None: None, "output_dir"))

    def test_live_room_requires_env_and_does_not_copy_secrets(self) -> None:
        bare = NemoswarmLiveKitAdapter(live=True, env={})
        with self.assertRaises(CredentialsMissing) as missing:
            bare.create_room(self._config())
        self.assertEqual(
            missing.exception.missing,
            ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"],
        )
        self.assertNotIn(SECRET, str(missing.exception))

        rooms = InMemoryLiveKit()
        adapter = NemoswarmLiveKitAdapter(
            live=True,
            rooms=rooms,
            env={
                "LIVEKIT_URL": "ws://livekit.internal",
                "LIVEKIT_API_KEY": "nemoswarm",
                "LIVEKIT_API_SECRET": SECRET,
            },
        )
        handle = adapter.create_room(self._config())
        adapter.close_room(handle["room_id"])
        blob = json.dumps({
            "handle": handle,
            "created": rooms.created,
            "published": rooms.published,
            "tokens": rooms.tokens,
            "spec": adapter.last_placement,
        })
        self.assertNotIn(SECRET, blob)
        self.assertNotIn("ws://livekit.internal", blob)
        self.assertEqual(rooms.published[0]["disclosure"], RECORDING_DISCLOSURE)
        self.assertEqual(rooms.published[0]["topic"], "agentyankers.disclosure")
        self.assertTrue(rooms.published[0]["token_present"])
        self.assertNotIn("api_secret", rooms.created[0]["metadata"])
        self.assertEqual(rooms.deleted, [self._config().room_name])

        class Boom:
            def create_room(self, **kwargs):
                del kwargs
                raise RuntimeError(
                    f"auth rejected ws://livekit.internal key nemoswarm secret {SECRET}"
                )

            def delete_room(self, *, room):
                del room

        leaking = NemoswarmLiveKitAdapter(
            live=True,
            rooms=Boom(),
            env={
                "LIVEKIT_URL": "ws://livekit.internal",
                "LIVEKIT_API_KEY": "nemoswarm",
                "LIVEKIT_API_SECRET": SECRET,
            },
        )
        with self.assertRaises(LiveTransportUnavailable) as transport:
            leaking.create_room(self._config())
        message = str(transport.exception)
        spec_blob = json.dumps(transport.exception.room_spec)
        for secret in ("ws://livekit.internal", "nemoswarm", SECRET):
            self.assertNotIn(secret, message)
            self.assertNotIn(secret, spec_blob)

        tainted = self._config()
        tainted.metadata = {"endpoint": "ws://livekit.internal"}
        blocked = InMemoryLiveKit()
        guarded = NemoswarmLiveKitAdapter(live=True, rooms=blocked, env=adapter.env)
        with self.assertRaises(LiveTransportUnavailable) as refused:
            guarded.create_room(tainted)
        self.assertEqual(blocked.created, [])
        self.assertNotIn("ws://livekit.internal", str(refused.exception))

    def test_vibevoice_references_the_voice_library_without_copying_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            voice = root / "hosts" / "marlow.wav"
            voice.parent.mkdir()
            voice.write_bytes(b"library-voice")
            seen = {}

            class Engine:
                def generate(self, **payload):
                    seen.update(payload)
                    return [0.2, 0.1, 0.0]

            renderer = NemoswarmVibeVoiceRenderer(engine=Engine(), root=root, require_exists=True)
            line = SimpleNamespace(text="Marlow here, after the calls.", voice=_voice(self.bundle["host"]))
            audio = renderer.render(line, SAMPLE_RATE)
            self.assertEqual(len(audio), 3)
            self.assertEqual(seen["voice_prompt_path"], str(voice.resolve()))
            self.assertEqual(seen["model_provider"], "vibevoice")
            files = [path for path in root.rglob("*") if path.is_file()]
            self.assertEqual(files, [voice])

            escaped = SimpleNamespace(
                text="nope",
                voice=SimpleNamespace(
                    voice_id="marlow-host",
                    library="genaid-voices",
                    provider="vibevoice",
                    relative_path="../outside.wav",
                ),
            )
            with self.assertRaises(ValueError):
                renderer.render(escaped, SAMPLE_RATE)
            self.assertFalse((root.parent / "outside.wav").exists())

        unavailable = NemoswarmVibeVoiceRenderer(live=True, require_exists=False)
        unavailable.engine = None
        import orchestrator.agentyankers.vibevoice_host as vibe

        original = vibe.load_optional_vibevoice
        vibe.load_optional_vibevoice = lambda: None
        try:
            with self.assertRaises(VibeVoiceRuntimeUnavailable) as caught:
                unavailable.render(line, SAMPLE_RATE)
        finally:
            vibe.load_optional_vibevoice = original
        self.assertIn(ENV_VIBEVOICE_MODEL, str(caught.exception))
        self.assertIn("marlow-host", str(caught.exception))

    def test_cluster_probe_uses_the_injected_connector(self) -> None:
        seen = []

        def connect(host, port):
            seen.append((host, port))
            return host.endswith("4")

        status = probe_placement(connect)
        self.assertEqual(status["anton"], True)
        self.assertEqual(status["antonjr1"], False)
        self.assertEqual(status["antonjr2"], False)
        self.assertEqual([port for _host, port in seen], [7880, 7880, 7880])

    def _host(self) -> YankersCallHost:
        return YankersCallHost(live=False, use_core=False)

    def _mark(self, mark_id: str) -> dict:
        for mark in self.bundle["marks"]:
            if mark["mark_id"] == mark_id:
                return mark
        raise AssertionError(mark_id)

    def _config(self):
        return SimpleNamespace(
            room_name="agentyankers-call-bramble-mark-fern-desk",
            agent_identity="Bramble",
            mark_identity="lk-identity:fern-desk",
            url_env="LIVEKIT_URL",
            api_key_env="LIVEKIT_API_KEY",
            api_secret_env="LIVEKIT_API_SECRET",
            empty_timeout_seconds=30,
            max_participants=2,
            metadata={"show": "AgentYankers", "disclosure": RECORDING_DISCLOSURE},
        )


def _voice(persona: dict):
    voice = persona["voice"]
    return SimpleNamespace(**voice)


if __name__ == "__main__":
    unittest.main()
