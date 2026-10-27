"""Create a private source ZIP with verified Mac helpers and Unix launcher permissions."""
import hashlib
import io
import json
from pathlib import Path
import stat
import struct
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {"messenger-helper-arm64": 0x0100000C, "messenger-helper-x64": 0x01000007}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Specify the output ZIP path")
    manifest = json.loads((ROOT / "native/bin/prebuilt-manifest.json").read_text())
    source_hash = hashlib.sha256()
    source_dir = ROOT / "native/messenger"
    for path in sorted(source_dir.iterdir(), key=lambda p: p.name):
        if path.name in ("go.mod", "go.sum") or (path.suffix == ".go" and not path.name.endswith("_test.go")):
            data = path.read_bytes()
            source_hash.update(json.dumps([path.name, len(data)], separators=(",", ":"), ensure_ascii=False).encode())
            source_hash.update(data)
    if manifest.get("version") != 1 or manifest.get("sourceDigest") != source_hash.hexdigest():
        raise SystemExit("Native source digest mismatch; rebuild the helpers")
    helpers = {}
    for name, cpu in TARGETS.items():
        data = (ROOT / "native/bin" / name).read_bytes()
        if digest(data) != manifest["files"].get(name):
            raise SystemExit("Native helper checksum mismatch")
        if data[:4] != bytes.fromhex("cffaedfe") or struct.unpack("<I", data[4:8])[0] != cpu:
            raise SystemExit("Native helper Mach-O architecture mismatch")
        helpers[name] = data
    source = subprocess.check_output(["git", "archive", "--format=zip", "HEAD"], cwd=ROOT)
    output = Path(sys.argv[1]).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(source)) as original, zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as result:
        for info in original.infolist():
            data = original.read(info)
            if info.filename.endswith((".command", ".sh")):
                data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o755) << 16
            result.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
        for name, data in {**helpers, "prebuilt-manifest.json": json.dumps(manifest, indent=2).encode()}.items():
            info = zipfile.ZipInfo("native/bin/" + name)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | (0o755 if name in TARGETS else 0o644)) << 16
            result.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED)
    with zipfile.ZipFile(output) as check:
        launcher = check.read("scripts/Build-macOS.command")
        assert launcher.startswith(b"#!/bin/bash\n") and b"\r" not in launcher
        archived_source_hash = hashlib.sha256()
        for path in sorted(source_dir.iterdir(), key=lambda p: p.name):
            if path.name in ("go.mod", "go.sum") or (path.suffix == ".go" and not path.name.endswith("_test.go")):
                data = check.read("native/messenger/" + path.name)
                archived_source_hash.update(json.dumps([path.name, len(data)], separators=(",", ":"), ensure_ascii=False).encode())
                archived_source_hash.update(data)
        assert archived_source_hash.hexdigest() == manifest["sourceDigest"], "Archived source must match the helper manifest"
        for name, data in helpers.items():
            info = check.getinfo("native/bin/" + name)
            assert info.create_system == 3 and (info.external_attr >> 16) & 0o111
            assert digest(check.read(info)) == digest(data)
        assert check.testzip() is None
        assert not any(n.endswith(("state.enc", "master-key.bin", "local.properties")) for n in check.namelist())
    print(json.dumps({"archive": output.name, "bytes": output.stat().st_size, "macHelpers": 2, "unixLauncher": True, "verified": True}))


if __name__ == "__main__":
    main()
