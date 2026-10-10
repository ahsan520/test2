#!/usr/bin/env python3
"""
backtest_entries.py — do any of our entry rules have an edge? Replays them on real 5m candles.

For each symbol it fetches ~N days of 5-minute Binance candles, computes Supertrend(10,3), ATR, volume
averages, and then trades every signal of every rule through the SAME exit model as the live bot:
  stop (default 1.25%, + stop slippage), optional T1 target, a trailing stop (once the peak clears 0.8%,
  exit when price falls max(0.5%, 35% of the peak) below it), a 3h time stop, entry slippage, round-trip fee.

Rules compared (all with the same exits):
  R0  random           control: random entries. The number every rule has to beat.
  R1  st5_cross        5m Supertrend flips up (what P0 buys today), then split by how far above the
                       line the close is, in ATR: R1a <=1.5, R1b 1.5-2.5, R1c >2.5 (the bot's EXHAUSTED zone)
  R1d cross_then_retest the bot's WAIT_RETEST behaviour: after a cross, wait (up to 3h) for price to pull back within
                       1.5 ATR of the line, then buy the first bullish close. NOTE: at a Supertrend(10,3) flip the close
                       is ~3 ATR above the new line by construction, so R1a/R1b are almost empty and nearly every fresh
                       cross counts as 'far' - the live bot's EXHAUSTED label is true of almost every cross.
  R2  pre_cross        P2-style, BEFORE the cross: trend still down, close within 1.5 ATR below the Supertrend
                       line, breaking the 12-bar high on volume >= 1.5x average
  R3  squeeze_break    P2-B-style: 12-bar range compressed (<= 2.5 ATR), close breaks above it on volume >= 1.5x
  R5  vol_shock_buyers the live 'SQUEEZE NOW' idea (buy as a spike starts): volume >= 2x average, taker-buy share >= 58%
                       (the candle-data stand-in for the bot's CVD-up), bullish candle, any trend
  R4  pullback_reclaim P2-A-style: uptrend >= 8 bars, pulled back within 0.7 ATR of the line in the last 6
                       bars, then closes above the prior high on an up candle, <= 2 ATR above the line

A rule only counts as promising if it beats R0 by more than 2 standard errors AND is positive versus R0 in
BOTH halves of the period. Even then it is a candidate, not proof: several rules are tested at once, so
some will look good by luck. Confirm on a different period before trusting it with money.

Run on GitHub Actions (backtest.yml) - the sandbox this was written in cannot reach Binance.
Standard library only.   Not financial advice.
"""
import argparse, json, math, os, random, ssl, sys, time, urllib.request, urllib.error
from collections import defaultdict

ENDPOINTS = ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"]
DEFAULT_SYMBOLS = "BTC ETH XRP RENDER GALA SUI APT IMX DOGE XLM XMR ZEC SOL LINK TAO AVAX FET UNI AAVE NEAR".split()


# ───────────────────────── data ─────────────────────────
def _get(path):
    last = None
    for base in ENDPOINTS:
        try:
            with urllib.request.urlopen(base + path, timeout=20) as r:
                return json.load(r)
        except ssl.SSLError as e:
            sys.exit(f"TLS/certificate problem ({e}). Run this on GitHub Actions or a network without HTTPS inspection.")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as e:
            if "CERTIFICATE_VERIFY_FAILED" in str(e):
                sys.exit("TLS certificate check failed (corporate proxy?). Run this on GitHub Actions instead.")
            last = e
    raise RuntimeError(f"all endpoints failed: {last}")


def fetch_5m(symbol, bars):
    out, end = [], None
    while len(out) < bars:
        lim = min(1000, bars - len(out))
        data = _get(f"/api/v3/klines?symbol={symbol}&interval=5m&limit={lim}" + (f"&endTime={end}" if end else ""))
        if not data:
            break
        out = data + out
        end = data[0][0] - 1
        if len(data) < lim:
            break
        time.sleep(0.08)
    return [{"t": k[0], "o": float(k[1]), "h": float(k[2]), "l": float(k[3]), "c": float(k[4]), "v": float(k[5]), "tb": float(k[9])} for k in out]


