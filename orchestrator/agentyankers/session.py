"""Run an AgentYankers call on the nemoswarm LiveKit host.

The runner checks consent, opens the room, speaks the recording disclosure,
then improvises with PersonaPlex. It writes a ``agentyankers/v1`` CallSession.
``EpisodePipeline`` in the core consumes that record plus the call waveform
stored under the recording ref.
"""

from __future__ import annotations

import argparse
import json
import re
import wave
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping, Sequence

from orchestrator.agentyankers.contract import (
    ENV_LIVEKIT_URL,
    PAUSE_SECONDS,
    SAMPLE_RATE,
    SCHEMA_VERSION,
    YankersHostError,
    assert_no_phone_numbers,
    build_text_prompt,
    contact_ref,
    core_module,
    recording_disclosure,
    require_call_consent,
    require_publish_consent,
    validate_call_session,
)
from orchestrator.agentyankers.livekit_host import NemoswarmLiveKitAdapter
from orchestrator.agentyankers.personaplex_host import NemoswarmPersonaPlexAdapter, tone
from orchestrator.agentyankers.vibevoice_host import NemoswarmVibeVoiceRenderer


@dataclass
class CallHostResult:
    """What the core's episode pipeline consumes from this host."""

    session: dict[str, Any]
    audio: list[float]
    bank: dict[str, list[float]]
    placement: dict[str, str]
    room: dict[str, str]

    def to_json(self) -> dict[str, Any]:
        return self.session


@dataclass
class _Prepared:
    session_id: str
    text_prompt: str
    room_name: str
    livekit: Any
    persona_config: dict[str, Any]


class _ReplySource:
    def __init__(self, lines: Sequence[Any]) -> None:
        self._lines = []
        for line in lines:
            if isinstance(line, str):
                item = SimpleNamespace(text=line, tags=[], audio=None)
            elif isinstance(line, Mapping):
                item = SimpleNamespace(
                    text=str(line["text"]),
                    tags=tuple(line.get("tags") or ()),
                    audio=line.get("audio"),
                )
            else:
                item = line
            if not str(item.text).strip():
                raise ValueError("mark reply is empty")
            assert_no_phone_numbers(item.text, field="mark reply")
            self._lines.append(item)
        self._index = 0

    def next_turn(self, agent_text: str) -> Any | None:
        del agent_text
        if self._index >= len(self._lines):
            return None
        line = self._lines[self._index]
        self._index += 1
        return line


class _AudioBank:
    def __init__(self) -> None:
        self.clips: dict[str, Any] = {}

    def put(self, ref_id: str, audio: Any) -> None:
        self.clips[ref_id] = audio

    def get(self, ref_id: str) -> Any:
        return self.clips[ref_id]


