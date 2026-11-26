#!/usr/bin/env python3
"""화자 임베딩 모델 비교 벤치 — 앱과 같은 Electron 런타임·같은 cli 로 후보 모델을 돌려 비교한다.

앱 기본 모델·임계값은 바꾸지 않는다. 오디오는 로컬에서만 처리한다(외부 전송 없음).

사용:
    python3 diar_bench.py --models campplus,eres2netv2,wespeaker_r34lm \\
        --meetings 53,50,51,44,40,45,46 --mode label-free[,oracle,auto] [--chunk 200]

모델 이름 → 파일:
    campplus         <userData>/models/sherpa-embedding.onnx (앱 모델, diar-regress 기본값과 같은 위치)
    eres2netv2       scripts/eval/models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx
    wespeaker_r34lm  scripts/eval/models/wespeaker_en_voxceleb_resnet34_LM.onnx
  파일이 없으면 안내 후 그 모델만 건너뛴다(표에 'missing', 종료 코드 0 유지).

모드:
    label-free  정답 없이 비교: (a) 1on1(53·50·40·45·46) 최종 화자 수 = 2 (b) 53↔50 목소리 매칭 margin
                (c) 51 처리 시간(≤180초)·최대 창(≤2.25초) (d) CAM++ 대비 세그먼트 라벨 불일치율(헝가리안 매칭 후)
    auto        자동 화자 수 가설로 refs/meeting_<id>.json 이 있는 회의의 DER/JER(eval_diar.evaluate, collar 0.25)
    oracle      ref 화자 수를 --num 으로 넘겨 다시 돌린 가설의 DER/JER

순서: ① node scripts/diar-regress.mjs --only <ids> --model <path> --tag <name> --dump-hyp out/hyp --chunk <N>
      ② (auto·oracle) ref 가 있으면 DER  ③ out/diar_bench.md, out/diar_bench.json
탈락: 1on1 에서 2명이 아닌 회의 2건 이상, 51 처리 180초 초과, 크래시(cli 실패로 가설 없음).

--chunk: sherpa-onnx-node 가 창마다 네이티브 메모리를 돌려주지 않아(ERes2NetV2 약 8MB/창) 큰 모델이 긴 회의에서
죽는다. 그래서 창 임베딩을 N개씩 cli 자식 프로세스로 나눠 뽑는다(기본 200, 모든 모델에 같게). 처리 시간에 자식
기동·모델 로드가 더해지므로 (c) 시간은 앱 경로(나누지 않음)보다 약간 길게 나온다.

`python3 -I` 로도 동작한다(이 스크립트 디렉터리를 sys.path 에 명시적으로 넣는다).
"""
from __future__ import annotations

import argparse
import itertools
import json
import os
import shutil
import subprocess
import sys
import time
from typing import Any, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from lib import seglst  # noqa: E402
import eval_diar  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
REGRESS = os.path.join(REPO, "scripts", "diar-regress.mjs")
DEFAULT_CHUNK = 200
MODELS_DIR = os.path.join(HERE, "models")
OUT_DIR = os.path.join(HERE, "out")
HYP_DIR = os.path.join(OUT_DIR, "hyp")

ONE_ON_ONE = [53, 50, 40, 45, 46]
CROSS_PROBE, CROSS_PROFILE = 53, 50
LONG_MEETING = 51
LONG_MAX_SEC = 180.0
MAX_WINDOW_SEC = 2.25
BASELINE = "campplus"
MODES = ("label-free", "oracle", "auto")


def userdata_dir() -> str:
    return os.environ.get("LINKWORK_USERDATA") or os.path.expanduser("~/Library/Application Support/linkwork")


def model_paths() -> dict[str, str]:
    return {
        "campplus": os.path.join(userdata_dir(), "models", "sherpa-embedding.onnx"),
        "eres2netv2": os.path.join(MODELS_DIR, "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx"),
        "wespeaker_r34lm": os.path.join(MODELS_DIR, "wespeaker_en_voxceleb_resnet34_LM.onnx"),
    }