def synthetic(n, seed, plant):
    """Random-walk candles with volatility clustering. plant=True adds a REAL edge: after a squeeze + volume
    breakout the price drifts up ~1.6%. Used only to prove the machinery detects an edge when one exists."""
    rnd = random.Random(seed)
    price, t, out = 100.0, 1_700_000_000_000, []
    i = 0
    while i < n:
        if rnd.random() < 0.006 and i + 40 < n:                       # a squeeze -> breakout episode
            for _ in range(12):                                       # compressed, quiet
                r = rnd.gauss(0, 0.0007); o = price; price *= 1 + r
                vq = rnd.uniform(40, 70); out.append((t, o, max(o, price) * 1.0004, min(o, price) * 0.9996, price, vq, vq * rnd.uniform(0.45, 0.55))); t += 300000; i += 1
            drift = 0.016 / 10 if plant else 0.0
            for j in range(10):                                       # breakout + follow-through
                r = (0.0045 if j == 0 else drift) + rnd.gauss(0, 0.0030); o = price; price *= 1 + r
                vq = rnd.uniform(160, 260) if j == 0 else rnd.uniform(80, 140); out.append((t, o, max(o, price) * 1.001, min(o, price) * 0.999, price, vq, vq * (0.66 if j == 0 else rnd.uniform(0.48, 0.55)))); t += 300000; i += 1
        else:
            vol = 0.0035 * (1.6 if rnd.random() < 0.15 else 1.0)
            r = rnd.gauss(0, vol); o = price; price *= 1 + r
            vq = rnd.uniform(50, 110); out.append((t, o, max(o, price) * (1 + abs(rnd.gauss(0, 0.0012))), min(o, price) * (1 - abs(rnd.gauss(0, 0.0012))), price, vq, vq * rnd.uniform(0.42, 0.58))); t += 300000; i += 1
    return [{"t": a, "o": o, "h": h, "l": l, "c": c, "v": v, "tb": tb} for a, o, h, l, c, v, tb in out[:n]]


# ───────────────────────── indicators ─────────────────────────
def indicators(k, atr_len=10, mult=3.0):
    n = len(k)
    if n < 60:
        return None
    h = [x["h"] for x in k]; l = [x["l"] for x in k]; c = [x["c"] for x in k]; v = [x["v"] for x in k]
    tr = [h[0] - l[0]] + [max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])) for i in range(1, n)]
    atr = [None] * n
    atr[atr_len - 1] = sum(tr[:atr_len]) / atr_len
    for i in range(atr_len, n):
        atr[i] = (atr[i - 1] * (atr_len - 1) + tr[i]) / atr_len        # Wilder RMA (TradingView default)
    fu = [None] * n; fl = [None] * n; trend = [0] * n; st = [None] * n
    for i in range(atr_len - 1, n):
        hl2 = (h[i] + l[i]) / 2; bu = hl2 + mult * atr[i]; bl = hl2 - mult * atr[i]
        if i == atr_len - 1:
            fu[i], fl[i] = bu, bl; trend[i] = 1 if c[i] > hl2 else -1
        else:
            fu[i] = bu if (bu < fu[i - 1] or c[i - 1] > fu[i - 1]) else fu[i - 1]
            fl[i] = bl if (bl > fl[i - 1] or c[i - 1] < fl[i - 1]) else fl[i - 1]
            trend[i] = 1 if c[i] > fu[i - 1] else (-1 if c[i] < fl[i - 1] else trend[i - 1])
        st[i] = fl[i] if trend[i] == 1 else fu[i]
    volma = [None] * n
    for i in range(20, n):
        volma[i] = sum(v[i - 20:i]) / 20
    return {"atr": atr, "st": st, "trend": trend, "volma": volma}


# ───────────────────────── signals ─────────────────────────
WARM = 40

def sig_cross(k, ind, i):
    if ind["trend"][i] == 1 and ind["trend"][i - 1] == -1:
        return (k[i]["c"] - ind["st"][i]) / ind["atr"][i]
    return None

