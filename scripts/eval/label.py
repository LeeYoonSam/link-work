#!/usr/bin/env python3
"""대화형 화자/전사 라벨링 도구 — 정답(ref)을 빠르게 만든다.

각 세그먼트의 구간 오디오를 바로 재생하고, 숫자 키로 화자를 지정하면 자동 저장된다.
앞부분만 라벨링하고 종료해도 그 구간만 평가되도록 eval_window를 기록한다(부분 라벨링).
외부 의존성 없음 — wave(구간 추출) + afplay(macOS 재생)만 사용.

사용법:
    python3 label.py --meeting 5            # 처음부터(또는 진행분 이어서)
    python3 label.py --meeting 5 --restart  # 진행분 버리고 처음부터
    python3 label.py --meeting 5 --max-play 12   # 구간 최대 재생 길이(초)

키:
    Enter   현재 화자 그대로 확정 → 다음
    1..9    해당 번호 화자로 지정 → 다음
    n       새 화자 이름 입력
    r       구간 다시 재생
    t       전사(text) 수정 (화자분리만 평가하면 생략 가능)
    x       이 세그먼트를 정답에서 제외
    b       이전 세그먼트
    g N     N번 세그먼트로 이동
    q       저장하고 종료 (라벨한 구간이 refs/meeting_<id>.json 으로 저장됨)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib import db, seglst  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
REFS_DIR = os.path.join(HERE, "refs")
OUT_DIR = os.path.join(HERE, "out")


def recordings_dir() -> str:
    return os.path.join(os.path.dirname(db.default_db_path()), "recordings")


def fmt_t(ms: int) -> str:
    s = ms / 1000.0
    return f"{int(s // 60):02d}:{s % 60:05.2f}"


class Player:
    """afplay 비동기 재생. 다음 재생/종료 시 이전 재생을 중단하고 임시파일 정리."""

    def __init__(self, wav_path: str, max_play_sec: float) -> None:
        self.wav_path = wav_path
        self.max_play_sec = max_play_sec
        self._proc: subprocess.Popen | None = None
        self._tmp: str | None = None
        with wave.open(wav_path, "rb") as w:
            self.fr = w.getframerate()
            self.nch = w.getnchannels()
            self.sw = w.getsampwidth()
            self.nframes = w.getnframes()

    def _extract(self, start_ms: int, end_ms: int) -> str:
        dur_ms = min(max(0, end_ms - start_ms), int(self.max_play_sec * 1000))
        start_f = min(int(start_ms / 1000 * self.fr), max(0, self.nframes - 1))
        n = int(dur_ms / 1000 * self.fr)
        with wave.open(self.wav_path, "rb") as w:
            w.setpos(start_f)
            frames = w.readframes(max(1, n))
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp.close()
        with wave.open(tmp.name, "wb") as o:
            o.setnchannels(self.nch)
            o.setsampwidth(self.sw)
            o.setframerate(self.fr)
            o.writeframes(frames)
        return tmp.name

    def play(self, start_ms: int, end_ms: int) -> None:
        self.stop()
        try:
            self._tmp = self._extract(start_ms, end_ms)
            self._proc = subprocess.Popen(
                ["afplay", self._tmp],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except Exception as e:  # noqa: BLE001
            print(f"  (재생 실패: {e})")

    def stop(self) -> None:
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.terminate()
            except Exception:  # noqa: BLE001
                pass
        self._proc = None
        if self._tmp and os.path.exists(self._tmp):
            try:
                os.unlink(self._tmp)
            except OSError:
                pass
        self._tmp = None


class Labeler:
    def __init__(self, meeting_id: int, max_play_sec: float, restart: bool) -> None:
        self.meeting_id = meeting_id
        self.out_dir = os.path.join(OUT_DIR, f"meeting_{meeting_id}")
        os.makedirs(self.out_dir, exist_ok=True)
        self.progress_path = os.path.join(self.out_dir, "label_progress.json")

        conn = db.connect()
        try:
            meeting = db.load_meeting(conn, meeting_id)
        finally:
            conn.close()
        self.title = meeting.title
        self.audio_path = os.path.join(recordings_dir(), meeting.audio_path or f"{meeting_id}.wav")

        if restart or not os.path.exists(self.progress_path):
            doc = seglst.from_meeting(meeting)
            self.segments = [
                {**s, "_status": "pending"} for s in doc.segments
            ]
            self.duration_ms = doc.duration_ms
            self.cursor = 0
        else:
            with open(self.progress_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.segments = data["segments"]
            self.duration_ms = data.get("duration_ms", 0)
            self.cursor = data.get("cursor", 0)

        # 화자 레지스트리(순서 보존): 가설 + 라벨 중 추가
        self.speakers: list[str] = []
        for s in self.segments:
            sp = s.get("speaker")
            if sp and sp not in self.speakers:
                self.speakers.append(sp)

        if not os.path.exists(self.audio_path):
            print(f"⚠ 오디오 파일이 없습니다: {self.audio_path}\n  화자는 텍스트만 보고 라벨해야 합니다.")
            self.player = None
        else:
            self.player = Player(self.audio_path, max_play_sec)

    # ── 저장 ──
    def save_progress(self) -> None:
        with open(self.progress_path, "w", encoding="utf-8") as f:
            json.dump(
                {"meeting_id": self.meeting_id, "duration_ms": self.duration_ms,
                 "cursor": self.cursor, "segments": self.segments},
                f, ensure_ascii=False, indent=2,
            )

    def export_ref(self) -> str:
        done = [s for s in self.segments if s.get("_status") == "done"]
        if not done:
            return ""
        clean = [{"start_ms": s["start_ms"], "end_ms": s["end_ms"],
                  "speaker": s["speaker"], "text": s.get("text", "")} for s in done]
        starts = [s["start_ms"] for s in done]
        ends = [s["end_ms"] for s in done]
        full = len(done) == len(self.segments)
        doc = seglst.EvalDoc(
            meeting_id=self.meeting_id,
            audio=os.path.basename(self.audio_path),
            duration_ms=self.duration_ms,
            segments=clean,
            eval_window=None if full else [min(starts), max(ends)],
        )
        os.makedirs(REFS_DIR, exist_ok=True)
        ref_path = os.path.join(REFS_DIR, f"meeting_{self.meeting_id}.json")
        seglst.save(doc, ref_path)
        return ref_path

    # ── 표시 ──
    def speaker_menu(self) -> str:
        return "  ".join(f"[{i + 1}]{name}" for i, name in enumerate(self.speakers))

    def show(self, idx: int) -> None:
        seg = self.segments[idx]
        done = sum(1 for s in self.segments if s.get("_status") == "done")
        bar = f"{done}/{len(self.segments)} 라벨됨"
        status = {"pending": "·", "done": "✓", "excluded": "✗"}.get(seg.get("_status", "pending"), "?")
        print("\n" + "─" * 70)
        print(f"[{idx + 1}/{len(self.segments)}] {status}  "
              f"{fmt_t(seg['start_ms'])}–{fmt_t(seg['end_ms'])}  "
              f"({(seg['end_ms'] - seg['start_ms']) / 1000:.1f}s)   {bar}")
        cur = seg.get("speaker", "?")
        cur_n = self.speakers.index(cur) + 1 if cur in self.speakers else "?"
        print(f"화자(현재): [{cur_n}] {cur}")
        print(f"전사: {seg.get('text', '').strip()}")
        print(f"화자목록: {self.speaker_menu()}   (n=새화자)")

    def set_speaker(self, seg: dict, name: str) -> None:
        if name not in self.speakers:
            self.speakers.append(name)
        seg["speaker"] = name
        seg["_status"] = "done"

    # ── 메인 루프 ──
    def run(self) -> None:
        print(f"\n▶ 라벨링 시작: meeting {self.meeting_id} 「{self.title}」 · "
              f"{len(self.segments)}개 세그먼트")
        print("  화자분리만 평가하려면 화자(숫자/Enter)만 지정하세요. 전사 평가는 t로 텍스트 수정.")
        print("  도중에 q로 종료해도 거기까지 저장됩니다(부분 라벨링).")

        i = self.cursor
        while 0 <= i < len(self.segments):
            self.cursor = i
            seg = self.segments[i]
            self.show(i)
            if self.player:
                self.player.play(seg["start_ms"], seg["end_ms"])

            try:
                cmd = input("명령 [Enter확정/숫자/n/r/t/x/b/g N/q] > ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                break

            if cmd == "":
                # 현재 화자 그대로 확정
                if seg.get("speaker"):
                    seg["_status"] = "done"
                i += 1
            elif cmd.isdigit():
                n = int(cmd)
                if 1 <= n <= len(self.speakers):
                    self.set_speaker(seg, self.speakers[n - 1])
                    i += 1
                else:
                    print(f"  화자 번호는 1~{len(self.speakers)} 입니다.")
            elif cmd == "n":
                name = input("  새 화자 이름 > ").strip()
                if name:
                    self.set_speaker(seg, name)
                    i += 1
            elif cmd == "r":
                if self.player:
                    self.player.play(seg["start_ms"], seg["end_ms"])
            elif cmd == "t":
                print(f"  현재 전사: {seg.get('text', '')}")
                new = input("  새 전사(Enter=유지) > ").strip()
                if new:
                    seg["text"] = new
                print("  (전사 수정됨. 화자도 지정해야 done 처리됩니다)")
            elif cmd == "x":
                seg["_status"] = "excluded"
                i += 1
            elif cmd == "b":
                i = max(0, i - 1)
            elif cmd.startswith("g"):
                parts = cmd.split()
                if len(parts) == 2 and parts[1].isdigit():
                    i = max(0, min(len(self.segments) - 1, int(parts[1]) - 1))
                else:
                    print("  사용법: g <번호>")
            elif cmd == "q":
                break
            else:
                print("  알 수 없는 명령. [Enter/숫자/n/r/t/x/b/g N/q]")

            self.save_progress()

        if self.player:
            self.player.stop()
        self.save_progress()
        ref_path = self.export_ref()
        done = sum(1 for s in self.segments if s.get("_status") == "done")
        print("\n" + "═" * 70)
        if ref_path:
            full = done == len(self.segments)
            print(f"✓ 정답 저장: {ref_path}")
            print(f"  라벨된 세그먼트 {done}개 · 화자 {len({s['speaker'] for s in self.segments if s.get('_status') == 'done'})}명"
                  f"{'' if full else ' · 부분 라벨링(eval_window 기록)'}")
            print(f"\n다음: python3 run_all.py --meeting {self.meeting_id} --no-summary")
        else:
            print("아직 done 처리된 세그먼트가 없어 정답을 저장하지 않았습니다.")
            print(f"진행분은 저장됨: {self.progress_path} (다시 실행하면 이어서)")


def main() -> int:
    ap = argparse.ArgumentParser(description="대화형 화자/전사 라벨링")
    ap.add_argument("--meeting", type=int, required=True)
    ap.add_argument("--max-play", type=float, default=15.0, help="구간 최대 재생 길이(초)")
    ap.add_argument("--restart", action="store_true", help="진행분 버리고 처음부터")
    args = ap.parse_args()

    labeler = Labeler(args.meeting, args.max_play, args.restart)
    labeler.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
