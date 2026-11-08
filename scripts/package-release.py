"""Package the Windows build and its matching source without local account data."""

import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "apps/client/package.json").read_text())["version"]
OUTPUT = ROOT / "artifacts" / f"Matrix Client {VERSION}"
SOURCE = OUTPUT / f"MatrixClient-{VERSION}-source.zip"
EXCLUDED = {"node_modules", "target", "dist", "gen", "__pycache__", ".git"}


def files(folder, excluded=EXCLUDED):
    for item in sorted(folder.iterdir()):
        if item.name in excluded or (excluded and item.name.startswith(".env")):
            continue
        if item.is_symlink():
            raise ValueError(f"Refusing to package a symlink: {item}")
        if item.is_dir():
            yield from files(item, excluded)
        else:
            yield item


def add_tree(archive, folder, prefix, excluded=EXCLUDED):
    if not folder.is_dir():
        raise FileNotFoundError(f"Missing source directory: {folder}")
    for item in files(folder, excluded):
        archive.write(item, (Path(prefix) / item.relative_to(folder)).as_posix())


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def package():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    frontend = ROOT / "third-party-sources"
    if not frontend.is_dir():
        frontend = ROOT / ".tools/frontend-sources"
    for name in ("react.tar.gz", "tauri.tar.gz"):
        if not (frontend / name).is_file():
            raise FileNotFoundError("Run scripts/prepare-source.ps1 before packaging.")
    notices = ROOT / "third-party-notices"
    if not notices.is_dir():
        notices = ROOT / ".tools/upstream-licenses"

    with zipfile.ZipFile(SOURCE, "w", zipfile.ZIP_DEFLATED, compresslevel=6, strict_timestamps=False) as archive:
        for name in (".gitignore", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "package.json", "README.md", "BUILDING.md", "COPYRIGHT.md", "LICENSE", "Start Matrix Client.cmd"):
            archive.write(ROOT / name, name)
        for name in ("apps", "crates", "scripts", "tests", "docs", "distribution"):
            add_tree(archive, ROOT / name, name)
        add_tree(archive, ROOT / "vendor", "vendor", excluded=set())
        add_tree(archive, frontend, "third-party-sources")
        add_tree(archive, notices, "third-party-notices")
        archive.writestr(".cargo/config.toml", '[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "vendor"\n')

    checksum_files = [p for p in files(OUTPUT) if p.name != "SHA256SUMS.txt"]
    (OUTPUT / "SHA256SUMS.txt").write_text("".join(f"{digest(p)}  {p.relative_to(OUTPUT).as_posix()}\n" for p in checksum_files), encoding="utf-8")
    bundle = ROOT / "artifacts" / f"MatrixClient-{VERSION}-windows-x64.zip"
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED, compresslevel=6, strict_timestamps=False) as archive:
        for item in files(OUTPUT):
            archive.write(item, f"{OUTPUT.name}/{item.relative_to(OUTPUT).as_posix()}", compress_type=zipfile.ZIP_STORED if item.suffix == ".zip" else zipfile.ZIP_DEFLATED)
    bundle.with_suffix(".zip.sha256").write_text(f"{digest(bundle)}  {bundle.name}\n", encoding="utf-8")
    with zipfile.ZipFile(bundle) as archive:
        if archive.testzip() is not None:
            raise ValueError("Release archive failed its integrity check")
    print(f"Packaged app, installer and source: {bundle}")


if __name__ == "__main__":
    package()
