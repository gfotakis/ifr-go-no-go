#!/usr/bin/env python3
"""IFR Go/No-Go local server.

Serves the app, relays aviationweather.gov (which sends no CORS headers),
resolves routes, and lists published approaches from the FAA d-TPP.

    python3 server.py              # opens http://127.0.0.1:8737
    python3 server.py --no-browser
    PORT=9000 python3 server.py

Reference data is cached in ~/.cache/ifr-go-no-go/:
  OurAirports airports/runways/navaids (refreshed weekly) and the FAA d-TPP
  metafile for the current 28-day cycle.
"""
VERSION = "1.2"

import csv
import datetime as dt
import errno
import http.server
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET

PORT = int(os.environ.get("PORT", 8737))
ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.expanduser("~/.cache/ifr-go-no-go")
UPSTREAM = "https://aviationweather.gov/api/data/"
PRODUCTS = {"metar", "taf", "pirep", "airsigmet", "gairmet", "fix"}
STATIC = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js"}
OURAIRPORTS = "https://davidmegginson.github.io/ourairports-data/"
UA = {"User-Agent": "ifr-go-no-go/1.2 (personal preflight tool)"}
TTL = 120
_wx_cache = {}


# ---------------------------------------------------------------- downloads
def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def cached_file(name, url, max_age_days):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, name)
    fresh = os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age_days * 86400
    if not fresh:
        try:
            data = fetch(url, timeout=120)
            with open(path + ".tmp", "wb") as fh:
                fh.write(data)
            os.replace(path + ".tmp", path)
        except Exception as err:
            if not os.path.exists(path):
                raise RuntimeError(f"couldn't download {url}: {err}")
            print(f"warning: using stale {name}: {err}")
    return path