class YankersCallHost:
    """Live call host. Dry runs stay in memory. Live runs inject the SDKs."""

    def __init__(
        self,
        *,
        live: bool = False,
        livekit: NemoswarmLiveKitAdapter | None = None,
        personaplex: NemoswarmPersonaPlexAdapter | None = None,
        vibevoice: NemoswarmVibeVoiceRenderer | None = None,
        use_core: bool | None = None,
        trace: list[str] | None = None,
    ) -> None:
        self.live = live
        self.livekit = livekit or NemoswarmLiveKitAdapter(live=live)
        self.personaplex = personaplex or NemoswarmPersonaPlexAdapter(live=live)
        self.vibevoice = vibevoice or NemoswarmVibeVoiceRenderer(live=live)
        self.use_core = core_module() is not None if use_core is None else use_core
        self.trace = trace if trace is not None else []

    def run_call(
        self,
        premise: Any,
        persona: Any,
        mark: Any,
        replies: Sequence[Any],
        *,
        session_id: str | None = None,
        disclosure: str | None = None,
    ) -> CallHostResult:
        del disclosure  # The recording disclosure sentence is fixed.
        mark_view = as_mark(mark)
        persona_view = as_persona(persona)
        premise_view = as_premise(premise)
        self.trace.append("consent")
        _reject_inputs(premise_view, persona_view, mark_view)
        require_call_consent(mark_view)
        if persona_view.role != "caller":
            raise YankersHostError(f"{persona_view.agent_name} is a host and does not place calls")

        core = core_module() if self.use_core else None
        if core is not None:
            return self._run_core(core, premise, persona, mark, replies, session_id)
        return self._run_local(premise_view, persona_view, mark_view, replies, session_id)

    def assert_can_publish(self, mark: Any) -> None:
        """Gate a recorded call before it is handed to EpisodePipeline."""
        require_publish_consent(as_mark(mark))

    def _run_core(
        self,
        core: Any,
        premise: Any,
        persona: Any,
        mark: Any,
        replies: Sequence[Any],
        session_id: str | None,
    ) -> CallHostResult:
        premise_model = core.PremiseOutline.model_validate(_dump(premise))
        persona_model = core.AgentPersona.model_validate(_dump(persona))
        mark_model = core.MarkIndexEntry.model_validate(_dump(mark))
        bank = _AudioBank()
        runner = core.CallRunner(self.livekit, self.personaplex)
        session = runner.run_call(
            premise_model,
            persona_model,
            mark_model,
            _ReplySource(replies),
            bank,
            session_id=session_id,
        )
        payload = session.model_dump(mode="json")
        ref_id = payload["recordings"][0]["ref_id"]
        audio = _as_float_list(bank.get(ref_id))
        room_id = str(payload["livekit"].get("room_id") or "")
        result = CallHostResult(
            session=payload,
            audio=audio,
            bank={ref_id: audio},
            placement=dict(getattr(self.livekit, "last_placement", {}) or {}),
            room={
                "room_id": room_id,
                "session_id": str(payload["livekit"].get("session_id") or ""),
                "room_name": str(payload["livekit"].get("room_name") or ""),
            },
        )
        validate_call_session(result.session)
        return result

    def _run_local(
        self,
        premise: Any,
        persona: Any,
        mark: Any,
        replies: Sequence[Any],
        session_id: str | None,
    ) -> CallHostResult:
        prepared = _prepare(premise, persona, mark, session_id)
        handle = self.livekit.create_room(prepared.livekit)
        self.trace.append("create_room")
        room_id = str(handle.get("room_id") or "")
        try:
            if not room_id:
                raise YankersHostError("LiveKit adapter did not return a room_id")
            state = self.livekit.handles.get(room_id, {})
            turns, audio = self._record(prepared, persona, mark, _ReplySource(replies))
            recording_id = _recording_id(prepared.session_id)
            session = {
                "schema_version": SCHEMA_VERSION,
                "session_id": prepared.session_id,
                "premise_id": premise.premise_id,
                "agent_name": persona.agent_name,
                "mark_id": mark.mark_id,
                "status": "recorded",
                "livekit": {
                    "schema_version": SCHEMA_VERSION,
                    "room_name": prepared.room_name,
                    "room_id": room_id,
                    "session_id": str(handle.get("session_id") or ""),
                    "agent_identity": persona.agent_name,
                    "mark_identity": mark.contact_ref,
                    "url_env": ENV_LIVEKIT_URL,
                },
                "personaplex": prepared.persona_config,
                "transcript": turns,
                "recordings": [
                    {
                        "schema_version": SCHEMA_VERSION,
                        "ref_id": recording_id,
                        "kind": "call",
                        "path": None,
                        "sample_rate": SAMPLE_RATE,
                        "channels": 1,
                        "duration_seconds": len(audio) / SAMPLE_RATE,
                    }
                ],
                "consent_snapshot": _consent_dict(mark),
                "disclosure_played": True,
            }
            validate_call_session(session)
            return CallHostResult(
                session=session,
                audio=audio,
                bank={recording_id: audio},
                placement=dict(state.get("placement") or {}),
                room=dict(handle),
            )
        finally:
            if room_id:
                self.livekit.close_room(room_id)
                self.trace.append("close_room")

    def _record(self, prepared: _Prepared, persona: Any, mark: Any, source: _ReplySource) -> tuple[list[dict[str, Any]], list[float]]:
        pieces: list[list[float]] = []
        turns: list[dict[str, Any]] = []
        cursor = 0
        pause = int(round(PAUSE_SECONDS * SAMPLE_RATE))
        disclosure = recording_disclosure()

        def push(role: str, name: str, text: str, samples: list[float], *, improvised: bool, tags: Sequence[str]) -> None:
            nonlocal cursor
            assert_no_phone_numbers(text, field=f"{role} turn")
            if pieces:
                cursor += pause
            if not samples:
                raise YankersHostError("generated audio is empty")
            start = cursor / SAMPLE_RATE
            cursor += len(samples)
            turns.append({
                "schema_version": SCHEMA_VERSION,
                "turn_id": f"turn-{len(turns) + 1:02d}",
                "speaker_role": role,
                "speaker_name": name,
                "text": text,
                "start_seconds": start,
                "end_seconds": cursor / SAMPLE_RATE,
                "tags": list(tags),
                "improvised": improvised,
            })
            pieces.append(list(samples))

        self.trace.append("disclose")
        push(
            "disclosure",
            persona.agent_name,
            disclosure,
            tone(SAMPLE_RATE, 0.4, 220.0),
            improvised=False,
            tags=[],
        )
        while True:
            reply = source.next_turn(turns[-1]["text"])
            if reply is None:
                break
            mark_audio = list(reply.audio) if reply.audio is not None else tone(SAMPLE_RATE, 0.3, 330.0)
            push("mark", mark.display_name, reply.text, mark_audio, improvised=False, tags=list(reply.tags))
            context = SimpleNamespace(
                agent_name=persona.agent_name,
                persona_prompt=persona.persona_prompt,
                text_prompt=prepared.text_prompt,
                premise_beats=tuple(
                    line[2:] for line in prepared.text_prompt.splitlines() if line.startswith("- ")
                ),
                mark_utterance=reply.text,
                speaker_name=persona.personaplex_speaker,
                voice_prompt_path=None,
                input_audio_path=None,
                sample_rate=SAMPLE_RATE,
                response_tail_seconds=prepared.persona_config["response_tail_seconds"],
                seed=None,
            )
            self.trace.append("generate")
            generated = self.personaplex.generate(context)
            if int(generated.sample_rate) != SAMPLE_RATE:
                raise YankersHostError("PersonaPlex adapter must return 24000 Hz audio")
            push(
                "agent",
                persona.agent_name,
                generated.text,
                list(generated.audio),
                improvised=True,
                tags=list(reply.tags),
            )
        mixed = _mix(pieces, pause)
        if len(mixed) != cursor:
            raise YankersHostError("call recording timeline does not match the transcript")
        return turns, mixed


