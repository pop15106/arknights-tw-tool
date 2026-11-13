"""以本機 Pillow 預處理與 Windows OCR 產生私人候選證據，不執行網路請求。"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image, ImageOps


def ensure_local_path(path: Path) -> Path:
    """先按文字路徑檢查各層，避免 resolve 先跟隨 junction 到其他位置。"""
    if str(path).startswith(("\\\\", "//")):
        raise ValueError("只接受本機路徑，不接受網路或裝置路徑。")
    absolute = Path(os.path.abspath(path))
    for component in reversed((absolute, *absolute.parents)):
        try:
            attributes = component.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(attributes.st_mode) or getattr(attributes, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError("路徑含符號連結或重新解析點，已停止。")
    return absolute


def prepare_output_directory(project: Path, requested: Path) -> Path:
    private = ensure_local_path(project / "private-fixtures")
    output = ensure_local_path(requested)
    if output == private or not output.is_relative_to(private):
        raise ValueError("結果只允許寫入本專案 private-fixtures 下的新執行目錄。")
    if output.exists():
        raise ValueError("輸出目錄已存在；請指定新的執行目錄，不覆寫任何既有檔案。")
    output.mkdir(parents=True, exist_ok=False)
    ensure_local_path(output)
    return output


def write_new_json(path: Path, value: object) -> None:
    ensure_local_path(path)
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)


def preprocess_images(files: list[Path], processed: Path, variants: list[str]) -> list[dict]:
    if not variants or len(variants) != len(set(variants)) or any(v not in {"original", "upscale2", "invert2", "namecolumn2"} for v in variants):
        raise ValueError("僅支援不重複的 original、upscale2、invert2、namecolumn2。")
    processed = ensure_local_path(processed)
    images = []
    seen_hashes: set[str] = set()
    for input_path in files:
        path = ensure_local_path(input_path)
        if not path.is_file() or path.stat().st_size > 20 * 1024 * 1024:
            raise ValueError("輸入必須為 20 MB 以下的圖片檔。")
        with path.open("rb") as stream:
            content = stream.read(20 * 1024 * 1024 + 1)
        if len(content) > 20 * 1024 * 1024:
            raise ValueError("輸入超過 20 MB，已停止。")
        digest = hashlib.sha256(content).hexdigest()
        if digest in seen_hashes:
            continue
        asset_id = "image-" + digest[:20]
        # 雜湊、前處理與原始變體均使用同一份位元組快照，不再重讀來源圖。
        with Image.open(io.BytesIO(content)) as source:
            extension = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}.get(source.format)
            if extension is None or source.width > 4000 or source.height > 4000:
                raise ValueError("僅接受單邊 4000 像素以下的 JPEG、PNG、WebP 圖片。")
            if source.getexif().get(274, 1) != 1:
                raise ValueError("此研究版尚未驗證 EXIF 旋轉或鏡射，已停止。")
            if "namecolumn2" in variants and source.size != (589, 1280):
                raise ValueError("namecolumn2 只接受已定義的 589 × 1280 版型。")
            source.load()
            image = source.convert("RGB")
        snapshot = ensure_local_path(processed / f"{asset_id}-source{extension}")
        with snapshot.open("xb") as stream:
            stream.write(content)
        entries = []
        for variant in variants:
            offset_x = offset_y = 0
            if variant == "original":
                variant_path, scale = snapshot, 1
            else:
                scale = 2
                base = image
                if variant == "namecolumn2":
                    offset_x, offset_y = 104, 258
                    base = image.crop((104, 258, 245, 1237))
                enlarged = base.resize((base.width * 2, base.height * 2), Image.Resampling.LANCZOS)
                if variant == "invert2":
                    enlarged = ImageOps.invert(ImageOps.grayscale(enlarged)).convert("RGB")
                variant_path = ensure_local_path(processed / f"{asset_id}-{variant}.png")
                with variant_path.open("xb") as stream:
                    enlarged.save(stream, format="PNG")
            entries.append({"name": variant, "scale": scale, "path": str(variant_path), "offsetX": offset_x, "offsetY": offset_y})
        images.append({"assetId": asset_id, "sha256": digest, "label": path.name, "width": image.width,
                       "height": image.height, "sourcePath": str(snapshot), "variants": entries})
        seen_hashes.add(digest)
    return images


def main() -> int:
    parser = argparse.ArgumentParser(description="多圖本機 OCR；輸出只可放在 private-fixtures。")
    parser.add_argument("--input-directory", type=Path, required=True)
    parser.add_argument("--pattern", default="*.jpg")
    parser.add_argument("--output-directory", type=Path, default=Path("private-fixtures/screenshots"))
    parser.add_argument("--variants", default="original,upscale2,invert2")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    source_dir = ensure_local_path(args.input_directory)
    if not source_dir.is_dir():
        raise ValueError("輸入目錄不存在。")
    files = sorted(source_dir.glob(args.pattern))
    if not files or len(files) > 100:
        raise ValueError("需要 1 至 100 張圖片。")
    variants = args.variants.split(",")
    output = prepare_output_directory(project, args.output_directory)
    processed = output / "processed"
    processed.mkdir(exist_ok=False)
    images = preprocess_images(files, processed, variants)
    manifest = output / "input-manifest.json"
    write_new_json(manifest, {"images": images})
    powershell = Path("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
    started = time.perf_counter()
    # 使用一般命令執行自撰腳本，不變更或略過任何 ExecutionPolicy 設定。
    script = (project / "scripts/ocr-windows.ps1").read_text(encoding="utf-8-sig")
    quote = lambda value: "'" + str(value).replace("'", "''") + "'"
    command = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & {\n" + script + "\n} -InputManifest " + quote(manifest) + " -OutputPath " + quote(output / "raw-ocr.json")
    # 內嵌執行沒有 PSScriptRoot，因此只替換此自製腳本的專案目錄變數。
    command = command.replace("$PSScriptRoot", quote(project / "scripts"))
    encoded = base64.b64encode(command.encode("utf-16-le")).decode("ascii")
    subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], check=True, timeout=600)
    duration = time.perf_counter() - started
    write_new_json(output / "run-summary.json", {"images": len(images), "variants": variants,
        "ocrWallSeconds": round(duration, 3), "networkRequestsByTool": 0,
        "note": "networkRequestsByTool 表示工具未實作網路呼叫，不是封包側錄證明。"})
    print(f"本機辨識完成：{len(images)} 張、{len(variants)} 種處理，OCR 共 {duration:.2f} 秒。")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        print(f"未完成：本機 OCR 程序傳回錯誤碼 {error.returncode}，請檢查上方錯誤。", file=sys.stderr)
        raise SystemExit(1)
    except subprocess.TimeoutExpired:
        print("未完成：本機 OCR 程序超過 600 秒，已停止。", file=sys.stderr)
        raise SystemExit(1)
    except (OSError, subprocess.SubprocessError):
        print("未完成：本機檔案或程序操作失敗，未覆寫既有檔案。", file=sys.stderr)
        raise SystemExit(1)
    except ValueError as error:
        print(f"未完成：{error}", file=sys.stderr)
        raise SystemExit(1)
