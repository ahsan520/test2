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
import argparse, json, ssl, sys, time, urllib.request, urllib.error
from collections import defaultdict
from datetime import datetime, timezone

ENDPOINTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"]

# audit actions that mean "the bot did NOT buy this cross"
SKIP_ACTIONS = {
    "st5_skipped_overextended", "st15_skipped_overextended",
    "st5_skipped_exhausted", "st15_skipped_exhausted",
    "st5_gate_prefilter", "st15_gate_prefilter",
    "st5_skipped_late_retest", "st15_skipped_late_retest",
    "st5_wait_retest", "st15_wait_retest",
    "st5_expired", "st15_expired",
}
# ...and the ones where it DID, for comparison
TAKEN_ACTIONS = {"st5_live_buy", "st15_live_buy", "st5_overextended_override",
                 "st15_overextended_override", "st5_spike_breakout_override", "st15_spike_breakout_override"}


def parse_ts(s):
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def load_events(paths):
    seen, out = set(), []
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
            # first occurrence per (action, event id) — wait_retest repeats every cycle
            key = (a, r.get("id") or (sym, r["timestamp"][:13]))
            if key in seen:
                continue
            seen.add(key)
            out.append({"action": a, "symbol": sym, "ts": parse_ts(r["timestamp"]), "id": r.get("id")})
    return out


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


def fetch_klines(symbol, start_ms, minutes):
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


def summarize(rows, title):
    print(f"\n{title}")
    print(f"  {'group':34} {'n':>3} {'avg%':>6} {'win%':>5} {'T1':>3} {'stop':>4} {'t/o':>3} {'avgMFE':>7} {'avgMAE':>7}")
    groups = defaultdict(list)
    for r in rows:
        groups[r["action"]].append(r)
    groups["ALL"] = rows
    for g, rs in sorted(groups.items(), key=lambda kv: (kv[0] == "ALL", kv[0])):
        n = len(rs)
        avg = sum(r["pnl"] for r in rs) / n
        win = 100 * sum(r["pnl"] > 0 for r in rs) / n
        c = lambda e: sum(r["exit"] == e for r in rs)
        print(f"  {g:34} {n:>3} {avg:>6.2f} {win:>5.0f} {c('T1'):>3} {c('stop'):>4} {c('timeout'):>3} "
              f"{sum(r['mfe'] for r in rs)/n:>7.2f} {sum(r['mae'] for r in rs)/n:>7.2f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--audit", action="append", required=True, help="audit.json (repeatable)")
    ap.add_argument("--stop", type=float, default=1.25)
    ap.add_argument("--t1", type=float, default=3.0)
    ap.add_argument("--hours", type=float, default=3.0, help="stale-timeout horizon")
    ap.add_argument("--fee", type=float, default=0.1, help="round-trip fee %% (check your MEXC tier)")
    ap.add_argument("--ca-bundle", help="PEM file with extra trusted root certificates (corporate proxy)")
    ap.add_argument("--insecure", action="store_true", help="disable TLS certificate checking (public data only; see hint)")
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
    if not events:
        sys.exit("No skipped/taken ST events found in the audit file(s).")
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
            res = simulate(fetch_klines(ev["symbol"], ev["ts"], want), args.stop, args.t1, args.fee)
        except RuntimeError as e:
            failed += 1
            print(f"  ! {ev['symbol']} {ev['action']}: {e}", file=sys.stderr)
            continue
        if not res:
            no_data.append((ev, when))
            continue
        row = {**ev, **res, "partial": partial}
        (taken if ev["action"] in TAKEN_ACTIONS else skipped).append(row)

    print(f"\nEvents found: {len(events)} | scored: {len(skipped) + len(taken)} | "
          f"window still open: {len(too_recent)} | no candles returned: {len(no_data)} | fetch failed: {failed}")
    for ev, when, age in too_recent:
        print(f"  - {ev['symbol']:10} {when} UTC {ev['action']:26} only {age:.0f} min old (needs {minutes}); "
              f"re-run later or add --partial")
    for ev, when in no_data:
        print(f"  - {ev['symbol']:10} {when} UTC {ev['action']:26} Binance returned no candles for that time")
    if any(r.get("partial") for r in skipped + taken):
        print("  (rows marked partial used a window that had not finished — treat those results as provisional)")
    if failed:
        print(f"\n{failed} event(s) could not be fetched (network/geo-block?) and were left out.")
    if skipped:
        summarize(skipped, "SKIPPED crosses — what buying anyway would have done")
    if taken:
        summarize(taken, "TAKEN crosses (same rules, for comparison)")
    best = sorted(skipped, key=lambda r: -r["mfe"])[:5]
    if best:
        print("\nBiggest misses (highest favourable move before the window ended):")
        for r in best:
            when = datetime.fromtimestamp(r["ts"] / 1000, timezone.utc).strftime("%m-%d %H:%M")
            print(f"  {r['symbol']:10} {when} UTC  {r['action']:28} MFE +{r['mfe']:.2f}%  MAE {r['mae']:.2f}%  -> {r['exit']}")
    print("\nRead it as a guide, not proof: small samples, one entry price, no trailing/profit-protection exits.")


if __name__ == "__main__":
    main()
