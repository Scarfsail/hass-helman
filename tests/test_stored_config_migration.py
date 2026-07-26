"""Run every config migration against a *real* stored config, not just fixtures.

Fixtures only contain what the author remembered to put in them. A real
`.storage/helman.config` contains what the editor and every past version of it
actually wrote — including keys no reader has ever read.

That is not hypothetical: the conditions unification shipped a reader that
rejects unknown keys, and every fixture test passed while the live config
carried a `params.release` written by an old editor draft. Left unnoticed it
would have failed to read the automation block on the first restart after
upgrading. This file is the guard, so the check happens on every run instead of
when someone thinks of it.

The store is found automatically at the sibling Home Assistant checkout, or via
``HELMAN_STORED_CONFIG``. When there is none — CI, a fresh clone — the test
skips, loudly enough to say why.
"""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from custom_components.helman.automation.config import read_automation_config
from custom_components.helman.automation.migration import migrate_config_document
from custom_components.helman.config_validation import validate_config_document

REPO_ROOT = Path(__file__).resolve().parents[1]

#: Where a developer's Home Assistant instance keeps this integration's config.
#: The dev container mounts the same checkout, so the host path is the live one.
DEFAULT_STORED_CONFIG = REPO_ROOT.parent / "hass-core/config/.storage/helman.config"


def _find_stored_config() -> Path | None:
    override = os.environ.get("HELMAN_STORED_CONFIG")
    if override:
        path = Path(override)
        return path if path.is_file() else None
    return DEFAULT_STORED_CONFIG if DEFAULT_STORED_CONFIG.is_file() else None


def _read_document(path: Path) -> dict:
    """Unwrap Home Assistant's ``Store`` envelope, or take a bare document."""
    payload = json.loads(path.read_text())
    data = payload.get("data") if isinstance(payload, dict) else None
    return data if isinstance(data, dict) else payload


class StoredConfigMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        path = _find_stored_config()
        if path is None:
            self.skipTest(
                "no stored config found; set HELMAN_STORED_CONFIG to a "
                f".storage/helman.config to run this check (looked at {DEFAULT_STORED_CONFIG})"
            )
        self.path = path
        self.document = _read_document(path)

    def test_the_stored_config_migrates_and_reads_back(self) -> None:
        migrated, migrated_ids = migrate_config_document(self.document)

        # The reader is the real gate: it rejects unknown keys, so anything the
        # migration forgot to move or drop fails right here.
        automation = read_automation_config(migrated)
        if automation is not None:
            for optimizer in automation.optimizers:
                self.assertTrue(
                    optimizer.conditions,
                    f"{optimizer.id!r} migrated without a condition group",
                )
        self.assertIsInstance(migrated_ids, list)

    def test_the_migrated_config_passes_full_validation(self) -> None:
        migrated, _ids = migrate_config_document(self.document)

        report = validate_config_document(migrated)

        self.assertTrue(
            report.valid,
            "migrated stored config does not validate:\n"
            + "\n".join(f"  {issue.path}: {issue.message}" for issue in report.errors),
        )

    def test_migrating_an_already_migrated_config_changes_nothing(self) -> None:
        once, _ids = migrate_config_document(self.document)

        twice, migrated_ids = migrate_config_document(once)

        # Migration runs on every load. A second pass must be a no-op, or a
        # dropped `config_version` would rewrite the document under the user.
        self.assertEqual(twice, once)
        self.assertEqual(migrated_ids, [])


if __name__ == "__main__":
    unittest.main()
