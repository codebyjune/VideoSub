import os
import sys
import math

# 强制 stdout 使用 UTF-8，避免 Windows GBK 编码错误
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import mlx_whisper

MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")


# faster-whisper 风格的模型名 -> mlx-whisper Hugging Face repo 名
MODEL_MAP = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "tiny.en": "mlx-community/whisper-tiny.en-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "base.en": "mlx-community/whisper-base.en-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "small.en": "mlx-community/whisper-small.en-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "medium.en": "mlx-community/whisper-medium.en-mlx",
    "large": "mlx-community/whisper-large-mlx",
    "large-v1": "mlx-community/whisper-large-v1-mlx",
    "large-v2": "mlx-community/whisper-large-v2-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
}


def resolve_model(model_size):
    """将用户输入的模型名转换为 mlx-whisper 可用的 repo 路径。"""
    if model_size in MODEL_MAP:
        return MODEL_MAP[model_size]
    # 如果用户直接传了完整 repo 路径或本地路径，则原样使用
    return model_size


def download_model(model_path):
    """预下载模型文件。优先查找本地 models/ 目录，不存在则尝试从 HF 下载。"""
    # 已经是本地绝对路径（macOS/Linux）/ 文件路径（无 /）则跳过下载
    if model_path.startswith("/") or "/" not in model_path:
        return  # 已是本地路径

    if not model_path.startswith("mlx-community/"):
        return  # 非 mlx-community repo 路径，不处理

    # 尝试本地 models/ 目录（手动 git clone 或 snapshot_download 下载的模型）
    repo_name = model_path.split("/", 1)[1] if "/" in model_path else model_path
    local_name = repo_name.replace("-mlx", "")
    local_path = os.path.join(MODELS_DIR, local_name)
    if os.path.isdir(local_path) and os.path.exists(os.path.join(local_path, "config.json")):
        print(f"✓ 使用本地模型: {local_path}")
        return local_path

    # 从 HF 下载
    from huggingface_hub import hf_hub_download, list_repo_files

    print("📥 正在下载模型文件...")
    try:
        files = list_repo_files(model_path)
    except Exception as e:
        print(f"⚠ 无法获取文件列表 ({e})，将交由 mlx-whisper 自动下载")
        return  # 失败时不打印完成

    model_files = [f for f in files if not f.startswith(".")]
    print(f"  共 {len(model_files)} 个文件")

    failed = 0
    for idx, filename in enumerate(model_files, 1):
        pct = int(idx * 100 / len(model_files))
        print(f"  [{pct}%] 下载: {filename}")
        try:
            hf_hub_download(
                repo_id=model_path,
                filename=filename,
                resume_download=True,
            )
        except Exception as e:
            print(f"  ⚠ {filename} 下载失败: {e}")
            failed += 1

    if failed == 0:
        print("✓ 模型下载完成")


def format_timestamp(seconds):
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds - int(seconds)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


# ─── 转录后补漏：检测 + 二次补录 + 合并 ───────────────────────────────────
GAP_THRESHOLD = 2.5        # 间隙≥2.5s 视为可疑遗漏
BACKFILL_CHUNK = 30.0      # 单次补录窗口上限（Whisper 单窗口即 30s）
LOGPROB_SURE = -0.8        # 前后段 avg_logprob ≥ 此值 → 确信有说话，间隙更可疑


def get_media_duration(video_file):
    """
    获取媒体总时长（秒）。
    依赖系统 ffprobe；未安装或失败时返回 None，调用方需自行处理。
    """
    try:
        import subprocess
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                video_file,
            ],
            stderr=subprocess.DEVNULL,
        )
        return float(out.decode().strip())
    except Exception:
        return None


def find_suspicious_gaps(segments, total_duration=None):
    """
    扫描 segment 时间轴，找出可疑的遗漏间隙。

    判定逻辑（logprob 加权）：
      - 时间间隔 ≥ GAP_THRESHOLD
      - 且 前后段 avg_logprob 较高（说明前后确实在说话，中间突然断了更可疑）

    total_duration 用于防止最后一个 segment 之后的时间被误判为遗漏
    （片尾静音不是遗漏）。若为 None 则仅检查 segment 之间的间隙。

    返回 [(gap_start, gap_end, score), ...]
        score ∈ [0,1]，越大越值得补录。
    """
    gaps = []
    n = len(segments)
    for i in range(n - 1):
        cur_end = segments[i].get("end", 0)
        nxt_start = segments[i + 1].get("start", 0)
        gap = nxt_start - cur_end
        if gap < GAP_THRESHOLD:
            continue

        # 前后段的置信度
        lp_before = segments[i].get("avg_logprob", float("nan"))
        lp_after = segments[i + 1].get("avg_logprob", float("nan"))
        if math.isnan(lp_before):
            lp_before = LOGPROB_SURE
        if math.isnan(lp_after):
            lp_after = LOGPROB_SURE

        # 两端都确信有说话 → 间隙可疑度最高
        sure = (lp_before >= LOGPROB_SURE) + (lp_after >= LOGPROB_SURE)
        # 时间因子：间隙越长越可疑（线性，封顶 1.0 @ 10s）
        time_factor = min(gap / 10.0, 1.0)
        score = (sure / 2.0) * 0.6 + time_factor * 0.4

        gaps.append((cur_end, nxt_start, score))

    # 片尾不补：结尾之后的静音不是遗漏（由调用方保证最后一个 segment
    #   已是真实内容，这里只处理 segment 之间的间隙）
    return gaps


