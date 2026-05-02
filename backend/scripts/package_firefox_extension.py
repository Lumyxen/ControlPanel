import os
import sys
import zipfile


EXCLUDE_DIRS = {"__pycache__"}
EXCLUDE_SUFFIXES = {".tmp", ".swp", ".DS_Store"}
ZIP_TIMESTAMP = (2026, 1, 1, 0, 0, 0)


def should_include(path):
    parts = set(path.split(os.sep))
    if parts & EXCLUDE_DIRS:
        return False
    return not any(path.endswith(suffix) for suffix in EXCLUDE_SUFFIXES)


def main():
    if len(sys.argv) != 3:
        print("Usage: package_firefox_extension.py <source_dir> <output_xpi>")
        sys.exit(1)

    source_dir = os.path.abspath(sys.argv[1])
    output_xpi = os.path.abspath(sys.argv[2])
    manifest_path = os.path.join(source_dir, "manifest.json")
    if not os.path.isfile(manifest_path):
        print(f"Missing manifest.json in {source_dir}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(os.path.dirname(output_xpi), exist_ok=True)
    files = []
    for root, _, filenames in os.walk(source_dir):
        for filename in filenames:
            abs_path = os.path.join(root, filename)
            rel_path = os.path.relpath(abs_path, source_dir).replace(os.sep, "/")
            if should_include(abs_path):
                files.append((abs_path, rel_path))

    files.sort(key=lambda item: item[1])
    with zipfile.ZipFile(output_xpi, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for abs_path, rel_path in files:
            info = zipfile.ZipInfo(rel_path, ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(abs_path, "rb") as handle:
                archive.writestr(info, handle.read())


if __name__ == "__main__":
    main()
