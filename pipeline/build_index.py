#!/usr/bin/env python3
# Ported from Ranella-Studio/Nasa-Challenge (first version): pipeline/build_index.py
"""Build the SPHEREx pointing index from NASA's public IRSA S3 archive.

Reads only the first ~20 KB (the FITS header) of one detector-1 file per
SPHEREx pointing, so the whole survey is indexed without downloading images.
Standard library only, so it runs unchanged in GitHub Actions.

    python3 pipeline/build_index.py            # incremental update
    python3 pipeline/build_index.py --full     # rebuild from scratch

Output (web/public/data/):
    pointings.json  metadata: folders, column layout, detector geometry
    pointings.bin   columnar little-endian arrays, one row per pointing
    pointings.pack  the same bytes, each column byte-shuffled, then gzipped
                    (what the site downloads: about half the size)

New releases (qr4, dr2, ...) are found by listing the bucket, and the newest
weeks are listed again on every run, so files NASA adds to a week that is
already indexed are picked up too. When an exposure is in more than one
release, the data release's copy is indexed (see folder_rank).
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import gzip
import json
import math
import os
import re
import struct
import sys
import time
import urllib.parse
import urllib.request

FOLDER_RE = re.compile(r"^[a-z]+\d+/level2/\d{4}W\d{2}_\w{2}/[\w.-]+$")
RELEASE_RE = re.compile(r"^[a-z]+\d+/$")

BUCKET = "https://nasa-irsa-spherex.s3.amazonaws.com/"
RECENT_WEEKS = 3  # week segments listed again on every run
OUT = os.path.join(os.path.dirname(__file__), "..", "web", "public", "data")
MJD0 = 60700.0  # stored times are float32 days since this MJD (2025-01-26)
PC_SCALE = 0.002 / 32767  # PC matrix entries quantized to int16
NAME_RE = re.compile(r"level2_(\d{4}W\d{2}_\w{2})_(\d{4})_(\d)D(\d)_spx_(.+)\.fits$")


def http(url, headers=None, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=headers or {})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # network hiccup or S3 throttling
            if i == tries - 1:
                raise
            time.sleep(2 ** i)


def s3_list(prefix, delimiter=None):
    keys, prefixes, token = [], [], None
    while True:
        q = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if delimiter:
            q["delimiter"] = delimiter
        if token:
            q["continuation-token"] = token
        d = http(BUCKET + "?" + urllib.parse.urlencode(q)).decode()
        keys += re.findall(r"<Key>(.*?)</Key>", d)
        prefixes += re.findall(r"<CommonPrefixes><Prefix>(.*?)</Prefix>", d)
        m = re.search(r"<NextContinuationToken>(.*?)</NextContinuationToken>", d)
        if not m:
            return keys, prefixes
        token = m.group(1)


def parse_cards(raw):
    hdr = {}
    for i in range(0, len(raw) - 79, 80):
        card = raw[i:i + 80].decode("ascii", "replace")
        key = card[:8].strip()
        if key == "END":
            break
        if card[8:10] == "= ":
            hdr[key] = card[10:].split("/")[0].strip().strip("'").strip()
    return hdr


def read_wcs(key):
    """WCS + mid-exposure time of the IMAGE HDU (starts at byte 2880)."""
    hdr, start = {}, 2880
    while "MJD-AVG" not in hdr and start < 2880 + 46080:
        hdr.update(parse_cards(http(BUCKET + key, {"Range": f"bytes={start}-{start + 23039}"})))
        start += 23040
    w = {k: float(hdr[k]) for k in ("CRVAL1", "CRVAL2", "PC1_1", "PC1_2", "PC2_1", "PC2_2", "CRPIX1", "CRPIX2", "MJD-AVG")}
    if not all(math.isfinite(v) for v in w.values()):
        raise ValueError("non-finite WCS value")
    return w


def tan_project(ra0, dec0, ra, dec):
    """Gnomonic projection of (ra, dec) about (ra0, dec0); returns degrees (xi, eta)."""
    r0, d0, r, d = map(math.radians, (ra0, dec0, ra, dec))
    cosc = math.sin(d0) * math.sin(d) + math.cos(d0) * math.cos(d) * math.cos(r - r0)
    xi = math.cos(d) * math.sin(r - r0) / cosc
    eta = (math.cos(d0) * math.sin(d) - math.sin(d0) * math.cos(d) * math.cos(r - r0)) / cosc
    return math.degrees(xi), math.degrees(eta)


def to_pixel(w, ra, dec):
    """Sky -> detector pixel (FITS 1-based) for a TAN WCS (SIP ignored; ~1 px)."""
    xi, eta = tan_project(w["CRVAL1"], w["CRVAL2"], ra, dec)
    a, b, c, d = w["PC1_1"], w["PC1_2"], w["PC2_1"], w["PC2_2"]
    det = a * d - b * c
    return (d * xi - b * eta) / det + w["CRPIX1"], (-c * xi + a * eta) / det + w["CRPIX2"]


def releases():
    """Every release in the bucket (qr2, qr3, and any later one NASA adds)."""
    return sorted(p.rstrip("/") for p in s3_list("", "/")[1] if RELEASE_RE.match(p))


def list_pointings(skip_folders):
    """Map (weekseg, exp) -> {folder, ver, subs} for every detector-1 file."""
    weeks = []
    for rel in releases():
        weeks += s3_list(f"{rel}/level2/", "/")[1]
    weeks = [w for w in weeks if w.count("/") == 3]
    # The newest weeks are listed again even if indexed: NASA can add files
    # (or a reprocessed copy) to a week after it first appears.
    recent = set(sorted(weeks, key=lambda w: w.split("/")[2])[-RECENT_WEEKS:])
    skip_folders = {f for f in skip_folders if f.rsplit("/", 1)[0] + "/" not in recent}

    def versions(week):
        return s3_list(week, "/")[1]

    folders = []
    with cf.ThreadPoolExecutor(32) as ex:
        for vs in ex.map(versions, weeks):
            folders += [v.rstrip("/") for v in vs]
    # Folder names end up in file URLs the web app builds: keep only names in
    # the archive's known shape.
    folders = [f for f in folders if FOLDER_RE.match(f) and f not in skip_folders]
    print(f"{len(weeks)} week segments, {len(folders)} folders to list (new, or in the {RECENT_WEEKS} newest weeks)", flush=True)

    def d1_files(folder):
        return folder, s3_list(folder + "/1/")[0]

    pts = {}
    with cf.ThreadPoolExecutor(32) as ex:
        for folder, keys in ex.map(d1_files, folders):
            for k in keys:
                m = NAME_RE.search(k)
                if not m:
                    continue
                weekseg, exp, sub, _, ver = m.groups()
                p = pts.setdefault((weekseg, int(exp)), {})
                p.setdefault((folder, ver), set()).add(int(sub))
    out = {}
    for key, by_folder in pts.items():
        # A pointing reprocessed in a "retry" folder: keep the most complete, newest copy.
        (folder, ver), subs = max(by_folder.items(), key=lambda kv: (len(kv[1]), kv[0][1][-8:]))
        out[key] = {"folder": folder, "ver": ver, "subs": subs}
    return out, set(folders)


def file_key(folder, weekseg, exp, sub, det, ver):
    return f"{folder}/{det}/level2_{weekseg}_{exp:04d}_{sub}D{det}_spx_{ver}.fits"


def calibrate_detectors(sample):
    """Centers and corners of detectors 2 and 3 in detector-1 pixel coordinates."""
    rows = {2: [], 3: []}

    def one(p):
        k1 = file_key(p["folder"], p["weekseg"], p["exp"], p["sub"], 1, p["ver"])
        w1 = read_wcs(k1)
        res = {}
        for det in (2, 3):
            try:
                wd = read_wcs(file_key(p["folder"], p["weekseg"], p["exp"], p["sub"], det, p["ver"]))
            except Exception:
                continue
            # detector-d pixel axes expressed in detector-1 pixels
            res[det] = to_pixel(w1, wd["CRVAL1"], wd["CRVAL2"])
        return res

    with cf.ThreadPoolExecutor(16) as ex:
        for res in ex.map(one, sample):
            for det, xy in res.items():
                rows[det].append(xy)
    geo = {}
    for det, xs in rows.items():
        xs.sort()
        mx = sorted(x for x, _ in xs)[len(xs) // 2]
        my = sorted(y for _, y in xs)[len(xs) // 2]
        spread = max(math.hypot(x - mx, y - my) for x, y in xs)
        geo[str(det)] = {"x": round(mx, 2), "y": round(my, 2), "n": len(xs), "max_dev_px": round(spread, 2)}
        print(f"detector {det} center in D1 pixels: ({mx:.1f}, {my:.1f}) n={len(xs)} max dev {spread:.1f}px", flush=True)
    return geo


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--threads", type=int, default=96)
    ap.add_argument("--limit", type=int, default=0, help="debug: index only N pointings")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    meta_path, bin_path = os.path.join(OUT, "pointings.json"), os.path.join(OUT, "pointings.bin")

    old_rows, old_meta = [], None
    if not args.full and os.path.exists(meta_path):
        old_meta = json.load(open(meta_path))
        old_rows = decode(old_meta, open(bin_path, "rb").read())
    done_folders = set(old_meta["folders"]) if old_meta else set()

    pts, new_folders = list_pointings(done_folders)
    # A re-listed folder only adds the exposures the index does not have yet.
    have = {(r["folder"], r["exp"]) for r in old_rows}
    todo = []
    for (weekseg, exp), p in sorted(pts.items()):
        if (p["folder"], exp) in have:
            continue
        todo.append({"weekseg": weekseg, "exp": exp, "sub": min(p["subs"]), "subs": p["subs"], "folder": p["folder"], "ver": p["ver"]})
    if args.limit:
        todo = todo[:: max(1, len(todo) // args.limit)]
    print(f"reading {len(todo)} headers", flush=True)

    def work(p):
        try:
            w = read_wcs(file_key(p["folder"], p["weekseg"], p["exp"], p["sub"], 1, p["ver"]))
        except Exception as e:
            print("skip", p["weekseg"], p["exp"], e, flush=True)
            return None
        p.update(w)
        return p

    rows, t0 = [], time.time()
    with cf.ThreadPoolExecutor(args.threads) as ex:
        for i, r in enumerate(ex.map(work, todo)):
            if r:
                rows.append(r)
            if i % 2000 == 0:
                print(f"  {i}/{len(todo)} {time.time() - t0:.0f}s", flush=True)

    folders = sorted(set(old_meta["folders"] if old_meta else []) | {r["folder"] for r in rows} | new_folders)
    geometry = old_meta["detectors"] if old_meta and old_meta.get("detectors") else None
    if geometry is None and rows:
        step = max(1, len(rows) // 60)
        geometry = calibrate_detectors(rows[::step])

    allrows = old_rows + [
        {"mjd": r["MJD-AVG"], "ra": r["CRVAL1"], "dec": r["CRVAL2"],
         "pc": (r["PC1_1"], r["PC1_2"], r["PC2_1"], r["PC2_2"]),
         "folder": r["folder"], "exp": r["exp"], "mask": sum(1 << (s - 1) for s in r["subs"])}
        for r in rows
    ]
    allrows = dedupe(allrows)
    allrows.sort(key=lambda r: r["mjd"])
    write(allrows, folders, geometry, meta_path, bin_path)


def folder_rank(folder):
    """Which copy of an exposure to keep when the archive holds several.

    A data release outranks a quick release: DR1 (November 2026) is NASA's
    reprocessed copy of the QR2 images, made to be used with QR3 as one
    uniformly processed set, and QR2 leaves the archive in February 2027.
    Within one kind the later release wins, then the later folder of a
    reprocessed week ("l2b_retry-..." sorts after "l2b-...").

    >>> dr1, qr2, qr3 = (f"{r}/level2/2025W39_2A/l2b-v27-2026-239" for r in ("dr1", "qr2", "qr3"))
    >>> folder_rank(dr1) > folder_rank(qr3) > folder_rank(qr2)
    True
    >>> folder_rank("dr2/level2/2025W39_2A/l2b-v30-2027-010") > folder_rank(dr1)
    True
    >>> folder_rank("qr10/level2/2027W01_1A/l2b-v30-2027-010") > folder_rank("qr9/level2/2027W01_1A/l2b-v30-2027-010")
    True
    >>> folder_rank("qr2/level2/2025W39_2A/l2b_retry-v20-2025-274") > folder_rank("qr2/level2/2025W39_2A/l2b-v20-2025-273")
    True
    """
    m = re.match(r"([a-z]+)(\d+)/", folder)
    kind, number = (m.group(1), int(m.group(2))) if m else ("", 0)
    return (kind == "dr", number, folder)


def dedupe(rows):
    """One row per exposure. The archive can hold an exposure more than once:
    in a second folder of a reprocessed week, or again in a later release.
    Keep the copy folder_rank puts first, so incremental runs never index the
    same pointing twice.

    >>> rows = [{"folder": f, "exp": 7} for f in ("qr2/level2/2025W39_2A/l2b-v20-2025-273", "dr1/level2/2025W39_2A/l2b-v27-2026-239")]
    >>> [r["folder"].split("/")[0] for r in dedupe(rows)]
    ['dr1']
    >>> [r["folder"].split("/")[0] for r in dedupe(rows[::-1])]
    ['dr1']
    """
    best = {}
    for r in rows:
        key = (r["folder"].split("/")[2], r["exp"])
        if key not in best or folder_rank(r["folder"]) > folder_rank(best[key]["folder"]):
            best[key] = r
    return list(best.values())


COLUMNS = [("t", "f4"), ("ra", "f4"), ("dec", "f4"), ("pc", "i2x4"), ("folder", "u2"), ("exp", "u2"), ("mask", "u1")]
WIDTH = {"f4": 4, "i2x4": 2, "u2": 2, "u1": 1}


def shuffle(blob, n):
    """Within each column, store byte 0 of every value, then byte 1, ... .
    Neighbouring values share their high bytes, so gzip finds long runs:
    2.30 MB packs to 1.28 MB instead of 1.65 MB for plain gzip."""
    out, off = [], 0
    for _, t in COLUMNS:
        w = WIDTH[t]
        seg = blob[off:off + w * n * (4 if t == "i2x4" else 1)]
        out += [seg[k::w] for k in range(w)]
        off += len(seg)
    return b"".join(out)


def write(rows, folders, geometry, meta_path, bin_path):
    n = len(rows)
    fidx = {f: i for i, f in enumerate(folders)}
    parts = [
        struct.pack(f"<{n}f", *[r["mjd"] - MJD0 for r in rows]),
        struct.pack(f"<{n}f", *[r["ra"] for r in rows]),
        struct.pack(f"<{n}f", *[r["dec"] for r in rows]),
        struct.pack(f"<{4 * n}h", *[max(-32767, min(32767, round(v / PC_SCALE))) for r in rows for v in r["pc"]]),
        struct.pack(f"<{n}H", *[fidx[r["folder"]] for r in rows]),
        struct.pack(f"<{n}H", *[r["exp"] for r in rows]),
        struct.pack(f"<{n}B", *[r["mask"] for r in rows]),
    ]
    blob, offsets, off = b"".join(parts), {}, 0
    for (name, _), part in zip(COLUMNS, parts):
        offsets[name] = off
        off += len(part)
    meta = {
        "source": BUCKET,
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": n,
        "mjd0": MJD0,
        "pcScale": PC_SCALE,
        "columns": [{"name": c, "type": t, "offset": offsets[c]} for c, t in COLUMNS],
        "folders": folders,
        "detectors": geometry,
        "detectorSize": 2040,
        "crpix": 1020.5,
        "time_range": [rows[0]["mjd"], rows[-1]["mjd"]] if rows else None,
    }
    # Write both files next to their targets, then swap them in, so a run that
    # dies halfway never leaves a mismatched pair behind.
    pack_path = os.path.join(os.path.dirname(bin_path), "pointings.pack")
    with open(bin_path + ".tmp", "wb") as f:
        f.write(blob)
    with open(pack_path + ".tmp", "wb") as f:
        f.write(gzip.compress(shuffle(blob, n), 9, mtime=0))
    with open(meta_path + ".tmp", "w") as f:
        json.dump(meta, f, indent=1)
    os.replace(bin_path + ".tmp", bin_path)
    os.replace(pack_path + ".tmp", pack_path)
    os.replace(meta_path + ".tmp", meta_path)
    print(f"wrote {n} pointings, {len(blob) / 1e6:.2f} MB", flush=True)


def decode(meta, blob):
    n, off = meta["count"], {c["name"]: c["offset"] for c in meta["columns"]}
    t = struct.unpack_from(f"<{n}f", blob, off["t"])
    ra = struct.unpack_from(f"<{n}f", blob, off["ra"])
    dec = struct.unpack_from(f"<{n}f", blob, off["dec"])
    pc = struct.unpack_from(f"<{4 * n}h", blob, off["pc"])
    folder = struct.unpack_from(f"<{n}H", blob, off["folder"])
    exp = struct.unpack_from(f"<{n}H", blob, off["exp"])
    mask = struct.unpack_from(f"<{n}B", blob, off["mask"])
    return [
        {"mjd": t[i] + meta["mjd0"], "ra": ra[i], "dec": dec[i],
         "pc": tuple(v * meta["pcScale"] for v in pc[4 * i:4 * i + 4]),
         "folder": meta["folders"][folder[i]], "exp": exp[i], "mask": mask[i]}
        for i in range(n)
    ]


if __name__ == "__main__":
    sys.exit(main())
