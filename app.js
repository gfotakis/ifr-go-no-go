"use strict";
// IFR Go/No-Go decision model.
// loadAll() gathers data, simulate() flies the route through the forecast winds, evaluate() applies the rules, render() draws.

const $ = s => document.querySelector(s);
const FORM = $("#plan");
const STORE_KEY = "ifr-gng-v2";
const EX_KEY = "ifr-gng-examples-cleared";
const TERMS_KEY = "ifr-gng-terms-v1";
const NM_PER_DEG = 60;
const M_TO_FT = 3.28084;
const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300]; // hPa, roughly 300 ft to 30,000 ft
const CLOUD_PCT = 40; // model cloud cover at a level that counts as being in cloud
const MISSED_MIN = 6; // missed approach allowance before heading to the alternate

// Mooney M20K 231 (TSIO-360-GB/LB, 210 hp). Sources: AOPA Pilot "The Mooney 231" (Feb 1994), published spec sheets.
// Values marked estimated in the UI are interpolated or typical, not POH figures.
const PRESETS = {
  m20k: {
    p65_0: 146, p65_8: 156, p65_12: 163, p65_24: 178, g65: 10.9,
    p75_0: 155, p75_8: 166, p75_12: 173, p75_24: 188, g75: 12.7,
    climbSL: 900, climb12: 800, climb24: 500, climbIas: 120, climbGph: 18,
    descFpm: 500, descGph: 9, taxiGal: 1.5, usableGal: 72, ceiling: 24000, demoXwind: 15,
  },
};

// ---------- helpers ----------
const num = v => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtZ = d => d.toISOString().slice(11, 16) + "Z";
const fmtLocal = d => d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtCig = c => (c == null ? "n/a" : c === Infinity ? "no ceiling" : `${Math.round(c).toLocaleString()} ft`);
// ceiling of a forecast summary, naming the layers when there is no ceiling ("no ceiling (FEW040)", "clear (SKC)")
const cigDesc = t => {
  if (t?.cig !== Infinity) return fmtCig(t?.cig);
  if (t.low) return `no ceiling (${t.low.cover}${String(Math.round(t.low.base / 100)).padStart(3, "0")})`;
  return t.clear ? `clear (${t.clear})` : "no ceiling";
};
const fmtVis = v => (v == null ? "n/a" : `${v >= 6 ? "6+" : +v.toFixed(2)} SM`);
const fmtHM = min => { const m = Math.round(min); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
const ft = n => Math.round(n).toLocaleString();
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const localInput = d => `${ymd(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
function interp(table, x) { // table: [[x, y], ...] ascending; clamps at the ends
  const t = table.filter(r => r[1] != null);
  if (!t.length) return null;
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (x <= t[i][0]) return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (x - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
  return t[t.length - 1][1];
}
function endOfCalMonth(dateStr, months) {
  if (!dateStr) return null;
  const [y, m] = dateStr.split("-").map(Number);
  return new Date(y, m - 1 + months + 1, 0, 23, 59, 59);
}

// ---------- geodesy ----------
function gcNm(a, b) {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
const lerpPt = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f });
function samplePath(pts, stepNm) { // points every stepNm along a polyline, each with its along-track distance
  const out = [];
  let along = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = gcNm(pts[i], pts[i + 1]);
    const n = Math.max(1, Math.ceil(d / stepNm));
    for (let k = 0; k < n; k++) out.push({ ...lerpPt(pts[i], pts[i + 1], k / n), along: along + d * k / n, leg: i });
    along += d;
  }
  if (pts.length) out.push({ lat: pts.at(-1).lat, lon: pts.at(-1).lon, along, leg: pts.length - 2 });
  return out;
}

// ---------- weather parsing ----------
function parseVis(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[PM+]/g, "").trim();
  return s.split(/\s+/).reduce((sum, part) => {
    if (part.includes("/")) { const [a, b] = part.split("/").map(Number); return sum + a / b; }
    return sum + Number(part);
  }, 0);
}
function ceilingOf(row, fullReplace) {
  const vv = row.vertVis != null ? (row.vertVis < 100 ? row.vertVis * 100 : row.vertVis) : null;
  const clouds = Array.isArray(row.clouds) ? row.clouds : null;
  const bases = (clouds || []).filter(c => ["BKN", "OVC", "OVX"].includes(c.cover) && c.base != null).map(c => c.base);
  if (vv != null) bases.push(vv);
  if (bases.length) return Math.min(...bases);
  if (clouds && clouds.length) return Infinity;
  return fullReplace ? Infinity : null;
}
function category(cig, vis) {
  if (cig == null && vis == null) return "NA";
  const c = cig ?? Infinity, v = vis ?? 99;
  if (c < 500 || v < 1) return "LIFR";
  if (c < 1000 || v < 3) return "IFR";
  if (c <= 3000 || v <= 5) return "MVFR";
  return "VFR";
}
function blankSum() { return { cig: null, vis: null, low: null, clear: null, wspd: 0, gust: 0, winds: [], wx: [], rows: 0 }; }
function absorb(t, row, fullReplace) {
  const c = ceilingOf(row, fullReplace);
  if (c != null) t.cig = t.cig == null ? c : Math.min(t.cig, c);
  for (const l of Array.isArray(row.clouds) ? row.clouds : []) {
    if (["FEW", "SCT"].includes(l.cover) && l.base != null && (!t.low || l.base < t.low.base)) t.low = { cover: l.cover, base: l.base };
    if (["SKC", "CLR", "NSC", "NCD", "CAVOK"].includes(l.cover)) t.clear = l.cover;
  }
  const v = parseVis(row.visib);
  if (v != null) t.vis = t.vis == null ? v : Math.min(t.vis, v);
  if (row.wspd != null) t.wspd = Math.max(t.wspd, row.wspd);
  if (row.wgst != null) t.gust = Math.max(t.gust, row.wgst);
  if (row.wspd != null) t.winds.push({ dir: row.wdir, spd: Math.max(row.wspd, row.wgst || 0) });
  if (row.wxString) t.wx.push(row.wxString);
  t.rows++;
}
// Worst conditions a TAF forecasts inside [from, to]; prevailing (base/FM/BECMG) kept apart from TEMPO/PROB
function tafWindow(taf, from, to) {
  const s = from / 1000, e = to / 1000;
  if (!taf || !taf.fcsts) return { covered: false, prev: blankSum(), cond: blankSum() };
  const out = { covered: taf.validTimeFrom <= s && taf.validTimeTo >= e, prev: blankSum(), cond: blankSum() };
  const prevailingStarts = taf.fcsts.filter(r => !r.fcstChange || r.fcstChange === "FM").map(r => r.timeFrom);
  for (const r of taf.fcsts) {
    let end = r.timeTo;
    if (r.fcstChange === "BECMG") { // a BECMG change lasts until the next FM group
      const next = prevailingStarts.filter(t => t > r.timeFrom);
      end = next.length ? Math.min(...next) : taf.validTimeTo;
    }
    if (!(r.timeFrom < e && end > s)) continue;
    const conditional = r.fcstChange === "TEMPO" || r.fcstChange === "PROB";
    absorb(conditional ? out.cond : out.prev, r, !r.fcstChange || r.fcstChange === "FM");
  }
  return out;
}
function metarSum(m) {
  if (!m) return null;
  const t = blankSum();
  absorb(t, m, true);
  return t;
}
function worst(a, b) {
  if (!a) return b; if (!b) return a;
  const pick = (x, y) => (x == null ? y : y == null ? x : Math.min(x, y));
  const low = !a.low ? b.low : !b.low ? a.low : a.low.base <= b.low.base ? a.low : b.low;
  return { cig: pick(a.cig, b.cig), vis: pick(a.vis, b.vis), low, clear: a.clear || b.clear, wspd: Math.max(a.wspd, b.wspd), gust: Math.max(a.gust, b.gust),
    winds: a.winds.concat(b.winds), wx: a.wx.concat(b.wx), rows: a.rows + b.rows };
}
function maxCrosswind(winds, runways) {
  const rw = (runways || []).filter(r => typeof r.alignment === "number" && !/^H/.test(r.id || ""));
  if (!rw.length || !winds.length) return null;
  let worstX = 0;
  for (const w of winds) {
    if (!w.spd) continue;
    if (typeof w.dir !== "number") { worstX = Math.max(worstX, w.spd); continue; } // variable: assume full crosswind
    const best = Math.min(...rw.map(r => Math.abs(Math.sin(rad(w.dir - r.alignment))) * w.spd));
    worstX = Math.max(worstX, best);
  }
  return Math.round(worstX);
}

// ---------- hazard geometry ----------
function distToPolygonNm(p, poly) {
  const k = Math.cos(rad(p.lat));
  const xy = poly.map(q => [(q.lon - p.lon) * NM_PER_DEG * k, (q.lat - p.lat) * NM_PER_DEG]);
  let inside = false;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    const [xi, yi] = xy[i], [xj, yj] = xy[j];
    if ((yi > 0) !== (yj > 0) && 0 < (xj - xi) * (0 - yi) / (yj - yi) + xi) inside = !inside;
  }
  if (inside) return 0;
  let best = Infinity;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    const [x1, y1] = xy[j], [x2, y2] = xy[i];
    const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / len));
    best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy));
  }
  return best;
}
const routeDistance = (pts, poly) => Math.min(...pts.map(p => distToPolygonNm(p, poly)));
function altFt(v, fzl) { // G-AIRMET levels: "SFC", "FZL", or hundreds of feet
  if (v == null || v === "") return null;
  if (v === "SFC") return 0;
  if (v === "FZL") return fzl ?? 0;
  const n = Number(v);
  return Number.isNaN(n) ? null : n < 1000 ? n * 100 : n;
}

// ---------- model winds (Open-Meteo) ----------
function hourIndex(s, tMs) {
  const times = s.hourly?.time;
  if (!times?.length) return -1;
  const i = Math.round((tMs - Date.parse(times[0] + ":00Z")) / 3600e3);
  return i < 0 || i >= times.length ? -1 : i;
}
function windAt(p, altFtMsl, tMs) {
  const samples = W.om;
  if (!samples?.length) return null;
  let s = samples[0], best = Infinity;
  for (const c of samples) {
    const d = (c.lat - p.lat) ** 2 + ((c.lon - p.lon) * Math.cos(rad(p.lat))) ** 2;
    if (d < best) { best = d; s = c; }
  }
  const h = hourIndex(s, tMs);
  if (h < 0) return null;
  const rows = LEVELS.map(L => {
    const hz = s.hourly[`geopotential_height_${L}hPa`]?.[h], spd = s.hourly[`wind_speed_${L}hPa`]?.[h], dir = s.hourly[`wind_direction_${L}hPa`]?.[h];
    if (hz == null || spd == null || dir == null) return null;
    return [hz * M_TO_FT, -spd * Math.sin(rad(dir)), -spd * Math.cos(rad(dir)), s.hourly[`temperature_${L}hPa`]?.[h]];
  }).filter(Boolean).sort((a, b) => a[0] - b[0]);
  if (!rows.length) return null;
  const u = interp(rows.map(r => [r[0], r[1]]), altFtMsl), v = interp(rows.map(r => [r[0], r[2]]), altFtMsl);
  return { spd: Math.hypot(u, v), dir: (deg(Math.atan2(-u, -v)) + 360) % 360, temp: interp(rows.map(r => [r[0], r[3]]), altFtMsl) };
}
function groundspeed(tas, course, wind) { // wind triangle; head > 0 is a headwind
  if (!wind) return { gs: tas, head: 0 };
  const a = rad(wind.dir - course);
  const cross = wind.spd * Math.sin(a), head = wind.spd * Math.cos(a);
  const wca = Math.asin(Math.max(-1, Math.min(1, cross / tas)));
  return { gs: Math.max(40, tas * Math.cos(wca) - head), head };
}

// Cloud cover by height at one model point and hour; base and tops are where cover crosses CLOUD_PCT
function cloudProfile(hourly, h) {
  const lv = LEVELS.map(L => ({ h: hourly[`geopotential_height_${L}hPa`]?.[h], cc: hourly[`cloud_cover_${L}hPa`]?.[h] }))
    .filter(x => x.h != null && x.cc != null).map(x => ({ h: x.h * M_TO_FT, cc: x.cc })).sort((a, b) => a.h - b.h);
  const cloudy = lv.filter(x => x.cc >= CLOUD_PCT);
  return { lv, base: cloudy[0]?.h ?? null, tops: cloudy.at(-1)?.h ?? null };
}
const coverAt = (cp, altFt) => interp(cp.lv.map(x => [x.h, x.cc]), altFt);

// ---------- performance ----------
// IAS to TAS in the standard atmosphere
const iasToTas = (ias, alt) => ias / Math.sqrt(Math.pow(Math.max(0.2, 1 - 6.8756e-6 * alt), 4.2559));
const settingComplete = st => !!st && st.rows.some(r => num(r.tas) != null) && st.rows.some(r => num(r.gph) != null);
function perfFrom(f) {
  const a = AC || exampleAircraft(PRESETS.m20k);
  const st = a.settings.find(x => x.name === f.power) || a.settings[0] || { name: "", rows: [] };
  const col = k => st.rows.filter(r => num(r.alt) != null && num(r[k]) != null).map(r => [num(r.alt), num(r[k])]).sort((x, y) => x[0] - y[0]);
  const T = { tas: col("tas"), gph: col("gph"), roc: col("roc"), climbIas: col("climbIas"), descIas: col("descIas") };
  const top = num(a.ceiling) || Math.max(24000, ...st.rows.map(r => num(r.alt) || 0));
  const lowHigh = (lo, hi, dflt) => alt => interp([[0, num(lo)], [top, num(hi)]], alt) ?? dflt; // one value alone holds for all altitudes
  const cruiseTas = alt => interp(T.tas, alt) ?? 150;
  const cruiseGphAt = alt => interp(T.gph, alt) ?? 11;
  return {
    setting: st.name, complete: settingComplete(st),
    cruiseTas, cruiseGphAt,
    cruiseGph: cruiseGphAt(num(f.cruise) ?? 8000), // at the planned cruise altitude, for reserves and the missed approach
    climbFpm: alt => Math.max(100, interp(T.roc, alt) ?? 700),
    climbTas: alt => iasToTas(interp(T.climbIas, alt) ?? 120, alt),
    climbGph: lowHigh(a.climbGphLow, a.climbGphHigh, 16),
    descFpm: num(a.descFpm) || 500,
    descTas: alt => { const ias = interp(T.descIas, alt); return ias != null ? iasToTas(ias, alt) : cruiseTas(alt); },
    descGph: lowHigh(a.descGphLow, a.descGphHigh, 8),
    taxiGal: num(a.taxiGal) ?? 1.5,
    usableGal: num(a.usableGal),
    ceiling: num(a.ceiling),
    demoXwind: num(a.demoXwind),
  };
}

// Fly a path in 1 nm steps: climb, cruise, descend, through the forecast winds at each position, altitude and time
function simulate(pts, o) {
  const legs = [], timeline = [];
  if (pts.length < 2) return null;
  const total = pts.slice(1).reduce((s, p, i) => s + gcNm(pts[i], p), 0);
  const target = o.endElev + 1500; // start of the approach
  let alt = o.startElev, t = 0, fuel = 0, along = 0, noWind = false, above125 = 0;
  timeline.push({ along: o.along0, t: o.t0, alt });
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], d = gcNm(a, b);
    const leg = { from: a.token || a.ident, to: b.token || b.ident, dist: d, course: bearing(a, b), time: 0, fuel: 0, headSum: 0, gsSum: 0, n: 0, wind: null, temp: null };
    let done = 0;
    while (done < d - 1e-6) {
      const step = Math.min(1, d - done);
      const pos = lerpPt(a, b, (done + step / 2) / d);
      const course = bearing(pos, b);
      const w = windAt(pos, alt, o.t0 + t * 60e3);
      if (!w) noWind = true;
      const descGs = groundspeed(o.perf.descTas(alt), course, w).gs;
      const descNm = Math.max(0, alt - target) / o.perf.descFpm / 60 * descGs;
      let phase = alt < o.cruise - 20 ? "climb" : "cruise";
      if (total - along <= descNm + 0.5 && alt > target) phase = "descent";
      const tas = phase === "climb" ? o.perf.climbTas(alt) : phase === "descent" ? o.perf.descTas(alt) : o.perf.cruiseTas(alt);
      const g = groundspeed(tas, course, w);
      const hrs = step / g.gs;
      if (phase === "climb") alt = Math.min(o.cruise, alt + o.perf.climbFpm(alt) * hrs * 60);
      if (phase === "descent") alt = Math.max(target, alt - o.perf.descFpm * hrs * 60);
      const gph = phase === "climb" ? o.perf.climbGph(alt) : phase === "descent" ? o.perf.descGph(alt) : o.perf.cruiseGphAt(alt);
      fuel += gph * hrs; leg.fuel += gph * hrs;
      t += hrs * 60; leg.time += hrs * 60;
      if (alt > 12500) above125 += hrs * 60;
      if (phase === "cruise" && w) { leg.headSum += g.head; leg.gsSum += g.gs; leg.n++; leg.wind = w; leg.temp = w.temp; }
      done += step; along += step;
      timeline.push({ along: o.along0 + along, t: o.t0 + t * 60e3, alt });
    }
    if (!leg.n) { // leg flown entirely in climb or descent: report the wind at its midpoint
      const w = windAt(lerpPt(a, b, 0.5), alt, o.t0 + t * 60e3);
      if (w) { const g = groundspeed(o.perf.cruiseTas(alt), leg.course, w); leg.headSum = g.head; leg.gsSum = g.gs; leg.n = 1; leg.wind = w; leg.temp = w.temp; }
    }
    legs.push({ ...leg, head: leg.n ? leg.headSum / leg.n : null, gs: leg.n ? leg.gsSum / leg.n : null });
  }
  return { total, minutes: t, fuel, legs, timeline, noWind, above125 };
}
function timeAtAlong(timelines, along) {
  for (const tl of timelines) {
    if (!tl?.length || along < tl[0].along - 0.01 || along > tl.at(-1).along + 0.01) continue;
    for (let i = 1; i < tl.length; i++) if (tl[i].along >= along) return tl[i].t;
    return tl.at(-1).t;
  }
  return null;
}

// ---------- data loading ----------
let W = { route: null, apt: {}, charts: {}, pireps: [], sigmets: [], gairmets: [], om: [], loadedAt: null, error: null, loading: false };
let pendingCharts = null; // saved approach choices, applied once the lists arrive
let refreshTimer = null;

// Open-Meteo through the local server (which caches it); errors come back as { error } with Open-Meteo's reason
const omFetch = url => fetch(url).then(async r => {
  if (r.ok) return r.json();
  let reason = "";
  try { reason = (await r.json()).reason || ""; } catch {}
  return { error: r.status === 429 ? `Open-Meteo's free daily limit is used up${reason ? ` (${reason.replace(/\.$/, "")})` : ""}` : `Open-Meteo answered ${r.status}${reason ? `: ${reason}` : ""}` };
}).catch(e => ({ error: e.message }));

