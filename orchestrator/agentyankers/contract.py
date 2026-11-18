"""Published AgentYankers contract used by the nemoswarm call host.

The show model lives in ``genaid_audio.agentyankers`` (schema ``agentyankers/v1``).
This module keeps the guardrails and the CallSession shape that host must
emit. When that package is installed, the host delegates to it. Nothing here
copies voice assets or LiveKit secrets.
"""

from __future__ import annotations

from collections.abc import Mapping
import re
from typing import Any


SCHEMA_VERSION = "agentyankers/v1"
SHOW_NAME = "AgentYankers"
PRODUCER = "DarbotLabs"
SAMPLE_RATE = 24_000

RECORDING_DISCLOSURE = (
    "This is AgentYankers, an adult comedy podcast from DarbotLabs. "
    "This call is being recorded. You are on with an automated agent. "
    "Say stop if you want the call to end."
)

ENV_LIVEKIT_URL = "LIVEKIT_URL"
ENV_LIVEKIT_API_KEY = "LIVEKIT_API_KEY"
ENV_LIVEKIT_API_SECRET = "LIVEKIT_API_SECRET"
ENV_PERSONAPLEX_MODEL = "GENAID_PERSONAPLEX_MODEL_BASE"
ENV_VIBEVOICE_MODEL = "GENAID_MODEL_BASE"
ENV_VOICES_DIR = "GENAID_VOICES_DIR"
DOCUMENTED_VOICE_ROOT = "/mnt/fschia/genai-media/audio/voice-library"

# Field names accepted by PersonaPlexGenerationRequest. Payloads stay a subset.
PERSONAPLEX_REQUEST_FIELDS = (
    "text",
    "output_format",
    "speaker_name",
    "voice_prompt_path",
    "input_audio_path",
    "text_prompt",
    "duration_seconds",
    "seed",
    "greedy",
    "temp_audio",
    "temp_text",
    "topk_audio",
    "topk_text",
    "response_tail_seconds",
    "master_output",
    "input_transcript",
    "expected_response_text",
    "adaptive_tail",
    "adaptive_tail_min_seconds",
    "adaptive_tail_eos_grace_seconds",
)

PAUSE_SECONDS = 0.1
DISCLOSURE_TOPIC = "agentyankers.disclosure"

_PHONE_PATTERNS = (
    re.compile(r"\+\d[\d\s().-]{7,}\d"),
    re.compile(r"\(\d{3}\)\s*\d{3}[-.\s]\d{4}"),
    re.compile(r"\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b"),
    re.compile(r"\b\d{10,15}\b"),
)
_CONTACT = re.compile(r"^(agent|lk-identity|room):[a-z0-9][a-z0-9-]{2,64}$")
_CALL_ID = re.compile(r"^call-[a-z0-9-]{3,80}$")
_REC_ID = re.compile(r"^rec-[a-z0-9-]{3,80}$")
_TURN_ID = re.compile(r"^turn-[a-z0-9-]{2,32}$")
_AGENT_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9]{1,31}$")


class YankersHostError(ValueError):
    """Base error. ``code`` stays stable for callers."""

    code = "error"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class ConsentRefusal(YankersHostError):
    def __init__(self, message: str, *, mark_id: str, action: str, code: str):
        super().__init__(message)
        self.mark_id = mark_id
        self.action = action
        self.code = code


class PhoneNumberRefusal(YankersHostError):
    """A phone-number-like string appeared. The matched text is not echoed."""

    code = "phone_number_forbidden"

    def __init__(self, field: str):
        self.field = field
        super().__init__(
            f"Refusing {field}: AgentYankers does not accept phone numbers. "
            "Use an agent id or a LiveKit identity."
        )


class CredentialsMissing(YankersHostError):
    code = "credentials_missing"

    def __init__(self, missing: list[str]):
        self.missing = list(missing)
        names = ", ".join(self.missing)
        super().__init__(
            f"Live credentials are not configured. Set environment variables: {names}."
        )


class LiveTransportUnavailable(YankersHostError):
    code = "livekit_transport_unavailable"

    def __init__(self, message: str, *, room_spec: dict[str, Any] | None = None):
        super().__init__(message)
        self.room_spec = room_spec or {}


class PersonaPlexRuntimeUnavailable(YankersHostError):
    code = "personaplex_unavailable"

    def __init__(self, message: str, *, payload: dict[str, Any]):
        super().__init__(message)
        self.payload = payload


class VibeVoiceRuntimeUnavailable(YankersHostError):
    code = "vibevoice_unavailable"