def backfill_gap(video_file, model_path, gap_start, gap_end, lang="en"):
    """
    对单个可疑间隙做二次补录。

    使用 clip_timestamps 精确限定到 [gap_start, gap_end] 区间，
    采用更激进的 no_speech_threshold（0.3）捕获弱语音，
    关闭 condition_on_previous_text 避免被前文带偏，
    并启用 logprob / compression_ratio 防幻觉阈值。
    超过 30s 的间隙自动分块。
    """
    import mlx_whisper

    backfilled = []
    t = gap_start
    while t < gap_end - 0.05:
        chunk_end = min(t + BACKFILL_CHUNK, gap_end)
        try:
            res = mlx_whisper.transcribe(
                video_file,
                path_or_hf_repo=model_path,
                language=lang,
                temperature=0.0,
                no_speech_threshold=0.3,
                condition_on_previous_text=False,
                word_timestamps=True,
                clip_timestamps=[t, chunk_end],
                compression_ratio_threshold=2.4,
                logprob_threshold=-1.0,
                verbose=False,
            )
            for seg in res.get("segments", []):
                txt = seg.get("text", "").strip()
                if not txt:
                    continue
                # 校正：clip 内的 segment 时间戳已是绝对时间
                seg_start = seg.get("start", t)
                seg_end = seg.get("end", chunk_end)
                # 裁剪到 gap 范围内（防止模型把邻近内容带进来）
                if seg_end <= gap_start or seg_start >= gap_end:
                    continue
                seg_start = max(seg_start, gap_start)
                seg_end = min(seg_end, gap_end)
                backfilled.append({
                    "start": seg_start,
                    "end": seg_end,
                    "text": txt,
                    "avg_logprob": seg.get("avg_logprob", float("nan")),
                    "_backfilled": True,
                })
        except Exception as e:
            print(f"  ⚠ 补录 [{t:.1f}-{chunk_end:.1f}] 失败: {e}")
        t = chunk_end
    return backfilled


def merge_segments(original, backfilled, is_near_duplicate_fn):
    """
    把补录段合并进原 segment 列表：
      - 按 start 时间排序
      - 双重去重：
        1) 文本相似（复用 is_near_duplicate）
        2) 时间区间大量重叠（IoU ≥ 0.5）—— Whisper 常把同一句话
           转录成略微不同的文本，仅靠文本相似度抓不全。
      - 冲突时保留 avg_logprob 更高（更可信）的那条。
    """
    merged = list(original) + backfilled
    merged.sort(key=lambda s: s.get("start", 0))

    def _iou(a, b):
        as_, ae = a.get("start", 0), a.get("end", 0)
        bs, be = b.get("start", 0), b.get("end", 0)
        if ae <= as_ or be <= bs:
            return 0.0
        inter = min(ae, be) - max(as_, bs)
        union = max(ae, be) - min(as_, bs)
        return inter / union if union > 0 else 0.0

    deduped = []
    for seg in merged:
        txt = seg.get("text", "").strip()
        if not txt:
            continue
        # 与已收录的最近 2 条比较（前后邻居都可能重复）
        is_dup = False
        for i_prev, prev in enumerate(deduped[-2:]):
            if is_near_duplicate_fn(txt, prev.get("text", "")) or _iou(seg, prev) >= 0.5:
                # 保留更可信的（用替换而非原地修改，避免篡改 original）
                if seg.get("avg_logprob", -9) > prev.get("avg_logprob", -9):
                    actual_idx = len(deduped) - 2 + i_prev
                    deduped[actual_idx] = seg
                is_dup = True
                break
        if not is_dup:
            deduped.append(seg)
    return deduped
# ──────────────────────────────────────────────────────────────────────