def write_session(result: CallHostResult, directory: str | Path) -> Path:
    """Write ``call_session.json`` and the call wav the episode pipeline can open."""
    target = Path(directory)
    target.mkdir(parents=True, exist_ok=True)
    session = json.loads(json.dumps(result.session))
    recording = session["recordings"][0]
    wav_path = target / f"{recording['ref_id']}.wav"
    _write_wav(wav_path, result.audio, SAMPLE_RATE)
    recording["path"] = str(wav_path)
    outfile = target / "call_session.json"
    outfile.write_text(json.dumps(session, indent=2) + "\n", encoding="utf-8")
    validate_call_session(session)
    return outfile


def load_fixture(path: str | Path) -> dict[str, Any]:
    source = Path(path)
    payload = json.loads(source.read_text(encoding="utf-8"))
    assert_no_phone_numbers(payload, field=str(source))
    return payload


def run_fixture(
    path: str | Path,
    *,
    mark_id: str | None = None,
    live: bool = False,
    output_dir: str | Path | None = None,
    host: YankersCallHost | None = None,
) -> CallHostResult:
    bundle = load_fixture(path)
    mark = _select_mark(bundle["marks"], mark_id)
    caller = bundle["caller"]
    replies = bundle["replies"][mark["mark_id"]]
    runner = host or YankersCallHost(live=live, use_core=False if not live else None)
    result = runner.run_call(bundle["premise"], caller, mark, replies)
    if output_dir is not None:
        write_session(result, output_dir)
    return result


def run_fixture_cli(args: argparse.Namespace) -> None:
    result = run_fixture(args.fixture, mark_id=args.mark, live=args.live, output_dir=args.out)
    print(json.dumps({
        "session_id": result.session["session_id"],
        "status": result.session["status"],
        "recording": result.session["recordings"][0]["ref_id"],
        "placement": result.placement,
        "out": args.out,
    }, indent=2))


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run an AgentYankers call on the nemoswarm LiveKit host")
    parser.add_argument("--fixture", required=True, help="Path to a fictional call bundle JSON")
    parser.add_argument("--mark", default=None, help="mark_id to call (default: the first mark)")
    parser.add_argument("--out", required=True, help="Directory for call_session.json and the call wav")
    parser.add_argument("--live", action="store_true", help="Open a real LiveKit room and load PersonaPlex")
    run_fixture_cli(parser.parse_args(argv))


def as_mark(mark: Any) -> Any:
    if hasattr(mark, "consent") and not isinstance(mark, Mapping):
        return mark
    data = dict(mark)
    data["consent"] = SimpleNamespace(**dict(data["consent"]))
    return SimpleNamespace(**data)


def as_persona(persona: Any) -> Any:
    if hasattr(persona, "agent_name") and not isinstance(persona, Mapping):
        return persona
    data = dict(persona)
    data["voice"] = SimpleNamespace(**dict(data["voice"]))
    return SimpleNamespace(**data)