async function getJSON(path, params) {
  const res = await fetch(`${path}?${new URLSearchParams(params)}`);
  if (!res.ok) {
    let msg = `answered ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}
const wx = (product, params) => getJSON(`/wx/${product}`, { format: "json", ...params });

// nearest station within maxNm; for TAFs given a time `at`, the nearest one whose latest issue is valid then
// (a closer TAF that has already run out by `at` is no use), else the nearest one at all
async function nearestStation(product, pt, maxNm, at) {
  const r = maxNm / 60;
  const box = [pt.lat - r, pt.lon - r * 1.2, pt.lat + r, pt.lon + r * 1.2].map(n => n.toFixed(3)).join(",");
  const rows = await wx(product, { bbox: box }).catch(() => []);
  const latest = id => rows.filter(t => t.icaoId === id).sort((a, b) => b.issueTime.localeCompare(a.issueTime))[0];
  const valid = t => at == null || (t.validTimeFrom * 1000 <= at && t.validTimeTo * 1000 > at);
  let best = null, bestValid = null;
  for (const row of rows) {
    const d = gcNm(pt, { lat: row.lat, lon: row.lon });
    if (d > maxNm) continue;
    if (!best || d < best.d) best = { row, d };
    if (product === "taf" && (!bestValid || d < bestValid.d) && valid(latest(row.icaoId))) bestValid = { row, d };
  }
  if (product === "taf" && bestValid) best = bestValid;
  if (best && product === "taf") best.row = latest(best.row.icaoId);
  return best;
}

let loadSeq = 0;
async function loadAll() {
  const seq = ++loadSeq;
  const f = readForm();
  W.loading = true;
  $("#wx-status").textContent = "Resolving route…";
  document.body.classList.add("loading");
  try {
    if (location.protocol === "file:") throw new Error("file");
    const slow = setTimeout(() => { $("#wx-status").textContent = "Downloading route data (first run only, about 35 MB)…"; }, 2500);
    const [route, altRes] = await Promise.all([
      getJSON("/nav/route", { q: f.route }),
      f.alt.trim() ? getJSON("/nav/route", { q: f.alt.trim() }) : Promise.resolve(null),
    ]).finally(() => clearTimeout(slow));
    if (seq !== loadSeq) return;
    const altPt = altRes?.points?.[0]?.kind === "airport" ? altRes.points[0] : null;
    const errors = [...route.errors, ...(f.alt.trim() && !altPt ? [`Alternate ${f.alt.trim().toUpperCase()} wasn't found as an airport.`] : [])];
    const pts = route.points;
    const dep = pts[0]?.kind === "airport" ? pts[0] : null;
    const dest = pts.length > 1 && pts.at(-1).kind === "airport" ? pts.at(-1) : null;
    const airports = [dep, dest, altPt].filter(Boolean);

    $("#wx-status").textContent = "Loading weather…";
    const ids = [...new Set(airports.map(a => a.icao || a.ident))];
    const etd = new Date(f.etd);
    const etdMs = Number.isNaN(+etd) ? Date.now() : +etd;
    const dist = pts.slice(1).reduce((s, p, i) => s + gcNm(pts[i], p), 0);
    const snap = new Date(Math.round((etdMs + dist / 150 * 30 * 60e3) / 10800e3) * 10800e3);

    // model samples along route + alternate leg, every ~20 nm, at most 40 points
    const path = dest && altPt ? [...pts, altPt] : pts;
    const pathNm = path.slice(1).reduce((s, p, i) => s + gcNm(path[i], p), 0);
    // Open-Meteo's free tier counts each location (and each 10 variables) as a call, 10,000 a day: keep the
    // points few and the windows on 12 h boundaries, so the server's cache answers repeat requests
    const omSamples = path.length > 1 ? samplePath(path, Math.max(25, pathNm / 19)) : [];
    const h0 = new Date(Math.floor((etdMs - 2 * 3600e3) / (12 * 3600e3)) * 12 * 3600e3);
    const h1 = new Date(+h0 + 36 * 3600e3);
    const hourly = ["cape", "lifted_index", "freezing_level_height", ...LEVELS.flatMap(L => [`wind_speed_${L}hPa`, `wind_direction_${L}hPa`, `geopotential_height_${L}hPa`, `temperature_${L}hPa`, `cloud_cover_${L}hPa`])];

    // area grid for the map (CAPE, cloud base and tops) at mid-flight, plus every METAR in the area
    const lats = path.map(p => p.lat), lons = path.map(p => p.lon);
    const box = path.length ? { s: Math.min(...lats) - 0.8, n: Math.max(...lats) + 0.8, w: Math.min(...lons) - 1, e: Math.max(...lons) + 1 } : null;
    const midHour = new Date(Math.round((etdMs + dist / 150 * 30 * 60e3) / 3600e3) * 3600e3);
    const grid = [];
    if (box) {
      const nx = 8, ny = Math.max(4, Math.min(6, Math.round(nx * (box.n - box.s) / ((box.e - box.w) * Math.cos(rad((box.n + box.s) / 2))))));
      const dLat = (box.n - box.s) / ny, dLon = (box.e - box.w) / nx;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) grid.push({ lat: box.s + dLat * (j + 0.5), lon: box.w + dLon * (i + 0.5), dLat, dLon });
    }
    const g0 = new Date(Math.floor(+midHour / (12 * 3600e3)) * 12 * 3600e3), gHour = Math.round((+midHour - +g0) / 3600e3);
    const gridUrl = "/om?" + new URLSearchParams({
      latitude: grid.map(g => g.lat.toFixed(3)).join(","), longitude: grid.map(g => g.lon.toFixed(3)).join(","),
      hourly: ["cape", ...LEVELS.flatMap(L => [`cloud_cover_${L}hPa`, `geopotential_height_${L}hPa`])].join(","),
      timezone: "GMT", start_hour: g0.toISOString().slice(0, 16), end_hour: new Date(+g0 + 12 * 3600e3).toISOString().slice(0, 16),
    });
    const omUrl = "/om?" + new URLSearchParams({
      latitude: omSamples.map(s => s.lat.toFixed(3)).join(","), longitude: omSamples.map(s => s.lon.toFixed(3)).join(","),
      hourly: hourly.join(","), wind_speed_unit: "kn", timezone: "GMT",
      start_hour: h0.toISOString().slice(0, 16), end_hour: h1.toISOString().slice(0, 16),
    });

    const [areaMetars, gridData] = await Promise.all([
      box ? wx("metar", { bbox: [box.s, box.w, box.n, box.e].map(n => n.toFixed(2)).join(",") }).catch(() => []) : [],
      grid.length ? omFetch(gridUrl) : null,
    ]);
    const gridList = Array.isArray(gridData) ? gridData : gridData && !gridData.error ? [gridData] : [];
    const gridCells = grid.map((g, i) => {
      const hr = gridList[i]?.hourly;
      if (!hr) return { ...g };
      const cp = cloudProfile(hr, gHour);
      return { ...g, cape: hr.cape?.[gHour] ?? null, base: cp.base, tops: cp.tops };
    });
    const [metars, tafs, sigmets, gairmets, om, ...charts] = await Promise.all([
      ids.length ? wx("metar", { ids: ids.join(",") }) : [],
      ids.length ? wx("taf", { ids: ids.join(",") }) : [],
      wx("airsigmet", {}).catch(() => []),
      wx("gairmet", { date: snap.toISOString().slice(0, 19) + "Z" }).catch(() => []),
      omSamples.length ? omFetch(omUrl) : [],
      ...[dep, dest, altPt].map(a => (a ? getJSON("/nav/approaches", { apt: a.faa || a.ident }).catch(() => ({ charts: [] })) : Promise.resolve({ charts: [] }))),
    ]);
    if (seq !== loadSeq) return;

    const apt = {};
    await Promise.all(airports.map(async a => {
      const id = a.icao || a.ident;
      const rec = { pt: a, wxId: id,
        metar: metars.find(m => m.icaoId === id) || null,
        taf: tafs.filter(t => t.icaoId === id).sort((x, y) => y.issueTime.localeCompare(x.issueTime))[0] || null };
      if (!rec.taf) { const n = await nearestStation("taf", a, 50, a === dep ? etdMs + 1800e3 : etdMs + dist / 140 * 3600e3); if (n) { rec.taf = n.row; rec.tafProxy = { id: n.row.icaoId, d: Math.round(n.d) }; } }
      if (!rec.metar) { const n = await nearestStation("metar", a, 30); if (n) { rec.metar = n.row; rec.metarProxy = { id: n.row.icaoId, d: Math.round(n.d) }; } }
      apt[a.token] = rec;
    }));
    const altCands = dest ? await fetchAltCands(dest.faa || dest.ident) : [];
    // beyond the TAFs: NBM guidance for the airports and the alternate candidates; SPC outlooks for days 1-3
    const etaGuess = etdMs + dist / 140 * 3600e3;
    let nbm = null, nbmError = null;
    if (leadH(etaGuess + 3 * 3600e3) > OUTLOOK_AFTER_H) {
      const nbmIds = [...new Set([...airports.map(nbmId), ...altCands.map(a => a.id)].filter(Boolean))].join(",");
      const [nbs, nbe] = await Promise.all([
        leadH(etdMs) < 74 ? getJSON("/nbm", { prod: "nbs", ids: nbmIds }).catch(e => ({ error: e.message })) : null,
        leadH(etaGuess) > 66 ? getJSON("/nbm", { prod: "nbe", ids: nbmIds }).catch(e => ({ error: e.message })) : null,
      ]);
      nbm = { nbs: nbs?.stations ? nbs : null, nbe: nbe?.stations ? nbe : null };
      nbmError = nbs?.error || nbe?.error || null;
    }
    const spc = leadH(etdMs) < 84 ? (await Promise.all([1, 2, 3].map(d => getJSON("/spc", { day: d }).catch(() => null)))).filter(Boolean) : [];
    const pirepIds = [...new Set([dep, dest].filter(Boolean).map(a => apt[a.token].metar?.icaoId || apt[a.token].wxId))];
    const pireps = (await Promise.all(pirepIds.map(id => wx("pirep", { id, distance: 100, age: 3 }).catch(() => [])))).flat();
    if (seq !== loadSeq) return;
    const seen = new Set();
    const omList = Array.isArray(om) ? om : om?.error ? [] : [om];

    W = { route: { ...route, errors }, dep, dest, altPt, apt, sigmets, gairmets,
      charts: { dep: charts[0], dest: charts[1], alt: charts[2] },
      pireps: pireps.filter(p => !seen.has(p.rawOb) && seen.add(p.rawOb)),
      om: omList.map((o, i) => ({ ...omSamples[i], hourly: o.hourly })), omError: om?.error || null,
      areaMetars, grid: gridCells, gridTime: midHour, gridError: gridData?.error || null, box, altCands, nbm, nbmError, spc,
      loadedAt: new Date(), error: null, loading: false };
    fillCharts();
    renderMap();
    $("#wx-status").textContent = "Updated " + W.loadedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch (err) {
    if (seq !== loadSeq) return;
    W.loading = false;
    W.error = err.message === "file"
      ? "This page needs its local server. Run  python3 ~/ifr-go-no-go/server.py  and use the address it prints."
      : `Couldn't load data: ${err.message}. Check the internet connection and press Refresh weather.`;
    $("#wx-status").textContent = "Data unavailable";
  } finally {
    if (seq === loadSeq) { document.body.classList.remove("loading"); update(); }
  }
}

// ---------- approach pickers ----------
function minimaLineFor(name) {
  if (/^ILS/.test(name)) return "ILS";
  if (/^(LOC|LDA|SDF)/.test(name)) return "LOC";
  if (/^(RNAV|GPS)/.test(name)) return "LPV";
  if (/^(VOR|TACAN|NDB)/.test(name)) return "VOR";
  return "Circling";
}
const chartAirport = {}; // which airport each picker was last filled for
function fillCharts() {
  for (const role of ["dest", "dep", "alt"]) {
    const sel = $(`#${role}Chart`);
    const list = W.charts?.[role]?.charts || [];
    const aptKey = (role === "dest" ? W.dest : role === "dep" ? W.dep : W.altPt)?.ident || "";
    const want = pendingCharts ? pendingCharts[`${role}Chart`] : sel.value;
    const sameAirport = pendingCharts ? true : chartAirport[role] === aptKey;
    sel.innerHTML = list.map(c => `<option>${esc(c.name)}</option>`).join("") + `<option value="">Other / not listed</option>`;
    if (want && list.some(c => c.name === want)) sel.value = want;
    else if (want === "" && sameAirport) sel.value = ""; // the pilot chose "Other" for this airport
    else { sel.value = list[0]?.name ?? ""; chartChosen(role); }
    chartAirport[role] = aptKey;
    updatePlateLink(role);
  }
  pendingCharts = null;
}
function updatePlateLink(role) {
  const sel = $(`#${role}Chart`);
  const chart = (W.charts?.[role]?.charts || []).find(c => c.name === sel.value);
  const a = $(`#${role}-plate`);
  a.textContent = chart ? `Open plate (PDF, cycle ${W.charts[role].cycle}) ↗` : "";
  if (chart) a.href = chart.url; else a.removeAttribute("href");
}
function chartChosen(role) {
  const name = $(`#${role}Chart`).value;
  updatePlateLink(role);
  if (!name) return;
  if (role === "dest") $("#destAppr").value = minimaLineFor(name);
  if (role === "alt") $("#altType").value = /^ILS/.test(name) ? "precision" : "nonprecision";
}

