#!/usr/bin/env python3
"""
missed_signal_check.py — did the bot's skips cost money, or save it?

Replays every skipped / waited ST5-ST15 cross found in audit.json against real
1-minute Binance candles: "if the bot had bought at the moment it skipped, what
would the 1.25% stop / 3% T1 / 3h stale-timeout rules have done?"

Run it on YOUR machine (the sandbox it was written in cannot reach Binance):

    python3 missed_signal_check.py --audit audit.json
    python3 missed_signal_check.py --audit a.json --audit b.json --stop 1.25 --t1 3 --hours 3 --fee 0.1

audit.json is capped, so save a copy every few days and pass them all with --audit.
Only the standard library is used.

Assumptions (all printed): entry = open of the 1m candle at the audit timestamp
(the decision moment); a candle that touches both stop and target counts as a
STOP (conservative); no slippage beyond --fee; no profit-protection/lock logic
(so winners are scored at T1 or at the horizon, losers at the stop).
"""
import argparse, bisect, json, ssl, sys, time, urllib.request, urllib.error
from collections import defaultdict
from datetime import datetime, timezone

ENDPOINTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"]
# Binance delisted XMR (2024-02-20): its endpoints answer 200 with no/frozen candles, so these symbols are routed to Kraken
# (same unconditional routing the bot uses in leaderboard-scanner.js / alert-runner.js / mexc-trader.js).
KRAKEN_PAIR = {"XMRUSDT": "XMRUSD"}

# audit actions that mean "the bot did NOT buy this cross"
SKIP_ACTIONS = {
    "st5_skipped_overextended", "st15_skipped_overextended",
    "st5_skipped_exhausted", "st15_skipped_exhausted",
    "st5_gate_prefilter", "st15_gate_prefilter",
    "st5_skipped_late_retest", "st15_skipped_late_retest",
    "st5_wait_retest", "st15_wait_retest",
    "st5_expired", "st15_expired",
    "early_buy_candidate",            # shadow EARLY BUY (P0) hits and near-misses, see early-buy.js
}
# ...and the ones where it DID, for comparison
TAKEN_ACTIONS = {"st5_live_buy", "st15_live_buy", "st5_overextended_override",
                 "st15_overextended_override", "st5_spike_breakout_override", "st15_spike_breakout_override"}


def parse_ts(s):
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def load_events(paths):
    """One row per cross. wait_retest -> expired/skipped for the same event id is ONE
    cross, not two: it is scored from the FIRST moment the bot declined to buy and
    labelled with the LAST thing that happened to it."""
    by_key = {}
    for p in paths:
        with open(p) as fh:
            rows = json.load(fh)
        rows = rows if isinstance(rows, list) else rows.get("entries", rows.get("events", []))
        for r in rows:
            a = r.get("action")
            if a not in SKIP_ACTIONS and a not in TAKEN_ACTIONS:
                continue
            sym = r.get("pair") or r.get("sym")
            if not sym or not r.get("timestamp"):
                continue
            sym = sym.split(":")[-1].upper()            # "BINANCE:RENDERUSDT" -> "RENDERUSDT"
            if not sym.endswith("USDT"):
                sym += "USDT"
            early = None
            if a == "early_buy_candidate":              # label by how close it was to a full pass
                failed = r.get("failed") or []
                early = {"path": "strict-pass" if r.get("strict") else "setup-pass" if r.get("setupPath") else "near-miss",
                         "trigger": str(r.get("trigger") or "n/a").upper(), "stage": r.get("stage") or "no-stage"}
                if r.get("strict"):
                    a = "early_strict"
                elif r.get("setupPath"):
                    a = "early_setup"       # passed via the setup-path relaxations (failed = the strict clauses it waived); NOT a miss
                else:
                    a = f"early_miss:{failed[0]}" if len(failed) == 1 else f"early_miss:{len(failed)} clauses"
            kind = "taken" if a in TAKEN_ACTIONS else "skipped"
            key = (kind, r.get("id") or (sym, a, r["timestamp"][:13]))
            ts = parse_ts(r["timestamp"])
            cur = by_key.get(key)
            if cur is None:
                cur = by_key[key] = {"action": a, "symbol": sym, "ts": ts, "id": r.get("id"), "_last": ts, "spike": False,
                                     "signal": r.get("signal"), "failed": r.get("failed") or []}
                if early:
                    cur.update(early)                                # first-seen path/trigger/stage (decision moment)
            else:
                cur["ts"] = min(cur["ts"], ts)                       # decision moment = earliest
                if ts >= cur["_last"]:
                    cur["action"], cur["_last"] = a, ts              # label = terminal state
            if r.get("spikeWouldPass") is True:                      # shadow verdict of the spike exception
                cur["spike"] = True
    out = list(by_key.values())
    for e in out:
        e.pop("_last", None)
        if e.pop("spike", False) and e["action"] in SKIP_ACTIONS:
            e["action"] += " [spike-pass]"      # skipped crosses the spike exception WOULD have allowed
    return sorted(out, key=lambda e: e["ts"])


