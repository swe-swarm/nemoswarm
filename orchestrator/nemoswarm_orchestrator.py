#!/usr/bin/env python3
"""
Nemoswarm Orchestrator -- runs on anton (10.1.0.4)
Manages LiveKit rooms and Nemotron agents across:
  - anton (10.1.0.4:7880) -- RTX 5090, 64-core TR 3990X
  - antonjr1 (10.1.0.5:7880) -- 2x RTX A4000, 32-core TR 3970X
  - antonjr2 (10.1.0.6:7880) -- RTX 4090, 32-core TR 3970X
  - framer (10.1.8.66:7880) -- legacy LiveKit (Docker)

Orchestrates multi-node reasoning swarms via LiveKit data channels.
"""
import os
import sys
import json
import asyncio
import argparse
import logging
import subprocess
from datetime import datetime, timezone
from typing import Dict, List, Optional

import httpx

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("orchestrator")

# Cluster topology
NODES = {
    "anton":    {"ip": "10.1.0.4",  "lk_port": 7880, "llm_port": 30000, "gpu": "RTX 5090 (32GB)",  "cores": 128, "role": "coordinator"},
    "antonjr1": {"ip": "10.1.0.5",  "lk_port": 7880, "llm_port": 30000, "gpu": "2x RTX A4000 (32GB)", "cores": 64, "role": "processor"},
    "antonjr2": {"ip": "10.1.0.6",  "lk_port": 7880, "llm_port": 30000, "gpu": "RTX 4090 (24GB)",  "cores": 64, "role": "validator"},
    "framer":   {"ip": "10.1.8.66", "lk_port": 7880, "llm_port": None,  "gpu": "none",             "cores": 0,  "role": "legacy"},
}

API_KEY = "nemoswarm"
API_SECRET = "darbotlivekit2026secretkey"


async def check_node_health(name: str, info: dict) -> dict:
    """Check LiveKit server and LLM health on a node."""
    result = {"name": name, "ip": info["ip"], "role": info["role"], "livekit": False, "llm": False}
    async with httpx.AsyncClient(timeout=5.0) as client:
        # LiveKit health
        try:
            r = await client.get(f"http://{info['ip']}:{info['lk_port']}")
            result["livekit"] = r.status_code < 500
            result["livekit_version"] = "v1.9.11"
        except Exception:
            pass
        # LLM health
        if info["llm_port"]:
            try:
                r = await client.get(f"http://{info['ip']}:{info['llm_port']}/health")
                result["llm"] = r.status_code == 200
            except Exception:
                pass
    return result


async def cluster_status() -> List[dict]:
    """Get health status of all nodes."""
    tasks = [check_node_health(name, info) for name, info in NODES.items()]
    return await asyncio.gather(*tasks)


async def send_to_room(node_ip: str, port: int, room: str, message: str, identity: str = "orchestrator"):
    """Send a message to a LiveKit room's data channel via the LLM on that node."""
    # For now, we use the LLM endpoint to generate and the data channel to broadcast
    # Full implementation would use livekit Python SDK to join room and publish
    log.info(f"Sending to {node_ip}:{port} room={room}: {message[:50]}...")


def ssh_cmd(host: str, cmd: str) -> str:
    """Execute SSH command on remote host."""
    result = subprocess.run(
        ["ssh", "-o", "StrictHostKeyChecking=no", f"darbot@{host}", cmd],
        capture_output=True, text=True, timeout=30,
    )
    return result.stdout.strip()