def sig_pre_cross(k, ind, i, gap=1.5):
    if ind["trend"][i] != -1 or not ind["volma"][i]:
        return False
    g = (ind["st"][i] - k[i]["c"]) / ind["atr"][i]
    if not (0 < g <= gap):
        return False
    return k[i]["c"] > max(x["h"] for x in k[i - 12:i]) and k[i]["v"] >= 1.5 * ind["volma"][i]

def sig_squeeze(k, ind, i):
    if not ind["volma"][i]:
        return False
    w = k[i - 12:i]
    rng = max(x["h"] for x in w) - min(x["l"] for x in w)
    return rng <= 2.5 * ind["atr"][i] and k[i]["c"] > max(x["h"] for x in w) and k[i]["v"] >= 1.5 * ind["volma"][i]

def sig_pullback(k, ind, i):
    if not ind["volma"][i] or any(ind["trend"][j] != 1 for j in range(i - 8, i + 1)):
        return False
    dist = (k[i]["c"] - ind["st"][i]) / ind["atr"][i]
    near = min((k[j]["l"] - ind["st"][j]) / ind["atr"][j] for j in range(i - 6, i))
    return near <= 0.7 and dist <= 2.0 and k[i]["c"] > k[i - 1]["h"] and k[i]["c"] > k[i]["o"] and k[i]["v"] >= ind["volma"][i]


def sig_vol_shock(k, ind, i):
    b = k[i]
    if not ind["volma"][i] or b["v"] <= 0:
        return False
    return b["v"] >= 2.0 * ind["volma"][i] and b.get("tb", 0) / b["v"] >= 0.58 and b["c"] > b["o"]


# ───────────────────────── exit model ─────────────────────────
def simulate(k, e, a):
    """Enter at the open of bar e. Returns trade dict or None."""
    n = len(k)
    if e >= n - 1:
        return None
    entry = k[e]["o"] * (1 + a.slip / 100)
    stop = entry * (1 - a.stop / 100)
    t1 = entry * (1 + a.t1 / 100) if a.t1 > 0 else None
    peak = mfe = mae = 0.0
    last = min(n - 1, e + int(a.hold_hours * 12))
    for j in range(e, last + 1):
        b = k[j]
        mfe = max(mfe, (b["h"] / entry - 1) * 100); mae = min(mae, (b["l"] / entry - 1) * 100)
        if b["l"] <= stop:                                              # stop first (conservative)
            px = min(stop, b["o"]) * (1 - a.stop_slip / 100)
            return _trade(entry, px, "stop", j, mfe, mae, a)
        peak = max(peak, (b["h"] / entry - 1) * 100)
        if t1 and b["h"] >= t1:
            return _trade(entry, t1, "T1", j, mfe, mae, a)
        pnl_c = (b["c"] / entry - 1) * 100
        if peak >= a.trail_peak and peak - pnl_c >= max(a.trail_min, a.trail_frac * peak):
            return _trade(entry, b["c"], "trail", j, mfe, mae, a)
    return _trade(entry, k[last]["c"], "timeout", last, mfe, mae, a)

def _trade(entry, exit_px, why, j, mfe, mae, a):
    return {"pnl": (exit_px / entry - 1) * 100 - a.fee, "why": why, "exit_i": j, "mfe": mfe, "mae": mae}


# ───────────────────────── runner ─────────────────────────
RULES = ["R0_random", "R1_st5_cross", "R1a_cross_near<=1.5ATR", "R1b_cross_mid_1.5-2.5", "R1c_cross_far>2.5ATR", "R1d_cross_then_retest",
         "R2_pre_cross", "R3_squeeze_break", "R4_pullback_reclaim", "R5_vol_shock_buyers"]