// ---------- the decision model ----------
function evaluate(f) {
  const items = [];
  const add = (level, area, text, ref = "", pts = 0) => items.push({ level, area, text, ref, pts });
  const ctx = { cards: [], hazards: [] };
  const now = new Date();
  const etd = new Date(f.etd);
  const cruise = num(f.cruise) ?? 0, mea = num(f.mea) ?? 0, altCruise = num(f.altCruise) ?? cruise;
  const P = perfFrom(f);
  const lowImc = (num(f.imc90) ?? 0) < (num(f.pmImc) ?? 0);
  const fiki = f.fiki;
  const loaded = !!W.loadedAt && !W.error;

  if (Number.isNaN(+etd)) { add("stop", "Plan", "Set a departure time."); return { items, ctx }; }
  if (etd < now - 15 * 60e3) add("caution", "Plan", "The departure time is in the past; forecasts may not match your flight.", "", 1);

  // ----- Route and performance -----
  const pts = W.route?.points || [];
  const dep = W.dep, dest = W.dest, altPt = W.altPt;
  for (const e of W.route?.errors || []) add("stop", "Plan", e);
  let sim = null, altSim = null, eta = etd, etaAlt = etd;
  if (loaded && dep && dest) {
    sim = simulate(pts, { startElev: dep.elevFt, endElev: dest.elevFt, cruise, perf: P, t0: +etd, along0: 0 });
    eta = new Date(+etd + sim.minutes * 60e3);
    if (altPt) {
      altSim = simulate([dest, altPt], { startElev: dest.elevFt + 1500, endElev: altPt.elevFt, cruise: altCruise, perf: P, t0: +eta + MISSED_MIN * 60e3, along0: sim.total });
      etaAlt = new Date(+eta + (MISSED_MIN + altSim.minutes) * 60e3);
    }
    if (sim.noWind) add("caution", "Plan", "Winds aloft weren't available for the whole flight, so part of the time and fuel estimate assumes no wind.", "", 1);
  } else if (loaded) add("stop", "Plan", "Enter a route that starts and ends at an airport.");
  ctx.sim = sim; ctx.altSim = altSim; ctx.times = { etd, eta, etaAlt };

  if (cruise < mea) add("stop", "Plan", `Cruise altitude ${ft(cruise)} ft is below the highest MEA (${ft(mea)} ft).`, "§91.177");
  if (!P.complete) add("stop", "Aircraft", `No cruise performance entered for the ${P.setting || "selected"} power setting. Fill in its table under Airplane, or pick another setting.`, "Performance");
  if (P.ceiling && cruise > P.ceiling) add("stop", "Aircraft", `Cruise altitude is above the airplane's ${ft(P.ceiling)} ft maximum operating altitude.`, "AFM");
  if (!f.oxygen && sim) {
    if (cruise > 14000) add("stop", "Pilot", "Above 14,000 ft the crew must use oxygen the whole time, and there's none on board.", "§91.211(a)(2)");
    else if (sim.above125 > 30) add("stop", "Pilot", `About ${Math.round(sim.above125)} min above 12,500 ft without oxygen; the limit is 30 min.`, "§91.211(a)(1)");
  }

  // ----- Pilot -----
  const thru = f.currentThru ? new Date(f.currentThru + "T23:59:59") : null;
  if (!thru) add("stop", "Pilot", "Enter the date your IFR currency runs through.", "§61.57(c)");
  else if (eta > thru) {
    const lapsed = (eta.getFullYear() - thru.getFullYear()) * 12 + eta.getMonth() - thru.getMonth();
    add("stop", "Pilot", lapsed <= 6
      ? "IFR currency has lapsed. Regain it with a safety pilot, in a simulator or with an instructor before acting as PIC under IFR."
      : "IFR currency lapsed more than 6 months ago. An instrument proficiency check (IPC) is required.", "§61.57(c)–(d)");
  } else add("ok", "Pilot", `IFR current through ${thru.toLocaleDateString()}.`, "§61.57(c)");
  if (f.ill || f.meds) add("stop", "Pilot", "Illness or impairing medication. Don't act as PIC while you have a known medical deficiency.", "§61.53");
  if (f.alcohol) add("stop", "Pilot", "Alcohol within 8 hours.", "§91.17");
  if (f.stress) add("caution", "Pilot", "Unusual stress lowers single-pilot IFR capacity.", "IMSAFE", 3);
  if (f.fatigue) add("caution", "Pilot", "You report feeling tired.", "IMSAFE", 3);
  if (f.hungry) add("caution", "Pilot", "Eat and hydrate before departure.", "IMSAFE", 1);
  const sleep = num(f.sleep);
  if (sleep != null && sleep < (num(f.pmSleep) ?? 0)) add("caution", "Pilot", `${sleep} h sleep is under your ${f.pmSleep} h minimum.`, "Personal minimum", 3);
  if (lowImc) add("caution", "Pilot", `Only ${f.imc90 || 0} h actual IMC in 90 days (your target: ${f.pmImc} h). Approach margins raised by 200 ft / ½ SM.`, "Personal minimum", 2);
  else add("ok", "Pilot", `${f.imc90} h actual IMC in the last 90 days.`);
  if ((num(f.type90) ?? 0) < (num(f.pmType) ?? 0)) add("caution", "Pilot", `${f.type90 || 0} h in type in 90 days is under your ${f.pmType} h.`, "Personal minimum", 2);

  // ----- Aircraft -----
  for (const [id, months, label, ref] of [["annual", 12, "Annual inspection", "§91.409"], ["pitot", 24, "Altimeter/static system check", "§91.411"], ["xpdr", 24, "Transponder check", "§91.413"], ["elt", 12, "ELT inspection", "§91.207"]]) {
    const due = endOfCalMonth(f[id], months);
    if (!due) add("stop", "Aircraft", `Enter the date of the last ${label.toLowerCase()}.`, ref);
    else if (eta > due) add("stop", "Aircraft", `${label} expired ${due.toLocaleDateString()}.`, ref);
    else add("ok", "Aircraft", `${label} valid through ${due.toLocaleDateString()}.`, ref);
  }
  if (f.useVor || f.destAppr === "VOR") {
    const vorAge = f.vorCheck ? (etd - new Date(f.vorCheck + "T00:00:00")) / 86400e3 : Infinity;
    if (vorAge > 30) add("stop", "Aircraft", "VOR check is older than 30 days (or missing).", "§91.171");
    else add("ok", "Aircraft", `VOR checked ${Math.floor(vorAge)} days ago.`, "§91.171");
  }
  const gpsAppr = ["LPV", "LNAV/VNAV", "LNAV"].includes(f.destAppr);
  if (!f.gpsDb) {
    if (gpsAppr) add("stop", "Aircraft", "GPS database is out of date; RNAV (GPS) approaches aren't authorized.", "AIM 1-1-17");
    else add("caution", "Aircraft", "GPS database is out of date. Verify every waypoint, and don't plan GPS approaches.", "AIM 1-1-17", 2);
  }
  if (f.inop === "unknown") add("stop", "Aircraft", "Inoperative equipment hasn't been evaluated against §91.213.", "§91.213");
  if (f.inop === "deferred") add("caution", "Aircraft", "Flying with deferred inoperative equipment.", "§91.213", 1);
  if (!f.autopilot) {
    if (f.pmNeedAp && f.inClouds) add("stop", "Aircraft", "No working autopilot, and your minimums require one for single-pilot IMC.", "Personal minimum");
    else add("caution", "Aircraft", "Single-pilot IMC without an autopilot.", "", 3);
  }

  // ----- Weather at the airports -----
  const pmAddCig = (num(f.pmAddCig) ?? 0) + (lowImc ? 200 : 0);
  const pmAddVis = (num(f.pmAddVis) ?? 0) + (lowImc ? 0.5 : 0);
  const A = pt => (pt && W.apt[pt.token]) || {};
  const depA = A(dep), dstA = A(dest), altA = A(altPt);
  const depId = dep?.token || "", destId = dest?.token || "", altId = altPt?.token || "";
  const depWin = [etd, new Date(+etd + 3600e3)];
  const dstWin = [new Date(+eta - 3600e3), new Date(+eta + 3600e3)];
  const altWin = [new Date(+etaAlt - 3600e3), new Date(+etaAlt + 3600e3)];
  const depW = tafWindow(depA.taf, ...depWin);
  const depNow = etd - now < 90 * 60e3 ? metarSum(depA.metar) : null;
  const depPrev = worst(depW.prev, depNow);
  const dstW = tafWindow(dstA.taf, ...dstWin);
  const altW = altPt ? tafWindow(altA.taf, ...altWin) : null;
  if (dep) ctx.cards.push({ role: "Departure", id: depId, a: depA, win: depWin, w: depW, prev: depPrev });
  if (dest) ctx.cards.push({ role: "Destination", id: destId, a: dstA, win: dstWin, w: dstW, prev: dstW.prev });
  if (altPt) ctx.cards.push({ role: "Alternate", id: altId, a: altA, win: altWin, w: altW, prev: altW.prev });
  // beyond the TAFs: forecast guidance instead, and the verdict becomes an outlook
  const depO = loaded ? outlookFor(dep, depA, depWin) : null, dstO = loaded ? outlookFor(dest, dstA, dstWin) : null, altO = loaded ? outlookFor(altPt, altA, altWin) : null;
  for (const [o, card] of [[depO, "Departure"], [dstO, "Destination"], [altO, "Alternate"]]) {
    const c = ctx.cards.find(x => x.role === card);
    if (o && c) { c.o = o; c.prev = o.prev; c.w = o; }
  }
  ctx.outlook = depO || dstO || altO ? { lead: Math.round(leadH(eta)), cycle: (W.nbm?.nbs || W.nbm?.nbe)?.cycle, source: (W.nbm?.nbs || W.nbm?.nbe)?.source, tafFrom: tafCoverFrom(eta) } : null;
  if (!ctx.outlook && etd - now > 30 * 3600e3) add("caution", "Plan", "Departure is more than 30 hours out, beyond most TAFs. Re-run this check within 24 hours of departure.", "", 2);
  const likely = w => `most likely ${fmtCig(w.prev.cig ?? Infinity)} / ${fmtVis(w.prev.vis ?? 10)}`;
  const ifrChance = (o, id, when, hi, lo) => {
    const pc = Math.max(o.ifc, o.ifv), what = o.ifc >= o.ifv ? "IFR ceilings (below 1,000 ft)" : "IFR visibility (below 3 SM)";
    if (pc >= 60) add("caution", "Weather", `${pc}% chance of ${what} at ${id} ${when}. Conditions could end up lower than the most likely values.`, "NBM", hi);
    else if (pc >= 30) add("caution", "Weather", `${pc}% chance of ${what} at ${id} ${when}.`, "NBM", lo);
  };
  const noGuidance = (o, id, what, pts) => add("caution", "Weather", `No ceiling or visibility guidance for ${id} ${what}: ${o.kind === "nbe" ? "the flight is more than 72 hours out, past the NBM ceiling and visibility forecasts" : o.why}.`, "NBM", pts);

  let altRequired = true;
  ctx.tsForecast = false;
  if (!loaded) {
    add("stop", "Weather", W.error ? "Data couldn't be loaded, so the flight can't be assessed." : "Loading route and weather…");
  } else if (dep && dest) {
    // departure
    if (depO) {
      if (depO.kind === "nbs") {
        const cig = depO.prev.cig ?? Infinity, vis = depO.prev.vis ?? 10;
        if (cig < num(f.pmDepCig) || vis < num(f.pmDepVis)) add("stop", "Weather", `Departure ${likely(depO)} (NBM), below your departure minimums (${f.pmDepCig} ft / ${f.pmDepVis} SM).`, "NBM");
        else if (cig < num(f.depMinCig) || vis < num(f.depMinVis)) {
          if (f.pmReturn) add("stop", "Weather", `No return option likely: departure ${likely(depO)} (NBM), below the approach back into ${depId} (${f.depMinCig} ft / ${f.depMinVis} SM).`, "NBM");
          else add("caution", "Weather", `No return option into ${depId} likely; you'd need a takeoff alternate within about 30 minutes.`, "NBM", 3);
        } else add("ok", "Weather", `Departure ${likely(depO)} (NBM): within your minimums, return possible.`, "NBM");
        ifrChance(depO, depId, "at departure", 2, 1);
      } else noGuidance(depO, depId, "at departure", 2);
      windChecks(add, f, P, depId, depO.prev, null, dep.runways);
    } else {
    if (depA.tafProxy) add("caution", "Weather", `${depId} has no TAF; departure forecast taken from ${depA.tafProxy.id}, ${depA.tafProxy.d} nm away.`, "§91.103", 1);
    if (depA.taf && !depW.prev.rows && !depNow) add("caution", "Weather", `The ${depA.taf.icaoId} TAF doesn't reach your departure time. Re-check when the next TAF is issued.`, "§91.103", 2);
    else if (!depA.taf && !depNow) add("caution", "Weather", `No TAF at or near ${depId}. Use the GFA to judge departure weather.`, "§91.103", 2);
    if (depPrev.cig != null || depPrev.vis != null) {
      const cig = depPrev.cig ?? Infinity, vis = depPrev.vis ?? 99;
      if (cig < num(f.pmDepCig) || vis < num(f.pmDepVis))
        add("stop", "Weather", `Departure ${fmtCig(cig)} / ${fmtVis(vis)} is below your departure minimums (${f.pmDepCig} ft / ${f.pmDepVis} SM).`, "Personal minimum");
      else if (cig < num(f.depMinCig) || vis < num(f.depMinVis)) {
        if (f.pmReturn) add("stop", "Weather", `No return option: departure weather ${fmtCig(cig)} / ${fmtVis(vis)} is below the approach back into ${depId} (${f.depMinCig} ft / ${f.depMinVis} SM).`, "Personal minimum");
        else add("caution", "Weather", `No return option into ${depId}; you need a takeoff alternate within about 30 minutes.`, "", 3);
      } else add("ok", "Weather", `Departure ${fmtCig(cig)} / ${fmtVis(vis)}: within your minimums, return possible.`);
    }
    windChecks(add, f, P, depId, depPrev, depW.cond, dep.runways);
    }

    // destination
    let altReason = "";
    if (dstO) {
      if (dstO.kind === "nbs") {
        const cig = dstO.prev.cig ?? Infinity, vis = dstO.prev.vis ?? 10;
        altRequired = cig < 2000 || vis < 3 || dstO.ifc >= 30;
        altReason = altRequired ? `guidance for ${destId} is ${likely(dstO)}, with a ${dstO.ifc}% chance of IFR ceilings` : "";
        const minCig = num(f.destMinCig) ?? 0, minVis = num(f.destMinVis) ?? 0, myCig = minCig + pmAddCig, myVis = minVis + pmAddVis;
        const apprName = f.destChart || f.destAppr;
        if (cig < minCig || vis < minVis) add("stop", "Weather", `${destId} is ${likely(dstO)} (NBM), below the ${apprName} minimums (${minCig} ft / ${minVis} SM).`, "NBM");
        else if (cig < myCig || vis < myVis) add("stop", "Weather", `${destId} is ${likely(dstO)} (NBM), below your minimums for this approach (${myCig} ft / ${+myVis.toFixed(2)} SM).`, "NBM");
        else add("ok", "Weather", `${destId} is ${likely(dstO)} (NBM), above your approach minimums (${myCig} ft / ${+myVis.toFixed(2)} SM).`, "NBM");
        if (cig < 500 || vis < 1) add("caution", "Weather", `Low IFR is the most likely outcome at ${destId}.`, "NBM", 2);
        ifrChance(dstO, destId, "around your arrival", 3, 2);
      } else {
        noGuidance(dstO, destId, "at your arrival", 3);
        altReason = `there's no ceiling or visibility guidance for ${destId} yet`;
      }
      windChecks(add, f, P, destId, dstO.prev, null, dest.runways);
    } else if (!dstA.taf) {
      add("caution", "Weather", `No TAF at or near ${destId}. Use the GFA for the destination.`, "§91.169", 3);
      altReason = "no TAF for the destination";
    } else {
      if (dstA.tafProxy) {
        add("caution", "Weather", `${destId} has no TAF; its forecast is taken from ${dstA.tafProxy.id}, ${dstA.tafProxy.d} nm away.`, "TAF", 2);
        altReason = `no TAF at ${destId}`;
      }
      if (!dstW.covered) add("caution", "Weather", `The ${dstA.taf.icaoId} TAF doesn't cover ETA ±1 h. Re-check when the next TAF is issued.`, "", 2);
      const p = dstW.prev, c = dstW.cond, all = worst(p, c);
      const cig = all.cig ?? Infinity, vis = all.vis ?? 99;
      if (!dstA.tafProxy) {
        altRequired = cig < 2000 || vis < 3;
        altReason = altRequired ? `forecast ${fmtCig(cig)} / ${fmtVis(vis)} within ETA ±1 h` : "";
      }
      const pc = p.cig ?? Infinity, pv = p.vis ?? 99;
      const minCig = num(f.destMinCig) ?? 0, minVis = num(f.destMinVis) ?? 0;
      const myCig = minCig + pmAddCig, myVis = minVis + pmAddVis;
      const apprName = f.destChart || f.destAppr;
      if (pc < minCig || pv < minVis) add("stop", "Weather", `${destId} forecast ${fmtCig(pc)} / ${fmtVis(pv)} is below the ${apprName} minimums (${minCig} ft / ${minVis} SM).`, "Approach plate");
      else if (pc < myCig || pv < myVis) add("stop", "Weather", `${destId} forecast ${fmtCig(pc)} / ${fmtVis(pv)} is below your minimums for this approach (${myCig} ft / ${+myVis.toFixed(2)} SM).`, "Personal minimum");
      else add("ok", "Weather", `${destId} forecast ${fmtCig(pc)} / ${fmtVis(pv)} is above your approach minimums (${myCig} ft / ${+myVis.toFixed(2)} SM).`);
      if (c.rows) {
        const cc = c.cig ?? Infinity, cv = c.vis ?? 99;
        if (cc < minCig || cv < minVis) add("caution", "Weather", `TEMPO/PROB at ${destId} drops to ${fmtCig(cc)} / ${fmtVis(cv)}, below approach minimums. Expect a possible missed approach.`, "TAF", 4);
        else if (cc < myCig || cv < myVis) add("caution", "Weather", `TEMPO/PROB at ${destId} drops to ${fmtCig(cc)} / ${fmtVis(cv)}, below your minimums.`, "TAF", 2);
      }
      if (pc < 500 || pv < 1) add("caution", "Weather", `Low IFR forecast at ${destId}.`, "", 2);
    }
    if (!["ILS", "LPV"].includes(f.destAppr)) add("caution", "Weather", `The ${f.destAppr} minimums line has no glidepath to a DA.`, "", 1);
    if (!(W.charts?.dest?.charts || []).length) add("caution", "Plan", `No published instrument approach found for ${destId}.`, "d-TPP", 3);
    if (!dstO) windChecks(add, f, P, destId, dstW.prev, dstW.cond, dest.runways);

    // alternate
    if (altRequired) {
      add("info", "Legal", `Alternate required: ${altReason}.`, "§91.169(b)");
      if (!altPt) add("stop", "Legal", "An alternate is required but none is entered.", "§91.169(a)");
    } else add("ok", "Legal", `No alternate required: ${destId} forecast is at least 2,000 ft and 3 SM within ETA ±1 h.`, "§91.169(b)");
    if (altPt) {
      const req = { precision: [600, 2], nonprecision: [800, 2], nonstd: [num(f.altNonCig) ?? 800, num(f.altNonVis) ?? 2], none: [Math.max(mea - altPt.elevFt, 1000), 3] }[f.altType];
      if (altO) {
        if (altO.kind === "nbs") {
          const pc = altO.prev.cig ?? Infinity, pv = altO.prev.vis ?? 10;
          if (pc < req[0] || pv < req[1]) add(altRequired ? "stop" : "caution", "Legal", `${altId} is ${likely(altO)} (NBM), likely below alternate minimums (${req[0]} ft / ${req[1]} SM).`, "NBM", 3);
          else add("ok", "Legal", `${altId} likely meets alternate minimums (${req[0]} ft / ${req[1]} SM): ${likely(altO)} (NBM).`, "NBM");
          if (altO.ifc >= 50) add("caution", "Legal", `${altO.ifc}% chance of IFR ceilings at the alternate ${altId}.`, "NBM", 1);
        } else add("caution", "Legal", `${altId} can't be shown to meet alternate minimums yet: ${altO.kind === "nbe" ? "no ceiling or visibility guidance past 72 hours" : altO.why}.`, "NBM", 2);
      } else if (!altA.taf) add(altRequired ? "stop" : "caution", "Legal", `No TAF at or near ${altId}, so it can't be shown to meet alternate minimums.`, "§91.169(c)", 3);
      else {
        if (altA.tafProxy) add("caution", "Legal", `${altId} has no TAF; using ${altA.tafProxy.id} (${altA.tafProxy.d} nm). Pick an alternate with its own TAF if you can.`, "§91.169(c)", 2);
        const pc = altW.prev.cig ?? Infinity, pv = altW.prev.vis ?? 99;
        if (pc < req[0] || pv < req[1]) add(altRequired ? "stop" : "caution", "Legal", `${altId} forecast ${fmtCig(pc)} / ${fmtVis(pv)} is below alternate minimums (${req[0]} ft / ${req[1]} SM).`, "§91.169(c)", 3);
        else add("ok", "Legal", `${altId} meets alternate minimums (${req[0]} ft / ${req[1]} SM): forecast ${fmtCig(pc)} / ${fmtVis(pv)}.`, "§91.169(c)");
        const cc = altW.cond.cig ?? Infinity, cv = altW.cond.vis ?? 99;
        if (altW.cond.rows && (cc < req[0] || cv < req[1])) add("caution", "Legal", `TEMPO/PROB at ${altId} dips below alternate minimums.`, "TAF", 2);
        if (!altW.covered) add("caution", "Weather", `The ${altA.taf.icaoId} TAF doesn't cover your arrival at ${altId}.`, "", 1);
      }
      if (!(W.charts?.alt?.charts || []).length && f.altType !== "none") add("caution", "Legal", `No published approach found for ${altId}; set alternate minimums to "No approach".`, "d-TPP", 2);
    }

    // fuel (§91.167) and personal reserve, from the simulated flight
    if (sim) {
      const onBoard = num(f.fuelGal) ?? 0;
      const tripGal = P.taxiGal + sim.fuel;
      const altGal = altRequired && altSim ? altSim.fuel + P.cruiseGph * MISSED_MIN / 60 : 0;
      const resGal = P.cruiseGph * 0.75;
      const legal = tripGal + altGal + resGal;
      const landing = onBoard - tripGal - altGal;
      const landingMin = landing / P.cruiseGph * 60;
      ctx.fuel = { onBoard, tripGal, altGal, resGal, legal, landing, landingMin, atDest: onBoard - tripGal };
      if (P.usableGal && onBoard > P.usableGal + 0.1) add("caution", "Fuel", `Fuel on board (${onBoard} gal) is more than the ${P.usableGal} gal usable capacity.`, "", 1);
      if (onBoard < legal) add("stop", "Fuel", `Need ${legal.toFixed(1)} gal (taxi and trip ${tripGal.toFixed(1)}${altGal ? ` + alternate ${altGal.toFixed(1)}` : ""} + 45 min ${resGal.toFixed(1)}); you have ${onBoard} gal.`, "§91.167");
      else if (landingMin < (num(f.pmFuelMin) ?? 45)) add("stop", "Fuel", `You'd land${altGal ? " at the alternate" : ""} with ${landing.toFixed(1)} gal (${Math.round(landingMin)} min), under your ${f.pmFuelMin} min floor.`, "Personal minimum");
      else add("ok", "Fuel", `Land${altGal ? " at the alternate" : ""} with ${landing.toFixed(1)} gal (${Math.round(landingMin)} min); legal need ${legal.toFixed(1)} of ${onBoard} gal.`, "§91.167");
    }

    // thunderstorms and freezing precipitation in the TAF windows
    for (const [id, o] of [[depId, depO], [destId, dstO], [altId, altO]]) {
      if (!o || !id || o.kind === "none") continue;
      const near = o.kind === "nbs" ? "within about 3 hours of your time" : "in the 12 hours around your time";
      const [hi, mid, lo] = o.kind === "nbs" ? [50, 25, 10] : [60, 30, 15];
      if (o.ts >= mid) ctx.tsForecast = true;
      if (o.ts >= hi) add("stop", "Weather", `Thunderstorms likely at ${id}: ${o.ts}% chance ${near} (NBM).`, "NBM");
      else if (o.ts >= mid) add("caution", "Weather", `${o.ts}% chance of thunderstorms at ${id} ${near} (NBM).`, "NBM", 4);
      else if (o.ts >= lo) add("caution", "Weather", `${o.ts}% chance of thunderstorms at ${id} ${near} (NBM).`, "NBM", 1);
      const fzra = o.pzr * o.pop / 100; // PZR is conditional on precipitation
      if (fzra >= 10) add("stop", "Weather", `Freezing rain possible at ${id}: ${o.pop}% chance of precipitation, ${o.pzr}% of it freezing rain (NBM).`, "NBM");
      else if (fzra >= 3) add("caution", "Weather", `Some risk of freezing rain at ${id} (NBM).`, "NBM", 3);
    }
    for (const [id, w, extra, rec, o] of [[depId, depW, depNow, depA, depO], [destId, dstW, null, dstA, dstO], [altId, altW, null, altA, altO]]) {
      if (!w || !id || o) continue;
      const src = rec.tafProxy ? ` (${rec.tafProxy.id} forecast)` : "";
      const pw = (w.prev.wx.join(" ") + " " + (extra ? extra.wx.join(" ") : "")).trim();
      const cw = w.cond.wx.join(" ");
      const onStation = /(^|\s)[-+]?TS/; // TS, +TSRA, -TSRA; not VCTS
      if (/FZRA|FZDZ|PL/.test(pw + " " + cw)) add("stop", "Weather", `Freezing precipitation forecast at ${id}${src}.`, "TAF");
      if (/TS/.test(pw + " " + cw)) ctx.tsForecast = true;
      if (onStation.test(pw)) add("stop", "Weather", `Thunderstorms forecast at ${id}${src} for your time window.`, "TAF");
      else if (/VCTS/.test(pw)) add("caution", "Weather", `Thunderstorms forecast in the vicinity of ${id}${src} (VCTS).`, "TAF", 4);
      else if (/TS/.test(cw)) add("caution", "Weather", `Possible thunderstorms (TEMPO/PROB) at ${id}${src}.`, "TAF", 4);
    }
  }

  // ----- Along the route: model data, SIGMETs, G-AIRMETs, PIREPs, CAPE -----
  const hz = (level, kind, text) => ctx.hazards.push({ level, kind, text });
  const routePts = dest ? samplePath(altPt ? [...pts, altPt] : pts, 10) : [];
  let convNearNm = Infinity;
  let fzl = num(f.fzl), fzlSrc = "entered";
  const tops = num(f.tops);
  let cloudAtCruise = f.inClouds && !(tops != null && cruise >= tops + 1000);
  const wxOnboard = f.datalink || f.stormscope;
  if (loaded && sim) {
    // model values at the time the airplane passes each sample point (±1 h for CAPE)
    const tls = [sim.timeline, altSim?.timeline];
    let capeMax = null, capeWhere = "", liMin = null, liWhere = "", fzlMin = null, fzlWhere = "";
    let baseMin = null, topsMax = null, nCloud = 0, nInCloud = 0;
    for (const s of W.om) {
      s.pass = null;
      const tPass = timeAtAlong(tls, s.along);
      if (tPass == null || !s.hourly) continue;
      const h = hourIndex(s, tPass);
      if (h < 0) continue;
      const near = [h - 1, h, h + 1].filter(i => i >= 0 && i < s.hourly.time.length);
      const cape = Math.max(...near.map(i => s.hourly.cape?.[i] ?? 0));
      const liLow = Math.min(...near.map(i => s.hourly.lifted_index?.[i] ?? 99));
      const li = liLow < 99 ? liLow : null; // 99: no model value
      const fz = s.hourly.freezing_level_height?.[h];
      const cloud = cloudProfile(s.hourly, h);
      s.pass = { cape, li, fzl: fz != null ? fz * M_TO_FT : null, cloud };
      if (cloud.lv.length && s.along <= sim.total + 0.1) {
        nCloud++;
        const flown = s.along < 0.1 || s.along > sim.total - 0.1 ? null : cruise; // ends are climb/descent
        if (flown != null && coverAt(cloud, flown) >= CLOUD_PCT) nInCloud++;
        if (cloud.base != null) baseMin = baseMin == null ? cloud.base : Math.min(baseMin, cloud.base);
        if (cloud.tops != null) topsMax = topsMax == null ? cloud.tops : Math.max(topsMax, cloud.tops);
      }
      const where = nearestName(s);
      if (capeMax == null || cape > capeMax) { capeMax = cape; capeWhere = where; }
      if (li != null && (liMin == null || li < liMin)) { liMin = li; liWhere = where; }
      if (fz != null && (fzlMin == null || fz * M_TO_FT < fzlMin)) { fzlMin = fz * M_TO_FT; fzlWhere = where; }
    }
    ctx.cape = { max: capeMax, where: capeWhere, li: liMin, liWhere };
    if (nCloud) {
      const pct = Math.round(nInCloud / Math.max(1, nCloud - 2) * 100);
      ctx.clouds = { baseMin, topsMax, pct };
      if (tops == null) cloudAtCruise = f.inClouds && nInCloud > 0;
      hz(pct ? "info" : "ok", "Clouds", `Model: lowest base ${baseMin != null ? ft(baseMin) + " ft" : "none"}, highest tops ${topsMax != null ? ft(topsMax) + " ft" : "none"} MSL; in cloud at ${ft(cruise)} ft on about ${Math.min(100, pct)}% of the route`);
    }
    if (fzl == null && fzlMin != null) { fzl = Math.round(fzlMin / 100) * 100; fzlSrc = `model, lowest near ${fzlWhere}`; }

    // SIGMETs
    const tStart = +etd / 1000, tEnd = +etaAlt / 1000;
    for (const s of W.sigmets) {
      if (s.validTimeTo < tStart || s.validTimeFrom > tEnd || !s.coords?.length) continue;
      const poly = s.coords.map(c => ({ lat: +c.lat, lon: +c.lon }));
      const d = routeDistance(routePts, poly);
      const low = s.altitudeLow1 ?? 0, high = s.altitudeHi1 ?? 60000;
      if (s.hazard === "CONVECTIVE") {
        convNearNm = Math.min(convNearNm, d);
        if (d <= 20) {
          add("stop", "Route", `Convective SIGMET ${s.seriesId} lies ${d < 1 ? "on" : `${Math.round(d)} nm from`} your route. Stay 20 nm clear of severe storms.`, "AC 00-24");
          hz("stop", "Conv SIGMET", `${s.seriesId}, tops FL${Math.round(high / 100)}, ${Math.round(d)} nm from route`);
        } else if (d <= 60) hz("caution", "Conv SIGMET", `${s.seriesId}, ${Math.round(d)} nm from route`);
      } else if (d <= 0.5 && low <= cruise + 2000) {
        add("stop", "Route", `SIGMET ${s.seriesId} (${s.hazard}) covers your route.`, "SIGMET");
        hz("stop", "SIGMET", `${s.seriesId} ${s.hazard} ${ft(low)}–${ft(high)} ft`);
      }
    }
    // G-AIRMETs, snapshot nearest mid-flight
    const mid = +etd + (+eta - +etd) / 2;
    const snaps = [...new Set(W.gairmets.map(g => g.validTime))];
    const snap = snaps.sort((a, b) => Math.abs(new Date(a) - mid) - Math.abs(new Date(b) - mid))[0];
    if (snap && Math.abs(new Date(snap) - mid) <= 2 * 3600e3) {
      const seen = new Set();
      for (const g of W.gairmets.filter(g => g.validTime === snap && g.geometryType === "AREA")) {
        const poly = (g.coords || []).map(c => ({ lat: +c.lat, lon: +c.lon }));
        if (poly.length < 3 || routeDistance(routePts, poly) > 0.5) continue;
        const key = g.hazard + g.due_to; if (seen.has(key)) continue; seen.add(key);
        const base = altFt(g.base, fzl), top = altFt(g.top, fzl);
        const overlaps = (base ?? 0) <= cruise + 1000;
        const lvl = base != null || top != null ? ` ${base != null ? ft(base) : "SFC"}–${top != null ? ft(top) : "?"} ft` : "";
        if (g.hazard === "ICE" && overlaps) {
          if (!fiki && cloudAtCruise) add("stop", "Route", `AIRMET Zulu (icing${lvl}) on your route and the airplane isn't approved for known icing.`, "G-AIRMET");
          else add("caution", "Route", `AIRMET Zulu (icing${lvl}) on your route.`, "G-AIRMET", fiki ? 2 : 3);
          hz(fiki ? "caution" : "stop", "Icing", `AIRMET Zulu${lvl}`);
        } else if (g.hazard === "TURB-LO" && overlaps) {
          add("caution", "Route", `AIRMET Tango (moderate turbulence${lvl}) on your route.`, "G-AIRMET", 2);
          hz("caution", "Turbulence", `AIRMET Tango${lvl}`);
        } else if (g.hazard === "LLWS") {
          add("caution", "Route", "Low-level wind shear AIRMET on your route.", "G-AIRMET", 3); hz("caution", "Wind shear", "AIRMET LLWS");
        } else if (g.hazard === "SFC_WND") {
          add("caution", "Route", "Sustained surface winds over 30 kt AIRMET on your route.", "G-AIRMET", 2); hz("caution", "Surface wind", "AIRMET");
        } else if (g.hazard === "MT_OBSC") {
          if (f.mountains) add("caution", "Route", "Mountains obscured on your route.", "G-AIRMET", 2);
          hz("info", "Mtn obscn", "AIRMET Sierra");
        } else if (g.hazard === "IFR") hz("info", "IFR", `AIRMET Sierra: ${g.due_to || "IFR conditions"}`);
      }
      hz("info", "G-AIRMET", `Snapshot valid ${fmtZ(new Date(snap))} checked against the route`);
    } else hz(ctx.outlook ? "info" : "caution", "G-AIRMET", "No G-AIRMET snapshot covers the flight time (they run 12 h ahead). Check the GFA closer to departure.");

    // SPC convective outlook areas the route crosses (days 1-3)
    const spcHit = spcOnRoute(routePts, [etd, eta, etaAlt]);
    if (spcHit) {
      const lbl = `SPC Day ${spcHit.day}`, txt = `Your route crosses an SPC ${SPC_NAME[spcHit.label]} area (${spcHit.label}).`;
      const r = SPC_RANK[spcHit.label];
      if (r >= 4) add("stop", "Route", `${txt} Organized severe storms are expected.`, lbl);
      else if (r === 3) add("caution", "Route", `${txt} Scattered severe storms are possible.`, lbl, 5);
      else if (r === 2) add("caution", "Route", `${txt} Isolated severe storms are possible.`, lbl, 3);
      else add("caution", "Route", `${txt} Thunderstorms are possible.`, lbl, 1);
      hz(r >= 4 ? "stop" : "caution", "SPC", `${spcHit.label}: ${SPC_NAME[spcHit.label]} (Day ${spcHit.day} outlook)`);
    } else if ((W.spc || []).length) hz("ok", "SPC", "No SPC convective outlook area on the route at your times");

    // PIREPs near departure and destination, at or below cruise + 4,000 ft (only for flights in the next hours)
    if (ctx.outlook) hz("info", "PIREPs", "Pilot reports describe the last 3 hours, so they aren't used for an outlook.");
    const rank = s => (/SEV|EXTRM/.test(s) ? 3 : /MOD/.test(s) ? 2 : /LGT|TRC/.test(s) ? 1 : 0);
    let flags = 0;
    for (const p of ctx.outlook ? [] : W.pireps) {
      const lvl = (p.fltLvl ?? 0) * 100;
      if (lvl > cruise + 4000) continue;
      const ice = Math.max(rank(p.icgInt1 || ""), rank(p.icgInt2 || ""));
      const tb = Math.max(rank(p.tbInt1 || ""), rank(p.tbInt2 || ""));
      if (ice >= 3) { add("stop", "Route", `Severe icing reported at ${ft(lvl)} ft: ${p.rawOb}`, "PIREP"); hz("stop", "PIREP ice", p.rawOb); flags++; }
      else if (ice === 2) { if (fiki) add("caution", "Route", `Moderate icing reported at ${ft(lvl)} ft.`, "PIREP", 3); else add("stop", "Route", `Moderate icing reported at ${ft(lvl)} ft and the airplane isn't approved for known icing.`, "PIREP"); hz(fiki ? "caution" : "stop", "PIREP ice", p.rawOb); flags++; }
      else if (ice === 1 && !fiki) { add("caution", "Route", `Light icing reported at ${ft(lvl)} ft.`, "PIREP", 2); hz("caution", "PIREP ice", p.rawOb); flags++; }
      if (tb >= 3) { add("stop", "Route", `Severe turbulence reported at ${ft(lvl)} ft.`, "PIREP"); hz("stop", "PIREP turb", p.rawOb); flags++; }
      else if (tb === 2) { add("caution", "Route", `Moderate turbulence reported at ${ft(lvl)} ft.`, "PIREP", 1); hz("caution", "PIREP turb", p.rawOb); flags++; }
    }
    if (!ctx.outlook) hz(flags ? "info" : "ok", "PIREPs", `${W.pireps.length} reports within 100 nm in the last 3 h${flags ? "" : ", none with icing or turbulence at your altitudes"}`);

    // Instability from two model numbers; the worse one decides.
    // CAPE: how much energy a rising parcel would have. Lifted index: how much warmer than the air
    // around it a surface parcel would be at 500 hPa (negative = buoyant). Either plus a trigger means storms.
    if (capeMax != null || liMin != null) {
      const P0 = num(f.pmCape) ?? 1000;
      const L0 = num(f.pmLi) ?? -3;
      const tsNear = ctx.tsForecast || convNearNm <= 60;
      const tier = instabilityTier(capeMax, liMin, P0, L0);
      const label = [
        capeMax != null ? `CAPE ${Math.round(capeMax)} J/kg near ${capeWhere}` : "",
        liMin != null ? `lifted index ${liMin.toFixed(1)}${liWhere && liWhere !== capeWhere ? ` near ${liWhere}` : ""}` : "",
      ].filter(Boolean).join(", ");
      const by = tier.cape === tier.li ? "" : tier.li > tier.cape ? " (driven by the lifted index)" : " (driven by CAPE)";
      const t = tier.level;
      if (t >= 2 && tsNear) add("stop", "Route", `${label}, with thunderstorms forecast or reported nearby. Expect storms that build fast and hard.`, "Instability");
      else if (t === 3) add("caution", "Route", `${label}: strong instability${by}. Any storm that fires can become severe.`, "Instability", 6);
      else if (t === 2) add("caution", "Route", `${label}: moderate instability${by}. Storms are likely if anything triggers lift (fronts, heating, terrain).`, "Instability", tier.cape >= 2 && tier.li >= 2 ? 5 : 4);
      else if (t === 1) add("caution", "Route", `${label}: some instability${by}. Isolated showers or storms are possible, worst in the afternoon.`, "Instability", 2);
      else add("ok", "Route", `${label}: stable air along the route.`, "Instability");
      if (t >= 2 && cloudAtCruise && !wxOnboard) add("caution", "Route", "Storms can hide inside cloud, and you have no datalink weather or stormscope to find them.", "Instability", 2);
      hz(t >= 2 ? (tsNear ? "stop" : "caution") : t === 1 ? "caution" : "ok", "Instability", `${label} (Open-Meteo model, at your passing time ±1 h)`);
    } else if (W.omError) hz("caution", "Instability", `Model data unavailable: ${W.omError}`);
  }

  // icing from the freezing level
  ctx.fzl = fzl; ctx.fzlSrc = fzlSrc;
  if (fzl != null) {
    if (cloudAtCruise && !fiki) {
      if (fzl <= mea) add("stop", "Route", `Freezing level (${ft(fzl)} ft, ${fzlSrc}) is at or below the MEA (${ft(mea)} ft): no ice-free altitude to descend to in cloud.`, "Icing");
      else if (fzl <= cruise + 1000) add("caution", "Route", `Cruise at ${ft(cruise)} ft is near or above the freezing level (${ft(fzl)} ft, ${fzlSrc}). Plan to stay below ${ft(fzl - 1000)} ft in cloud.`, "Icing", 3);
      else add("ok", "Route", `Freezing level (${ft(fzl)} ft, ${fzlSrc}) is well above cruise.`);
    } else if (cloudAtCruise && fiki && fzl <= mea) add("caution", "Route", "Freezing level at or below the MEA. You have FIKI equipment, but plan an exit to clear air.", "Icing", 2);
    hz(fzl <= cruise + 1000 && cloudAtCruise ? "caution" : "ok", "Freezing lvl", `${ft(fzl)} ft MSL (${fzlSrc})`);
  }

  // ----- Night, terrain, external pressures -----
  if (f.night && f.inClouds) {
    if (!f.pmNightImc) add("stop", "Environment", "Night IMC is outside your personal minimums.", "Personal minimum");
    else add("caution", "Environment", "Night IMC.", "", 2);
  }
  if (f.mountains) add("caution", "Environment", "Mountainous terrain: fewer options if something fails.", "", 2);
  if (f.mustArrive) add("caution", "Pressure", "Schedule pressure. Decide now what you will do if the weather turns.", "", 3);
  if (f.paxPressure) add("caution", "Pressure", "Passenger pressure. Brief them on the possibility of a diversion.", "", 2);
  if (f.newDest) add("caution", "Pressure", "Unfamiliar destination. Study the airport diagram and the approach in advance.", "", 1);
  if (f.noPlanB) add("caution", "Pressure", "No backup plan. Arrange one before you go, to remove the pressure to continue.", "", 2);

  return { items, ctx };
}