def load_guard(paths):
    """(sorted timestamps, canBuy flags) from the bot's own market_guard audit rows - lets every event be tagged with whether
    the guard (BTC 4H regime etc.) was allowing buys at that moment."""
    pts = []
    for p in paths:
        with open(p) as fh:
            rows = json.load(fh)
        rows = rows if isinstance(rows, list) else rows.get("entries", rows.get("events", []))
        for r in rows:
            if r.get("action") == "market_guard" and r.get("timestamp"):
                pts.append((parse_ts(r["timestamp"]), bool(r.get("canBuy")) and not r.get("closeAll")))
    pts.sort()
    return [t for t, _ in pts], [c for _, c in pts]


def guard_state(guard, ts, max_age_min=15):
    times, flags = guard
    i = bisect.bisect_right(times, ts) - 1
    if i < 0 or ts - times[i] > max_age_min * 60000:
        return "guard-unknown"
    return "guard-open" if flags[i] else "guard-blocked"


SSL_CTX = None   # set from --ca-bundle / --insecure in main()

SSL_HINT = """
TLS certificate check failed - this is a network/certificate problem on YOUR side, not a Binance block.
It usually means a corporate proxy is inspecting HTTPS with its own certificate. Options, best first:
  1. Run the script from a personal machine / home network (no proxy in the way).
  2. Give Python your company's root certificate (macOS):
       security find-certificate -a -p /Library/Keychains/System.keychain \\
         /System/Library/Keychains/SystemRootCertificates.keychain > ~/ca-bundle.pem
       python3 missed_signal_check.py --audit audit.json --ca-bundle ~/ca-bundle.pem
  3. Last resort: --insecure turns certificate checking off. This script only downloads PUBLIC price
     candles and sends no credentials, but a proxy could then alter the data - results are only as
     trustworthy as that network.
"""


def _is_cert_error(e):
    reason = getattr(e, "reason", e)
    return isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(e)


def fetch_kraken(symbol, start_ms, minutes):
    """1m candles from Kraken. Kraken only serves its most recent ~720 candles (~12h), so older events come back empty."""
    url = f"https://api.kraken.com/0/public/OHLC?pair={KRAKEN_PAIR[symbol]}&interval=1&since={int(start_ms / 1000) - 60}"
    try:
        with urllib.request.urlopen(url, timeout=15, context=SSL_CTX) as resp:
            data = json.load(resp)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, ssl.SSLError) as e:
        if _is_cert_error(e):
            sys.exit(SSL_HINT)
        raise RuntimeError(f"kraken failed for {symbol}: {e}")
    if data.get("error"):
        raise RuntimeError(f"kraken {symbol}: {', '.join(data['error'])}")
    res = data.get("result", {})
    key = next((k for k in res if k != "last"), None)
    rows = (res.get(key) or [])[:-1]                      # last frame is the still-forming candle
    out = [{"t": int(r[0]) * 1000, "o": float(r[1]), "h": float(r[2]), "l": float(r[3]), "c": float(r[4])}
           for r in rows if int(r[0]) * 1000 >= start_ms]
    return out[:minutes + 1]