def run(all_k, a):
    rnd = random.Random(a.seed)
    trades = []
    for sym, k in all_k.items():
        ind = indicators(k)
        if not ind:
            continue
        n = len(k); mid = n // 2
        free = defaultdict(lambda: 0)
        last_cross, cross_used = None, True
        for i in range(WARM, n - a.delay_bars - 2):
            hits = []
            if rnd.random() < a.random_p:
                hits.append("R0_random")
            d = sig_cross(k, ind, i)
            if d is not None:
                hits.append("R1_st5_cross")
                hits.append("R1a_cross_near<=1.5ATR" if d <= 1.5 else "R1b_cross_mid_1.5-2.5" if d <= 2.5 else "R1c_cross_far>2.5ATR")
                last_cross, cross_used = i, False
            elif ind["trend"][i] != 1 or (last_cross is not None and i - last_cross > 36):
                last_cross = None
            if last_cross is not None and not cross_used and i > last_cross:
                dist = (k[i]["c"] - ind["st"][i]) / ind["atr"][i]
                if dist <= 1.5 and k[i]["c"] > k[i]["o"] and k[i]["c"] > k[i - 1]["c"]:
                    hits.append("R1d_cross_then_retest")
            if sig_pre_cross(k, ind, i): hits.append("R2_pre_cross")
            if sig_squeeze(k, ind, i):   hits.append("R3_squeeze_break")
            if sig_pullback(k, ind, i):  hits.append("R4_pullback_reclaim")
            if sig_vol_shock(k, ind, i): hits.append("R5_vol_shock_buyers")
            for rule in hits:
                if i < free[rule]:
                    continue
                t = simulate(k, i + a.delay_bars, a)
                if not t:
                    continue
                free[rule] = t["exit_i"] + 6                             # no overlapping trades per symbol/rule
                if rule == "R1d_cross_then_retest":
                    cross_used = True
                t.update(rule=rule, sym=sym, half=0 if i < mid else 1)
                trades.append(t)
    return trades

def stats(tr):
    n = len(tr)
    if n == 0:
        return None
    p = [t["pnl"] for t in tr]; avg = sum(p) / n
    sd = math.sqrt(sum((x - avg) ** 2 for x in p) / (n - 1)) if n > 1 else 0.0
    se = sd / math.sqrt(n) if n > 1 else float("nan")
    share = lambda w: 100 * sum(t["why"] == w for t in tr) / n
    return dict(n=n, avg=avg, se=se, win=100 * sum(x > 0 for x in p) / n, stop=share("stop"), t1=share("T1"),
                trail=share("trail"), tmo=share("timeout"), mfe=sum(t["mfe"] for t in tr) / n, mae=sum(t["mae"] for t in tr) / n)