// 0 stable, 1 some, 2 moderate (at or past your personal limit), 3 strong; each number scored on its own
function instabilityTier(cape, li, P0, L0) {
  const c = cape == null ? 0 : cape >= 2500 ? 3 : cape >= P0 ? 2 : cape >= 300 ? 1 : 0;
  const l = li == null ? 0 : li <= -6 ? 3 : li <= L0 ? 2 : li <= 0 ? 1 : 0;
  return { cape: c, li: l, level: Math.max(c, l) };
}

function nearestName(s) {
  const pts = [...(W.route?.points || []), ...(W.altPt ? [W.altPt] : [])];
  let best = null, bd = Infinity;
  for (const p of pts) { const d = gcNm(s, p); if (d < bd) { bd = d; best = p; } }
  return best ? (bd < 8 ? best.token : `${Math.round(bd)} nm from ${best.token}`) : "route";
}

function windChecks(add, f, P, id, prev, cond, runways) {
  if (!prev) return;
  const xw = maxCrosswind(prev.winds, runways);
  const xwC = maxCrosswind(cond?.winds || [], runways);
  const maxX = num(f.pmXwind), maxG = num(f.pmGust);
  if (xw != null && xw > maxX) add("stop", "Weather", `${id} crosswind up to ${xw} kt on the best runway (your limit ${maxX} kt).`, "Personal minimum");
  else if (xw != null && P.demoXwind && xw > P.demoXwind) add("caution", "Weather", `${id} crosswind up to ${xw} kt exceeds the ${P.demoXwind} kt demonstrated value.`, "AFM", 2);
  else if (xwC != null && xwC > maxX) add("caution", "Weather", `TEMPO/PROB winds at ${id} give up to ${xwC} kt crosswind.`, "TAF", 2);
  if (prev.gust > maxG) add("stop", "Weather", `${id} gusts to ${prev.gust} kt (your limit ${maxG} kt).`, "Personal minimum");
  else if (cond?.gust > maxG) add("caution", "Weather", `TEMPO/PROB gusts to ${cond.gust} kt at ${id}.`, "TAF", 2);
}