def fetch_klines(symbol, start_ms, minutes):
    if symbol in KRAKEN_PAIR:
        return fetch_kraken(symbol, start_ms, minutes)
    last = None
    for base in ENDPOINTS:
        url = f"{base}/api/v3/klines?symbol={symbol}&interval=1m&startTime={start_ms}&limit={minutes + 1}"
        try:
            with urllib.request.urlopen(url, timeout=15, context=SSL_CTX) as resp:
                data = json.load(resp)
            return [{"t": k[0], "o": float(k[1]), "h": float(k[2]), "l": float(k[3]), "c": float(k[4])} for k in data]
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, ssl.SSLError) as e:
            if _is_cert_error(e):
                sys.exit(SSL_HINT)               # same failure for every call - stop once, explain once
            last = e
    raise RuntimeError(f"all endpoints failed for {symbol}: {last}")


def simulate(candles, stop_pct, t1_pct, fee_pct):
    """Returns dict(exit, pnl, mfe, mae, minutes) or None if no candles."""
    if not candles:
        return None
    entry = candles[0]["o"]
    stop, tgt = entry * (1 - stop_pct / 100), entry * (1 + t1_pct / 100)
    mfe = mae = 0.0
    for i, k in enumerate(candles):
        mfe = max(mfe, (k["h"] / entry - 1) * 100)
        mae = min(mae, (k["l"] / entry - 1) * 100)
        if k["l"] <= stop:                     # stop checked first (conservative)
            return {"exit": "stop", "pnl": -stop_pct - fee_pct, "mfe": mfe, "mae": mae, "minutes": i}
        if k["h"] >= tgt:
            return {"exit": "T1", "pnl": t1_pct - fee_pct, "mfe": mfe, "mae": mae, "minutes": i}
    last = candles[-1]["c"]
    return {"exit": "timeout", "pnl": (last / entry - 1) * 100 - fee_pct, "mfe": mfe, "mae": mae, "minutes": len(candles) - 1}


def summarize(rows, title, key=None):
    key = key or (lambda r: r["action"])
    print(f"\n{title}")
    print(f"  {'group':34} {'n':>3} {'avg%':>6} {'win%':>5} {'T1':>3} {'stop':>4} {'t/o':>3} {'avgMFE':>7} {'avgMAE':>7}")
    groups = defaultdict(list)
    for r in rows:
        groups[key(r)].append(r)
    groups["ALL"] = rows
    for g, rs in sorted(groups.items(), key=lambda kv: (kv[0] == "ALL", kv[0])):
        n = len(rs)
        avg = sum(r["pnl"] for r in rs) / n
        win = 100 * sum(r["pnl"] > 0 for r in rs) / n
        c = lambda e: sum(r["exit"] == e for r in rs)
        print(f"  {g:34} {n:>3} {avg:>6.2f} {win:>5.0f} {c('T1'):>3} {c('stop'):>4} {c('timeout'):>3} "
              f"{sum(r['mfe'] for r in rs)/n:>7.2f} {sum(r['mae'] for r in rs)/n:>7.2f}")


def sensitivity(rows, fee, stops=(0.75, 1.0, 1.5), t1s=(1.0, 1.5, 2.0, 3.0)):
    """Same candles, different exits: shows whether the stop/T1 pair - not the entry signal - is what is losing."""
    print("\nExit sensitivity on the SAME skipped entries (avg% / win%) - rows = stop %, cols = T1 %")
    print("  " + f"{'stop':>6} " + " ".join(f"{'T1 ' + str(t):>13}" for t in t1s))
    for sp in stops:
        cells = []
        for t in t1s:
            res = [simulate(r["candles"], sp, t, fee)["pnl"] for r in rows]
            cells.append(f"{sum(res) / len(res):>6.2f}/{100 * sum(x > 0 for x in res) / len(res):>3.0f}%")
        print(f"  {sp:>6} " + " ".join(f"{c:>13}" for c in cells))


# Promotion bar for letting SETUP-approach alerts graduate beyond alert-only (see early-buy.js header).
SETUP_MIN_N, SETUP_MIN_WIN, SETUP_MIN_AVG = 50, 55.0, 0.0