def find_node() -> str:
    for c in (os.environ.get("NODE"), shutil.which("node"), "/opt/homebrew/opt/node@22/bin/node", "/opt/homebrew/bin/node"):
        if c and os.path.exists(c):
            return c
    raise SystemExit("node 실행 파일을 찾지 못했습니다(NODE 환경 변수로 지정).")


def parse_ids(v: str) -> list[int]:
    ids: list[int] = []
    for p in v.split(","):
        p = p.strip()
        if not p:
            continue
        n = int(p)
        if n <= 0:
            raise ValueError(p)
        if n not in ids:
            ids.append(n)
    return ids


# ── 실행 ────────────────────────────────────────────────────────────────────

def run_regress(node: str, ids: list[int], model_path: str, tag: str, num: Optional[int] = None, chunk: int = 0) -> dict[str, Any]:
    """diar-regress 를 돌려 회의별 가설·통계를 읽는다. 종료 코드 1(단언 실패)은 정상 결과로 본다."""
    os.makedirs(HYP_DIR, exist_ok=True)
    for mid in ids:  # 이전 실행의 결과가 이번 것으로 오인되지 않게 지운다
        for kind in ("hyp", "stats"):
            p = os.path.join(HYP_DIR, f"{kind}_{mid}_{tag}.json")
            if os.path.exists(p):
                os.unlink(p)
    cmd = [node, REGRESS, "--only", ",".join(map(str, ids)), "--model", model_path, "--tag", tag, "--dump-hyp", HYP_DIR]
    if num:
        cmd += ["--num", str(num)]
    if chunk > 0:
        cmd += ["--chunk", str(chunk)]
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True)
    wall = time.time() - t0
    per: dict[int, dict[str, Any]] = {}
    for mid in ids:
        hp = os.path.join(HYP_DIR, f"hyp_{mid}_{tag}.json")
        sp = os.path.join(HYP_DIR, f"stats_{mid}_{tag}.json")
        if os.path.exists(hp) and os.path.exists(sp):
            with open(sp, "r", encoding="utf-8") as f:
                stats = json.load(f)
            per[mid] = {"hyp_path": hp, "stats": stats}
        else:
            per[mid] = {"hyp_path": None, "stats": None}
    return {
        "exit_code": proc.returncode,
        "wall_sec": round(wall, 1),
        "stdout": proc.stdout,
        "stderr_tail": "\n".join(proc.stderr.strip().splitlines()[-8:]),
        "meetings": per,
    }


# ── 지표 ────────────────────────────────────────────────────────────────────

def _l2(v: list[float]) -> list[float]:
    n = sum(x * x for x in v) ** 0.5 or 1.0
    return [x / n for x in v]


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def cross_margin(probe_voices: list[dict], profile_voices: list[dict]) -> Optional[dict[str, Any]]:
    """probe 주요 화자 2명 × profile 화자 최적 1:1 매칭(합 최대). margin = 최소 매칭 cos − 최대 교차 cos."""
    probe = sorted(probe_voices, key=lambda v: -v["speech_ms"])[:2]
    if len(probe) < 2 or len(profile_voices) < 2:
        return None
    P = [_l2(v["embedding"]) for v in probe]
    Q = [_l2(v["embedding"]) for v in profile_voices]
    S = [[_cos(p, q) for q in Q] for p in P]
    best = None
    for i in range(len(Q)):
        for j in range(len(Q)):
            if i != j and (best is None or S[0][i] + S[1][j] > best[0]):
                best = (S[0][i] + S[1][j], i, j)
    _, i, j = best
    matched = [S[0][i], S[1][j]]
    cross = [S[0][j], S[1][i]]
    return {
        "matched": [round(x, 4) for x in matched],
        "cross": [round(x, 4) for x in cross],
        "margin": round(min(matched) - max(cross), 4),
    }