def as_premise(premise: Any) -> Any:
    if hasattr(premise, "premise_id") and not isinstance(premise, Mapping):
        return premise
    data = dict(premise)
    data["beats"] = [SimpleNamespace(**dict(beat)) for beat in data["beats"]]
    return SimpleNamespace(**data)


def _reject_inputs(premise: Any, persona: Any, mark: Any) -> None:
    assert_no_phone_numbers(_dump(premise), field="premise")
    assert_no_phone_numbers(_dump(persona), field="persona")
    assert_no_phone_numbers(_dump(mark), field="mark")
    contact_ref(mark.contact_ref, field="contact_ref")


def _prepare(premise: Any, persona: Any, mark: Any, session_id: str | None) -> _Prepared:
    resolved = session_id or _session_id(persona.agent_name, mark.mark_id)
    text_prompt = build_text_prompt(persona, premise)
    room_name = f"agentyankers-{resolved}"
    voice = None
    if persona.voice.provider == "personaplex":
        voice = {
            "schema_version": SCHEMA_VERSION,
            "voice_id": persona.voice.voice_id,
            "library": persona.voice.library,
            "provider": persona.voice.provider,
            "relative_path": persona.voice.relative_path,
        }
    persona_config = {
        "schema_version": SCHEMA_VERSION,
        "text_prompt": text_prompt,
        "speaker_name": persona.personaplex_speaker,
        "voice": voice,
        "response_tail_seconds": 1.5,
        "sample_rate": SAMPLE_RATE,
    }
    livekit = SimpleNamespace(
        room_name=room_name,
        agent_identity=persona.agent_name,
        mark_identity=mark.contact_ref,
        url_env="LIVEKIT_URL",
        api_key_env="LIVEKIT_API_KEY",
        api_secret_env="LIVEKIT_API_SECRET",
        empty_timeout_seconds=30,
        max_participants=2,
        metadata={
            "show": "AgentYankers",
            "premise_id": premise.premise_id,
            "mark_id": mark.mark_id,
            "disclosure": recording_disclosure(),
        },
    )
    return _Prepared(
        session_id=resolved,
        text_prompt=text_prompt,
        room_name=room_name,
        livekit=livekit,
        persona_config=persona_config,
    )


def _mix(pieces: Sequence[Sequence[float]], pause_samples: int) -> list[float]:
    mixed: list[float] = []
    pause = [0.0] * pause_samples
    for index, piece in enumerate(pieces):
        if index:
            mixed.extend(pause)
        mixed.extend(piece)
    return mixed


def _session_id(agent_name: str, mark_id: str) -> str:
    slug = re.sub(r"[^a-z0-9-]+", "-", f"{agent_name}-{mark_id}".lower()).strip("-")
    return f"call-{slug}"[:84]


def _recording_id(session_id: str) -> str:
    suffix = session_id.removeprefix("call-")
    return f"rec-{suffix}"[:84]


def _consent_dict(mark: Any) -> dict[str, Any]:
    consent = mark.consent
    return {
        "schema_version": SCHEMA_VERSION,
        "opted_in": bool(consent.opted_in),
        "consent_id": consent.consent_id,
        "scope": consent.scope,
        "disclosure_accepted": bool(consent.disclosure_accepted),
        "consented_at": consent.consented_at,
    }


def _select_mark(marks: Sequence[Mapping[str, Any]], mark_id: str | None) -> dict[str, Any]:
    if mark_id is None:
        return dict(marks[0])
    for mark in marks:
        if mark["mark_id"] == mark_id:
            return dict(mark)
    raise YankersHostError(f"unknown mark_id {mark_id}")


def _dump(value: Any) -> Any:
    if isinstance(value, SimpleNamespace):
        return {key: _dump(item) for key, item in vars(value).items()}
    if isinstance(value, Mapping):
        return {key: _dump(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_dump(item) for item in value]
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    return value


def _as_float_list(audio: Any) -> list[float]:
    tolist = getattr(audio, "tolist", None)
    if tolist is not None:
        audio = tolist()
    flat = list(audio)
    if flat and isinstance(flat[0], list):
        flat = [row[0] for row in flat]
    return [float(sample) for sample in flat]


def _write_wav(path: Path, samples: Sequence[float], sample_rate: int) -> None:
    import struct

    frames = bytearray()
    for sample in samples:
        clipped = max(-1.0, min(1.0, float(sample)))
        frames.extend(struct.pack("<h", int(clipped * 32767.0)))
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(frames)