def core_module():
    """Return ``genaid_audio.agentyankers`` when the private core is installed."""
    try:
        import genaid_audio.agentyankers as core
    except ImportError:
        return None
    return core


def recording_disclosure() -> str:
    """The exact sentence inserted into every call. Callers cannot replace it."""
    core = core_module()
    if core is not None:
        return core.recording_disclosure()
    return RECORDING_DISCLOSURE


def find_phone_numbers(value: Any) -> list[str]:
    """Return matched phone-like strings. Callers should not log the result."""
    found: list[str] = []
    _walk_phones(value, found)
    return found


def assert_no_phone_numbers(value: Any, *, field: str = "payload") -> None:
    if find_phone_numbers(value):
        raise PhoneNumberRefusal(field)


def explain_consent(mark: Any) -> str:
    name = mark.display_name
    if not mark.opted_in or not mark.consent.opted_in:
        return f"{name} has not opted in"
    scope = mark.consent.scope
    if scope == "call":
        return f"{name} opted in for a call only; publishing is refused"
    if scope == "publish":
        return f"{name} opted in for publication only; a new call is refused"
    if scope == "call_and_publish":
        return f"{name} opted in for calls and publication"
    return f"{name} has no usable consent scope"


def require_call_consent(mark: Any) -> None:
    core = core_module()
    if core is not None and not isinstance(mark, Mapping):
        core.require_call_consent(mark)
        return
    if not mark.opted_in or not mark.consent.opted_in:
        raise ConsentRefusal(
            f"{mark.display_name} has not opted in. AgentYankers will not call this mark.",
            mark_id=mark.mark_id,
            action="call",
            code="consent_missing",
        )
    if mark.consent.scope not in {"call", "call_and_publish"}:
        raise ConsentRefusal(
            f"{mark.display_name} is not consented for a call.",
            mark_id=mark.mark_id,
            action="call",
            code="consent_scope",
        )
    if not mark.consent.disclosure_accepted:
        raise ConsentRefusal(
            f"{mark.display_name} has not accepted the recording disclosure.",
            mark_id=mark.mark_id,
            action="call",
            code="disclosure_required",
        )


def require_publish_consent(mark: Any) -> None:
    core = core_module()
    if core is not None and not isinstance(mark, Mapping):
        core.require_publish_consent(mark)
        return
    if not mark.opted_in or not mark.consent.opted_in:
        raise ConsentRefusal(
            f"{mark.display_name} has not opted in. AgentYankers will not publish this mark.",
            mark_id=mark.mark_id,
            action="publish",
            code="consent_missing",
        )
    if mark.consent.scope not in {"publish", "call_and_publish"}:
        raise ConsentRefusal(
            f"{explain_consent(mark)}.",
            mark_id=mark.mark_id,
            action="publish",
            code="consent_scope",
        )
    if not mark.consent.disclosure_accepted:
        raise ConsentRefusal(
            f"{mark.display_name} has not accepted the recording disclosure.",
            mark_id=mark.mark_id,
            action="publish",
            code="disclosure_required",
        )


def contact_ref(value: str, *, field: str) -> str:
    if not _CONTACT.fullmatch(value or ""):
        raise YankersHostError(
            f"invalid {field}: use an agent:, lk-identity:, or room: ref"
        )
    return value


def build_text_prompt(persona: Any, premise: Any) -> str:
    """Persona plus the premise outline. The model is told not to read a script."""
    beats = "\n".join(f"- {beat['outline'] if isinstance(beat, Mapping) else beat.outline}" for beat in premise_beats(premise))
    constraints = premise["constraints"] if isinstance(premise, Mapping) else premise.constraints
    tone = premise["tone"] if isinstance(premise, Mapping) else premise.tone
    name = persona["agent_name"] if isinstance(persona, Mapping) else persona.agent_name
    prompt = persona["persona_prompt"] if isinstance(persona, Mapping) else persona.persona_prompt
    return (
        f"You are {name}. {prompt}\n"
        "Improvise from this premise outline. Do not read a script.\n"
        f"{beats}\n"
        f"Constraints: {constraints}\n"
        f"Tone: {tone}."
    )


def premise_beats(premise: Any) -> list[Any]:
    beats = premise["beats"] if isinstance(premise, Mapping) else premise.beats
    return list(beats)