// ---------- rendering ----------
// an airport card in outlook mode: NBM guidance instead of the TAF
function outlookCard(c) {
  const o = c.o, pt = c.a?.pt, st = W.nbm?.[o.kind]?.stations?.[o.id];
  const xw = maxCrosswind(o.prev.winds || [], pt?.runways);
  const run = o.cycle ? `NBM ${o.kind.toUpperCase()} ${o.cycle.slice(11, 13)}Z${o.source === "IEM" ? " via IEM" : ""}` : "";
  let body;
  if (o.kind === "nbs") {
    const mid = (+c.win[0] + +c.win[1]) / 2;
    const strip = (st?.rows || []).filter(r => Math.abs(Date.parse(r.t) - mid) <= 9.1 * 3600e3).map(r => {
      const pc = Math.max(r.IFC ?? 0, r.IFV ?? 0), inWin = Math.abs(Date.parse(r.t) - mid) <= 1.6 * 3600e3;
      return `<span class="ifr-cell${inWin ? " now" : ""}" style="--p:${pc}" title="${fmtZ(new Date(r.t))}: ${r.IFC ?? "?"}% IFR ceiling, ${r.IFV ?? "?"}% IFR visibility${r.T03 ? `, ${r.T03}% thunder` : ""}"><b>${pc}</b><i>${r.t.slice(11, 13)}Z</i></span>`;
    }).join("");
    body = `<dt>Most likely</dt><dd>${fmtCig(o.prev.cig ?? Infinity)} / ${fmtVis(o.prev.vis ?? 10)}</dd>
        <dt>IFR chance</dt><dd>ceiling ${o.ifc}% · vis ${o.ifv}%</dd>
        <dt>Thunder</dt><dd>${o.ts}% (3 h)</dd>
        <dt>Wind</dt><dd>${o.prev.wspd} kt${o.prev.gust ? " G" + o.prev.gust : ""}${xw != null ? ` · xwind ${xw}` : ""}</dd>
      </dl>
      ${strip ? `<div class="ifr-strip" aria-label="Chance of IFR every 3 hours around your time">${strip}</div><div class="sub" style="font-size:0.75rem">% chance of IFR (ceiling or visibility) every 3 h; your time is outlined</div>` : ""}`;
  } else if (o.kind === "nbe") {
    body = `<dt>Ceiling / vis</dt><dd>no guidance past 72 h</dd>
        <dt>Thunder</dt><dd>${o.ts}% (12 h)</dd>
        <dt>Rain</dt><dd>${o.pop}% (12 h)</dd>
        <dt>Wind</dt><dd>${o.prev.wspd} kt${o.prev.gust ? " G" + o.prev.gust : ""}${xw != null ? ` · xwind ${xw}` : ""}</dd>
      </dl>`;
  } else body = `<dt>Guidance</dt><dd>none: ${esc(o.why)}</dd></dl>`;
  return `<div class="wx outlook-wx">
      <div class="wx-head"><div><span class="role">${c.role} · outlook</span><br><b>${esc(c.id)}</b></div><span class="cat OUT" title="Forecast guidance, not a TAF">NBM</span></div>
      <div class="name">${esc(pt?.name || "")}${pt ? ` · ${pt.elevFt} ft` : ""}${run ? `<br>${esc(run)}` : ""}</div>
      <dl class="kv">
        <dt>Window</dt><dd title="${fmtZ(c.win[0])}–${fmtZ(c.win[1])}">${fmtLocal(c.win[0])}–${new Date(c.win[1]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} local</dd>
        ${body}
    </div>`;
}
const AREA_ORDER = ["Plan", "Legal", "Weather", "Route", "Fuel", "Pilot", "Aircraft", "Environment", "Pressure"];
function li(i) {
  return `<li class="item ${i.level}"><span class="tag">${esc(i.area)}</span><span class="t">${esc(i.text)}${i.pts ? ` <span class="pts">+${i.pts}</span>` : ""}</span>${i.ref ? `<span class="r">${esc(i.ref)}</span>` : "<span></span>"}</li>`;
}
const stat = (label, value, sub = "") => `<div class="stat"><div class="lbl">${esc(label)}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;
const windTxt = w => (w ? `${String(Math.round(w.dir / 10) * 10 || 360).padStart(3, "0")}°/${Math.round(w.spd)}` : "—");
function compTxt(head) {
  if (head == null) return "—";
  const v = Math.round(head);
  return v > 0 ? `<span class="head">${v} head</span>` : v < 0 ? `<span class="tail">${-v} tail</span>` : "calm";
}

function render({ items, ctx }) {
  const by = l => items.filter(i => i.level === l).sort((a, b) => AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area));
  const stops = by("stop"), cautions = by("caution").sort((a, b) => b.pts - a.pts), oks = by("ok").concat(by("info"));
  const score = cautions.reduce((s, i) => s + i.pts, 0);
  let cls, word, why;
  if (stops.length) { cls = "stop"; word = "NO-GO"; why = `${stops.length} hard stop${stops.length > 1 ? "s" : ""}. Fix or wait.`; }
  else if (score >= 12) { cls = "stop"; word = "NO-GO"; why = `Risk score ${score}: too many factors stacked together.`; }
  else if (cautions.length) { cls = "caution"; word = "CAUTION"; why = `Go only with a plan for each caution (score ${score}).`; }
  else { cls = "go"; word = "GO"; why = "Within legal limits and your personal minimums."; }
  if (ctx.outlook) { // beyond the TAFs: an outlook, never a go/no-go
    const o = ctx.outlook, bad = stops.length || score >= 12;
    cls = `outlook ${bad ? "o-bad" : cautions.length ? "o-marginal" : "o-good"}`;
    word = bad ? "LOOKS BAD" : cautions.length ? "MARGINAL" : "LOOKS GOOD";
    why = `Outlook, ${o.lead} h ahead: forecast guidance${o.cycle ? ` (NBM ${o.cycle.slice(11, 13)}Z${o.source === "IEM" ? " via IEM" : ""})` : ""}, not TAFs. TAFs should cover your arrival from about ${fmtLocal(o.tafFrom)}; re-check then for the go/no-go.`;
  }
  if (W.loading && !W.loadedAt) { cls = ""; word = "—"; why = "Loading route and weather…"; }

  const v = $("#verdict");
  v.className = "verdict " + cls;
  v.querySelector(".word").textContent = word;
  v.querySelector(".why").textContent = why;
  $("#pin").style.left = Math.min(score, 20) / 20 * 100 + "%";
  $("#stops-h").textContent = ctx.outlook ? "Likely no-go factors" : "Hard stops";
  $("#stops").innerHTML = stops.map(li).join("") || `<li class="item ok"><span class="tag">All</span><span class="t">No hard stops.</span><span></span></li>`;
  $("#cautions").innerHTML = cautions.map(li).join("") || `<li class="item ok"><span class="tag">All</span><span class="t">No cautions.</span><span></span></li>`;
  $("#oks").innerHTML = oks.map(li).join("");
  $("#ok-sum").textContent = `Checks passed (${oks.length})`;

  // route header
  const t = ctx.times;
  const pts = W.route?.points || [];
  $("#route-meta").innerHTML = pts.map(p => `<span><b>${esc(p.token)}</b> ${esc(p.kind === "fix" ? "fix" : p.name)}</span>`).join("");
  $("#route-err").textContent = (W.route?.errors || []).join(" ");
  if (t && !Number.isNaN(+t.etd)) {
    $("#etd-z").textContent = `${fmtZ(t.etd)}${ctx.sim ? ` · ETA ${fmtZ(t.eta)}` : ""}`;
    $("#wx-when").textContent = `Departure ${fmtLocal(t.etd)} (${fmtZ(t.etd)})`;
  }
  for (const [r, p] of [["dest", W.dest], ["dep", W.dep], ["alt", W.altPt]]) $(`#${r}-name`).textContent = p ? `· ${p.token} ${p.name}` : "";

  // trip stats and legs
  const s = ctx.sim, a = ctx.altSim, fu = ctx.fuel;
  if (s) {
    const P = perfFrom(readForm());
    const cruiseLegs = s.legs.filter(l => l.head != null);
    const avgHead = cruiseLegs.length ? cruiseLegs.reduce((x, l) => x + l.head * l.dist, 0) / cruiseLegs.reduce((x, l) => x + l.dist, 0) : null;
    $("#nav-when").textContent = `ETA ${fmtLocal(t.eta)} (${fmtZ(t.eta)})`;
    $("#trip-stats").innerHTML = [
      stat("Distance", `${Math.round(s.total)} nm`, a ? `+ ${Math.round(a.total)} nm to alternate` : ""),
      stat("Time en route", fmtHM(s.minutes), a ? `alternate +${fmtHM(a.minutes + MISSED_MIN)}` : ""),
      stat("Average wind", compTxt(avgHead), `TAS ${Math.round(P.cruiseTas(num($("#cruise").value) ?? 0))} kt at cruise`),
      fu ? stat("Trip fuel", `${fu.tripGal.toFixed(1)} gal`, `${fu.atDest.toFixed(1)} gal left at destination`) : "",
      fu ? stat("Legal minimum", `${fu.legal.toFixed(1)} gal`, `of ${fu.onBoard} on board (§91.167)`) : "",
      ctx.cape?.max != null ? stat("Max CAPE · lowest LI", `${Math.round(ctx.cape.max)} · ${ctx.cape.li != null ? ctx.cape.li.toFixed(1) : "—"}`, `J/kg near ${esc(ctx.cape.where)}${ctx.cape.li != null ? ` · LI near ${esc(ctx.cape.liWhere)}` : ""}`) : "",
    ].join("");
    const modelFor = (from, to) => {
      const vals = W.om.filter(o => o.pass && o.along >= from - 0.1 && o.along <= to + 0.1);
      const fz = vals.map(o => o.pass.fzl).filter(x => x != null);
      return { cape: vals.length ? Math.max(...vals.map(o => o.pass.cape)) : null, fzl: fz.length ? Math.min(...fz) : null };
    };
    let along = 0;
    const row = (l, muted) => {
      const m = modelFor(along, along + l.dist); along += l.dist;
      return `<tr${muted ? ' style="color:var(--muted)"' : ""}><td>${esc(l.from)} → ${esc(l.to)}</td><td>${Math.round(l.dist)}</td><td>${String(Math.round(l.course)).padStart(3, "0")}°</td><td>${windTxt(l.wind)}${l.temp != null ? ` · ${Math.round(l.temp)}°C` : ""}</td><td>${compTxt(l.head)}</td><td>${l.gs ? Math.round(l.gs) : "—"}</td><td>${fmtHM(l.time)}</td><td>${l.fuel.toFixed(1)}</td><td>${m.cape != null ? Math.round(m.cape) : "—"}</td><td>${m.fzl != null ? ft(m.fzl) : "—"}</td></tr>`;
    };
    const rows = s.legs.map(l => row(l, false)).join("") + (a ? a.legs.map(l => row(l, true)).join("") : "");
    $("#legs").innerHTML = `<thead><tr><th>Leg</th><th>NM</th><th>Course</th><th>Wind · temp</th><th>Component</th><th>GS</th><th>Time</th><th>Gal</th><th>CAPE</th><th>Frz lvl</th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><td>To destination</td><td>${Math.round(s.total)}</td><td></td><td></td><td>${compTxt(avgHead)}</td><td></td><td>${fmtHM(s.minutes)}</td><td>${s.fuel.toFixed(1)}</td><td></td><td></td></tr></tfoot>`;
    $("#wind-src").textContent = `Winds and temperatures at your altitude come from the Open-Meteo forecast model for the time you pass each point; courses are true. Time and fuel use the ${esc(P.setting)} table of the ${esc(AC?.tail || "example")} preset: its climb speeds and rates, cruise speeds and fuel flows, and a ${P.descFpm} fpm descent, but not taxi. The grey alternate leg adds ${MISSED_MIN} min for a missed approach.`;
  } else {
    $("#nav-when").textContent = "";
    $("#trip-stats").innerHTML = stat("Route", W.loading ? "Loading…" : "—", W.route?.errors?.length ? "Fix the route above" : "");
    $("#legs").innerHTML = ""; $("#wind-src").textContent = "";
  }

  renderProfile(ctx);
  applyMapOutlook(ctx.outlook);
  renderAltPicker(ctx);
  refreshPsMini();
  lastCtx = ctx;

  // weather cards
  $("#wx-cards").innerHTML = ctx.cards.map(c => {
    if (c.o) return outlookCard(c);
    const m = c.a?.metar, mc = metarSum(m);
    const catNow = m?.fltCat || (mc ? category(mc.cig, mc.vis) : "NA");
    const cond = c.w?.cond;
    const xw = maxCrosswind(c.prev?.winds || [], c.a?.pt?.runways);
    const proxy = [c.a?.tafProxy && `TAF from ${c.a.tafProxy.id} (${c.a.tafProxy.d} nm)`, c.a?.metarProxy && `METAR from ${c.a.metarProxy.id} (${c.a.metarProxy.d} nm)`].filter(Boolean).join(" · ");
    return `<div class="wx">
      <div class="wx-head"><div><span class="role">${c.role}</span><br><b>${esc(c.id)}</b></div><span class="cat ${esc(catNow)}" title="Current flight category">${esc(catNow)}</span></div>
      <div class="name">${esc(c.a?.pt?.name || "")}${c.a?.pt ? ` · ${c.a.pt.elevFt} ft` : ""}${proxy ? `<br><span style="color:var(--caution)">${esc(proxy)}</span>` : ""}</div>
      <dl class="kv">
        <dt>Window</dt><dd>${fmtZ(c.win[0])}–${fmtZ(c.win[1])}</dd>
        <dt>Worst forecast</dt><dd>${c.a?.taf ? (c.prev?.rows ? `${cigDesc(c.prev)} / ${fmtVis(c.prev?.vis)}` : `TAF ${esc(c.a.taf.icaoId)} ends before this window`) : c.prev?.rows ? `METAR ${cigDesc(c.prev)} / ${fmtVis(c.prev.vis)}` : "No TAF"}</dd>
        ${cond?.rows ? `<dt>TEMPO/PROB</dt><dd>${cigDesc(cond)} / ${fmtVis(cond.vis)}${cond.wx.length ? " " + esc(cond.wx.join(" ")) : ""}</dd>` : ""}
        <dt>Wind</dt><dd>${c.prev ? `${c.prev.wspd} kt${c.prev.gust ? " G" + c.prev.gust : ""}` : "n/a"}${xw != null ? ` · xwind ${xw}` : ""}</dd>
      </dl>
      ${m ? `<pre class="raw">${esc(m.rawOb)}</pre>` : ""}
      ${c.a?.taf ? `<details><summary>TAF ${esc(c.a.taf.icaoId)}</summary><pre class="raw">${esc(c.a.taf.rawTAF.replace(/ (FM|TEMPO|BECMG|PROB)/g, "\n  $1"))}</pre></details>` : ""}
    </div>`;
  }).join("");
  $("#route-hz").innerHTML = ctx.hazards.map(h => `<li><span class="k ${h.level}">${esc(h.kind)}</span><span>${esc(h.text)}</span></li>`).join("")
    || `<li><span class="k info">Route</span><span>${W.loading ? "Loading…" : "Route hazards appear once the route resolves."}</span></li>`;
  $("#fzl-hint").textContent = ctx.fzlSrc && ctx.fzlSrc !== "entered" && ctx.fzl != null ? `Using ${ft(ctx.fzl)} ft (${ctx.fzlSrc})` : "Blank: lowest model value along the route";
  $("#perf-src").innerHTML = acKey === AC_EXAMPLE
    ? 'Example Mooney M20K 231 figures from the AOPA Pilot review (Feb 1994) and published specs. Climb speed, descent and taxi fuel are estimates. Make your own preset: enter your registration, replace the figures with your POH or ForeFlight numbers and press Save preset.'
    : `${esc(AC.tail || "This airplane")}${AC.type ? ` (${esc(AC.type)})` : ""}: your own figures. Check them against your POH.`;

  const banners = [];
  if (W.error) banners.push(`<div class="banner err">${esc(W.error)}</div>`);
  if (!store.get(EX_KEY)) banners.push(`<div class="banner">Pilot, inspection and approach-minimum fields start with <b>example values</b>. Replace them with your own; they're saved in this browser. The model is only as good as what you enter.</div>`);
  $("#banners").innerHTML = banners.join("");
  document.querySelectorAll(".example").forEach(el => (el.hidden = !!store.get(EX_KEY)));
}

// ---------- threat map (Leaflet) ----------
let map = null, layerCtl = null, overlays = {};
const DEFAULT_ON = new Set(["Route", "METARs: category and ceiling", "SIGMETs", "G-AIRMETs", "PIREPs", "CAPE (model)"]);
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const capeColor = c => (c >= 2500 ? css("--cape3") : c >= 1000 ? css("--cape2") : c >= 300 ? css("--cape1") : null);
const liColor = (v, L0) => (v == null ? null : v <= -6 ? css("--li3") : v <= L0 ? css("--li2") : v <= 0 ? css("--li1") : null);
const CAT_COLOR = { VFR: "#2e8b57", MVFR: "#2d6fc4", IFR: "#c8392f", LIFR: "#a3329e" };
const GAIRMET_STYLE = {
  ICE: { color: "#2f7fd0", label: "Icing (Zulu)" }, "TURB-LO": { color: "#d9822b", label: "Turbulence below FL180 (Tango)" },
  "TURB-HI": { color: "#b0702a", label: "Turbulence above FL180 (Tango)" }, IFR: { color: "#a3329e", label: "IFR (Sierra)" },
  MT_OBSC: { color: "#8a6a4a", label: "Mountain obscuration (Sierra)" }, LLWS: { color: "#c8392f", label: "Low-level wind shear" },
  SFC_WND: { color: "#c8392f", label: "Surface wind > 30 kt" },
};

