"""The websocket half of automatic UI refresh.

A card learns that its data was rewritten by subscribing to the integration's
own ``helman/subscribe_updates`` command rather than to the ``helman_data_changed``
bus event: Home Assistant refuses a bus subscription outside its fixed
``SUBSCRIBE_ALLOWLIST`` to a non-admin user, which left a household member with a
normal account looking at cards that never refreshed. These tests pin what that
command has to keep doing -- forward every announcement, ask nobody for admin,
and let go of the bus when the client goes away.

The shared test fakes provide the Home Assistant and connection behavior used here.
"""

from __future__ import annotations

from _fakes import FakeHass as SharedFakeHass

from _fakes import FakeConnection as SharedFakeConnection

import unittest

from custom_components.helman import websockets as websockets_module

from custom_components.helman.const import (  # noqa: E402
    DATA_CHANGED_KIND_PLAN,
    EVENT_DATA_CHANGED,
)

ws_subscribe_updates = websockets_module.ws_subscribe_updates

class FakeEvent:
    def __init__(self, data: dict) -> None:
        self.data = data


class FakeBus:
    """Just enough bus to see a listener attach, fire and detach."""

    def __init__(self) -> None:
        self.listeners: dict[str, list] = {}

    def async_listen(self, event_type: str, listener):
        self.listeners.setdefault(event_type, []).append(listener)

        def _unlisten() -> None:
            self.listeners[event_type].remove(listener)

        return _unlisten

    def fire(self, event_type: str, data: dict) -> None:
        for listener in list(self.listeners.get(event_type, [])):
            listener(FakeEvent(data))


class FakeConnection(SharedFakeConnection):
    def __init__(self, *, is_admin: bool = False) -> None:
        super().__init__()
        self.user = type("User", (), {"is_admin": is_admin, "id": "u1", "name": "Doma"})()
        self.subscriptions: dict[int, object] = {}
        self.messages: list[dict] = []

    def send_result(self, msg_id: int, result: object = None) -> None:
        super().send_result(msg_id, result)

    def send_message(self, message: dict) -> None:
        self.messages.append(message)



class FakeHass(SharedFakeHass):
    def __init__(self) -> None:
        super().__init__()
        self.bus = FakeBus()
        self.data = {}


class DataChangedSubscriptionTests(unittest.TestCase):
    def test_a_non_admin_may_subscribe(self) -> None:
        hass = FakeHass()
        connection = FakeConnection(is_admin=False)

        ws_subscribe_updates(hass, connection, {"id": 7, "type": "helman/subscribe_updates"})

        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results, [(7, None)])
        self.assertIn(7, connection.subscriptions)
        self.assertEqual(len(hass.bus.listeners[EVENT_DATA_CHANGED]), 1)

    def test_an_announcement_reaches_the_client_with_its_kind(self) -> None:
        hass = FakeHass()
        connection = FakeConnection()

        ws_subscribe_updates(hass, connection, {"id": 7, "type": "helman/subscribe_updates"})
        hass.bus.fire(EVENT_DATA_CHANGED, {"kind": DATA_CHANGED_KIND_PLAN})

        self.assertEqual(
            connection.messages,
            [{"id": 7, "type": "event", "event": {"kind": DATA_CHANGED_KIND_PLAN}}],
        )

    def test_unsubscribing_detaches_the_bus_listener(self) -> None:
        hass = FakeHass()
        connection = FakeConnection()

        ws_subscribe_updates(hass, connection, {"id": 7, "type": "helman/subscribe_updates"})
        connection.subscriptions.pop(7)()
        hass.bus.fire(EVENT_DATA_CHANGED, {"kind": DATA_CHANGED_KIND_PLAN})

        self.assertEqual(hass.bus.listeners[EVENT_DATA_CHANGED], [])
        self.assertEqual(connection.messages, [])


if __name__ == "__main__":
    unittest.main()
