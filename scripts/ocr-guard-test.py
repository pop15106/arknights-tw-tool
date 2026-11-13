"""僅用合成圖片測試檔案防護及座標，絕不呼叫 OCR 引擎。"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path

from PIL import Image


PROJECT = Path(__file__).resolve().parents[1]
PRIVATE = PROJECT / "private-fixtures"
SPEC = importlib.util.spec_from_file_location("ocr_batch", PROJECT / "scripts/ocr-batch.py")
assert SPEC and SPEC.loader
BATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BATCH)
POWERSHELL = Path("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")


def ps_quote(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def powershell(command: str) -> subprocess.CompletedProcess[str]:
    encoded = base64.b64encode(command.encode("utf-16-le")).decode("ascii")
    return subprocess.run([str(POWERSHELL), "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                          capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)


class OcrGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        PRIVATE.mkdir(exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="ocr-guard-test-", dir=PRIVATE)
        self.root = Path(self.temporary.name).absolute()
        self.assertTrue(self.root.is_relative_to(PRIVATE))
        self.source = self.root / "source"
        self.source.mkdir()
        self.image = self.source / "synthetic.png"
        Image.new("RGB", (589, 1280), "white").save(self.image)

    def tearDown(self) -> None:
        # 只清除本測試建立且已核對位於私人目錄下的暫存資料夾。
        self.assertTrue(self.root.resolve().is_relative_to(PRIVATE.resolve()))
        self.temporary.cleanup()

    def prepared(self, variants: list[str] | None = None) -> tuple[Path, Path, dict]:
        output = BATCH.prepare_output_directory(PROJECT, self.root / "run")
        processed = output / "processed"
        processed.mkdir()
        images = BATCH.preprocess_images([self.image], processed, variants or ["original", "namecolumn2"])
        manifest = output / "input-manifest.json"
        content = {"images": images}
        BATCH.write_new_json(manifest, content)
        return output, manifest, content

    def validate_ps(self, manifest: Path, output: Path) -> subprocess.CompletedProcess[str]:
        script = (PROJECT / "scripts/ocr-windows.ps1").read_text(encoding="utf-8-sig")
        script = script.replace("$PSScriptRoot", ps_quote(PROJECT / "scripts"))
        command = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & {\n" + script + "\n} -ValidateOnly -InputManifest " + ps_quote(manifest) + " -OutputPath " + ps_quote(output)
        return powershell(command)

    def test_output_must_be_new_private_directory(self) -> None:
        marker = self.source / "keep.txt"
        marker.write_text("保留原內容", encoding="utf-8")
        with self.assertRaises(ValueError):
            BATCH.prepare_output_directory(PROJECT, self.source)
        with self.assertRaises(ValueError):
            BATCH.prepare_output_directory(PROJECT, PROJECT / "outside-guard-test")
        self.assertEqual(marker.read_text(encoding="utf-8"), "保留原內容")

    def test_existing_file_never_overwritten(self) -> None:
        output = self.root / "result.json"
        output.write_text("保留", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            BATCH.write_new_json(output, {"changed": True})
        self.assertEqual(output.read_text(encoding="utf-8"), "保留")

    def test_snapshot_and_name_column_leave_original_unchanged(self) -> None:
        before = self.image.read_bytes()
        output, _, manifest = self.prepared()
        image = manifest["images"][0]
        self.assertEqual(self.image.read_bytes(), before)
        self.assertEqual(image["sha256"], hashlib.sha256(before).hexdigest())
        snapshot = Path(image["sourcePath"])
        self.assertTrue(snapshot.is_relative_to(output))
        self.assertEqual(snapshot.read_bytes(), before)
        variants = {entry["name"]: entry for entry in image["variants"]}
        self.assertEqual(variants["original"]["path"], str(snapshot))
        cropped = variants["namecolumn2"]
        self.assertEqual((cropped["scale"], cropped["offsetX"], cropped["offsetY"]), (2, 104, 258))
        with Image.open(cropped["path"]) as actual:
            self.assertEqual(actual.size, (282, 1958))

    def test_all_unverified_exif_orientations_rejected(self) -> None:
        for orientation in range(2, 9):
            with self.subTest(orientation=orientation):
                source = self.source / f"orientation-{orientation}.jpg"
                exif = Image.Exif(); exif[274] = orientation
                Image.new("RGB", (589, 1280), "white").save(source, exif=exif)
                before = source.read_bytes()
                processed = self.root / f"processed-{orientation}"
                processed.mkdir()
                with self.assertRaisesRegex(ValueError, "EXIF"):
                    BATCH.preprocess_images([source], processed, ["original"])
                self.assertEqual(source.read_bytes(), before)
                self.assertEqual(list(processed.iterdir()), [])

    def test_validate_only_accepts_snapshot_and_creates_no_ocr_output(self) -> None:
        output, manifest, _ = self.prepared()
        target = output / "raw-ocr.json"
        result = self.validate_ps(manifest, target)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(target.exists())
        target.write_text("保留", encoding="utf-8")
        result = self.validate_ps(manifest, target)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(target.read_text(encoding="utf-8"), "保留")
        self.assertNotEqual(self.validate_ps(manifest, self.image).returncode, 0)

    def test_powershell_rejects_forged_source_hash_and_variant_geometry(self) -> None:
        output, manifest, content = self.prepared()
        forged = json.loads(json.dumps(content))
        forged["images"][0]["sha256"] = "0" * 64
        fake_manifest = output / "forged-manifest.json"
        BATCH.write_new_json(fake_manifest, forged)
        self.assertNotEqual(self.validate_ps(fake_manifest, output / "raw-ocr.json").returncode, 0)
        forged = json.loads(json.dumps(content))
        forged["images"][0]["variants"][1]["offsetX"] = 103
        bad_geometry = output / "bad-geometry.json"
        BATCH.write_new_json(bad_geometry, forged)
        self.assertNotEqual(self.validate_ps(bad_geometry, output / "raw-ocr.json").returncode, 0)

    def test_reparse_directory_is_rejected_before_output(self) -> None:
        link = self.root / "junction"
        target = self.root / "target"
        target.mkdir()
        result = powershell("New-Item -ItemType Junction -Path " + ps_quote(link) + " -Target " + ps_quote(target) + " | Out-Null")
        if result.returncode:
            self.skipTest("目前環境無法建立測試 junction")
        try:
            with self.assertRaisesRegex(ValueError, "連結"):
                BATCH.prepare_output_directory(PROJECT, link / "run")
            output, manifest, _ = self.prepared()
            self.assertNotEqual(self.validate_ps(manifest, link / "raw-ocr.json").returncode, 0)
        finally:
            self.assertTrue(link.absolute().is_relative_to(self.root))
            os.rmdir(link)  # 只移除此 junction，沒有遞迴刪除目標。
        self.assertTrue(target.exists())
        self.assertEqual(list(target.iterdir()), [])

    def test_reparse_attribute_is_rejected_without_following_target(self) -> None:
        real_lstat = Path.lstat
        watched = self.root / "untrusted-parent"
        visited = []
        def lstat(path: Path, *args, **kwargs):
            visited.append(path)
            if path == watched:
                return SimpleNamespace(st_mode=0, st_file_attributes=1024)
            return real_lstat(path, *args, **kwargs)
        with patch.object(Path, "lstat", lstat):
            with self.assertRaisesRegex(ValueError, "連結"):
                BATCH.ensure_local_path(watched / "would-follow-target.json")
        self.assertNotIn(watched / "would-follow-target.json", visited)

    def test_powershell_crop_offset_restores_original_coordinates(self) -> None:
        script_path = PROJECT / "scripts/ocr-windows.ps1"
        command = """
        [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
        $tokens=$null; $errors=$null
        $ast=[Management.Automation.Language.Parser]::ParseFile(PATH, [ref]$tokens, [ref]$errors)
        $fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Convert-OcrBounds'}, $true)
        if ($null -eq $fn) { throw '座標函式不存在' }
        . ([scriptblock]::Create($fn.Extent.Text))
        Convert-OcrBounds ([pscustomobject]@{X=12;Y=20;Width=40;Height=30}) 2 104 258 | ConvertTo-Json -Compress
        """.replace("PATH", ps_quote(script_path))
        result = powershell(command)
        self.assertEqual(result.returncode, 0, result.stderr)
        bounds = json.loads(result.stdout)
        self.assertEqual({key: value / 2 for key, value in bounds.items()}, {"x": 110, "y": 268, "width": 20, "height": 15})


if __name__ == "__main__":
    unittest.main(verbosity=2)
