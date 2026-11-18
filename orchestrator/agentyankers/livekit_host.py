"""LiveKit room host for AgentYankers.

Satisfies ``LiveKitAdapter``: ``create_room(config) -> {room_id, session_id, room_name}``
and ``close_room(room_id)``. The LiveKit server SDK and the realtime client are
injected. Secrets stay in ``LIVEKIT_URL``, ``LIVEKIT_API_KEY``, and
``LIVEKIT_API_SECRET`` and are never copied into the room spec, the handle, or
error text.
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from typing import Any, Callable

from orchestrator.agentyankers.cluster import place_call
from orchestrator.agentyankers.contract import (
    DISCLOSURE_TOPIC,
    ENV_LIVEKIT_API_KEY,
    ENV_LIVEKIT_API_SECRET,
    ENV_LIVEKIT_URL,
    CredentialsMissing,
    LiveTransportUnavailable,
    public_room_spec,
    recording_disclosure,
)


TokenMinter = Callable[..., str]


class InMemoryLiveKit:
    """Room service stand-in for dry runs. It never opens a socket."""

    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.deleted: list[str] = []
        self.published: list[dict[str, Any]] = []
        self.tokens: list[dict[str, str]] = []

    def create_room(self, **request: Any) -> dict[str, str]:
        record = {
            "sid": f"RM_{request['name']}",
            "name": request["name"],
            "empty_timeout": request.get("empty_timeout"),
            "max_participants": request.get("max_participants"),
            "metadata": request.get("metadata") or {},
        }
        self.created.append(record)
        return {"sid": record["sid"], "name": record["name"]}

    def delete_room(self, *, room: str) -> None:
        self.deleted.append(room)

    def mint_token(self, *, api_key: str, api_secret: str, identity: str, room: str, metadata: str) -> str:
        del api_key, api_secret
        self.tokens.append({"identity": identity, "room": room, "metadata": metadata})
        return f"token-{identity}"

    def join_and_disclose(self, **request: Any) -> dict[str, str]:
        published = {
            "url_present": bool(request.get("url")),
            "token_present": bool(request.get("token")),
            "identity": request.get("identity"),
            "room_name": request.get("room_name"),
            "topic": request.get("topic"),
            "disclosure": request.get("disclosure"),
        }
        self.published.append(published)
        return {"identity": str(request.get("identity") or "")}


class NemoswarmLiveKitAdapter:
    """Open an AgentYankers room on the cluster LiveKit service."""

    def __init__(
        self,
        *,
        live: bool = False,
        rooms: Any | None = None,
        joiner: Any | None = None,
        token_minter: TokenMinter | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        self.live = live
        self.rooms = rooms if rooms is not None else (None if live else InMemoryLiveKit())
        self.joiner = joiner
        self.token_minter = token_minter
        self.env = env
        self.handles: dict[str, dict[str, Any]] = {}
        self.last_placement: dict[str, str] = {}

    def missing_env(self) -> list[str]:
        source = self.env if self.env is not None else os.environ
        missing = []
        for name in (ENV_LIVEKIT_URL, ENV_LIVEKIT_API_KEY, ENV_LIVEKIT_API_SECRET):
            if not str(source.get(name, "")).strip():
                missing.append(name)
        return missing

    def create_room(self, config: Any) -> dict[str, str]:
        spec = public_room_spec(config)
        if self.live:
            missing = self.missing_env()
            if missing:
                raise CredentialsMissing(missing)
        elif self.rooms is None:
            self.rooms = InMemoryLiveKit()

        metadata = {str(key): str(value) for key, value in dict(spec.get("metadata") or {}).items()}
        placement = place_call(
            agent_name=str(spec["agent_identity"]),
            mark_identity=str(spec["mark_identity"]),
            room_name=str(spec["room_name"]),
        )
        metadata.update(placement)
        metadata["disclosure"] = recording_disclosure()
        self._reject_secret_leak(metadata)
        self._reject_secret_leak(spec)

        request = {
            "name": spec["room_name"],
            "empty_timeout": spec["empty_timeout_seconds"],
            "max_participants": spec["max_participants"],
            "metadata": metadata,
        }
        joined = None
        try:
            created = self._create(request)
            token = self._mint(spec["agent_identity"], spec["room_name"], metadata) if self.live else "dry-run"
            if self.live:
                joined = self._join(
                    room_name=spec["room_name"],
                    identity=spec["agent_identity"],
                    token=token,
                    disclosure=metadata["disclosure"],
                )
        except (CredentialsMissing, LiveTransportUnavailable):
            self._abandon(spec["room_name"], joined)
            raise
        except Exception as exc:
            self._abandon(spec["room_name"], joined)
            raise self._clean_transport_error(exc, spec) from None

        room_id = str(created.get("sid") or created.get("room_id") or "")
        if not room_id:
            self._abandon(spec["room_name"], joined)
            raise LiveTransportUnavailable("LiveKit did not return a room sid.", room_spec=spec)
        session_id = f"lk-{spec['room_name']}"
        handle = {
            "room_id": room_id,
            "session_id": session_id,
            "room_name": spec["room_name"],
        }
        self.last_placement = dict(placement)
        self.handles[room_id] = {
            "room_name": spec["room_name"],
            "spec": spec,
            "placement": placement,
            "metadata": metadata,
            "joined": joined,
        }
        self._reject_secret_leak(handle)
        return handle

    def close_room(self, room_id: str) -> None:
        state = self.handles.pop(room_id, None)
        if state is None:
            return
        self._disconnect(state.get("joined"))
        rooms = self.rooms
        if rooms is None:
            return
        rooms.delete_room(room=state["room_name"])

    def _abandon(self, room_name: str, joined: Any) -> None:
        self._disconnect(joined)
        rooms = self.rooms
        if rooms is None:
            return
        delete = getattr(rooms, "delete_room", None)
        if delete is None:
            return
        try:
            delete(room=room_name)
        except Exception:
            return

    def _disconnect(self, joined: Any) -> None:
        if joined is None:
            return
        disconnect = getattr(joined, "disconnect", None)
        if disconnect is None:
            return
        result = disconnect()
        if asyncio.iscoroutine(result):
            _run_sync(result)

    def _create(self, request: dict[str, Any]) -> dict[str, Any]:
        rooms = self.rooms
        if rooms is None:
            rooms = _LiveKitServerRooms(self._credentials())
            self.rooms = rooms
        created = rooms.create_room(**request)
        if asyncio.iscoroutine(created):
            created = _run_sync(created)
        if hasattr(created, "sid"):
            return {"sid": created.sid, "name": getattr(created, "name", request["name"])}
        return dict(created)

    def _mint(self, identity: str, room_name: str, metadata: dict[str, str]) -> str:
        url, api_key, api_secret = self._credentials()
        del url
        body = json.dumps(metadata, sort_keys=True)
        minter = self.token_minter
        if minter is None and self.rooms is not None and hasattr(self.rooms, "mint_token"):
            minter = self.rooms.mint_token
        if minter is None:
            minter = _default_token_minter
        token = minter(
            api_key=api_key,
            api_secret=api_secret,
            identity=identity,
            room=room_name,
            metadata=body,
        )
        if not token or api_secret in str(token):
            raise LiveTransportUnavailable("LiveKit token mint did not return a usable token.")
        return str(token)

    def _join(self, *, room_name: str, identity: str, token: str, disclosure: str) -> Any:
        url, _key, _secret = self._credentials()
        joiner = self.joiner
        if joiner is None and self.rooms is not None and hasattr(self.rooms, "join_and_disclose"):
            joiner = self.rooms
        if joiner is None:
            joiner = LiveKitPythonRtc()
        joined = joiner.join_and_disclose(
            url=url,
            token=token,
            identity=identity,
            room_name=room_name,
            topic=DISCLOSURE_TOPIC,
            disclosure=disclosure,
        )
        if asyncio.iscoroutine(joined):
            joined = _run_sync(joined)
        return joined

    def _credentials(self) -> tuple[str, str, str]:
        source = self.env if self.env is not None else os.environ
        missing = self.missing_env()
        if missing:
            raise CredentialsMissing(missing)
        return (
            str(source[ENV_LIVEKIT_URL]).strip(),
            str(source[ENV_LIVEKIT_API_KEY]).strip(),
            str(source[ENV_LIVEKIT_API_SECRET]).strip(),
        )

    def _reject_secret_leak(self, payload: Any) -> None:
        if not self.live:
            return
        secret = str((self.env if self.env is not None else os.environ).get(ENV_LIVEKIT_API_SECRET, ""))
        if secret and secret in json.dumps(payload):
            raise LiveTransportUnavailable("Refusing to copy LiveKit credentials into the room plan.")

    def _clean_transport_error(self, exc: Exception, spec: dict[str, Any]) -> LiveTransportUnavailable:
        secret = ""
        if self.live:
            secret = str((self.env if self.env is not None else os.environ).get(ENV_LIVEKIT_API_SECRET, ""))
        text = str(exc)
        if secret and secret in text:
            text = "LiveKit transport failed."
        elif not text:
            text = "LiveKit transport failed."
        else:
            text = f"LiveKit transport failed: {text}"
        return LiveTransportUnavailable(text, room_spec=spec)


class _LiveKitServerRooms:
    """Lazy wrapper around ``livekit.api``. Imported only when a live room opens."""

    def __init__(self, credentials: tuple[str, str, str]) -> None:
        self._credentials = credentials

    def create_room(self, **request: Any) -> dict[str, str]:
        api = _import_livekit_api()
        url, key, secret = self._credentials

        async def _open():
            client = api.LiveKitAPI(url, key, secret)
            try:
                room = await client.room.create_room(
                    api.CreateRoomRequest(
                        name=request["name"],
                        empty_timeout=int(request["empty_timeout"]),
                        max_participants=int(request["max_participants"]),
                        metadata=json.dumps(request["metadata"]),
                    )
                )
                return {"sid": room.sid, "name": room.name}
            finally:
                await client.aclose()

        return _run_sync(_open())

    def delete_room(self, *, room: str) -> None:
        api = _import_livekit_api()
        url, key, secret = self._credentials

        async def _close():
            client = api.LiveKitAPI(url, key, secret)
            try:
                await client.room.delete_room(api.DeleteRoomRequest(room=room))
            finally:
                await client.aclose()

        _run_sync(_close())


class LiveKitPythonRtc:
    """Join with ``livekit.rtc`` and publish the recording disclosure."""

    def join_and_disclose(self, **request: Any) -> Any:
        async def _join():
            from livekit import rtc

            room = rtc.Room()
            await room.connect(request["url"], request["token"])
            participant = room.local_participant
            payload = str(request["disclosure"]).encode("utf-8")
            published = participant.publish_data(payload, reliable=True, topic=request["topic"])
            if asyncio.iscoroutine(published):
                await published
            return room

        try:
            return _run_sync(_join())
        except ImportError:
            raise LiveTransportUnavailable(
                "LiveKit credentials are present but the livekit realtime SDK is not installed. "
                "Inject a joiner or install livekit to open the room."
            ) from None


def _default_token_minter(*, api_key: str, api_secret: str, identity: str, room: str, metadata: str) -> str:
    try:
        from livekit import api
    except ImportError:
        raise LiveTransportUnavailable(
            "LiveKit credentials are present but the LiveKit server SDK is not installed. "
            "Inject a token minter or install livekit to open the room."
        ) from None
    token = api.AccessToken(api_key, api_secret)
    token.with_identity(identity)
    token.with_metadata(metadata)
    grants = api.VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,
        can_subscribe=True,
        can_publish_data=True,
    )
    token.with_grants(grants)
    return token.to_jwt()


def _import_livekit_api():
    try:
        from livekit import api
    except ImportError:
        raise LiveTransportUnavailable(
            "LiveKit credentials are present but the LiveKit server SDK is not installed. "
            "Inject a room service or install livekit to open the room."
        ) from None
    return api


def _run_sync(coro):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    box: dict[str, Any] = {}

    def _target() -> None:
        try:
            box["value"] = asyncio.run(coro)
        except Exception as exc:  # noqa: BLE001 — re-raised on the caller thread
            box["error"] = exc

    thread = threading.Thread(target=_target, name="agentyankers-livekit")
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box.get("value")
