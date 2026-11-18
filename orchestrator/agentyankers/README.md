# AgentYankers call host

This package is the live call host for AgentYankers. The show model stays in the private `genaid_audio.agentyankers` package (`agentyankers/v1`). Nemoswarm opens the LiveKit room, injects PersonaPlex and VibeVoice, and writes the `CallSession` that `EpisodePipeline` consumes.

Voice files are read from `GENAID_VOICES_DIR` (the genaid-voices library). They are not copied into this repo.

## What runs where

| Step | Node | Role |
| --- | --- | --- |
| Consent check | antonjr2 | validator, before any room opens |
| Caller agent | antonjr1 | processor, LiveKit identity of the caller |
| Room, PersonaPlex, VibeVoice | anton | coordinator |

Turn order matches the rest of the cluster: `antonjr2`, `antonjr1`, `anton`.

`NemoswarmLiveKitAdapter` implements `LiveKitAdapter.create_room` / `close_room`. On a live run it uses `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`, joins as the caller, and publishes the recording disclosure on `agentyankers.disclosure`. Secret values are not written into the room spec, the handle, or errors.

`NemoswarmPersonaPlexAdapter` implements `PersonaPlexAdapter.generate`. Inject `genaid_audio.personaplex_native.PersonaPlexNativeEngine`, or set `GENAID_PERSONAPLEX_MODEL_BASE` (plus `GENAID_PERSONAPLEX_SOURCE_ROOT` and `GENAID_PERSONAPLEX_DEPENDENCY_PATH`) so the host can construct it. The request is the published PersonaPlex payload: persona and premise outline, not a script.

`NemoswarmVibeVoiceRenderer` implements `VoiceoverRenderer.render` for host commentary. It resolves a relative path inside the voice library and passes that path to the injected engine.

## Guardrails

Every mark needs `opted_in` and a consent record. A call allows `call` or `call_and_publish`. Publication allows `publish` or `call_and_publish`. The recording disclosure is fixed:

> This is AgentYankers, an adult comedy podcast from DarbotLabs. This call is being recorded. You are on with an automated agent. Say stop if you want the call to end.

It is the first transcript turn. Callers cannot replace it. Marks are addressed with `agent:`, `lk-identity:`, or `room:` refs. Phone numbers are refused, and the error does not include the matched text. This host does not place PSTN calls.

## Dry run

```bash
python3 -m orchestrator.agentyankers \
  --fixture orchestrator/agentyankers/fixtures/lobby-light.json \
  --out /tmp/agentyankers-call
```

That writes `call_session.json` and a 24 kHz mono wav. `EpisodePipeline.assemble` in the core takes the session, and the waveform stored under the recording ref, after a publish-consent check.

`--live` opens a real room and loads PersonaPlex. Without the SDK or the model, the host stops with `credentials_missing`, `livekit_transport_unavailable`, or `personaplex_unavailable`.

```bash
python3 -m unittest orchestrator.agentyankers.test_host
```
