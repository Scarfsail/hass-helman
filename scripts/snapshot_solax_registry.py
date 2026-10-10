"""Refresh dev/solax_modbus/registry_snapshot.json from prod's entity registry.

Writes ``{"<entry title>": {"<entity_id>": {"unique_id": ..., "device": "<device
name>"}, ...}, ...}`` for every ``solax_modbus`` registry row on prod, grouped by
its config entry's title. Keyed by entity id, because one unique id can be
registered in several domains (the EV charger's ``control_command`` sensor and
select). Only ids and device names are written; the token is read from the
environment and never stored.

    HASS_PROD_TOKEN=... .venv/bin/python -I scripts/snapshot_solax_registry.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import aiohttp

PROD_WS_URL = "ws://192.168.0.44:8123/api/websocket"
DOMAIN = "solax_modbus"
SNAPSHOT_PATH = (
    Path(__file__).resolve().parents[1] / "dev" / DOMAIN / "registry_snapshot.json"
)


async def _call(ws: aiohttp.ClientWebSocketResponse, msg_id: int, **payload):
    await ws.send_json({"id": msg_id, **payload})
    while True:
        reply = await ws.receive_json()
        if reply.get("id") != msg_id:
            continue
        if not reply.get("success"):
            raise RuntimeError(f"{payload['type']} failed: {reply.get('error')}")
        return reply["result"]


async def fetch_snapshot(token: str) -> dict[str, dict[str, dict[str, str]]]:
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(PROD_WS_URL) as ws:
            await ws.receive_json()  # auth_required
            await ws.send_json({"type": "auth", "access_token": token})
            auth = await ws.receive_json()
            if auth.get("type") != "auth_ok":
                raise RuntimeError(f"authentication failed: {auth.get('message')}")

            entries = await _call(ws, 1, type="config_entries/get", domain=DOMAIN)
            rows = await _call(ws, 2, type="config/entity_registry/list")
            devices = await _call(ws, 3, type="config/device_registry/list")

    titles = {entry["entry_id"]: entry["title"] for entry in entries}
    device_names = {
        device["id"]: device["name_by_user"] or device["name"] for device in devices
    }
    snapshot: dict[str, dict[str, dict[str, str]]] = {
        title: {} for title in titles.values()
    }
    for row in rows:
        if row["platform"] == DOMAIN and row["config_entry_id"] in titles:
            snapshot[titles[row["config_entry_id"]]][row["entity_id"]] = {
                "unique_id": row["unique_id"],
                "device": device_names.get(row["device_id"]),
            }
    return snapshot


def main() -> int:
    token = os.environ.get("HASS_PROD_TOKEN")
    if not token:
        print("error: set HASS_PROD_TOKEN to a prod long-lived token", file=sys.stderr)
        return 2
    snapshot = asyncio.run(fetch_snapshot(token))
    if not any(snapshot.values()):
        print(f"error: no {DOMAIN} rows on prod; snapshot left unchanged", file=sys.stderr)
        return 1
    SNAPSHOT_PATH.write_text(
        json.dumps(snapshot, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    for title, ids in sorted(snapshot.items()):
        print(f"{title}: {len(ids)} rows")
    print(f"wrote {SNAPSHOT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
