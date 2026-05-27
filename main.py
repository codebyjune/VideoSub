from faster_whisper import WhisperModel
import os
import sys

# 强制 stdout 使用 UTF-8，避免 Windows GBK 编码错误
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


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

    # 自动检测设备（用 ctranslate2 而不是 torch，因为 torch 可能是 CPU 版）
    device = "cuda"
    compute_type = "float16"
    try:
        from ctranslate2 import get_cuda_device_count
        if get_cuda_device_count() == 0:
            device = "cpu"
            compute_type = "int8"
    except ImportError:
        device = "cpu"
        compute_type = "int8"

    print(f"加载模型: {model_size} | 设备: {device}")
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    segments, info = model.transcribe(
        video_file,
        language="en",
        beam_size=5,
        vad_filter=True,
        word_timestamps=True
    )

    print(f"转录完成！语言: {info.language} | 置信度: {info.language_probability:.2f}")

    srt_filename = os.path.splitext(video_file)[0] + ".srt"

    with open(srt_filename, "w", encoding="utf-8") as f:
        for i, segment in enumerate(segments, start=1):
            start = segment.start
            end = segment.end
            text = segment.text.strip()

            f.write(f"{i}\n")
            f.write(f"{format_timestamp(start)} --> {format_timestamp(end)}\n")
            f.write(f"{text}\n\n")

            print(f"[{format_timestamp(start)} --> {format_timestamp(end)}] {text}")

    print(f"\n✅ 字幕文件已保存：{srt_filename}")
    # 标记输出，方便 Electron 解析
    print(f"SRT_OUTPUT:{os.path.abspath(srt_filename)}")


def format_timestamp(seconds):
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds - int(seconds)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


if __name__ == "__main__":
    main()