def personaplex_request_payload(context: Any) -> dict[str, Any]:
    """Dict whose keys are a subset of ``PersonaPlexGenerationRequest``."""
    core = core_module()
    if core is not None and not isinstance(context, Mapping):
        return core.personaplex_request_payload(context)
    payload = {
        "text": context.mark_utterance,
        "output_format": "wav",
        "speaker_name": context.speaker_name,
        "voice_prompt_path": context.voice_prompt_path,
        "input_audio_path": context.input_audio_path,
        "text_prompt": context.text_prompt,
        "response_tail_seconds": context.response_tail_seconds,
        "master_output": True,
        "input_transcript": context.mark_utterance,
        "seed": context.seed,
    }
    unknown = set(payload) - set(PERSONAPLEX_REQUEST_FIELDS)
    if unknown:
        raise YankersHostError(f"unexpected PersonaPlex fields: {sorted(unknown)}")
    assert_no_phone_numbers(payload, field="personaplex request")
    return payload


def public_room_spec(config: Any) -> dict[str, Any]:
    """Room plan with env var names. Secret values are not copied."""
    core = core_module()
    if core is not None and type(config).__module__.startswith("genaid_audio."):
        return core.build_room_spec(config)
    metadata = dict(getattr(config, "metadata", {}) or {})
    return {
        "room_name": config.room_name,
        "agent_identity": config.agent_identity,
        "mark_identity": config.mark_identity,
        "url_env": getattr(config, "url_env", ENV_LIVEKIT_URL),
        "api_key_env": getattr(config, "api_key_env", ENV_LIVEKIT_API_KEY),
        "api_secret_env": getattr(config, "api_secret_env", ENV_LIVEKIT_API_SECRET),
        "empty_timeout_seconds": int(getattr(config, "empty_timeout_seconds", 30)),
        "max_participants": int(getattr(config, "max_participants", 2)),
        "metadata": metadata,
    }


def validate_call_session(payload: Mapping[str, Any]) -> None:
    """Check the CallSession shape EpisodePipeline accepts."""
    assert_no_phone_numbers(payload, field="call session")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise YankersHostError("call session schema_version must be agentyankers/v1")
    if payload.get("status") != "recorded":
        raise YankersHostError("a finished call session is recorded")
    if payload.get("disclosure_played") is not True:
        raise YankersHostError("call session is missing disclosure_played")
    if not _CALL_ID.fullmatch(str(payload.get("session_id", ""))):
        raise YankersHostError("invalid session_id")
    if not _AGENT_NAME.fullmatch(str(payload.get("agent_name", ""))):
        raise YankersHostError("invalid agent_name")
    livekit = payload.get("livekit") or {}
    contact_ref(str(livekit.get("mark_identity", "")), field="mark_identity")
    if livekit.get("url_env") != ENV_LIVEKIT_URL:
        raise YankersHostError("livekit binding must name LIVEKIT_URL, not a url value")
    turns = payload.get("transcript") or []
    if not turns or turns[0].get("speaker_role") != "disclosure":
        raise YankersHostError("the recording disclosure must be the first turn")
    if turns[0].get("text") != recording_disclosure():
        raise YankersHostError("the recording disclosure sentence cannot be replaced")
    if turns[0].get("improvised") is not False:
        raise YankersHostError("the disclosure is the only scripted agent line")
    for turn in turns:
        if not _TURN_ID.fullmatch(str(turn.get("turn_id", ""))):
            raise YankersHostError("invalid turn_id")
        if float(turn["end_seconds"]) <= float(turn["start_seconds"]):
            raise YankersHostError("turn end_seconds must be after start_seconds")
    recordings = [item for item in payload.get("recordings") or [] if item.get("kind") == "call"]
    if len(recordings) != 1:
        raise YankersHostError("call session needs one call recording ref")
    recording = recordings[0]
    if not _REC_ID.fullmatch(str(recording.get("ref_id", ""))):
        raise YankersHostError("invalid recording ref_id")
    if int(recording.get("sample_rate", 0)) != SAMPLE_RATE:
        raise YankersHostError("recordings use 24000 Hz")
    persona = payload.get("personaplex") or {}
    if int(persona.get("sample_rate", 0)) != SAMPLE_RATE:
        raise YankersHostError("PersonaPlex calls use 24000 Hz")
    if "Do not read a script." not in str(persona.get("text_prompt", "")):
        raise YankersHostError("PersonaPlex text_prompt must be an outline, not a script")
    consent = payload.get("consent_snapshot") or {}
    if not consent.get("opted_in"):
        raise YankersHostError("recorded calls keep the consent snapshot")


def _walk_phones(value: Any, found: list[str]) -> None:
    if isinstance(value, str):
        for pattern in _PHONE_PATTERNS:
            found.extend(pattern.findall(value))
        return
    if isinstance(value, Mapping):
        for item in value.values():
            _walk_phones(item, found)
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            _walk_phones(item, found)
