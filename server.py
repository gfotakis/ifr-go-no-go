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
VERSION = "1.1.01"

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
UA = {"User-Agent": "ifr-go-no-go/1.1.01 (personal preflight tool)"}
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


NAV = NavData()
APPR = Approaches()


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