def main():
    if len(sys.argv) < 2:
        print("用法: python main.py <video_path> [model_size]")
        print("  model_size: tiny.en, small.en, medium.en, large-v3, large-v3-turbo (默认: medium.en)")
        sys.exit(1)

    video_file = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "medium.en"

    if not os.path.exists(video_file):
        print(f"错误: 文件不存在: {video_file}")
        sys.exit(1)

    model_path = resolve_model(model_size)
    print(f"加载模型: {model_size} ({model_path})")

    # 预下载模型（优先本地 models/ 目录，否则从 HF 下载）
    local_path = download_model(model_path)
    if local_path:
        model_path = local_path

    # mlx-whisper 在 Apple Silicon 上自动使用 Metal 加速
    # no_speech_threshold=0.6（默认值）：原 0.3 过于激进，会把含背景音/停顿的真实语音
    #   误判为静音而整段跳过，是"偶尔漏几句话"的主因。
    # condition_on_previous_text=True：保留 30s 窗口之间的上下文，减少边界丢词；
    #   由此可能产生的跨窗口重复幻觉由下方 is_near_duplicate 过滤。
    result = mlx_whisper.transcribe(
        video_file,
        path_or_hf_repo=model_path,
        language="en",
        temperature=0.0,
        no_speech_threshold=0.6,
        condition_on_previous_text=True,
        word_timestamps=True,
        verbose=False,
    )

    detected_lang = result.get("language", "")
    print(f"转录完成！检测到语言: {detected_lang or 'en'}")

    srt_filename = os.path.splitext(video_file)[0] + ".srt"

    segments = result.get("segments", [])

    def is_repetition_hallucination(text, max_repeat=5):
        words = text.strip().rstrip(".").split()
        if not words:
            return False
        counts = {}
        for w in words:
            w_clean = w.rstrip(".,;:!?")
            counts[w_clean] = counts.get(w_clean, 0) + 1
        return any(c >= max_repeat for c in counts.values())

    def is_near_duplicate(text, prev_text, threshold=0.9):
        """检测跨 30s 窗口的重复幻觉（condition_on_previous_text=True 时偶发）。"""
        if not prev_text:
            return False
        a = text.lower().strip().rstrip(".,;:!?")
        b = prev_text.lower().strip().rstrip(".,;:!?")
        if not a or not b:
            return False
        if a == b:
            return True
        def _strip_punct(ws):
            return [w.rstrip(".,;:!?") for w in ws]
        wa, wb = _strip_punct(a.split()), _strip_punct(b.split())
        if len(wa) < 4 or len(wb) < 4:
            return False
        sa, sb = set(wa), set(wb)
        return len(sa & sb) / max(len(sa), len(sb)) >= threshold

    # 先过滤掉重复幻觉段，得到干净的初始 segment 列表
    clean_segments = []
    skipped_repetition = 0
    prev_text = ""
    for segment in segments:
        text = segment.get("text", "").strip()
        if not text:
            continue
        if is_repetition_hallucination(text):
            skipped_repetition += 1
            print(f"[跳过重复] {text[:80]}...")
            continue
        if is_near_duplicate(text, prev_text):
            skipped_repetition += 1
            print(f"[跳过跨窗口重复] {text[:80]}...")
            continue
        prev_text = text
        clean_segments.append(segment)

    print(f"初始转录段: {len(clean_segments)} 条（跳过重复 {skipped_repetition} 条）")

    # ─── 转录后补漏：检测可疑间隙并二次补录 ─────────────────────────────
    total_duration = get_media_duration(video_file)
    if total_duration is None:
        print("⚠ 未获取到媒体总时长（ffprobe 不可用），仍可继续补漏")
    gaps = find_suspicious_gaps(clean_segments, total_duration)
    if gaps:
        print(f"\n🔎 检测到 {len(gaps)} 个可疑遗漏间隙（≥{GAP_THRESHOLD}s）:")
        for gs, ge, sc in gaps:
            print(f"   [{format_timestamp(gs)} → {format_timestamp(ge)}] "
                  f"时长 {ge-gs:.1f}s  可疑度 {sc:.2f}")

        all_backfilled = []
        for idx, (gs, ge, sc) in enumerate(gaps, 1):
            # 零门槛全补：对所有 ≥2.5s 间隙都补录，追求最高覆盖率
            print(f"   [{idx}] 补录中...")
            bf = backfill_gap(video_file, model_path, gs, ge, lang="en")
            if bf:
                print(f"        ✓ 补回 {len(bf)} 段:")
                for b in bf:
                    print(f"          [{format_timestamp(b['start'])} → "
                          f"{format_timestamp(b['end'])}] {b['text'][:60]}")
                all_backfilled.extend(bf)
            else:
                print(f"        - 该间隙无语音（确属静音）")

        if all_backfilled:
            clean_segments = merge_segments(
                clean_segments, all_backfilled, is_near_duplicate
            )
            print(f"\n✅ 补漏完成：新增 {len(all_backfilled)} 段，"
                  f"合并后共 {len(clean_segments)} 段")
    else:
        print("\n✓ 未检测到可疑遗漏间隙")

    # ─── 输出 SRT ──────────────────────────────────────────────────────
    written = 0
    with open(srt_filename, "w", encoding="utf-8") as f:
        for segment in clean_segments:
            start = segment.get("start", 0)
            end = segment.get("end", 0)
            text = segment.get("text", "").strip()
            if not text:
                continue
            # 过滤掉纯标点/无意义残留（如 "."、"..."、"嗯." 等）
            if not any(c.isalnum() for c in text):
                continue
            written += 1
            f.write(f"{written}\n")
            f.write(f"{format_timestamp(start)} --> {format_timestamp(end)}\n")
            f.write(f"{text}\n\n")

            print(f"[{format_timestamp(start)} --> {format_timestamp(end)}] {text}")

    print(f"\n✅ 字幕文件已保存：{srt_filename}")
    if skipped_repetition > 0:
        print(f"   跳过重复幻觉段: {skipped_repetition} 条")
    # 标记输出，方便 Electron 解析
    print(f"SRT_OUTPUT:{os.path.abspath(srt_filename)}")


if __name__ == "__main__":
    main()
