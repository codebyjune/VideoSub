import os
import sys

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
        wa, wb = a.split(), b.split()
        if len(wa) < 4 or len(wb) < 4:
            return False
        sa, sb = set(wa), set(wb)
        return len(sa & sb) / max(len(sa), len(sb)) >= threshold

    skipped_repetition = 0
    written = 0
    prev_text = ""
    with open(srt_filename, "w", encoding="utf-8") as f:
        for segment in segments:
            start = segment.get("start", 0)
            end = segment.get("end", 0)
            text = segment.get("text", "").strip()
            if not text:
                continue  # 跳过空段
            if is_repetition_hallucination(text):
                skipped_repetition += 1
                print(f"[跳过重复] {text[:80]}...")
                continue
            if is_near_duplicate(text, prev_text):
                skipped_repetition += 1
                print(f"[跳过跨窗口重复] {text[:80]}...")
                continue
            prev_text = text
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