def report(trades, a):
    by = defaultdict(list)
    for t in trades:
        by[t["rule"]].append(t)
    base = stats(by["R0_random"]) if by["R0_random"] else None
    print(f"\nExit model: stop {a.stop}% (+{a.stop_slip}% slip) | T1 {a.t1}% | trail >={a.trail_peak}% peak, max({a.trail_min}%, {a.trail_frac:.0%} of peak) | "
          f"time stop {a.hold_hours}h | fee {a.fee}% | entry slip {a.slip}% | entry {a.delay_bars} bar(s) after the signal bar")
    print(f"\n{'rule':26}{'n':>5}{'avg%':>7}{'±se':>6}{'win%':>6}{'stop%':>6}{'T1%':>5}{'trail%':>7}{'tmo%':>6}{'MFE':>6}{'MAE':>6}{'1st½':>7}{'2nd½':>7}  verdict")
    for rule in RULES:
        tr = by.get(rule, [])
        s = stats(tr)
        if not s:
            print(f"{rule:26}{0:>5}   (no signals)"); continue
        h1 = stats([t for t in tr if t["half"] == 0]); h2 = stats([t for t in tr if t["half"] == 1])
        f = lambda x: f"{x['avg']:+.2f}" if x else "  n/a"
        verdict = ""
        if rule != "R0_random" and base and s["n"] >= 30:
            ok = (s["avg"] - base["avg"]) > 2 * s["se"] and h1 and h2 and h1["avg"] > (stats([t for t in by['R0_random'] if t['half']==0]) or base)["avg"] \
                 and h2["avg"] > (stats([t for t in by['R0_random'] if t['half']==1]) or base)["avg"]
            verdict = "CANDIDATE - confirm elsewhere" if ok else "no evidence of edge"
        elif rule != "R0_random":
            verdict = "too few trades (<30)"
        print(f"{rule:26}{s['n']:>5}{s['avg']:>7.2f}{s['se']:>6.2f}{s['win']:>6.0f}{s['stop']:>6.0f}{s['t1']:>5.0f}{s['trail']:>7.0f}{s['tmo']:>6.0f}{s['mfe']:>6.2f}{s['mae']:>6.2f}{f(h1):>7}{f(h2):>7}  {verdict}")
    if base:
        print(f"\nControl R0 (random entries) averages {base['avg']:+.2f}% per trade with these exits: that is what 'no edge' looks like here. "
              f"A rule must beat it, not zero.")
    print("\nCaveats: 5m candles only (no intrabar order), stop checked before target inside a candle, fills at open +slippage, no funding/fees beyond the "
          "round-trip fee, coins' history is one market regime. About 7 rules are tested at once, so one may look good by chance.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=30); ap.add_argument("--symbols", nargs="*", default=DEFAULT_SYMBOLS)
    ap.add_argument("--stop", type=float, default=1.25); ap.add_argument("--stop-slip", type=float, default=0.2)
    ap.add_argument("--t1", type=float, default=3.0); ap.add_argument("--fee", type=float, default=0.1)
    ap.add_argument("--slip", type=float, default=0.1); ap.add_argument("--delay-bars", type=int, default=1)
    ap.add_argument("--hold-hours", type=float, default=3.0)
    ap.add_argument("--trail-peak", type=float, default=0.8); ap.add_argument("--trail-min", type=float, default=0.5)
    ap.add_argument("--trail-frac", type=float, default=0.35)
    ap.add_argument("--random-p", type=float, default=0.012, help="chance per bar of a random-control entry")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--synthetic", choices=["null", "plant"], help="self-test on generated candles instead of Binance")
    ap.add_argument("--out", help="write the raw trades to this JSON file")
    ap.add_argument("--stop-sweep", help="comma list of stop %% values, e.g. 0.4,0.7,1.0,1.25,1.5: prints average %% per trade for every rule at each stop")
    a = ap.parse_args()

    bars = a.days * 288
    all_k = {}
    if a.synthetic:
        print(f"SYNTHETIC self-test ({a.synthetic}) — not real market data")
        for i, s in enumerate(a.symbols[:12]):
            all_k[s] = synthetic(bars, a.seed + i, a.synthetic == "plant")
    else:
        for s in a.symbols:
            try:
                k = fetch_5m(s.upper() + ("" if s.upper().endswith("USDT") else "USDT"), bars)
            except RuntimeError as e:
                print(f"  ! {s}: {e}", file=sys.stderr); continue
            if len(k) >= 200:
                all_k[s] = k
            else:
                print(f"  ! {s}: only {len(k)} candles, skipped", file=sys.stderr)
        if not all_k:
            sys.exit("No candle data could be fetched.")
    span = (list(all_k.values())[0][-1]["t"] - list(all_k.values())[0][0]["t"]) / 86400000
    print(f"{len(all_k)} symbols, about {span:.0f} days of 5m candles each")
    trades = run(all_k, a)
    report(trades, a)
    if a.stop_sweep:
        sweep = [float(x) for x in a.stop_sweep.split(",") if x.strip()]
        print("\nSTOP SWEEP - average % per trade (and stop-out share) by stop distance; entries and all other exits unchanged")
        print(f"{'rule':26}" + "".join(f"{('stop '+str(x)+'%'):>16}" for x in sweep))
        grid = {}
        for st in sweep:
            a.stop = st
            by = defaultdict(list)
            for t in run(all_k, a):
                by[t["rule"]].append(t)
            for rule in RULES:
                grid[(rule, st)] = stats(by.get(rule, []))
        for rule in RULES:
            cells = ""
            for st in sweep:
                g = grid[(rule, st)]
                cells += f"{(f'{g['avg']:+.2f} ({g['stop']:.0f}%)' if g else 'n/a'):>16}"
            print(f"{rule:26}{cells}")
        print("Pick the stop where the rules you actually trade stay best; if the control R0 barely moves between stops, the stop is not what decides profit.")
    if a.out:
        with open(a.out, "w") as fh:
            json.dump(trades, fh)

if __name__ == "__main__":
    main()
