"""PersonaPlex engine injection for AgentYankers caller turns.

Satisfies ``PersonaPlexAdapter.generate(context)``. A host passes
``genaid_audio.personaplex_native.PersonaPlexNativeEngine``. The model root
stays in ``GENAID_PERSONAPLEX_MODEL_BASE``. This module does not load weights
unless that engine is injected or the optional import succeeds.
"""

from __future__ import annotations

import inspect
import math
import os
import shutil
import tempfile
from dataclasses import dataclass
from typing import Any

from orchestrator.agentyankers.contract import (
    ENV_PERSONAPLEX_MODEL,
    SAMPLE_RATE,
    PersonaPlexRuntimeUnavailable,
    YankersHostError,
    assert_no_phone_numbers,
    personaplex_request_payload,
)


@dataclass
class PersonaPlexTurn:
    text: str
    audio: list[float]
    sample_rate: int


class ImprovisationStandIn:
    """Dry-run lines from the agent name and the mark's reply. No model load."""

    stand_in = True

    def reply(self, context: Any, payload: dict[str, Any]) -> PersonaPlexTurn:
        del payload
        text = f"{context.agent_name}, improvising: {str(context.mark_utterance).strip()}"
        assert_no_phone_numbers(text, field="agent turn")
        frequency = 180.0 + (sum(ord(char) for char in context.agent_name) % 200)
        return PersonaPlexTurn(
            text=text,
            audio=tone(context.sample_rate, 0.2, frequency),
            sample_rate=context.sample_rate,
        )


class NemoswarmPersonaPlexAdapter:
    """Call an injected PersonaPlex engine with the published request payload."""

    def __init__(self, engine: Any | None = None, *, live: bool = False, output_dir: str | None = None) -> None:
        self.engine = engine
        self.live = live
        self.output_dir = output_dir
        self.payloads: list[dict[str, Any]] = []

    def generate(self, context: Any) -> PersonaPlexTurn:
        payload = personaplex_request_payload(context)
        self.payloads.append(payload)
        engine = self.engine
        if engine is None and self.live:
            engine = load_optional_personaplex()
        if engine is None:
            if self.live:
                raise PersonaPlexRuntimeUnavailable(
                    "PersonaPlex generation is not bundled in nemoswarm. "
                    "Inject a PersonaPlexAdapter that calls "
                    "genaid_audio.personaplex_native.PersonaPlexNativeEngine. "
                    f"Model root env: {ENV_PERSONAPLEX_MODEL}.",
                    payload=payload,
                )
            engine = ImprovisationStandIn()
        if isinstance(engine, ImprovisationStandIn) or getattr(engine, "stand_in", False):
            turn = engine.reply(context, payload) if hasattr(engine, "reply") else engine.generate(context)
            return _coerce_turn(turn, context)
        return _coerce_turn(self._native(engine, payload), context)

    def _native(self, engine: Any, payload: dict[str, Any]) -> Any:
        request = _as_request(payload)
        directory = self.output_dir or tempfile.mkdtemp(prefix="agentyankers-pp-")
        cleanup = self.output_dir is None
        try:
            if _accepts_keyword(engine.generate, "output_dir"):
                return engine.generate(request, output_dir=directory)
            return engine.generate(request)
        finally:
            if cleanup:
                shutil.rmtree(directory, ignore_errors=True)


def load_optional_personaplex() -> Any | None:
    """Construct ``PersonaPlexNativeEngine`` when the core and the model env are present."""
    model_base = os.environ.get(ENV_PERSONAPLEX_MODEL, "").strip()
    if not model_base:
        return None
    try:
        from genaid_audio.personaplex_native import PersonaPlexNativeEngine
    except ImportError:
        return None
    return PersonaPlexNativeEngine(
        model_base=model_base,
        source_root=os.environ.get("GENAID_PERSONAPLEX_SOURCE_ROOT", ""),
        dependency_path=os.environ.get("GENAID_PERSONAPLEX_DEPENDENCY_PATH", ""),
        device=os.environ.get("GENAID_PERSONAPLEX_DEVICE", "cpu"),
        dtype=os.environ.get("GENAID_PERSONAPLEX_DTYPE", "bfloat16"),
    )


def tone(sample_rate: int, seconds: float, frequency: float) -> list[float]:
    count = max(1, int(round(seconds * sample_rate)))
    return [
        math.sin(2.0 * math.pi * frequency * index / sample_rate) * 0.2
        for index in range(count)
    ]


def _as_request(payload: dict[str, Any]) -> Any:
    try:
        from genaid_audio.personaplex_native import PersonaPlexGenerationRequest
    except ImportError:
        return dict(payload)
    return PersonaPlexGenerationRequest(**payload)


def _accepts_keyword(func: Any, name: str) -> bool:
    """True only when the callable can take ``name`` as a keyword.

    Builtins and other callables without an inspectable signature return False,
    so a required host argument such as ``output_dir`` is not passed blindly.
    """
    try:
        signature = inspect.signature(func)
    except (TypeError, ValueError):
        return False
    for parameter in signature.parameters.values():
        if parameter.kind is inspect.Parameter.VAR_KEYWORD:
            return True
        if parameter.name == name and parameter.kind is not inspect.Parameter.POSITIONAL_ONLY:
            return True
    return False


def _coerce_turn(result: Any, context: Any) -> PersonaPlexTurn:
    if isinstance(result, PersonaPlexTurn):
        text = result.text
        audio = list(result.audio)
        sample_rate = int(result.sample_rate)
    elif hasattr(result, "audio_bytes") and hasattr(result, "diagnostics"):
        audio, sample_rate = _pcm_from_wav_bytes(result.audio_bytes)
        text = str((result.diagnostics or {}).get("generated_text") or "")
    else:
        text = str(getattr(result, "text", "") or "")
        sample_rate = int(getattr(result, "sample_rate", SAMPLE_RATE))
        audio = _as_float_list(getattr(result, "audio", result))
    if not text.strip():
        text = f"{context.agent_name}, improvising: {str(context.mark_utterance).strip()}"
    assert_no_phone_numbers(text, field="agent turn")
    if sample_rate != SAMPLE_RATE:
        raise YankersHostError("PersonaPlex adapter must return 24000 Hz audio")
    if not audio:
        raise YankersHostError("generated audio is empty")
    return PersonaPlexTurn(text=text.strip(), audio=audio, sample_rate=sample_rate)


def _pcm_from_wav_bytes(payload: bytes) -> tuple[list[float], int]:
    import io
    import wave

    with wave.open(io.BytesIO(payload), "rb") as handle:
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
        width = handle.getsampwidth()
    if width != 2:
        raise YankersHostError("PersonaPlex wav audio must be 16-bit")
    import struct

    count = len(frames) // 2
    samples = [sample / 32768.0 for sample in struct.unpack("<" + "h" * count, frames)]
    return samples, rate


def _as_float_list(audio: Any) -> list[float]:
    if isinstance(audio, (bytes, bytearray)):
        samples, _rate = _pcm_from_wav_bytes(bytes(audio))
        return samples
    tolist = getattr(audio, "tolist", None)
    if tolist is not None:
        audio = tolist()
    flat = list(audio)
    if flat and isinstance(flat[0], list):
        flat = [row[0] for row in flat]
    return [float(sample) for sample in flat]
