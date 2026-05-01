from __future__ import annotations

import json
import unittest

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "custom_components" / "helman" / "manifest.json"


class ManifestTests(unittest.TestCase):
    def test_helman_manifest_declares_service_integration_type(self) -> None:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

        self.assertEqual(manifest.get("integration_type"), "service")


if __name__ == "__main__":
    unittest.main()
