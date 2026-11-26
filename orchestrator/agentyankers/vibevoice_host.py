"""VibeVoice voiceover injection for AgentYankers host commentary.

Satisfies ``VoiceoverRenderer.render(line, sample_rate)``. Voice files stay in
the genaid-voices library (``GENAID_VOICES_DIR``). This module resolves a
relative path and passes it to an injected engine. It does not copy the asset.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from orchestrator.agentyankers.contract import (
    DOCUMENTED_VOICE_ROOT,
    ENV_VIBEVOICE_MODEL,
    ENV_VOICES_DIR,
    SAMPLE_RATE,
    VibeVoiceRuntimeUnavailable,
    YankersHostError,
    assert_no_phone_numbers,
)
from orchestrator.agentyankers.personaplex_host import tone


@dataclass(frozen=True)
class ResolvedVoice:
    voice_id: str
    library: str
    provider: str
    relative_path: str
    absolute_path: str
    exists: bool
    root: str


class NemoswarmVibeVoiceRenderer:
    """Render one host line with an injected VibeVoice engine."""

    def __init__(
        self,
        engine: Any | None = None,
        *,
        live: bool = False,
        root: str | Path | None = None,
        require_exists: bool | None = None,
    ) -> None:
        self.engine = engine
        self.live = live
        self.root = root
        self.require_exists = live if require_exists is None else require_exists
        self.rendered: list[str] = []

    def render(self, line: Any, sample_rate: int) -> list[float]:
        if sample_rate != SAMPLE_RATE:
            raise ValueError("voiceover sample rate must be 24000")
        voice = line.voice
        if getattr(voice, "provider", None) != "vibevoice":
            raise ValueError("host commentary uses a vibevoice voice from genaid-voices")
        assert_no_phone_numbers(line.text, field="commentary line")
        resolved = resolve_voice(voice, root=self.root, require_exists=self.require_exists)
        engine = self.engine
        if engine is None and self.live:
            engine = load_optional_vibevoice()
        if engine is None:
            if self.live:
                raise VibeVoiceRuntimeUnavailable(
                    "VibeVoice synthesis is not bundled in nemoswarm. "
                    "Inject a VoiceoverRenderer. "
                    f"Voice id {resolved.voice_id} ({resolved.library}) is the reference. "
                    f"Model env {ENV_VIBEVOICE_MODEL}."
                )
            self.rendered.append(resolved.voice_id)
            frequency = 160.0 + (sum(ord(char) for char in resolved.voice_id) % 280)
            return tone(sample_rate, 0.25, frequency)
        audio = _invoke_engine(engine, line, resolved, sample_rate)
        self.rendered.append(resolved.voice_id)
        if not audio:
            raise YankersHostError("VibeVoice returned empty audio")
        return audio


def voice_library_root(root: str | Path | None = None) -> Path:
    if root is not None:
        return Path(root)
    configured = os.environ.get(ENV_VOICES_DIR, "").strip()
    if configured:
        return Path(configured)
    return Path(DOCUMENTED_VOICE_ROOT)


def resolve_voice(voice: Any, *, root: str | Path | None = None, require_exists: bool = False) -> ResolvedVoice:
    """Resolve a voice id to a path inside the voice library. The file is not copied."""
    relative = getattr(voice, "relative_path", None)
    if relative is None and isinstance(voice, dict):
        relative = voice.get("relative_path")
    voice_id = voice["voice_id"] if isinstance(voice, dict) else voice.voice_id
    library = voice["library"] if isinstance(voice, dict) else voice.library
    provider = voice["provider"] if isinstance(voice, dict) else voice.provider
    if not relative:
        raise ValueError(f"voice {voice_id} has no library path")
    library_root = voice_library_root(root)
    absolute = _safe_join(library_root, str(relative))
    exists = absolute.is_file()
    if require_exists and not exists:
        raise FileNotFoundError(f"voice asset not in library: {voice_id} ({relative})")
    return ResolvedVoice(
        voice_id=str(voice_id),
        library=str(library),
        provider=str(provider),
        relative_path=str(relative).replace("\\", "/"),
        absolute_path=str(absolute),
        exists=exists,
        root=str(library_root),
    )


def load_optional_vibevoice() -> Any | None:
    """Import a VibeVoice engine when ``GENAID_MODEL_BASE`` is set. Weights stay outside this repo."""
    model_base = os.environ.get(ENV_VIBEVOICE_MODEL, "").strip()
    if not model_base:
        return None
    candidates = (
        ("genaid_audio.vibevoice_native", "VibeVoiceNativeEngine"),
        ("genaid_audio.serve_app", "VibeVoiceWorker"),
    )
    for module_name, class_name in candidates:
        try:
            module = __import__(module_name, fromlist=[class_name])
            cls = getattr(module, class_name)
        except (ImportError, AttributeError):
            continue
        try:
            return cls(model_base=model_base)
        except TypeError:
            continue
    return None


def _invoke_engine(engine: Any, line: Any, resolved: ResolvedVoice, sample_rate: int) -> list[float]:
    if hasattr(engine, "render"):
        rendered = engine.render(line, sample_rate)
        return _as_float_list(getattr(rendered, "audio", rendered))
    payload = {
        "text": line.text,
        "speaker_name": resolved.voice_id,
        "voice_prompt_path": resolved.absolute_path,
        "output_format": "wav",
        "model_provider": "vibevoice",
        "audio_profile": "podcast_studio",
        "sample_rate": sample_rate,
    }
    if hasattr(engine, "synthesize"):
        return _as_float_list(engine.synthesize(**payload))
    if hasattr(engine, "generate"):
        return _as_float_list(engine.generate(**payload))
    raise VibeVoiceRuntimeUnavailable(
        "Injected VibeVoice engine has no render, synthesize, or generate method. "
        f"Model env {ENV_VIBEVOICE_MODEL}."
    )


def _safe_join(root: Path, relative: str) -> Path:
    parts = Path(relative).parts
    if not relative or Path(relative).is_absolute() or ".." in parts:
        raise ValueError("voice path must stay inside the voice library root")
    root_resolved = root.resolve()
    candidate = (root_resolved / relative).resolve()
    if candidate != root_resolved and root_resolved not in candidate.parents:
        raise ValueError("voice path must stay inside the voice library root")
    return candidate


def _as_float_list(audio: Any) -> list[float]:
    if hasattr(audio, "audio"):
        audio = audio.audio
    tolist = getattr(audio, "tolist", None)
    if tolist is not None:
        audio = tolist()
    return [float(sample) for sample in list(audio)]