def _assignment(weights: list[list[float]]) -> list[tuple[int, int]]:
    """가중치 합 최대 1:1 매칭(헝가리안). scipy 가 있으면 쓰고, 없으면 작은 행렬은 전수, 크면 탐욕."""
    n, m = len(weights), len(weights[0]) if weights else 0
    if n == 0 or m == 0:
        return []
    try:
        from scipy.optimize import linear_sum_assignment  # type: ignore

        r, c = linear_sum_assignment([[-w for w in row] for row in weights])
        return list(zip(r.tolist(), c.tolist()))
    except ImportError:
        pass
    if min(n, m) <= 8 and max(n, m) <= 9:
        best: tuple[float, list[tuple[int, int]]] = (-1.0, [])
        if n <= m:
            for perm in itertools.permutations(range(m), n):
                s = sum(weights[i][perm[i]] for i in range(n))
                if s > best[0]:
                    best = (s, [(i, perm[i]) for i in range(n)])
        else:
            for perm in itertools.permutations(range(n), m):
                s = sum(weights[perm[j]][j] for j in range(m))
                if s > best[0]:
                    best = (s, [(perm[j], j) for j in range(m)])
        return best[1]
    cells = sorted(((weights[i][j], i, j) for i in range(n) for j in range(m)), reverse=True)
    used_r: set[int] = set()
    used_c: set[int] = set()
    out = []
    for _, i, j in cells:
        if i not in used_r and j not in used_c:
            out.append((i, j))
            used_r.add(i)
            used_c.add(j)
    return out


def label_disagreement(base_path: str, cand_path: str) -> Optional[dict[str, Any]]:
    """같은 세그먼트 목록에 붙은 두 화자 라벨을 헝가리안 매칭한 뒤, 발화 시간 가중 불일치율과 구간 목록."""
    base = seglst.load(base_path).segments
    cand = seglst.load(cand_path).segments
    cand_by = {(s["start_ms"], s["end_ms"]): s["speaker"] for s in cand}
    pairs = []
    for s in base:
        key = (s["start_ms"], s["end_ms"])
        if key in cand_by:
            pairs.append((s["start_ms"], s["end_ms"], str(s["speaker"]), str(cand_by[key])))
    if not pairs:
        return None
    bl = sorted({p[2] for p in pairs})
    cl = sorted({p[3] for p in pairs})
    w = [[0.0] * len(cl) for _ in bl]
    total = 0.0
    for st, en, b, c in pairs:
        d = max(0, en - st)
        w[bl.index(b)][cl.index(c)] += d
        total += d
    mapping = {cl[j]: bl[i] for i, j in _assignment(w)}
    mismatches = []
    bad = 0.0
    for st, en, b, c in pairs:
        mapped = mapping.get(c)
        if mapped != b:
            bad += max(0, en - st)
            mismatches.append({"start_ms": st, "end_ms": en, "baseline": b, "candidate": c, "candidate_mapped": mapped})
    return {
        "segments": len(pairs),
        "mismatch_segments": len(mismatches),
        "rate_percent": round(bad / total * 100, 2) if total > 0 else 0.0,
        "mapping": mapping,
        "mismatches": mismatches,
    }


def der_for(mid: int, hyp_path: Optional[str]) -> Optional[dict[str, Any]]:
    ref_path = eval_diar.ref_path_for(mid)
    if not hyp_path or not os.path.exists(ref_path):
        return None
    ref = seglst.load(ref_path)
    hyp = seglst.apply_window(ref, seglst.load(hyp_path))
    return eval_diar.evaluate(ref, hyp, collar=0.25)


# ── 보고 ────────────────────────────────────────────────────────────────────