async def orchestrate_swarm(prompt: str, room: str = "nemoswarm", nodes: List[str] = None):
    """
    Orchestrate a multi-node reasoning swarm:
    1. Check all nodes healthy
    2. Create room on each node's LiveKit
    3. Dispatch prompt to each node's LLM in turn order
    4. Collect and synthesize responses
    """
    target_nodes = nodes or ["antonjr2", "antonjr1", "anton"]
    log.info(f"Orchestrating swarm: room={room}, nodes={target_nodes}")

    # Health check
    status = await cluster_status()
    healthy = {s["name"]: s for s in status if s["livekit"] and (s["llm"] or s["role"] == "legacy")}
    log.info(f"Healthy nodes: {list(healthy.keys())}")

    responses = {}
    context_so_far = ""

    for node_name in target_nodes:
        if node_name not in healthy:
            log.warning(f"Skipping {node_name} -- not healthy")
            continue

        info = NODES[node_name]
        if not info["llm_port"]:
            continue

        # Build context-enriched prompt
        if context_so_far:
            enriched = (
                f"Previous agents responded:\n{context_so_far}\n\n"
                f"Now it is your turn, {node_name.upper()}. "
                f"Give your unique perspective on: {prompt}"
            )
        else:
            enriched = prompt

        messages = [
            {"role": "system", "content": f"You are {node_name.upper()}, a collaborative AI agent in Nemoswarm."},
            {"role": "user", "content": enriched},
        ]

        log.info(f"Calling {node_name} ({info['ip']}:{info['llm_port']})...")
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                r = await client.post(
                    f"http://{info['ip']}:{info['llm_port']}/v1/chat/completions",
                    json={"model": "nemotron", "messages": messages, "max_tokens": 1000, "temperature": 0.7, "stream": False},
                )
                if r.status_code == 200:
                    content = r.json()["choices"][0]["message"]["content"]
                    responses[node_name] = content
                    context_so_far += f"\n[{node_name.upper()}]: {content}\n"
                    log.info(f"{node_name} responded: {len(content)} chars")
                else:
                    log.error(f"{node_name} returned HTTP {r.status_code}")
        except Exception as e:
            log.error(f"{node_name} failed: {e}")

    return {
        "room": room,
        "prompt": prompt,
        "responses": responses,
        "node_count": len(responses),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


async def manage_framer(action: str):
    """Manage services on framer via SSH from anton."""
    framer = NODES["framer"]["ip"]
    if action == "status":
        return ssh_cmd(framer, "docker ps --format '{{.Names}}\\t{{.Status}}'")
    elif action == "restart-livekit":
        return ssh_cmd(framer, "docker restart livekit-server")
    elif action == "restart-agents":
        return ssh_cmd(framer, "docker restart nemotron-anton nemotron-antonjr1 nemotron-antonjr2")
    elif action == "logs":
        return ssh_cmd(framer, "docker logs --tail 20 livekit-server")
    else:
        return f"Unknown action: {action}"


async def main():
    parser = argparse.ArgumentParser(description="Nemoswarm Orchestrator")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("status", help="Check cluster health")
    sub.add_parser("topology", help="Show cluster topology")

    swarm_p = sub.add_parser("swarm", help="Run multi-node reasoning swarm")
    swarm_p.add_argument("prompt", help="Prompt to send to the swarm")
    swarm_p.add_argument("--room", default="nemoswarm")
    swarm_p.add_argument("--nodes", nargs="+", default=None)

    framer_p = sub.add_parser("framer", help="Manage framer services")
    framer_p.add_argument("action", choices=["status", "restart-livekit", "restart-agents", "logs"])

    yank_p = sub.add_parser("yankers", help="Run an AgentYankers call on the cluster LiveKit host")
    yank_p.add_argument("--fixture", required=True, help="Fictional call bundle JSON")
    yank_p.add_argument("--mark", default=None, help="mark_id to call")
    yank_p.add_argument("--out", required=True, help="Directory for call_session.json and the call wav")
    yank_p.add_argument("--live", action="store_true", help="Open a real LiveKit room and load PersonaPlex")

    args = parser.parse_args()

    if args.command == "status":
        results = await cluster_status()
        for r in results:
            lk = "OK" if r["livekit"] else "DOWN"
            llm = "OK" if r["llm"] else ("N/A" if NODES[r["name"]]["role"] == "legacy" else "DOWN")
            print(f"  {r['name']:12s} {r['ip']:12s} {r['role']:12s} LK={lk:4s} LLM={llm:4s} {NODES[r['name']]['gpu']}")

    elif args.command == "topology":
        print("Nemoswarm Cluster Topology")
        print("=" * 70)
        for name, info in NODES.items():
            marker = " ** COORDINATOR **" if info["role"] == "coordinator" else ""
            print(f"  {name:12s} {info['ip']:12s} {info['gpu']:25s} {info['cores']:3d} cores{marker}")

    elif args.command == "swarm":
        result = await orchestrate_swarm(args.prompt, args.room, args.nodes)
        print(json.dumps(result, indent=2))

    elif args.command == "framer":
        output = await manage_framer(args.action)
        print(output)

    elif args.command == "yankers":
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if root not in sys.path:
            sys.path.insert(0, root)
        from orchestrator.agentyankers.session import run_fixture_cli
        run_fixture_cli(args)

    else:
        parser.print_help()


if __name__ == "__main__":
    asyncio.run(main())