function renderMap() {
  const el = $("#map");
  if (!window.L) { el.textContent = "The map library didn't load. It needs an internet connection."; return; }
  if (!W.route?.points?.length) return;
  if (!map) {
    map = L.map(el, { scrollWheelZoom: false, worldCopyJump: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 13,
    }).addTo(map);
    layerCtl = L.control.layers(null, null, { collapsed: false }).addTo(map);
    new ResizeObserver(() => { map.invalidateSize(); if (map._routeBounds) map.fitBounds(map._routeBounds); }).observe(el);
    $("#map-legend").innerHTML = `<span><b>CAPE J/kg</b> <i style="background:${css("--cape1")}"></i>300–999 <i style="background:${css("--cape2")}"></i>1,000–2,499 <i style="background:${css("--cape3")}"></i>2,500+</span>
      <span><b>METAR</b> ${Object.entries(CAT_COLOR).map(([k, c]) => `<i style="background:${c};border-radius:50%"></i>${k}`).join(" ")}</span>
      <span><b>Hazards</b> <i style="background:#c8392f"></i>Convective SIGMET <i style="background:#7a3fbf"></i>Other SIGMET ${["ICE", "TURB-LO", "IFR"].map(k => `<i style="background:${GAIRMET_STYLE[k].color}"></i>${GAIRMET_STYLE[k].label}`).join(" ")}</span>
      <span><b>PIREP</b> ❄ icing · ≈ turbulence · ▲ other</span>
      <span><b>Model clouds</b> T = tops (above the point), B = base (below), hundreds of ft MSL</span>`;
  }
  const visible = new Set(Object.keys(overlays).length ? Object.entries(overlays).filter(([, lg]) => map.hasLayer(lg)).map(([k]) => k) : DEFAULT_ON);
  for (const lg of Object.values(overlays)) { layerCtl.removeLayer(lg); map.removeLayer(lg); }
  overlays = {};
  const add = (name, lg) => { overlays[name] = lg; layerCtl.addOverlay(lg, name); if (visible.has(name)) lg.addTo(map); };
  const accent = css("--accent");

  // CAPE and model clouds from the area grid
  const capeL = L.layerGroup(), baseL = L.layerGroup(), topsL = L.layerGroup();
  for (const g of W.grid || []) {
    const b = [[g.lat - g.dLat / 2, g.lon - g.dLon / 2], [g.lat + g.dLat / 2, g.lon + g.dLon / 2]];
    const c = g.cape != null ? capeColor(g.cape) : null;
    if (c) L.rectangle(b, { stroke: false, fillColor: c, fillOpacity: 0.32 }).bindTooltip(`CAPE ${Math.round(g.cape)} J/kg`).addTo(capeL);
    const lbl = (txt, color, dy) => L.marker([g.lat, g.lon], { icon: L.divIcon({ className: "grid-label", html: `<span style="color:${color}">${txt}</span>`, iconSize: [44, 14], iconAnchor: [22, 7 + dy] }), interactive: false });
    if (g.base != null) lbl(`B${String(Math.round(g.base / 100)).padStart(3, "0")}`, g.base < 1000 ? CAT_COLOR.IFR : g.base < 3000 ? CAT_COLOR.MVFR : css("--muted"), -8).addTo(baseL); // below the point
    if (g.tops != null) lbl(`T${String(Math.round(g.tops / 100)).padStart(3, "0")}`, css("--ink"), 8).addTo(topsL); // above the point
  }
  add("CAPE (model)", capeL);
  add("Cloud base (model)", baseL);
  add("Cloud tops (model)", topsL);

  // G-AIRMETs
  const gL = L.layerGroup();
  for (const g of W.gairmets || []) {
    const st = GAIRMET_STYLE[g.hazard];
    if (!st || g.geometryType !== "AREA" || !g.coords?.length) continue;
    const lvl = g.base || g.top ? `<br>${g.base ?? "SFC"} to ${g.top ?? "?"}` : "";
    L.polygon(g.coords.map(c => [+c.lat, +c.lon]), { color: st.color, weight: 1.5, dashArray: g.hazard === "IFR" ? "5 4" : null, fillOpacity: g.hazard === "IFR" ? 0.04 : 0.12 })
      .bindPopup(`<b>${st.label}</b>${lvl}<br>${esc(g.due_to || "")}<br>Valid ${esc(g.validTime?.slice(11, 16) || "")}Z`).addTo(gL);
  }
  add("G-AIRMETs", gL);

  // SIGMETs
  const sL = L.layerGroup();
  for (const sg of W.sigmets || []) {
    if (!sg.coords?.length) continue;
    const conv = sg.hazard === "CONVECTIVE";
    L.polygon(sg.coords.map(c => [+c.lat, +c.lon]), { color: conv ? "#c8392f" : "#7a3fbf", weight: 2, fillOpacity: 0.22 })
      .bindPopup(`<b>${conv ? "Convective SIGMET" : `SIGMET (${esc(sg.hazard)})`} ${esc(sg.seriesId)}</b><br>Tops ${sg.altitudeHi1 ? "FL" + Math.round(sg.altitudeHi1 / 100) : "?"}<br>Valid until ${new Date(sg.validTimeTo * 1000).toISOString().slice(11, 16)}Z<pre style="white-space:pre-wrap;max-width:300px">${esc(sg.rawAirSigmet || "")}</pre>`).addTo(sL);
  }
  add("SIGMETs", sL);

  // METARs
  const mL = L.layerGroup();
  const metars = W.areaMetars || [];
  for (const m of metars) {
    const sum = metarSum(m);
    const cat = m.fltCat || category(sum.cig, sum.vis);
    const mk = L.circleMarker([m.lat, m.lon], { radius: 6, color: "#fff", weight: 1, fillColor: CAT_COLOR[cat] || "#888", fillOpacity: 0.95 }).bindPopup(`<b>${esc(m.icaoId)}</b> ${esc(cat)}<br><code style="white-space:pre-wrap">${esc(m.rawOb)}</code>`);
    const cig = sum.cig != null && sum.cig !== Infinity ? String(Math.round(sum.cig / 100)).padStart(3, "0") : "";
    if (cig && metars.length <= 80) mk.bindTooltip(cig, { permanent: true, direction: "right", offset: [6, 0], className: "wx-label" });
    mk.addTo(mL);
  }
  add("METARs: category and ceiling", mL);

  // PIREPs
  const pL = L.layerGroup();
  const rank = s => (/SEV|EXTRM/.test(s) ? 3 : /MOD/.test(s) ? 2 : /LGT|TRC/.test(s) ? 1 : 0);
  for (const p of W.pireps || []) {
    if (p.lat == null) continue;
    const ice = Math.max(rank(p.icgInt1 || ""), rank(p.icgInt2 || "")), tb = Math.max(rank(p.tbInt1 || ""), rank(p.tbInt2 || ""));
    const color = ice ? GAIRMET_STYLE.ICE.color : tb ? GAIRMET_STYLE["TURB-LO"].color : css("--muted");
    const sym = ice ? "❄" : tb ? "≈" : "▲";
    L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "pirep-ico", html: `<span style="color:${color}">${sym}</span>`, iconSize: [16, 16] }) })
      .bindPopup(`<b>PIREP</b> ${p.fltLvl ? `FL${String(p.fltLvl).padStart(3, "0")}` : ""} ${esc(p.acType || "")}<br><code style="white-space:pre-wrap">${esc(p.rawOb)}</code>`).addTo(pL);
  }
  add("PIREPs", pL);

  // route
  const rL = L.layerGroup();
  const pts = W.route.points;
  L.polyline(pts.map(p => [p.lat, p.lon]), { color: accent, weight: 4 }).addTo(rL);
  if (W.dest && W.altPt) L.polyline([[W.dest.lat, W.dest.lon], [W.altPt.lat, W.altPt.lon]], { color: accent, weight: 3, dashArray: "8 6" }).addTo(rL);
  for (const p of [...pts, ...(W.altPt ? [W.altPt] : [])]) {
    L.circleMarker([p.lat, p.lon], { radius: p.kind === "airport" ? 6 : 4, color: accent, weight: 2, fillColor: css("--panel"), fillOpacity: 1 })
      .bindTooltip(p.token + (p === W.altPt ? " (alt)" : ""), { permanent: true, direction: "top", offset: [0, -6], className: "wx-label" }).addTo(rL);
  }
  add("Route", rL);
  overlays.Route.addTo(map);

  const all = [...pts, ...(W.altPt ? [W.altPt] : [])].map(p => [p.lat, p.lon]);
  map._routeBounds = L.latLngBounds(all).pad(0.25);
  map.invalidateSize();
  map.fitBounds(map._routeBounds);
  $("#map-when").textContent = W.gridError ? `Model layers unavailable: ${W.gridError} · ${metars.length} METARs`
    : W.gridTime ? `Model layers for ${fmtZ(W.gridTime)} · ${metars.length} METARs` : "";
}

// outlook: reports that describe now (METARs, SIGMETs, G-AIRMETs, PIREPs) are switched off and marked;
// the model layers stay, since they're forecasts for the flight time
const OBS_LAYERS = ["METARs: category and ceiling", "SIGMETs", "G-AIRMETs", "PIREPs"];
let mapOutlook = null;
function applyMapOutlook(o) {
  const on = !!o, banner = $("#map-outlook");
  $("#map-card").classList.toggle("outlook-card", on);
  banner.hidden = !on;
  if (on) banner.textContent = `Outlook: model forecast for ${W.gridTime ? fmtLocal(W.gridTime) : "your flight time"} (${o.lead} h ahead). Current reports (METARs, SIGMETs, G-AIRMETs, PIREPs) are hidden: they describe now, not your flight.`;
  if (!map) return;
  if (on !== mapOutlook) { // switching modes: hide the reports in an outlook, bring the defaults back after it
    for (const n of OBS_LAYERS) {
      const lg = overlays[n];
      if (!lg) continue;
      if (on) map.removeLayer(lg); else if (DEFAULT_ON.has(n)) lg.addTo(map);
    }
    mapOutlook = on;
  }
  for (const label of document.querySelectorAll("#map .leaflet-control-layers-overlays label"))
    label.classList.toggle("stale", on && OBS_LAYERS.some(n => label.textContent.includes(n)));
  if (on && W.gridTime && !W.gridError) $("#map-when").textContent = `Model layers for ${fmtLocal(W.gridTime)} (${fmtZ(W.gridTime)}) · outlook`;
}

// ---------- vertical profile (SVG) ----------
// View window in nm along the route and ft MSL; x1/y1 null = whole route / automatic height
const PZ = { x0: 0, x1: null, y0: 0, y1: null, total: null, last: null, ctx: null };
const PZ_YMAX = 45000;
function renderProfile(ctx) {
  const el = $("#profile");
  PZ.ctx = ctx;
  const s = ctx.sim;
  const samples = (W.om || []).filter(o => o.pass?.cloud?.lv?.length);
  const ob = $("#profile-outlook");
  $("#profile").closest(".card").classList.toggle("outlook-card", !!ctx.outlook);
  ob.hidden = !ctx.outlook;
  if (ctx.outlook) ob.textContent = `Model forecast for your flight time, ${ctx.outlook.lead} h ahead: use it for trends, not details.`;
  if (!s || !samples.length) {
    PZ.last = null; $("#pz-range").textContent = "";
    const why = W.loading ? "Loading…" : ctx.outlook && ctx.outlook.lead > 16 * 24 ? "The forecast model reaches 16 days ahead, so there's no profile for this flight yet."
      : W.omError ? `Model data unavailable: ${esc(W.omError)}. Press Refresh weather in a minute.` : "The profile appears once the route and model data load.";
    el.innerHTML = `<p class="sub">${why}</p>`;
    return;
  }
  const total = s.total + (ctx.altSim?.total || 0);
  if (PZ.total == null || Math.abs(PZ.total - total) > 0.5) { PZ.x0 = 0; PZ.x1 = null; } // new route: show all of it
  PZ.total = total;
  const cruise = num($("#cruise").value) || 0;
  const autoY = Math.min(30000, Math.max(12000, Math.ceil((Math.max(cruise, ctx.clouds?.topsMax || 0) + 3000) / 2000) * 2000));
  const vx0 = PZ.x0, vx1 = PZ.x1 ?? total, vy0 = PZ.y1 == null ? 0 : PZ.y0, vy1 = PZ.y1 ?? autoY;
  const VW = 1000, VH = 380, pl = 52, pr = 12, pt = 12, pb = 84, pw = VW - pl - pr, ph = VH - pt - pb;
  PZ.last = { vx0, vx1, vy0, vy1, total, pl, pw, pt, ph, VW, VH };
  const X = d => pl + (d - vx0) / (vx1 - vx0) * pw, Y = h => pt + ph - (h - vy0) / (vy1 - vy0) * ph;
  const L0 = num($("#pmLi").value) ?? -3;
  const out = [`<defs><clipPath id="pz-plot"><rect x="${pl}" y="${pt}" width="${pw}" height="${ph}"/></clipPath><clipPath id="pz-x"><rect x="${pl}" y="0" width="${pw}" height="${VH}"/></clipPath></defs>`];
  // grid lines: a round step that gives at most 8 lines
  const step = [250, 500, 1000, 2000, 4000, 5000, 10000].find(st => (vy1 - vy0) / st <= 8) || 10000;
  for (let h = Math.ceil(vy0 / step) * step; h <= vy1; h += step) out.push(`<line x1="${pl}" x2="${VW - pr}" y1="${Y(h)}" y2="${Y(h)}" stroke="var(--line)" stroke-width="1"/><text x="${pl - 6}" y="${Y(h) + 4}" text-anchor="end">${h ? (h / 1000) + "k" : "0"}</text>`);
  const plot = [], strip = [];
  // cloud cells: one column per sample, one band per pressure level
  const colX = (o, i) => [X(i ? (samples[i - 1].along + o.along) / 2 : o.along), X(i < samples.length - 1 ? (o.along + samples[i + 1].along) / 2 : o.along)];
  const visible = (x0, x1) => x1 >= pl - 1 && x0 <= VW - pr + 1;
  samples.forEach((o, i) => {
    const [x0, x1] = colX(o, i);
    if (!visible(x0, x1)) return;
    const lv = o.pass.cloud.lv;
    lv.forEach((l, j) => {
      if (l.cc < 10) return;
      const lo = j ? (lv[j - 1].h + l.h) / 2 : Math.max(0, l.h - 300), hi = j < lv.length - 1 ? (l.h + lv[j + 1].h) / 2 : l.h + 1500;
      if (hi < vy0 || lo > vy1) return;
      plot.push(`<rect x="${x0.toFixed(1)}" y="${Y(hi).toFixed(1)}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${Math.max(0, Y(lo) - Y(hi)).toFixed(1)}" fill="var(--cloud)" fill-opacity="${(l.cc / 100 * 0.8).toFixed(2)}"><title>${Math.round(l.cc)}% cloud at ${ft(l.h)} ft</title></rect>`);
    });
  });
  // freezing level
  const fz = samples.filter(o => o.pass.fzl != null).map(o => `${X(o.along).toFixed(1)},${Y(o.pass.fzl).toFixed(1)}`);
  if (fz.length) plot.push(`<polyline points="${fz.join(" ")}" fill="none" stroke="var(--fzl)" stroke-width="2" stroke-dasharray="6 4"/>`);
  // flight profile (every point once zoomed in)
  const every = (vx1 - vx0) < total / 1.5 ? 1 : 3;
  const thin = tl => tl.filter((_, i) => i % every === 0 || i === tl.length - 1).map(p => `${X(p.along).toFixed(1)},${Y(p.alt).toFixed(1)}`).join(" ");
  plot.push(`<polyline points="${thin(s.timeline)}" fill="none" stroke="var(--accent)" stroke-width="3"/>`);
  if (ctx.altSim) plot.push(`<polyline points="${thin(ctx.altSim.timeline)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="7 5"/>`);
  out.push(`<g clip-path="url(#pz-plot)">${plot.join("")}</g>`);
  // CAPE and lifted index strips
  const yc = pt + ph + 22, yl = yc + 16;
  out.push(`<text x="${pl - 6}" y="${yc + 9}" text-anchor="end">CAPE</text><text x="${pl - 6}" y="${yl + 9}" text-anchor="end">LI</text>`);
  samples.forEach((o, i) => {
    const [x0, x1] = colX(o, i);
    if (!visible(x0, x1)) return;
    const w = Math.max(1, x1 - x0).toFixed(1);
    strip.push(`<rect x="${x0.toFixed(1)}" y="${yc}" width="${w}" height="12" fill="${capeColor(o.pass.cape) || "var(--inset)"}"><title>CAPE ${Math.round(o.pass.cape)} J/kg</title></rect>`);
    strip.push(`<rect x="${x0.toFixed(1)}" y="${yl}" width="${w}" height="12" fill="${liColor(o.pass.li, L0) || "var(--inset)"}"><title>${o.pass.li != null ? `Lifted index ${o.pass.li.toFixed(1)}` : "Lifted index unavailable"}</title></rect>`);
  });
  // waypoints
  let along = 0;
  const wps = [{ t: W.route.points[0].token, d: 0 }];
  s.legs.forEach(l => { along += l.dist; wps.push({ t: l.to, d: along }); });
  if (ctx.altSim) wps.push({ t: W.altPt.token + " (alt)", d: total });
  const wpTxt = [];
  for (const w of wps) {
    if (w.d < vx0 - 0.01 || w.d > vx1 + 0.01) continue;
    const x = X(w.d);
    strip.push(`<line x1="${x}" x2="${x}" y1="${pt}" y2="${pt + ph + 4}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 3"/>`);
    wpTxt.push(`<text x="${x}" y="${pt + ph + 16}" text-anchor="${x - pl < 30 ? "start" : VW - pr - x < 30 ? "end" : "middle"}">${esc(w.t)}<title>${esc(w.t)}: ${Math.round(w.d)} nm</title></text>`);
  }
  out.push(`<g clip-path="url(#pz-x)">${strip.join("")}</g>`, ...wpTxt);
  out.push(`<line x1="${pl}" x2="${VW - pr}" y1="${pt + ph}" y2="${pt + ph}" stroke="var(--muted)"/>`);
  // legend
  const ly = VH - 10;
  out.push(`<rect x="${pl}" y="${ly - 9}" width="14" height="10" fill="var(--cloud)" fill-opacity="0.7"/><text x="${pl + 20}" y="${ly}">Cloud (darker = more cover)</text>
    <line x1="${pl + 222}" x2="${pl + 248}" y1="${ly - 4}" y2="${ly - 4}" stroke="var(--fzl)" stroke-width="2" stroke-dasharray="6 4"/><text x="${pl + 254}" y="${ly}">Freezing level</text>
    <line x1="${pl + 366}" x2="${pl + 392}" y1="${ly - 4}" y2="${ly - 4}" stroke="var(--accent)" stroke-width="3"/><text x="${pl + 398}" y="${ly}">Your altitude (dashed: alt)</text>
    <text x="${pl + 596}" y="${ly}">CAPE</text>${[1, 2, 3].map(k => `<rect x="${pl + 616 + k * 12}" y="${ly - 9}" width="10" height="10" fill="var(--cape${k})"/>`).join("")}
    <text x="${pl + 672}" y="${ly}">LI</text>${[1, 2, 3].map(k => `<rect x="${pl + 678 + k * 12}" y="${ly - 9}" width="10" height="10" fill="var(--li${k})"/>`).join("")}<text x="${pl + 732}" y="${ly}">some / your limit / strong</text>`);
  el.innerHTML = `<svg viewBox="0 0 ${VW} ${VH}" role="img" aria-label="Vertical profile of clouds, freezing level, instability and flight path along the route">${out.join("")}</svg>`;
  el.classList.add("pz-on");
  $("#pz-range").textContent = `${Math.round(vx0)}–${Math.round(vx1)} of ${Math.round(total)} nm · ${ft(vy0)}–${ft(vy1)} ft`;
}

// zoom and pan; factor < 1 zooms in, the anchor point stays put
function pzSet(x0, x1, y0, y1) {
  const L = PZ.last;
  if (!L) return;
  const T = L.total;
  const xs = Math.min(T, Math.max(Math.min(10, T), x1 - x0));
  x0 = Math.max(0, Math.min(T - xs, x0));
  const ys = Math.min(PZ_YMAX, Math.max(1000, y1 - y0));
  y0 = Math.max(0, Math.min(PZ_YMAX - ys, y0));
  PZ.x0 = xs >= T - 1e-6 ? 0 : x0; PZ.x1 = xs >= T - 1e-6 ? null : x0 + xs;
  if (Math.abs(y0 - L.vy0) > 1 || Math.abs(y0 + ys - L.vy1) > 1) { PZ.y0 = y0; PZ.y1 = y0 + ys; } // otherwise the height stays automatic
  pzDraw();
}
function pzZoomX(f, at) { const { vx0, vx1, vy0, vy1 } = PZ.last; pzSet(at - (at - vx0) * f, at + (vx1 - at) * f, vy0, vy1); }
function pzZoomY(f, at) { const { vx0, vx1, vy0, vy1 } = PZ.last; pzSet(vx0, vx1, at - (at - vy0) * f, at + (vy1 - at) * f); }
let pzFrame = 0;
function pzDraw() { cancelAnimationFrame(pzFrame); pzFrame = requestAnimationFrame(() => PZ.ctx && renderProfile(PZ.ctx)); }
function pzPoint(e) { // pointer position as nm along the route and ft MSL
  const L = PZ.last, svg = $("#profile svg");
  if (!L || !svg) return null;
  const r = svg.getBoundingClientRect();
  const vx = (e.clientX - r.left) / r.width * L.VW, vy = (e.clientY - r.top) / r.height * L.VH;
  return { d: L.vx0 + (vx - L.pl) / L.pw * (L.vx1 - L.vx0), h: L.vy0 + (L.pt + L.ph - vy) / L.ph * (L.vy1 - L.vy0), scale: L.VW / r.width };
}
function setupProfileZoom() {
  const el = $("#profile");
  $("#pz-tools").addEventListener("click", e => {
    const b = e.target.closest("[data-pz]");
    if (!b || !PZ.last) return;
    const { vx0, vx1, vy0, vy1 } = PZ.last;
    const k = b.dataset.pz;
    if (k === "reset") { PZ.x0 = 0; PZ.x1 = null; PZ.y0 = 0; PZ.y1 = null; pzDraw(); }
    else if (k[0] === "x") pzZoomX(k[1] === "+" ? 0.5 : 2, (vx0 + vx1) / 2);
    else pzZoomY(k[1] === "+" ? 0.67 : 1.5, vy0 === 0 ? 0 : (vy0 + vy1) / 2); // keep the ground in view when it is
  });
  el.addEventListener("wheel", e => {
    if (!e.ctrlKey || !PZ.last) return; // plain scrolling still scrolls the page
    const p = pzPoint(e);
    if (!p) return;
    e.preventDefault();
    const f = Math.exp((e.deltaY || e.deltaX) * 0.0025);
    if (e.shiftKey) pzZoomY(f, Math.max(0, p.h)); else pzZoomX(f, p.d);
  }, { passive: false });
  let drag = null;
  el.addEventListener("pointerdown", e => {
    if (e.button !== 0 || !PZ.last || !e.target.closest("svg")) return;
    const p = pzPoint(e);
    drag = { x: e.clientX, y: e.clientY, scale: p.scale, ...PZ.last };
    el.setPointerCapture(e.pointerId);
    el.classList.add("pz-drag");
  });
  el.addEventListener("pointermove", e => {
    if (!drag) return;
    const dnm = (e.clientX - drag.x) * drag.scale / drag.pw * (drag.vx1 - drag.vx0);
    const dft = (e.clientY - drag.y) * drag.scale / drag.ph * (drag.vy1 - drag.vy0);
    pzSet(drag.vx0 - dnm, drag.vx1 - dnm, drag.vy0 + dft, drag.vy1 + dft);
  });
  const end = () => { drag = null; el.classList.remove("pz-drag"); };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("dblclick", () => { PZ.x0 = 0; PZ.x1 = null; PZ.y0 = 0; PZ.y1 = null; pzDraw(); });
}