def fmt(v: Any, nd: int = 2) -> str:
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def build_markdown(report: dict[str, Any]) -> str:
    lines = ["# 화자 임베딩 모델 비교 (diar_bench)", ""]
    lines.append(f"- 회의: {', '.join(map(str, report['meetings']))}")
    lines.append(f"- 모드: {', '.join(report['modes'])}")
    lines.append(f"- 기준 모델: {BASELINE} (앱 기본). 앱 설정·임계값은 바꾸지 않는다.")
    chunk = report.get("chunk", 0)
    lines.append(f"- 창 임베딩 분할: {f'{chunk}창씩 자식 프로세스' if chunk else '나누지 않음(앱 경로)'}")
    lines.append("")
    if "label-free" in report["modes"]:
        lines += [
            "## 라벨 없는 지표",
            "",
            "| 모델 | 상태 | (a) 1on1 2명 | (b) 53↔50 margin | (c) 51 시간(s) | (c) 최대 창(s) | (d) CAM++ 대비 불일치(%) | 총 처리(s) | 판정 |",
            "|---|---|---|---|---|---|---|---|---|",
        ]
        for name, m in report["models"].items():
            if m["status"] != "ok":
                lines.append(f"| {name} | {m['status']} | - | - | - | - | - | - | - |")
                continue
            lf = m["label_free"]
            a = lf["one_on_one"]
            a_s = f"{a['ok']}/{a['total']}" if a["total"] else "-"
            b = lf["cross"]
            b_s = fmt(b["margin"], 3) if b else "-"
            c = lf["long"]
            d = lf["disagreement_overall_percent"]
            verdict = "탈락: " + "; ".join(m["dropped"]) if m["dropped"] else "통과"
            lines.append(
                f"| {name} | ok | {a_s} | {b_s} | {fmt(c['elapsed_sec'], 1) if c else '-'} | "
                f"{fmt(c['max_window_sec']) if c else '-'} | {fmt(d) if d is not None else '-'} | "
                f"{fmt(m['total_elapsed_sec'], 1)} | {verdict} |"
            )
        lines.append("")
        lines += ["### 회의별 최종 화자 수·처리 시간", "", "| 모델 | " + " | ".join(map(str, report["meetings"])) + " |",
                  "|---|" + "---|" * len(report["meetings"])]
        for name, m in report["models"].items():
            if m["status"] != "ok":
                continue
            cells = []
            for mid in report["meetings"]:
                st = m["per_meeting"].get(str(mid), {})
                if st.get("crash"):
                    cells.append("crash")
                else:
                    cells.append(f"{st.get('speakers_final', '-')}명 / {fmt(st.get('elapsed_sec'), 1)}s")
            lines.append(f"| {name} | " + " | ".join(cells) + " |")
        lines.append("")
    for mode in ("auto", "oracle"):
        if mode not in report["modes"]:
            continue
        lines += [f"## DER ({mode})", "", "| 모델 | 회의 | 정답 화자 | 가설 화자 | DER(%) | JER(%) |", "|---|---|---|---|---|---|"]
        any_row = False
        for name, m in report["models"].items():
            for mid, r in (m.get(mode) or {}).items():
                any_row = True
                lines.append(
                    f"| {name} | {mid} | {r.get('ref_speakers', '-')} | {r.get('hyp_speakers', '-')} | "
                    f"{fmt(r.get('der_percent'))} | {fmt(r.get('jer_percent'))} |"
                )
        if not any_row:
            lines.append("| - | refs/meeting_<id>.json 정답이 있는 회의가 없다 | - | - | - | - |")
        lines.append("")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="화자 임베딩 모델 비교 벤치(diar-regress 가설 + 라벨 없는 지표/DER)")
    ap.add_argument("--models", default="campplus,eres2netv2,wespeaker_r34lm")
    ap.add_argument("--meetings", default="53,50,51,44,40,45,46")
    ap.add_argument("--mode", default="label-free", help="label-free|oracle|auto (콤마로 여러 개)")
    ap.add_argument("--chunk", type=int, default=DEFAULT_CHUNK,
                    help=f"창 임베딩을 N개씩 자식 프로세스로 나눠 뽑는다(기본 {DEFAULT_CHUNK}, 0=나누지 않음). 모든 모델에 같게 적용")
    args = ap.parse_args()

    try:
        meetings = parse_ids(args.meetings)
    except ValueError:
        ap.error(f"--meetings 는 양의 정수 콤마 목록이어야 합니다: {args.meetings}")
    modes = [m.strip() for m in args.mode.split(",") if m.strip()]
    bad = [m for m in modes if m not in MODES]
    if bad or not modes:
        ap.error(f"--mode 는 {'|'.join(MODES)} 중에서: {args.mode}")
    paths = model_paths()
    names = [n.strip() for n in args.models.split(",") if n.strip()]
    unknown = [n for n in names if n not in paths]
    if unknown:
        ap.error(f"모르는 모델: {', '.join(unknown)} (가능: {', '.join(paths)})")

    node = find_node()
    if args.chunk < 0:
        ap.error(f"--chunk 는 0 이상의 정수여야 합니다: {args.chunk}")
    report: dict[str, Any] = {"meetings": meetings, "modes": modes, "chunk": args.chunk, "models": {}}
    runs: dict[str, dict[str, Any]] = {}

    for name in names:
        path = paths[name]
        if not os.path.exists(path):
            print(f"[diar_bench] {name}: 모델 파일 없음 → 건너뜀 ({path})", file=sys.stderr)
            report["models"][name] = {"status": "missing", "path": path}
            continue
        print(f"[diar_bench] {name}: diar-regress 실행 중 (회의 {','.join(map(str, meetings))})...", file=sys.stderr)
        run = run_regress(node, meetings, path, name, chunk=args.chunk)
        runs[name] = run
        entry: dict[str, Any] = {
            "status": "ok",
            "path": path,
            "regress_exit": run["exit_code"],
            "wall_sec": run["wall_sec"],
            # 회의별 단언 실패·cli 오류(stderr 꼬리) 줄 — 크래시 원인 확인용
            "regress_fail_lines": [ln for ln in run["stdout"].splitlines() if ln.startswith("  회의 ") or "FAIL" in ln],
        }
        if run["exit_code"] == 2:
            entry["status"] = "error"
            entry["error"] = run["stderr_tail"]
            print(f"[diar_bench] {name}: 준비물 없음\n{run['stderr_tail']}", file=sys.stderr)
        report["models"][name] = entry

    # ── 라벨 없는 지표 ──
    base_run = runs.get(BASELINE)
    for name, run in runs.items():
        entry = report["models"][name]
        if entry["status"] != "ok":
            continue
        per: dict[str, Any] = {}
        total_ms = 0
        crashes = []
        for mid in meetings:
            r = run["meetings"][mid]
            st = r["stats"]
            if st is None:
                per[str(mid)] = {"crash": True}
                crashes.append(mid)
                continue
            total_ms += int(st.get("elapsedMs") or 0)
            per[str(mid)] = {
                "crash": False,
                "speakers_final": st.get("speakersFinal"),
                "speakers_diarized": st.get("speakersDiarized"),
                "raw_clusters": st.get("rawClusters"),
                "windows": st.get("windows"),
                "max_window_sec": st.get("maxWindowSec"),
                "elapsed_sec": round((st.get("elapsedMs") or 0) / 1000, 1),
            }
        entry["per_meeting"] = per
        entry["total_elapsed_sec"] = round(total_ms / 1000, 1)
        dropped: list[str] = []
        if crashes:
            dropped.append(f"크래시(회의 {','.join(map(str, crashes))})")

        if "label-free" in modes:
            oo = [m for m in ONE_ON_ONE if m in meetings and not per[str(m)].get("crash")]
            not2 = [m for m in oo if per[str(m)].get("speakers_final") != 2]
            cross = None
            p, q = run["meetings"].get(CROSS_PROBE), run["meetings"].get(CROSS_PROFILE)
            if p and q and p["stats"] and q["stats"]:
                cross = cross_margin(p["stats"].get("voices") or [], q["stats"].get("voices") or [])
            long = None
            if LONG_MEETING in meetings and not per[str(LONG_MEETING)].get("crash"):
                lm = per[str(LONG_MEETING)]
                long = {
                    "elapsed_sec": lm["elapsed_sec"],
                    "max_window_sec": lm["max_window_sec"],
                    "elapsed_ok": lm["elapsed_sec"] <= LONG_MAX_SEC,
                    "window_ok": (lm["max_window_sec"] or 0) <= MAX_WINDOW_SEC,
                }
                if not long["elapsed_ok"]:
                    dropped.append(f"51 처리 {lm['elapsed_sec']}초 > {LONG_MAX_SEC:g}초")
            if len(not2) >= 2:
                dropped.append(f"1on1 2명 아님 {len(not2)}건({','.join(map(str, not2))})")
            disagree: dict[str, Any] = {}
            overall = None
            if base_run and name != BASELINE and report["models"].get(BASELINE, {}).get("status") == "ok":
                tot_bad = tot_all = 0.0
                for mid in meetings:
                    bp = base_run["meetings"][mid]["hyp_path"]
                    cp = run["meetings"][mid]["hyp_path"]
                    if not bp or not cp:
                        continue
                    d = label_disagreement(bp, cp)
                    if d is None:
                        continue
                    disagree[str(mid)] = d
                    seg_total = sum(max(0, s["end_ms"] - s["start_ms"]) for s in seglst.load(bp).segments)
                    tot_all += seg_total
                    tot_bad += d["rate_percent"] / 100 * seg_total
                overall = round(tot_bad / tot_all * 100, 2) if tot_all > 0 else None
            elif name == BASELINE:
                overall = 0.0
            entry["label_free"] = {
                "one_on_one": {"total": len(oo), "ok": len(oo) - len(not2), "not_two": not2},
                "cross": cross,
                "long": long,
                "disagreement_overall_percent": overall,
                "disagreement": {k: {kk: vv for kk, vv in v.items() if kk != "mismatches"} for k, v in disagree.items()},
            }
            entry["_mismatches"] = {k: v["mismatches"] for k, v in disagree.items()}
        entry["dropped"] = dropped

        # ── DER ──
        if "auto" in modes:
            entry["auto"] = {}
            for mid in meetings:
                r = der_for(mid, run["meetings"][mid]["hyp_path"])
                if r is not None:
                    entry["auto"][str(mid)] = r
        if "oracle" in modes:
            entry["oracle"] = {}
            for mid in meetings:
                ref_path = eval_diar.ref_path_for(mid)
                if not os.path.exists(ref_path):
                    continue
                num = seglst.load(ref_path).num_speakers
                if num < 1:
                    continue
                print(f"[diar_bench] {name}: 회의 {mid} oracle(--num {num}) 실행 중...", file=sys.stderr)
                orun = run_regress(node, [mid], entry["path"], f"{name}_oracle", num, chunk=args.chunk)
                r = der_for(mid, orun["meetings"][mid]["hyp_path"])
                if r is not None:
                    r["num"] = num
                    entry["oracle"][str(mid)] = r

    os.makedirs(OUT_DIR, exist_ok=True)
    md = build_markdown(report)
    full = json.loads(json.dumps(report))
    for name, m in full["models"].items():
        mm = m.pop("_mismatches", None)
        if mm is not None and "label_free" in m:
            for mid, lst in mm.items():
                m["label_free"]["disagreement"].setdefault(mid, {})["mismatches"] = lst
    with open(os.path.join(OUT_DIR, "diar_bench.json"), "w", encoding="utf-8") as f:
        json.dump(full, f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUT_DIR, "diar_bench.md"), "w", encoding="utf-8") as f:
        f.write(md)
    print(md)
    print(f"[diar_bench] 저장: {os.path.join(OUT_DIR, 'diar_bench.md')}, diar_bench.json", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
