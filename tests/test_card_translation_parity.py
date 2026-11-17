"""The card's English bundle carries every key the Czech one does.

``localize.ts`` falls back to Czech for a key missing from the viewer's
language, so a key added to ``cs.json`` alone shows Czech text to English
users without any error.
"""

import json
from pathlib import Path

import pytest

LOCALIZE = Path(__file__).parent.parent / "frontend" / "cards" / "localize"


def _keys(node: object, prefix: str = "") -> set[str]:
    if not isinstance(node, dict):
        return {prefix}
    keys: set[str] = set()
    for key, value in node.items():
        keys |= _keys(value, f"{prefix}.{key}" if prefix else key)
    return keys


@pytest.mark.parametrize("bundle", ["translations", "editor-translations"])
def test_english_bundle_has_every_czech_key(bundle: str) -> None:
    cs = _keys(json.loads((LOCALIZE / bundle / "cs.json").read_text("utf-8")))
    en = _keys(json.loads((LOCALIZE / bundle / "en.json").read_text("utf-8")))
    assert sorted(cs - en) == []