// ---------- aircraft presets ----------
// One preset per registration, saved in this browser: whole-airplane figures plus one table per power
// setting, laid out like ForeFlight's (per pressure altitude: climb IAS and rate, cruise TAS and fuel
// flow, descent IAS). Blank cells are interpolated.
const AC_KEY = "ifr-gng-aircraft-v1";
const AC_EXAMPLE = "__example", AC_NEW = "__new";
const AC_FIELD_RE = /^(ac|ps)_/; // editor inputs: kept in the preset, not in the saved flight form
const AC_COLS = [["alt", "Pressure altitude", 1000], ["climbIas", "Climb IAS", 5], ["roc", "Rate of climb", 50], ["tas", "Cruise TAS", 1], ["gph", "Fuel flow", 0.1], ["descIas", "Descent IAS", 5]];
const blankRow = alt => ({ alt, climbIas: null, roc: null, tas: null, gph: null, descIas: null });
const clone = o => JSON.parse(JSON.stringify(o));
let AC = null, acKey = AC_EXAMPLE, acDirty = false, acTab = 0;

function acStore() { try { return JSON.parse(store.get(AC_KEY) || "{}") || {}; } catch { return {}; } }
function acPut(all) { store.set(AC_KEY, JSON.stringify(all)); }
// the built-in example, or a preset made from the old fixed form (65%/75% TAS at 0, 8, 12 and 24 thousand ft)
function exampleAircraft(p, extra = {}) {
  const roc = alt => Math.round(interp([[0, num(p.climbSL)], [12000, num(p.climb12)], [24000, num(p.climb24)]], alt) ?? 700);
  const setting = (name, k) => ({ name, rows: [0, 8, 12, 24].map(th => ({ ...blankRow(th * 1000), climbIas: num(p.climbIas), roc: roc(th * 1000), tas: num(p[`p${k}_${th}`]), gph: num(p[`g${k}`]) })) });
  return { tail: "", type: "Mooney M20K 231", usableGal: num(p.usableGal), taxiGal: num(p.taxiGal), ceiling: num(p.ceiling), demoXwind: num(p.demoXwind),
    climbGphLow: num(p.climbGph), climbGphHigh: num(p.climbGph), descGphLow: num(p.descGph), descGphHigh: num(p.descGph), descFpm: num(p.descFpm),
    settings: [setting("75%", 75), setting("65%", 65)], ...extra };
}
function blankAircraft() {
  const rows = () => Array.from({ length: 13 }, (_, i) => blankRow(i * 2000));
  return { tail: "", type: "", usableGal: null, taxiGal: null, ceiling: null, demoXwind: null,
    climbGphLow: null, climbGphHigh: null, descGphLow: null, descGphHigh: null, descFpm: 500,
    settings: [{ name: "75%", rows: rows() }, { name: "65%", rows: rows() }] };
}
function loadAircraft(key) {
  const all = acStore();
  acKey = key === AC_EXAMPLE || key === AC_NEW || all[key] ? key : AC_EXAMPLE;
  AC = acKey === AC_EXAMPLE ? exampleAircraft(PRESETS.m20k) : acKey === AC_NEW ? blankAircraft() : clone(all[acKey]);
  acDirty = false; acTab = 0;
  renderAcEditor(); renderPowerOptions();
}
function initAircraft(saved) {
  const all = acStore();
  // older versions kept one airplane in the flight form; turn a customised one into a preset
  if (saved && saved.preset === "custom" && saved.p75_0 != null && !Object.keys(all).length) {
    const tail = (saved.tail || "MYPLANE").toUpperCase();
    all[tail] = exampleAircraft(saved, { tail, type: "" });
    acPut(all);
    saved.acPick = tail;
  }
  const keys = Object.keys(acStore());
  loadAircraft(saved?.acPick && saved.acPick !== AC_NEW ? saved.acPick : keys.length ? keys.sort()[0] : AC_EXAMPLE);
  let pw = saved?.power;
  if (/^\d+$/.test(pw || "")) pw += "%"; // older saves: "65" / "75"
  if (AC.settings.some(x => x.name === pw)) $("#power").value = pw;
}
function renderPowerOptions(renamedFrom) {
  const sel = $("#power"), cur = sel.value;
  sel.innerHTML = AC.settings.map(x => `<option value="${esc(x.name)}">${esc(x.name || "Unnamed")}${settingComplete(x) ? "" : " (no data)"}</option>`).join("");
  const want = renamedFrom != null && cur === renamedFrom ? AC.settings[acTab].name : cur;
  sel.value = AC.settings.some(x => x.name === want) ? want : AC.settings.find(settingComplete)?.name ?? AC.settings[0]?.name ?? "";
}
function acStatus(msg) {
  const el = $("#ac-status");
  el.classList.toggle("dirty", !msg && acDirty);
  el.textContent = msg || (acDirty ? "Unsaved changes" : acKey === AC_EXAMPLE ? "Example airplane. Enter your registration, change the figures and save to make your own preset."
    : acKey === AC_NEW ? "New airplane, not saved yet" : `Saved as ${acKey}`);
}
function renderAcEditor() {
  const all = acStore();
  $("#acPick").innerHTML = Object.keys(all).sort().map(k => `<option value="${esc(k)}">${esc(k)}${all[k].type ? ` · ${esc(all[k].type)}` : ""}</option>`).join("")
    + `<option value="${AC_EXAMPLE}">Example: Mooney M20K 231</option><option value="${AC_NEW}">＋ New airplane…</option>`;
  $("#acPick").value = acKey;
  for (const el of document.querySelectorAll("[data-ac]")) el.value = AC[el.dataset.ac] ?? "";
  $("#ps-tabs").innerHTML = AC.settings.map((x, i) => `<button type="button" class="${i === acTab ? "" : "ghost"}" data-act="tab" data-i="${i}" aria-pressed="${i === acTab}">${esc(x.name || "Unnamed")}${settingComplete(x) ? "" : " (empty)"}</button>`).join("")
    + `<button type="button" class="ghost" data-act="addSetting">＋ Power setting</button>`;
  const st = AC.settings[acTab];
  $("#ps-body").hidden = !st;
  if (st) {
    $("#ps_name").value = st.name;
    renderPsRows();
    $("#ps_copy").innerHTML = `<option value="">Copy climb &amp; descent from…</option>` + AC.settings.map((x, i) => (i === acTab ? "" : `<option value="${i}">${esc(x.name || "Unnamed")}</option>`)).join("");
    $("#ps_copy").hidden = AC.settings.length < 2;
  }
  acStatus();
}
// the table, in full or folded to the one line for the planned cruise altitude
const PS_MIN_KEY = "ifr-gng-perf-min";
let psMin = store.get(PS_MIN_KEY) === "1", psMiniKey = "";
const cruiseAlt = () => num($("#cruise").value) ?? 0;
const psRowHtml = (r, i) => `<tr>${AC_COLS.map(([k, label, step]) => `<td><input type="number" step="${step}" data-col="${k}" data-r="${i}" value="${r[k] ?? ""}" aria-label="${label}, row ${i + 1}"></td>`).join("")}<td><button type="button" class="ghost icon" data-act="delRow" data-r="${i}" title="Remove this row" aria-label="Remove row ${i + 1}">✕</button></td></tr>`;
function renderPsRows() {
  const st = AC.settings[acTab];
  if (!st) return;
  const alt = cruiseAlt(), note = $("#ps-mini-note"), toggle = $("#ps_toggle");
  psMiniKey = `${acKey}|${acTab}|${alt}|${st.rows.length}|${psMin}`;
  $("#ps-body").classList.toggle("min", psMin);
  toggle.textContent = psMin ? `Show full table (${st.rows.length} rows)` : "Minimize to cruise altitude";
  toggle.setAttribute("aria-expanded", String(!psMin));
  if (!psMin) { $("#ps-rows").innerHTML = st.rows.map(psRowHtml).join(""); note.textContent = ""; return; }
  const i = st.rows.findIndex(r => num(r.alt) === alt);
  if (i >= 0) { // a row for this altitude: show it, still editable
    $("#ps-rows").innerHTML = psRowHtml(st.rows[i], i);
    note.textContent = `${st.name} at your cruise altitude, ${ft(alt)} ft.`;
    return;
  }
  const alts = st.rows.map(r => num(r.alt)).filter(a => a != null).sort((a, b) => a - b);
  const lo = alts.filter(a => a < alt).at(-1), hi = alts.find(a => a > alt);
  const col = k => st.rows.filter(r => num(r.alt) != null && num(r[k]) != null).map(r => [num(r.alt), num(r[k])]).sort((x, y) => x[0] - y[0]);
  const fmt = (k, v) => (v == null ? "—" : k === "gph" ? v.toFixed(1) : String(Math.round(v)));
  const vals = AC_COLS.map(([k]) => (k === "alt" ? null : interp(col(k), alt)));
  $("#ps-rows").innerHTML = `<tr class="interp">${AC_COLS.map(([k], j) => `<td${k !== "alt" && vals[j] != null ? ' class="v"' : ""}>${k === "alt" ? ft(alt) : fmt(k, vals[j])}</td>`).join("")}<td></td></tr>`;
  note.textContent = vals.every(v => v == null) ? `${st.name} has no figures yet. Show the full table to fill it in.`
    : `${st.name} at your cruise altitude, ${ft(alt)} ft. There's no row for it, so these values are interpolated${lo != null && hi != null ? ` between ${ft(lo)} and ${ft(hi)} ft` : " from the nearest row"}. Show the full table to edit.`;
}
function refreshPsMini() { // the folded line follows the cruise altitude
  const st = AC?.settings[acTab];
  if (psMin && st && `${acKey}|${acTab}|${cruiseAlt()}|${st.rows.length}|${psMin}` !== psMiniKey) renderPsRows();
}