def dedupe(rows, window_min):
    """Keep the first event per symbol per window: repeated alerts on one coin are one bet, not independent samples."""
    last, out = {}, []
    for r in sorted(rows, key=lambda r: r["ts"]):
        if r["symbol"] in last and r["ts"] - last[r["symbol"]] < window_min * 60000:
            continue
        last[r["symbol"]] = r["ts"]
        out.append(r)
    return out


def setup_report(skipped, window_min):
    """Early-buy candidates split by path and by trigger status / stage, raw and de-duplicated, plus a promotion verdict."""
    early = [r for r in skipped if r.get("path")]
    if not early:
        return
    for label, rows in ((f"raw ({len(early)} rows)", early), (f"de-duplicated, 1 per symbol per {window_min:g} min", dedupe(early, window_min))):
        summarize(rows, f"EARLY-BUY by path - {label}", key=lambda r: r["path"])
        summarize(rows, f"EARLY-BUY by trigger status / stage - {label}", key=lambda r: f"{r['trigger']} / {r['stage']}")
    setup = [r for r in dedupe(early, window_min) if r["trigger"] == "SETUP" and r["stage"] == "approach"]
    print("\nSETUP-approach promotion check (de-duplicated):")
    if not setup:
        print("  no SETUP / approach events in this window")
        return
    n = len(setup)
    avg = sum(r["pnl"] for r in setup) / n
    win = 100 * sum(r["pnl"] > 0 for r in setup) / n
    ok = n >= SETUP_MIN_N and win >= SETUP_MIN_WIN and avg > SETUP_MIN_AVG
    print(f"  n={n} (need {SETUP_MIN_N}) | win {win:.0f}% (need {SETUP_MIN_WIN:.0f}%) | avg {avg:.2f}% (need > {SETUP_MIN_AVG:g}%)")
    print("  VERDICT: " + ("meets the bar - review before widening it, still check by regime" if ok else
                           "does NOT meet the bar - keep EARLY_SETUP_MODE=alert"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--audit", action="append", required=True, help="audit.json (repeatable)")
    ap.add_argument("--stop", type=float, default=1.25)
    ap.add_argument("--t1", type=float, default=3.0)
    ap.add_argument("--hours", type=float, default=3.0, help="stale-timeout horizon")
    ap.add_argument("--fee", type=float, default=0.1, help="round-trip fee %% (check your MEXC tier)")
    ap.add_argument("--ca-bundle", help="PEM file with extra trusted root certificates (corporate proxy)")
    ap.add_argument("--insecure", action="store_true", help="disable TLS certificate checking (public data only; see hint)")
    ap.add_argument("--dedupe-min", type=float, default=180.0,
                    help="window (minutes, default = the 3h horizon) for the de-duplicated early-buy split: first event per symbol per window. The audit logger already caps rows at 1 per symbol per 60 min, so 60 changes nothing")
    ap.add_argument("--partial", action="store_true",
                    help="also score events whose window is still open, using the candles available so far (marked partial)")
    args = ap.parse_args()

    global SSL_CTX
    if args.insecure:
        SSL_CTX = ssl._create_unverified_context()
        print("WARNING: TLS certificate checking is OFF (--insecure).", file=sys.stderr)
    elif args.ca_bundle:
        try:
            SSL_CTX = ssl.create_default_context(cafile=args.ca_bundle)
        except (OSError, ssl.SSLError) as e:
            sys.exit(f"Could not load --ca-bundle {args.ca_bundle}: {e}")

    events = load_events(args.audit)
    guard = load_guard(args.audit)
    if not events:
        print("No skipped/taken ST events found in the audit file(s) - nothing to replay.")
        print("Normal when the market guard paused buys, or the audit window is short. Not an error.")
        print("Tip: pass several saved audit snapshots with repeated --audit to widen the window.")
        sys.exit(0)
    minutes = int(args.hours * 60)
    print(f"{len(events)} events | stop {args.stop}% | T1 {args.t1}% | horizon {args.hours}h | fee {args.fee}%")
    skipped, taken, failed = [], [], 0
    too_recent, no_data = [], []
    now = time.time() * 1000
    for ev in events:
        age_min = (now - ev["ts"]) / 60000
        when = datetime.fromtimestamp(ev["ts"] / 1000, timezone.utc).strftime("%m-%d %H:%M")
        partial = age_min < minutes
        if partial and not args.partial:
            too_recent.append((ev, when, age_min))
            continue
        want = max(1, min(minutes, int(age_min)))        # never ask for candles that don't exist yet
        try:
            candles = fetch_klines(ev["symbol"], ev["ts"], want)
            res = simulate(candles, args.stop, args.t1, args.fee)
        except RuntimeError as e:
            failed += 1
            print(f"  ! {ev['symbol']} {ev['action']}: {e}", file=sys.stderr)
            continue
        if not res:
            no_data.append((ev, when))
            continue
        row = {**ev, **res, "partial": partial, "candles": candles, "guard": guard_state(guard, ev["ts"])}
        (taken if ev["action"] in TAKEN_ACTIONS else skipped).append(row)

    print(f"\nEvents found: {len(events)} | scored: {len(skipped) + len(taken)} | "
          f"window still open: {len(too_recent)} | no candles returned: {len(no_data)} | fetch failed: {failed}")
    for ev, when, age in too_recent:
        print(f"  - {ev['symbol']:10} {when} UTC {ev['action']:26} only {age:.0f} min old (needs {minutes}); "
              f"re-run later or add --partial")
    for ev, when in no_data:
        src = "Kraken (only keeps ~12h of 1m candles)" if ev["symbol"] in KRAKEN_PAIR else "Binance"
        print(f"  - {ev['symbol']:10} {when} UTC {ev['action']:26} {src} returned no candles for that time")
    if any(r.get("partial") for r in skipped + taken):
        print("  (rows marked partial used a window that had not finished — treat those results as provisional)")
    if failed:
        print(f"\n{failed} event(s) could not be fetched (network/geo-block?) and were left out.")
    if skipped:
        summarize(skipped, "SKIPPED crosses — what buying anyway would have done")
    if taken:
        summarize(taken, "TAKEN crosses (same rules, for comparison)")
    if skipped:
        summarize(skipped, "SKIPPED crosses by market-guard state at the time (from the bot's own market_guard rows)", key=lambda r: r["guard"])
        if any(r.get("signal") for r in skipped):
            summarize([r for r in skipped if r.get("signal")], "EARLY-BUY candidates by signal label (is the signalSafe clause right to block them?)",
                      key=lambda r: str(r["signal"]))
            clause = defaultdict(list)
            for r in skipped:
                for c in r.get("failed") or []:
                    clause[c].append(r)
            if clause:
                print("\nEarly-buy candidates grouped by each clause they FAILED (a clause is earning its keep if buying through it loses)")
                print(f"  {'clause failed':34} {'n':>3} {'avg%':>6} {'win%':>5}")
                for c, rs in sorted(clause.items(), key=lambda kv: -len(kv[1])):
                    print(f"  {c:34} {len(rs):>3} {sum(r['pnl'] for r in rs) / len(rs):>6.2f} {100 * sum(r['pnl'] > 0 for r in rs) / len(rs):>5.0f}")
        setup_report(skipped, args.dedupe_min)
        sensitivity(skipped, args.fee)
    best = sorted(skipped, key=lambda r: -r["mfe"])[:5]
    if best:
        print("\nBiggest misses (highest favourable move before the window ended):")
        for r in best:
            when = datetime.fromtimestamp(r["ts"] / 1000, timezone.utc).strftime("%m-%d %H:%M")
            print(f"  {r['symbol']:10} {when} UTC  {r['action']:28} MFE +{r['mfe']:.2f}%  MAE {r['mae']:.2f}%  -> {r['exit']}")
    print("\nRead it as a guide, not proof: small samples, one entry price, no trailing/profit-protection exits.")
    print("Crypto majors move together: several events in the same hour are ONE market move, not independent samples.")


if __name__ == "__main__":
    main()