def nm_between(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 3440.065 * math.asin(math.sqrt(h))


# ---------------------------------------------------------------- reference data
class NavData:
    """Airports, runways and navaids from OurAirports, loaded once."""

    def __init__(self):
        self.lock = threading.Lock()
        self.ready = False
        self.airports = {}   # any ident/code -> airport dict
        self.navaids = {}    # ident -> [navaid dicts]
        self.fixes = {}      # ident -> [fix dicts] (filled lazily from aviationweather)

    def load(self):
        with self.lock:
            if self.ready:
                return
            apt_path = cached_file("airports.csv", OURAIRPORTS + "airports.csv", 7)
            rwy_path = cached_file("runways.csv", OURAIRPORTS + "runways.csv", 7)
            nav_path = cached_file("navaids.csv", OURAIRPORTS + "navaids.csv", 7)
            by_ident = {}
            with open(apt_path, newline="", encoding="utf-8") as fh:
                for r in csv.DictReader(fh):
                    if r["type"] in ("closed", "balloonport"):
                        continue
                    apt = {
                        "kind": "airport", "ident": r["ident"], "name": r["name"],
                        "lat": float(r["latitude_deg"]), "lon": float(r["longitude_deg"]),
                        "elevFt": int(float(r["elevation_ft"])) if r["elevation_ft"] else 0,
                        "icao": r["icao_code"] or (r["gps_code"] if len(r["gps_code"]) == 4 else ""),
                        "faa": r["local_code"], "country": r["iso_country"], "type": r["type"], "runways": [],
                    }
                    by_ident[r["ident"]] = apt
                    for code in {r["ident"], r["icao_code"], r["gps_code"], r["local_code"], r["iata_code"] if r["iso_country"] == "US" else ""}:
                        if not code:
                            continue
                        prev = self.airports.get(code)
                        # prefer US airports and real airports over heliports for shared codes
                        if prev is None or (prev["country"] != "US" and apt["country"] == "US") or (prev["type"] == "heliport" and apt["type"] != "heliport"):
                            self.airports[code] = apt
            with open(rwy_path, newline="", encoding="utf-8") as fh:
                for r in csv.DictReader(fh):
                    apt = by_ident.get(r["airport_ident"])
                    if not apt or r["closed"] == "1":
                        continue
                    hdg = r["le_heading_degT"]
                    if not hdg:
                        m = re.match(r"(\d{1,2})", r["le_ident"] or "")
                        hdg = int(m.group(1)) * 10 if m else None
                    if hdg is None or hdg == "":
                        continue
                    apt["runways"].append({
                        "id": f'{r["le_ident"]}/{r["he_ident"]}', "alignment": float(hdg),
                        "lengthFt": int(r["length_ft"]) if r["length_ft"] else None, "surface": r["surface"],
                    })
            with open(nav_path, newline="", encoding="utf-8") as fh:
                for r in csv.DictReader(fh):
                    self.navaids.setdefault(r["ident"], []).append({
                        "kind": "navaid", "ident": r["ident"], "name": f'{r["name"]} {r["type"]}',
                        "lat": float(r["latitude_deg"]), "lon": float(r["longitude_deg"]),
                        "country": r["iso_country"], "type": r["type"],
                    })
            self.ready = True

    def fix(self, ident):
        if ident not in self.fixes:
            try:
                rows = json.loads(fetch(f"{UPSTREAM}fix?ids={urllib.parse.quote(ident)}&format=json", 20) or b"[]")
            except Exception:
                rows = []
            self.fixes[ident] = [{"kind": "fix", "ident": ident, "name": f"{ident} (fix)", "lat": r["lat"], "lon": r["lon"]} for r in rows]
        return self.fixes[ident]

    @staticmethod
    def nearest(cands, near):
        if not cands:
            return None
        if near is None:
            us = [c for c in cands if c.get("country", "US") == "US"]
            return (us or cands)[0]
        return min(cands, key=lambda c: nm_between((c["lat"], c["lon"]), near))

    def airport(self, code):
        code = code.upper()
        return self.airports.get(code) or (self.airports.get(code[1:]) if len(code) == 4 and code[0] == "K" else None)

    def resolve(self, text):
        self.load()
        tokens = [t for t in re.split(r"[\s,]+", text.upper()) if t and t != "DCT"]
        points, errors, near = [], [], None
        for i, tok in enumerate(tokens):
            end = i in (0, len(tokens) - 1)
            if re.fullmatch(r"[VJTQ]\d{1,4}", tok):
                errors.append(f"{tok} is an airway. Airways aren't expanded yet; list the fixes along it instead.")
                continue
            if re.search(r"\.", tok):  # SID/STAR like PICAN.PICAN2 or MSY.LEV
                errors.append(f"{tok} looks like a procedure. Enter its fixes instead.")
                continue
            apt = self.airport(tok)
            navs = [n for n in self.navaids.get(tok, [])]
            pt = None
            if end and apt:
                pt = apt
            elif len(tok) == 5 and tok.isalpha():
                pt = self.nearest(self.fix(tok), near) or apt
            elif len(tok) <= 3 and navs:
                pt = self.nearest(navs, near)
            else:
                pt = apt or self.nearest(navs, near) or self.nearest(self.fix(tok), near)
            if not pt:
                errors.append(f"{tok} wasn't found as an airport, navaid or fix.")
                continue
            points.append({**{k: v for k, v in pt.items() if k != "runways"}, "token": tok, **({"runways": pt["runways"]} if pt["kind"] == "airport" else {})})
            near = (pt["lat"], pt["lon"])
        if points and points[0]["kind"] != "airport":
            errors.append("The route must start at an airport.")
        if len(points) > 1 and points[-1]["kind"] != "airport":
            errors.append("The route must end at an airport.")
        return {"points": points, "errors": errors}


class Approaches:
    """Instrument approach charts from the FAA d-TPP metafile for the current cycle."""

    REF = dt.date(2026, 1, 22)  # AIRAC 2601

    def __init__(self):
        self.lock = threading.Lock()
        self.cycle = None
        self.index = {}

    @classmethod
    def current_cycle(cls, today=None):
        today = today or dt.datetime.now(dt.timezone.utc).date()
        n = (today - cls.REF).days // 28
        eff = cls.REF + dt.timedelta(days=28 * n)
        first = eff
        while (first - dt.timedelta(days=28)).year == eff.year:
            first -= dt.timedelta(days=28)
        return f"{eff.year % 100:02d}{(eff - first).days // 28 + 1:02d}"

    def load(self):
        cycle = self.current_cycle()
        with self.lock:
            if self.cycle == cycle:
                return
            path = cached_file(f"dtpp-{cycle}.xml", f"https://aeronav.faa.gov/d-tpp/{cycle}/xml_data/d-tpp_Metafile.xml", 400)
            index = {}
            for _, el in ET.iterparse(path, events=("end",)):
                if el.tag != "airport_name":
                    continue
                charts = []
                for rec in el.iter("record"):
                    if (rec.findtext("chart_code") or "") != "IAP":
                        continue
                    pdf = rec.findtext("pdf_name") or ""
                    charts.append({"name": (rec.findtext("chart_name") or "").strip(),
                                   "url": f"https://aeronav.faa.gov/d-tpp/{cycle}/{pdf}"})
                for code in (el.get("apt_ident"), el.get("icao_ident")):
                    if code:
                        index[code] = charts
                el.clear()
            self.index, self.cycle = index, cycle

    def lookup(self, code):
        self.load()
        code = code.upper()
        charts = self.index.get(code) or (self.index.get(code[1:]) if len(code) == 4 and code[0] == "K" else None) or []
        return {"cycle": self.cycle, "charts": charts}


class NbmText:
    """National Blend of Models station bulletins, for flights beyond the TAFs.

    NBS: every 3 h, 6-72 h ahead (ceiling, visibility, IFR chances, thunder, wind).
    NBE: every 12 h, 24-192 h ahead (thunder, precipitation, wind; no ceiling or visibility).
    The whole-country file comes from NOMADS once per cycle and is cached on disk; the
    Iowa Environmental Mesonet's per-station JSON is the backup.
    """

    NOMADS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/blend/prod/"
    IEM = "https://mesonet.agron.iastate.edu/api/1/mos.json"
    NAMES = {"nbs": "nbstx", "nbe": "nbetx"}
    HEADER = re.compile(r"^ (\S+)\s+NBM V[\d.]+ NB[SE] GUIDANCE\s+(\d\d)/(\d\d)/(\d{4})\s+(\d\d)00 UTC")

    def __init__(self):
        self.lock = threading.Lock()
        self.state = {prod: {"cycle": None, "path": None, "index": {}, "checked": 0.0} for prod in self.NAMES}

    def url(self, prod, cycle):
        return f"{self.NOMADS}blend.{cycle:%Y%m%d}/{cycle:%H}/text/blend_{self.NAMES[prod]}.t{cycle:%H}z"

    def refresh(self, prod):
        """Make sure a recent bulletin is on disk and indexed; look for a newer one at most hourly."""
        st = self.state[prod]
        if st["cycle"] and time.time() - st["checked"] < 3600:
            return st
        st["checked"] = time.time()
        now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
        if st["cycle"] and now - st["cycle"] < dt.timedelta(hours=3):
            return st  # a 30 MB download every few hours is plenty
        os.makedirs(CACHE_DIR, exist_ok=True)
        for back in range(0, 9):
            cycle = now - dt.timedelta(hours=back)
            if st["cycle"] and cycle <= st["cycle"]:
                break
            path = os.path.join(CACHE_DIR, f"{prod}-{cycle:%Y%m%d%H}.txt")
            if not os.path.exists(path):
                try:
                    req = urllib.request.Request(self.url(prod, cycle), headers=UA, method="HEAD")
                    urllib.request.urlopen(req, timeout=15).close()
                except Exception:
                    continue  # not published yet
                data = fetch(self.url(prod, cycle), timeout=180)
                with open(path + ".tmp", "wb") as fh:
                    fh.write(data)
                os.replace(path + ".tmp", path)
            st.update(cycle=cycle, path=path, index=self.build_index(path))
            for old in os.listdir(CACHE_DIR):  # keep only the cycle in use
                if old.startswith(prod + "-") and os.path.join(CACHE_DIR, old) != path:
                    try:
                        os.remove(os.path.join(CACHE_DIR, old))
                    except OSError:
                        pass
            break
        if not st["cycle"]:
            raise RuntimeError(f"no {prod.upper()} bulletin found on NOMADS")
        return st

    def build_index(self, path):
        index, pos = {}, 0
        with open(path, "rb") as fh:
            for line in fh:
                if b"NBM V" in line and b"GUIDANCE" in line:
                    m = self.HEADER.match(line.decode("ascii", "replace"))
                    if m:
                        index[m.group(1)] = pos
                pos += len(line)
        return index

    def parse_block(self, lines):
        m = self.HEADER.match(lines[0])
        run = dt.datetime(int(m.group(4)), int(m.group(2)), int(m.group(3)), int(m.group(5)), tzinfo=dt.timezone.utc)
        fhr = next(l for l in lines if l.startswith(" FHR"))
        spans = [(mm.start(), mm.end(), int(mm.group())) for mm in re.finditer(r"\d+", fhr[5:])]
        rows = [{"t": (run + dt.timedelta(hours=h)).strftime("%Y-%m-%dT%H:%MZ")} for _, _, h in spans]
        for line in lines:
            code = line[1:4]
            if not re.fullmatch(r"[A-Z][A-Z0-9]{2}", code) or code in ("FHR", "UTC"):
                continue
            body, prev = line[5:], 0
            for i, (_, end, _) in enumerate(spans):
                cell = body[prev:end].replace("|", "").strip()
                prev = end
                if re.fullmatch(r"-?\d+", cell):
                    rows[i][code] = int(cell) * (10 if code in ("WDR", "TWD") else 1)  # the text gives directions in tens of degrees
        return {"run": run.strftime("%Y-%m-%dT%H:%MZ"), "rows": rows}

    def from_nomads(self, prod, ids):
        with self.lock:
            st = self.refresh(prod)
        out = {}
        with open(st["path"], encoding="ascii", errors="replace") as fh:
            for want, sid in ids.items():
                if sid not in st["index"]:
                    continue
                fh.seek(st["index"][sid])
                lines = []
                for line in fh:
                    if not line.strip():
                        break
                    lines.append(line.rstrip("\n"))
                out[want] = self.parse_block(lines)
        return {"source": "NOMADS", "cycle": st["cycle"].strftime("%Y-%m-%dT%H:%MZ"), "stations": out}

    def from_iem(self, prod, ids):
        out, cycle = {}, None
        for want, sid in ids.items():
            try:
                data = json.loads(fetch(f"{self.IEM}?station={urllib.parse.quote(sid)}&model={prod.upper()}", 20))
            except Exception:
                continue
            recs = data.get("data") or []
            if not recs:
                continue
            run = max(r["runtime_utc"] for r in recs if r.get("runtime_utc"))
            rows = []
            for r in recs:
                if r.get("runtime_utc") != run:
                    continue
                row = {"t": r["ftime_utc"].replace(" ", "T")[:16] + "Z"}
                for k, v in r.items():
                    if len(k) == 3 and isinstance(v, (int, float)) and not isinstance(v, bool):
                        row[k.upper()] = int(v)
                rows.append(row)
            out[want] = {"run": run.replace(" ", "T")[:16] + "Z", "rows": sorted(rows, key=lambda x: x["t"])}
            cycle = out[want]["run"]
        return {"source": "IEM", "cycle": cycle, "stations": out}

    def lookup(self, prod, wanted):
        prod = prod if prod in self.NAMES else "nbs"
        ids = {}
        for w in wanted:
            w = w.upper()
            cands = [w] + (["K" + w] if len(w) == 3 else []) + ([w[1:]] if len(w) == 4 and w[0] == "K" else [])
            ids[w] = cands
        try:
            st_index = None
            with self.lock:
                st_index = self.refresh(prod)["index"]
            pick = {w: next((c for c in cands if c in st_index), cands[0]) for w, cands in ids.items()}
            res = self.from_nomads(prod, pick)
        except Exception as err:
            print(f"warning: NBM from NOMADS failed ({err}); using IEM")
            res = self.from_iem(prod, {w: (cands[1] if len(cands) > 1 and len(w) == 3 else cands[0]) for w, cands in ids.items()})
        res["prod"] = prod
        res["missing"] = [w for w in ids if w not in res["stations"]]
        return res


class SpcOutlook:
    """SPC day 1-3 categorical convective outlooks (GeoJSON), cached for 30 minutes."""

    def __init__(self):
        self.cache = {}

    def day(self, n):
        n = max(1, min(3, int(n)))
        hit = self.cache.get(n)
        if hit and time.time() - hit[0] < 1800:
            return hit[1]
        data = json.loads(fetch(f"https://www.spc.noaa.gov/products/outlook/day{n}otlk_cat.lyr.geojson", 20))
        feats = [{"label": f["properties"].get("LABEL"), "valid": f["properties"].get("VALID"), "expire": f["properties"].get("EXPIRE"),
                  "geometry": f.get("geometry")} for f in data.get("features", [])]
        self.cache[n] = (time.time(), {"day": n, "features": feats})
        return self.cache[n][1]


NAV = NavData()
APPR = Approaches()
NBM = NbmText()
SPC = SpcOutlook()


def alternates(code, radius):
    """Airports with a published instrument approach within radius nm of code, nearest first."""
    NAV.load()
    APPR.load()
    center = NAV.airport(code)
    if not center:
        return {"error": f"{code} wasn't found as an airport", "airports": []}
    c = (center["lat"], center["lon"])
    dlat = radius / 60
    seen, out = set(), []
    for apt in NAV.airports.values():
        if id(apt) in seen or apt is center or apt["type"] in ("heliport", "seaplane_base"):
            continue
        seen.add(id(apt))
        if abs(apt["lat"] - c[0]) > dlat:
            continue
        d = nm_between(c, (apt["lat"], apt["lon"]))
        if d > radius:
            continue
        charts = APPR.lookup(apt["faa"] or apt["ident"])["charts"]
        if not charts:
            continue
        names = [ch["name"] for ch in charts]
        lengths = [r["lengthFt"] for r in apt["runways"] if r["lengthFt"]]
        out.append({
            "ident": apt["ident"], "icao": apt["icao"], "faa": apt["faa"], "name": apt["name"],
            "lat": apt["lat"], "lon": apt["lon"], "elevFt": apt["elevFt"], "dist": round(d, 1),
            "approaches": len(charts), "ils": any(n.startswith("ILS") for n in names),
            "longestRwy": max(lengths) if lengths else None,
        })
    out.sort(key=lambda a: a["dist"])
    return {"center": center["ident"], "radius": radius, "airports": out}


# ---------------------------------------------------------------- HTTP
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        try:
            if url.path.startswith("/wx/"):
                return self.relay(url.path[4:], url.query)
            if url.path == "/nav/route":
                return self.json(NAV.resolve(q.get("q", "")))
            if url.path == "/nav/approaches":
                return self.json(APPR.lookup(q.get("apt", "")))
            if url.path == "/nav/alternates":
                return self.json(alternates(q.get("apt", ""), min(200.0, float(q.get("radius", 100)))))
            if url.path == "/nbm":
                return self.json(NBM.lookup(q.get("prod", "nbs"), [i for i in q.get("ids", "").split(",") if i][:80]))
            if url.path == "/spc":
                return self.json(SPC.day(q.get("day", "1")))
            if url.path == "/nav/status":
                return self.json({"nav": NAV.ready, "cycle": APPR.cycle})
        except Exception as err:
            return self.json({"error": str(err)}, 502)
        name = STATIC.get(url.path)
        if not name:
            return self.send_error(404)
        with open(os.path.join(ROOT, name), "rb") as fh:
            body = fh.read()
        self.reply(200, body, ("text/html" if name.endswith(".html") else "text/javascript") + "; charset=utf-8")

    def do_POST(self):
        # Quit button: only accept it from this app's own page
        origin = self.headers.get("Origin", "")
        if urllib.parse.urlsplit(self.path).path != "/app/quit" or origin not in (f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"):
            return self.send_error(403)
        self.json({"stopping": True})
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def relay(self, product, query):
        if product not in PRODUCTS:
            return self.send_error(404)
        target = f"{UPSTREAM}{product}?{query}"
        hit = _wx_cache.get(target)
        if hit and time.time() - hit[0] < TTL:
            return self.reply(200, hit[1], "application/json")
        try:
            status, body = 200, fetch(target, 20)
        except urllib.error.HTTPError as err:
            status, body = err.code, err.read() or json.dumps({"error": str(err)}).encode()
        except Exception as err:
            status, body = 502, json.dumps({"error": f"aviationweather.gov unreachable: {err}"}).encode()
        if status == 204 or (status == 200 and not body.strip()):
            status, body = 200, b"[]"
        if status == 200:
            _wx_cache[target] = (time.time(), body)
        self.reply(status, body, "application/json")

    def json(self, obj, status=200):
        self.reply(status, json.dumps(obj).encode(), "application/json")

    def reply(self, status, body, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    url = f"http://127.0.0.1:{PORT}/"
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as err:
        if err.errno != errno.EADDRINUSE:
            raise
        try:  # is it already this app?
            with urllib.request.urlopen(url, timeout=3) as resp:
                ours = b"IFR Go/No-Go" in resp.read(4096)
        except Exception:
            ours = False
        if ours:
            print(f"IFR Go/No-Go is already running at {url}")
            if "--no-browser" not in sys.argv:
                webbrowser.open(url)
            return
        sys.exit(f"Port {PORT} is used by another program. Try: PORT=8738 python3 {sys.argv[0]}")
    print(f"IFR Go/No-Go running at {url}  (Ctrl+C to stop)")
    # warm the reference data so the first route lookup is quick
    threading.Thread(target=lambda: (NAV.load(), APPR.load()), daemon=True).start()
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()
    print("\nStopped.")


if __name__ == "__main__":
    main()
