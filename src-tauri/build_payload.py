# Zips the console payload from D:\Claude\ddlock into src-tauri\payload.zip
# Run before every cargo build (wired into npm scripts).
# payload.zip is a BUILD ARTIFACT: gitignored, never committed (stays private).
import zipfile, os

SRC = r"D:\Claude\ddlock"
OUT = os.path.join(os.path.dirname(__file__), "payload.zip")
FILES = ["gi_tier1", "gi_tier2", "gi_tier3", "potato", "addons"]

if os.path.exists(OUT):
    os.remove(OUT)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in FILES:
        p = os.path.join(SRC, f)
        if os.path.isfile(p):
            z.write(p, f)
            continue
        for root, _, names in os.walk(p):
            for n in names:
                fp = os.path.join(root, n)
                z.write(fp, os.path.relpath(fp, SRC))
print("wrote", OUT, os.path.getsize(OUT), "bytes")