function acChanged(structural, fromInput) {
  acDirty = true;
  if (structural) renderAcEditor(); else acStatus();
  renderPowerOptions();
  if (!fromInput) update(); // typing already triggers the form's own update
}
// rows from pasted or imported text: Markdown tables, CSV, tab- or space-separated; plus ForeFlight-style extras
function parseProfileText(text) {
  const rows = [], extra = {};
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#+\s*climb/i.test(line)) section = "climb";
    else if (/^#+\s*descent/i.test(line)) section = "desc";
    else if (/^#+\s*cruise/i.test(line)) section = "cruise";
    const ff = line.match(/(low|high) altitude point fuel flow[^|]*\|\s*([\d.]+)/i);
    if (ff && (section === "climb" || section === "desc")) { extra[`${section === "desc" ? "descGph" : "climbGph"}${ff[1].toLowerCase() === "low" ? "Low" : "High"}`] = +ff[2]; continue; }
    const ceil = line.match(/max(?:imum)?\s+(?:operating\s+)?(?:ceiling|altitude)[^|]*\|\s*([\d,]+)/i);
    if (ceil) { extra.ceiling = +ceil[1].replace(/,/g, ""); continue; }
    const ac = line.match(/\*\*Aircraft:\*\*\s*([A-Z0-9-]{2,8})\s*[·|–-]\s*(.+)$/i);
    if (ac) { extra.tail = ac[1].toUpperCase(); extra.type = ac[2].trim(); continue; }
    let cells;
    if (/[|\t;]/.test(line)) cells = line.replace(/(\d),(\d{3})\b/g, "$1$2").split(/[|\t;]/);
    else if (!/\s/.test(line)) cells = line.split(",");
    else cells = line.replace(/(\d),(\d{3})\b/g, "$1$2").split(/[\s,]+/);
    cells = cells.map(c => c.trim()).filter(Boolean);
    if (cells.length >= 5 && cells.length <= 7 && cells.every(c => /^-?\d+(\.\d+)?$/.test(c))) {
      const n = cells.map(Number);
      rows.push({ alt: n[0], climbIas: n[1], roc: n[2], tas: n[3], gph: n[4], descIas: n[5] ?? null });
    }
  }
  rows.sort((a, b) => a.alt - b.alt);
  return { rows, extra };
}
function applyProfileText(text, from) {
  const { rows, extra } = parseProfileText(text);
  if (!rows.length && !Object.keys(extra).length) { acStatus(`No performance rows found in ${from}. Each row needs at least 5 numbers: altitude, climb IAS, rate of climb, cruise TAS, fuel flow.`); return false; }
  if (acKey === AC_EXAMPLE) { // don't mix the pilot's numbers into the example: start a fresh airplane
    const name = AC.settings[acTab]?.name;
    AC = blankAircraft(); acKey = AC_NEW;
    acTab = Math.max(0, AC.settings.findIndex(x => x.name === name));
  }
  if (rows.length) AC.settings[acTab].rows = rows;
  for (const k of ["climbGphLow", "climbGphHigh", "descGphLow", "descGphHigh", "ceiling"]) if (extra[k] != null) AC[k] = extra[k];
  if (extra.tail && !AC.tail) AC.tail = extra.tail;
  if (extra.type && !AC.type) AC.type = extra.type;
  acChanged(true);
  acStatus(`Read ${rows.length} rows into ${AC.settings[acTab].name || "this setting"}${Object.keys(extra).length ? " plus the airplane figures found" : ""}. Check them, then press Save preset.`);
  return true;
}
function acSave() {
  const tail = (AC.tail || "").trim().toUpperCase();
  if (!tail) { acStatus("Enter the registration, then save."); $("#ac_tail").focus(); return; }
  const names = AC.settings.map(x => x.name.trim());
  if (names.some(n => !n) || new Set(names).size !== names.length) { acStatus("Give every power setting its own name."); return; }
  const all = acStore();
  if (all[tail] && acKey !== tail && !confirm(`Replace the saved ${tail} preset?`)) return;
  AC.tail = tail;
  all[tail] = clone(AC);
  acPut(all);
  acKey = tail; acDirty = false;
  renderAcEditor();
  update();
}
function acDelete() {
  const all = acStore();
  if (!all[acKey]) { acStatus("This airplane isn't saved, so there's nothing to delete."); return; }
  if (!confirm(`Delete the ${acKey} preset from this browser?`)) return;
  delete all[acKey];
  acPut(all);
  loadAircraft(Object.keys(all).sort()[0] || AC_EXAMPLE);
  update();
}
function acExport() {
  const blob = new Blob([JSON.stringify({ format: "ifr-go-no-go-aircraft", version: 1, aircraft: AC }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${AC.tail || "airplane"}-performance.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function setupAircraftEditor() {
  const ed = $("#ac-editor");
  $("#acPick").addEventListener("input", e => {
    if (acDirty && !confirm("Discard the unsaved changes to this airplane?")) { e.target.value = acKey; return; }
    loadAircraft(e.target.value);
  });
  ed.addEventListener("input", e => {
    const t = e.target;
    if (t.dataset.ac) {
      const k = t.dataset.ac;
      AC[k] = k === "tail" ? t.value.trim().toUpperCase() : k === "type" ? t.value : num(t.value);
      acChanged(false, true);
    } else if (t.dataset.col) {
      AC.settings[acTab].rows[+t.dataset.r][t.dataset.col] = num(t.value);
      acChanged(false, true);
    } else if (t.id === "ps_name") {
      const old = AC.settings[acTab].name;
      AC.settings[acTab].name = t.value.trim();
      $(`#ps-tabs [data-i="${acTab}"]`).textContent = AC.settings[acTab].name || "Unnamed";
      acDirty = true; acStatus(); renderPowerOptions(old);
    } else if (t.id === "ps_copy" && t.value !== "") {
      const src = AC.settings[+t.value], dst = AC.settings[acTab];
      for (const r of src.rows) {
        let d = dst.rows.find(x => num(x.alt) === num(r.alt));
        if (!d) { d = blankRow(num(r.alt)); dst.rows.push(d); }
        Object.assign(d, { climbIas: r.climbIas, roc: r.roc, descIas: r.descIas });
      }
      dst.rows.sort((a, b) => (num(a.alt) ?? 0) - (num(b.alt) ?? 0));
      acChanged(true, true);
      acStatus(`Copied the climb and descent columns from ${src.name}.`);
    }
  });
  ed.addEventListener("click", e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const st = AC.settings[acTab], act = b.dataset.act;
    if (act === "tab") { acTab = +b.dataset.i; renderAcEditor(); return; }
    if (act === "toggleMin") { psMin = !psMin; store.set(PS_MIN_KEY, psMin ? "1" : "0"); renderPsRows(); return; }
    if (act === "save") return acSave();
    if (act === "delete") return acDelete();
    if (act === "export") return acExport();
    if (act === "import") return $("#ac_file").click();
    if (act === "pasteApply") { if (applyProfileText($("#ps_paste").value, "the pasted text")) $("#ps_paste").value = ""; return; }
    if (act === "addSetting") {
      let n = 1; while (AC.settings.some(x => x.name === `Setting ${n}`)) n++;
      AC.settings.push({ name: `Setting ${n}`, rows: Array.from({ length: 13 }, (_, i) => blankRow(i * 2000)) });
      acTab = AC.settings.length - 1;
    } else if (act === "delSetting") {
      if (AC.settings.length <= 1) { acStatus("An airplane needs at least one power setting."); return; }
      if (!confirm(`Delete the ${st.name || "unnamed"} power setting?`)) return;
      AC.settings.splice(acTab, 1); acTab = Math.max(0, acTab - 1);
    } else if (act === "addRow") {
      const last = st.rows.at(-1);
      st.rows.push(blankRow(last ? (num(last.alt) ?? 0) + 1000 : 0));
    } else if (act === "delRow") st.rows.splice(+b.dataset.r, 1);
    else if (act === "fill") {
      const step = +$("#ps_step").value, top = num(AC.ceiling) || Math.max(24000, ...st.rows.map(r => num(r.alt) || 0));
      for (let alt = 0; alt <= top; alt += step) if (!st.rows.some(r => num(r.alt) === alt)) st.rows.push(blankRow(alt));
      st.rows.sort((a, b) => (num(a.alt) ?? 0) - (num(b.alt) ?? 0));
    } else return;
    acChanged(true);
  });
  $("#ac_file").addEventListener("change", async e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (data) {
      const a = data.format === "ifr-go-no-go-aircraft" ? data.aircraft : null;
      if (!a || !Array.isArray(a.settings)) { acStatus(`${file.name} isn't an IFR Go/No-Go airplane preset.`); return; }
      if (acDirty && !confirm("Discard the unsaved changes to this airplane?")) return;
      AC = a; acKey = AC_NEW; acTab = 0;
      acChanged(true);
      acStatus(`Loaded ${a.tail || "the airplane"} from ${file.name}. Press Save preset to keep it.`);
      return;
    }
    applyProfileText(text, file.name);
  });
}

// ---------- departure time: date picker plus a 24-hour HH:MM field, kept in the hidden #etd ----------
function parseTime24(v) { // "1430", "14:30", "14.30", "9:05", "9" -> "14:30"; null if not a time
  const m = v.trim().match(/^(\d{1,2})(?:[:.h ]?(\d{2}))?$/);
  if (!m) return null;
  const h = +m[1], mi = +(m[2] ?? 0);
  return h < 24 && mi < 60 ? `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}` : null;
}
function etdToFields() {
  const [d, t] = ($("#etd").value || "").split("T");
  $("#etdDate").value = d || "";
  $("#etdTime").value = t ? t.slice(0, 5) : "";
  $("#etdTime").classList.remove("bad");
}
function fieldsToEtd() {
  const t = parseTime24($("#etdTime").value), d = $("#etdDate").value;
  $("#etdTime").classList.toggle("bad", !t && $("#etdTime").value.trim() !== "");
  $("#etd").value = d && t ? `${d}T${t}` : "";
}

// ---------- outlook: forecast guidance beyond the TAFs ----------
// A time window that starts more than OUTLOOK_AFTER_H hours ahead and isn't covered by a TAF is judged
// from the National Blend of Models: NBS (3-hourly, to 72 h) has ceiling, visibility and IFR chances;
// NBE (12-hourly, to 192 h) only thunder, precipitation and wind.
const OUTLOOK_AFTER_H = 20;
const nbmId = pt => (pt?.icao || pt?.ident || "").toUpperCase();
const nbmCig = v => (v == null ? null : v === -88 ? Infinity : v * 100);
const nbmVis = v => (v == null ? null : v >= 100 ? 10 : v / 10);
const leadH = t => (+t - Date.now()) / 3600e3;
// worst guidance around [from, to] (the 3-hourly steps either side count)
function nbmWindow(st, from, to) {
  const near = pad => (st?.rows || []).filter(r => { const t = Date.parse(r.t); return t >= +from - pad && t <= +to + pad; });
  const rows = near(1.5 * 3600e3);
  if (!rows.length) return null;
  const sum = blankSum();
  let ifc = 0, ifv = 0, ts = 0, pzr = 0;
  for (const r of rows) {
    const c = nbmCig(r.CIG), v = nbmVis(r.VIS);
    if (c != null && c !== Infinity) sum.cig = sum.cig == null ? c : Math.min(sum.cig, c);
    if (v != null) sum.vis = sum.vis == null ? v : Math.min(sum.vis, v);
    if (r.WSP != null) { sum.wspd = Math.max(sum.wspd, r.WSP); sum.winds.push({ dir: r.WDR, spd: Math.max(r.WSP, r.GST || 0) }); }
    if (r.GST != null) sum.gust = Math.max(sum.gust, r.GST);
    ifc = Math.max(ifc, r.IFC ?? 0); ifv = Math.max(ifv, r.IFV ?? 0); ts = Math.max(ts, r.T03 ?? 0); pzr = Math.max(pzr, r.PZR ?? 0);
    sum.rows++;
  }
  const pop = Math.max(0, ...near(3 * 3600e3).map(r => r.P06 ?? 0)); // 6-hour PoP sits on every other step
  return { kind: "nbs", prev: sum, cond: blankSum(), covered: true, ifc, ifv, ts, pzr, pop };
}
function nbeWindow(st, from, to) {
  const rows = (st?.rows || []).filter(r => { const t = Date.parse(r.t); return t >= +from - 6 * 3600e3 && t <= +to + 6 * 3600e3; });
  if (!rows.length) return null;
  const sum = blankSum();
  for (const r of rows) {
    if (r.WSP != null) { sum.wspd = Math.max(sum.wspd, r.WSP); sum.winds.push({ dir: r.WDR, spd: Math.max(r.WSP, r.GST || 0) }); }
    if (r.GST != null) sum.gust = Math.max(sum.gust, r.GST);
    sum.rows++;
  }
  return { kind: "nbe", prev: sum, cond: blankSum(), covered: true, ts: Math.max(0, ...rows.map(r => r.T12 ?? 0)), pop: Math.max(0, ...rows.map(r => r.P12 ?? 0)), pzr: Math.max(0, ...rows.map(r => r.PZR ?? 0)) };
}
// guidance for one airport and window, or null when its TAF covers the window's middle (or it's close enough to wait for one)
function outlookFor(pt, rec, win) {
  if (!pt || leadH(win[0]) <= OUTLOOK_AFTER_H) return null;
  const mid = (+win[0] + +win[1]) / 2; // a TAF that covers the middle of the window (ETA for the destination) is used, not guidance
  if (rec?.taf && rec.taf.validTimeFrom * 1000 <= mid && rec.taf.validTimeTo * 1000 > mid) return null;
  const id = nbmId(pt);
  const o = nbmWindow(W.nbm?.nbs?.stations?.[id], ...win) || nbeWindow(W.nbm?.nbe?.stations?.[id], ...win);
  if (o) return { ...o, id, cycle: (o.kind === "nbs" ? W.nbm.nbs : W.nbm.nbe).cycle, source: (o.kind === "nbs" ? W.nbm.nbs : W.nbm.nbe).source };
  const why = W.nbmError ? `guidance couldn't be loaded (${W.nbmError})` : leadH(win[0]) > 190 ? "it's beyond any forecast guidance (8 days)" : `there's no NBM guidance for ${id}`;
  return { kind: "none", id, why, prev: blankSum(), cond: blankSum(), covered: false };
}
// when the first TAF covering `t` (+1 h) should be out: issued every 6 h, valid 24 h (30 h at some large airports)
function tafCoverFrom(t) {
  const six = 6 * 3600e3;
  return new Date(Math.ceil((+t + 3600e3 - 24 * 3600e3) / six) * six - 40 * 60e3);
}

// SPC day 1-3 categorical outlooks along the route
const SPC_RANK = { TSTM: 1, MRGL: 2, SLGT: 3, ENH: 4, MDT: 5, HIGH: 6 };
const SPC_NAME = { TSTM: "general thunderstorms", MRGL: "marginal severe risk", SLGT: "slight severe risk", ENH: "enhanced severe risk", MDT: "moderate severe risk", HIGH: "high severe risk" };
const spcTime = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
function spcOnRoute(routePts, times) {
  let best = null;
  for (const d of W.spc || []) for (const ft_ of d.features || []) {
    if (!SPC_RANK[ft_.label] || !ft_.geometry) continue;
    const from = spcTime(ft_.valid), to = spcTime(ft_.expire);
    if (!times.some(t => +t >= from && +t < to)) continue;
    const polys = ft_.geometry.type === "Polygon" ? [ft_.geometry.coordinates] : ft_.geometry.type === "MultiPolygon" ? ft_.geometry.coordinates : [];
    for (const poly of polys) {
      const ring = (poly[0] || []).map(([lon, lat]) => ({ lat, lon }));
      if (ring.length < 3 || routeDistance(routePts, ring) > 10) continue;
      if (!best || SPC_RANK[ft_.label] > SPC_RANK[best.label]) best = { label: ft_.label, day: d.day };
    }
  }
  return best;
}

// ---------- alternate candidates ----------
const ALT_RADIUS = 100; // nm from the destination
const MIL_RE = /\b(Naval|NAS|NOLF|Air Force|AFB|Army|AAF|Air National Guard|ANGB|Marine Corps|MCAS|Joint Base|JRB|Coast Guard)\b/i;
const CIVIL_RE = /\b(Regional|Municipal|International|County|City)\b/i; // joint-use fields like "Esler Army Airfield / Esler Regional"
let lastCtx = null;
// airports with a published approach near `code`, each with its own TAF (no proxies: §91.169 wants a forecast for the field)
async function fetchAltCands(code) {
  try {
    const r = await getJSON("/nav/alternates", { apt: code, radius: ALT_RADIUS });
    const list = (r.airports || []).map(a => ({ ...a, id: a.icao || a.ident, mil: MIL_RE.test(a.name) && !CIVIL_RE.test(a.name) }));
    const ids = list.map(a => a.id).filter(id => /^[A-Z0-9]{4}$/.test(id));
    const tafs = ids.length ? await wx("taf", { ids: ids.join(",") }).catch(() => []) : [];
    for (const a of list) a.taf = tafs.filter(t => t.icaoId === a.id).sort((x, y) => y.issueTime.localeCompare(x.issueTime))[0] || null;
    return list;
  } catch { return []; }
}
// status of each candidate at its own ETA (destination ETA + missed approach + ~140 kt to get there)
function rateAltCands(cands, eta, nbs = W.nbm?.nbs) {
  return (cands || []).map(a => {
    const req = a.ils ? [600, 2] : [800, 2];
    const t = +eta + (MISSED_MIN + a.dist / 140 * 60) * 60e3;
    let status = "notaf", fc = "", src = "taf";
    const tafOk = a.taf && tafWindow(a.taf, t - 3600e3, t + 3600e3).covered;
    if (!tafOk && leadH(t) > OUTLOOK_AFTER_H) { // beyond the TAFs: NBM guidance
      src = "nbm";
      const o = nbmWindow(nbs?.stations?.[a.id], t - 3600e3, t + 3600e3);
      if (o) {
        const pc = o.prev.cig ?? Infinity, pv = o.prev.vis ?? 10;
        fc = `NBM ${pc === Infinity ? "no ceiling" : ft(pc)} / ${fmtVis(pv)}`;
        status = pc < req[0] || pv < req[1] ? "below" : o.ifc >= 50 || o.ts >= 50 ? "marginal" : "ok";
      }
    } else if (a.taf) {
      const w = tafWindow(a.taf, t - 3600e3, t + 3600e3);
      const pc = w.prev.cig ?? Infinity, pv = w.prev.vis ?? 99, cc = w.cond.cig ?? Infinity, cv = w.cond.vis ?? 99;
      fc = `${pc === Infinity ? "no ceiling" : ft(pc)} / ${fmtVis(pv)}`;
      status = pc < req[0] || pv < req[1] ? "below" : (w.cond.rows && (cc < req[0] || cv < req[1])) || !w.covered ? "marginal" : "ok";
    }
    return { ...a, req, status, fc, src };
  });
}
// nearest civil field that meets alternate minimums, else the nearest civil one with only TEMPO/PROB worries
function bestAlternate(rated) {
  const civil = rated.filter(a => !a.mil);
  return civil.find(a => a.status === "ok") || civil.find(a => a.status === "marginal") || null;
}
let altPickHtml = "";
function renderAltPicker(ctx) {
  const sel = $("#altPick");
  const cands = W.altCands;
  let html;
  if (!W.dest) html = `<option value="">Enter a destination first</option>`;
  else if (!cands) html = `<option value="">Alternates load with the weather</option>`;
  else if (!cands.length) html = `<option value="">No airport with an approach within ${ALT_RADIUS} nm</option>`;
  else {
    const rated = rateAltCands(cands, ctx.times?.eta || new Date());
    const guided = rated.some(a => a.src === "nbm");
    const groups = guided ? [
      ["ok", "Likely meets alternate minimums (NBM guidance)"], ["marginal", "Likely meets them, but a high chance of IFR or storms"],
      ["below", "Likely below alternate minimums"], ["notaf", leadH(ctx.times?.eta || Date.now()) > 72 ? "No ceiling or visibility guidance past 72 h" : "No NBM guidance for the field"], ["mil", "Military (PPR, usually not available)"],
    ] : [
      ["ok", "Meets alternate minimums"], ["marginal", "TEMPO/PROB below minimums, or TAF doesn't cover ETA"],
      ["below", "Forecast below alternate minimums"], ["notaf", "No TAF on the field (can't qualify)"], ["mil", "Military (PPR, usually not available)"],
    ];
    const opt = a => {
      const name = a.name.length > 30 ? a.name.slice(0, 29) + "…" : a.name;
      const mins = `${a.req[0]}-${a.req[1]}`;
      const wxTxt = a.status === "notaf" ? (a.src === "nbm" ? "no guidance" : "no TAF") : a.status === "ok" ? `${a.fc} ✓ ${mins}` : a.status === "marginal" ? `${a.fc} ~ ${mins}` : `${a.fc} ✗ ${mins}`;
      return `<option value="${esc(a.id)}">${esc(a.id)} · ${Math.round(a.dist)} nm · ${esc(name)} · ${a.ils ? "ILS" : "non-ILS"} · ${esc(wxTxt)}</option>`;
    };
    html = `<option value="">Pick from ${cands.length} within ${ALT_RADIUS} nm of ${esc(W.dest.token)}…</option>` + groups.map(([k, label]) => {
      const list = rated.filter(a => (k === "mil" ? a.mil : !a.mil && a.status === k));
      return list.length ? `<optgroup label="${label} (${list.length})">${list.map(opt).join("")}</optgroup>` : "";
    }).join("");
  }
  if (html !== altPickHtml) { sel.innerHTML = html; altPickHtml = html; }
  const cur = $("#alt").value.trim().toUpperCase();
  const match = (cands || []).find(a => [a.id, a.ident, a.faa].includes(cur));
  sel.value = match ? match.id : "";
}

// ---------- reverse course ----------
async function reverseCourse() {
  const r = $("#route");
  const toks = r.value.trim().split(/\s+/).filter(Boolean);
  if (toks.length < 2) return;
  r.value = toks.reverse().join(" ").toUpperCase();
  // the old destination approach becomes the return approach at departure, and the other way round
  const swap = (a, b) => { const x = $(a).value; $(a).value = $(b).value; $(b).value = x; };
  swap("#destMinCig", "#depMinCig");
  swap("#destMinVis", "#depMinVis");
  const oldDep = $("#depChart").value;
  pendingCharts = { destChart: oldDep, depChart: $("#destChart").value, altChart: $("#altChart").value };
  if (oldDep) $("#destAppr").value = minimaLineFor(oldDep);
  // pick an alternate near the new destination; the trip takes about as long the other way
  const hint = $("#alt-hint"), btn = $("#reverse"), newDest = toks.at(-1).toUpperCase();
  btn.disabled = true;
  hint.textContent = `Finding an alternate near ${newDest}…`;
  const eta = new Date(+new Date($("#etd").value || Date.now()) + (lastCtx?.sim?.minutes || 90) * 60e3);
  const cands = await fetchAltCands(newDest);
  const nbs = leadH(eta) > OUTLOOK_AFTER_H && leadH(eta) < 74 ? await getJSON("/nbm", { prod: "nbs", ids: cands.map(a => a.id).join(",") }).catch(() => null) : null;
  const best = bestAlternate(rateAltCands(cands, eta, nbs));
  btn.disabled = false;
  $("#alt").value = best ? best.id : "";
  hint.textContent = best
    ? `Reverse picked ${best.id}, ${Math.round(best.dist)} nm from ${newDest}${best.status === "marginal" ? " (TEMPO/PROB near minimums)" : ""}. Pick another from the list if you prefer.`
    : `No civil airport within ${ALT_RADIUS} nm of ${newDest} has a TAF meeting alternate minimums at your ETA, so the alternate is blank.`;
  update();
  loadAll();
}

// ---------- form state ----------
function readForm() {
  const o = {};
  for (const el of FORM.elements) if (el.id && !AC_FIELD_RE.test(el.id)) o[el.id] = el.type === "checkbox" ? el.checked : el.value;
  return o;
}
function writeForm(o) {
  for (const [k, v] of Object.entries(o)) {
    const el = document.getElementById(k);
    if (!el || !FORM.contains(el) || AC_FIELD_RE.test(k)) continue;
    if (el.type === "checkbox") el.checked = !!v; else el.value = v;
  }
}
function defaults() {
  const now = new Date();
  const etd = new Date(now); etd.setMinutes(0, 0, 0); etd.setHours(etd.getHours() + 2);
  const ago = m => { const d = new Date(now); d.setMonth(d.getMonth() - m); return ymd(d); };
  const ahead = m => ymd(new Date(now.getFullYear(), now.getMonth() + m + 1, 0));
  return { datalink: true, stormscope: true, etd: localInput(etd), currentThru: ahead(3), annual: ago(4), pitot: ago(10), xpdr: ago(10), elt: ago(4), vorCheck: ago(0) };
}
function update() {
  const f = readForm();
  if (!pendingCharts) store.set(STORE_KEY, JSON.stringify(f)); // don't overwrite saved approaches before the lists load
  render(evaluate(f));
}

// ---------- boot ----------
(function boot() {
  const d = defaults();
  writeForm(d);
  let saved = null;
  try { saved = JSON.parse(store.get(STORE_KEY) || "null"); } catch {}
  if (saved) {
    if (!saved.etd || new Date(saved.etd) < new Date(Date.now() - 3600e3)) saved.etd = d.etd;
    pendingCharts = { destChart: saved.destChart, depChart: saved.depChart, altChart: saved.altChart };
    if (saved.datalink === undefined) { delete saved.datalink; delete saved.stormscope; }
    writeForm(saved);
  } else pendingCharts = {};
  etdToFields();
  initAircraft(saved);
  setupAircraftEditor();
  let reloadTimer;
  const ALT_HINT = $("#alt-hint").textContent;
  FORM.addEventListener("input", e => {
    const id = e.target.id;
    if (e.target.closest("fieldset")?.querySelector(".example")) store.set(EX_KEY, "1");
    if (["destChart", "depChart", "altChart"].includes(id)) chartChosen(id.replace("Chart", ""));
    if (id === "etdDate" || id === "etdTime") fieldsToEtd();
    if (id === "altPick") { if (!e.target.value) return; $("#alt").value = e.target.value; }
    if (id === "alt" || id === "altPick") $("#alt-hint").textContent = ALT_HINT; // drop any note from Reverse
    if (["route", "alt", "altPick", "etdDate", "etdTime"].includes(id)) { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadAll, 900); }
    update();
  });
  $("#reload").addEventListener("click", loadAll);
  $("#reverse").addEventListener("click", reverseCourse);
  $("#etdTime").addEventListener("blur", () => { const t = parseTime24($("#etdTime").value); if (t) $("#etdTime").value = t; });
  // Quit: first click asks, second click within 4 s stops the server
  let quitTimer = null;
  $("#quit").addEventListener("click", async e => {
    const btn = e.currentTarget;
    if (!quitTimer) {
      btn.textContent = "Click again to quit";
      quitTimer = setTimeout(() => { btn.textContent = "Quit app"; quitTimer = null; }, 4000);
      return;
    }
    clearTimeout(quitTimer);
    btn.disabled = true;
    btn.textContent = "Stopping…";
    try { await fetch("/app/quit", { method: "POST" }); } catch {}
    clearInterval(refreshTimer);
    document.querySelector(".layout").hidden = true;
    $("#banners").hidden = true;
    $("#stopped").hidden = false;
    $("#wx-status").textContent = "Stopped";
    btn.textContent = "Stopped";
    $("#reload").disabled = true;
    window.close(); // works only if the browser allows it; otherwise the banner says to close the tab
  });
  setupProfileZoom();
  // first launch: the pilot accepts that this is a decision aid, not a briefing
  if (store.get(TERMS_KEY) !== "1") {
    const dlg = $("#terms");
    dlg.addEventListener("cancel", e => e.preventDefault()); // Esc doesn't skip it
    $("#termsOk").addEventListener("change", e => { $("#termsAccept").disabled = !e.target.checked; });
    $("#termsAccept").addEventListener("click", () => { store.set(TERMS_KEY, "1"); dlg.close(); });
    dlg.showModal();
  }
  W.loading = true;
  update();
  loadAll();
  refreshTimer = setInterval(loadAll, 15 * 60e3);
})();
