#!/usr/bin/env python3
"""Unpack 3D model downloads dropped into the print share's inbox.

Installed by setup-print-share.sh and run by the prints-inbox systemd path unit
whenever something lands in /srv/prints/_inbox (\\\\<server>\\prints\\_inbox).

  model.zip          -> /srv/prints/model/...   (printable files + readme/license)
  part.stl / .3mf    -> /srv/prints/part/part.stl
  the original zip   -> /srv/prints/_processed/ (or _failed/ if it can't be read)

The log is /srv/prints/_processed/extract.log, readable from any device. It
lives outside _inbox on purpose: writing it inside would retrigger the unit.
"""

import os
import re
import shutil
import sys
import time
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath

SHARE = Path(os.environ.get("PRINT_SHARE_DIR", "/srv/prints"))
INBOX = SHARE / "_inbox"
PROCESSED = SHARE / "_processed"
FAILED = SHARE / "_failed"
LOG = PROCESSED / "extract.log"

PRINTABLE = {".stl", ".3mf", ".step", ".stp", ".obj", ".gcode"}
# Kept alongside the models: instructions and the creator's license/credits.
DOCS = {".txt", ".md", ".pdf"}
# Browsers write these while a download is still in progress.
PARTIAL = {".crdownload", ".part", ".partial", ".download", ".tmp"}

SETTLE_SECONDS = 5          # file must stop changing this long before it's touched
MAX_WAIT_SECONDS = 30 * 60  # give up on a download that never finishes
MAX_MEMBERS = 5000          # zip-bomb guards
MAX_UNPACKED_BYTES = 4 * 1024**3


def log(message: str) -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {message}"
    print(line, flush=True)
    PROCESSED.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def safe_name(name: str) -> str:
    """A folder/file name every device on the share can open (Windows is strictest)."""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return cleaned[:100] or "model"


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    for n in range(2, 1000):
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"no free name for {path}")


def is_settled(path: Path) -> bool:
    try:
        return time.time() - path.stat().st_mtime >= SETTLE_SECONDS
    except FileNotFoundError:
        return False


def pending_files() -> list[Path]:
    files = []
    for entry in INBOX.iterdir():
        if not entry.is_file() or entry.name.startswith((".", "~$")):
            continue
        if entry.suffix.lower() in PARTIAL:
            continue
        files.append(entry)
    return files


def extract_zip(archive: Path) -> None:
    target = unique_path(SHARE / safe_name(archive.stem))
    with zipfile.ZipFile(archive) as bundle:
        members = [m for m in bundle.infolist() if not m.is_dir()]
        if len(members) > MAX_MEMBERS or sum(m.file_size for m in members) > MAX_UNPACKED_BYTES:
            raise ValueError("archive is too large to unpack safely")

        wanted = []
        for member in members:
            inner = PurePosixPath(member.filename.replace("\\", "/"))
            # Zip-slip guard: no absolute paths, drive letters, or ".." escapes.
            if inner.is_absolute() or ".." in inner.parts or ":" in inner.parts[0]:
                log(f"  skipped unsafe path {member.filename!r}")
                continue
            if inner.suffix.lower() not in PRINTABLE | DOCS or "__MACOSX" in inner.parts:
                continue
            wanted.append((member, inner.parts))

        # Many zips wrap everything in one top folder; drop it rather than
        # nesting "Model/Model/part.stl".
        tops = {parts[0] for _, parts in wanted}
        if len(tops) == 1 and all(len(parts) > 1 for _, parts in wanted):
            wanted = [(member, parts[1:]) for member, parts in wanted]

        kept = 0
        for member, parts in wanted:
            destination = target.joinpath(*(safe_name(part) for part in parts))
            destination.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(member) as source, open(unique_path(destination), "wb") as sink:
                shutil.copyfileobj(source, sink)
            kept += 1

    if not kept:
        raise ValueError("no printable files (.stl, .3mf, .step, .obj, .gcode) inside")
    log(f"unpacked {archive.name} -> {target.name}/ ({kept} files)")


def file_loose(model: Path) -> None:
    target = unique_path(SHARE / safe_name(model.stem))
    target.mkdir(parents=True)
    shutil.move(str(model), target / safe_name(model.name))
    log(f"filed {model.name} -> {target.name}/")


def handle(path: Path) -> None:
    suffix = path.suffix.lower()
    try:
        if suffix == ".zip":
            extract_zip(path)
            shutil.move(str(path), unique_path(PROCESSED / path.name))
        elif suffix in PRINTABLE:
            file_loose(path)
        else:
            raise ValueError("not a .zip or a printable model file")
    except Exception as error:  # one bad download must not stop the rest
        FAILED.mkdir(parents=True, exist_ok=True)
        if path.exists():
            shutil.move(str(path), unique_path(FAILED / path.name))
        log(f"FAILED {path.name}: {error} (moved to _failed/)")


def main() -> int:
    for folder in (INBOX, PROCESSED, FAILED):
        folder.mkdir(parents=True, exist_ok=True)

    # The path unit fires as soon as a download starts writing, so keep
    # looping until everything in the inbox has finished arriving.
    deadline = time.time() + MAX_WAIT_SECONDS
    while True:
        waiting = False
        for path in pending_files():
            if is_settled(path):
                handle(path)
            else:
                waiting = True
        # A partial file that stopped growing is an abandoned download, not
        # one worth waiting for.
        in_progress = any(
            e.is_file() and e.suffix.lower() in PARTIAL and time.time() - e.stat().st_mtime < 120
            for e in INBOX.iterdir()
        )
        if not (waiting or in_progress) or time.time() > deadline:
            return 0
        time.sleep(SETTLE_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
