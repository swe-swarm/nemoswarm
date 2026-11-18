"""Where an AgentYankers call sits on the anton cluster.

Chain-of-thought order matches the rest of nemoswarm: validator, then
processor, then coordinator (antonjr2, antonjr1, anton). LiveKit credentials
are not stored on the nodes.
"""

from __future__ import annotations

from typing import Callable


# Public cluster map. Ports match orchestrator/nemoswarm_orchestrator.py.
NODES = {
    "anton": {
        "host": "10.1.0.4",
        "livekit_port": 7880,
        "moshi_port": 8998,
        "role": "coordinator",
    },
    "antonjr1": {
        "host": "10.1.0.5",
        "livekit_port": 7880,
        "moshi_port": 8998,
        "role": "processor",
    },
    "antonjr2": {
        "host": "10.1.0.6",
        "livekit_port": 7880,
        "moshi_port": 8998,
        "role": "validator",
    },
}

TURN_ORDER = ("antonjr2", "antonjr1", "anton")
COORDINATOR = "anton"
CALLER_NODE = "antonjr1"
VALIDATOR_NODE = "antonjr2"
PERSONAPLEX_NODE = "anton"
VIBEVOICE_NODE = "anton"
PERSONAPLEX_IDENTITY = "personaplex"


def place_call(*, agent_name: str, mark_identity: str, room_name: str) -> dict[str, str]:
    """Node assignment stamped into the LiveKit room. Values are labels, not secrets."""
    return {
        "show": "AgentYankers",
        "coordinator": COORDINATOR,
        "validator_node": VALIDATOR_NODE,
        "caller_node": CALLER_NODE,
        "personaplex_node": PERSONAPLEX_NODE,
        "vibevoice_node": VIBEVOICE_NODE,
        "personaplex_identity": PERSONAPLEX_IDENTITY,
        "turn_order": ",".join(TURN_ORDER),
        "agent_name": agent_name,
        "mark_identity": mark_identity,
        "room_name": room_name,
    }


def probe_placement(connector: Callable[[str, int], bool] | None = None) -> dict[str, bool]:
    """Check each node's LiveKit port. ``connector(host, port)`` is injectable."""
    connect = connector or _tcp_open
    return {
        name: bool(connect(info["host"], int(info["livekit_port"])))
        for name, info in NODES.items()
    }


def _tcp_open(host: str, port: int) -> bool:
    import socket

    sock = socket.socket()
    sock.settimeout(1.0)
    try:
        sock.connect((host, port))
    except OSError:
        return False
    finally:
        sock.close()
    return True
