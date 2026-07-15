# VideoSub

下载视频 → Whisper 转录英文字幕 → DeepSeek 翻译中文 → 硬嵌入视频，一站式桌面工具。

Download → Transcribe → Translate → Burn subtitles, all-in-one desktop tool.

![](https://img.shields.io/badge/platform-macOS-blue)
![](https://img.shields.io/badge/license-MIT-green)

## 功能 / Features

- **视频下载** — 基于 yt-dlp，支持 YouTube 等主流视频网站
- **Whisper 转录** — 本地运行 [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper)，支持 tiny.en ~ large-v3 多档模型，Apple Silicon (Metal) 自动加速
- **DeepSeek 翻译** — 字幕逐条翻译为中文，自动分批 + 降级重试，保证 1:1 行数对齐
- **硬嵌入字幕** — 可选，翻译完成后用 FFmpeg 将双语字幕直接烧录进视频画面
- **暗色主题** — 自动跟随系统，也可手动切换

## 安装 / Setup

### 前置依赖 / Prerequisites

- [Python 3.10+](https://www.python.org/) + [uv](https://docs.astral.sh/uv/)
- [Node.js 18+](https://nodejs.org/)
- [FFmpeg](https://ffmpeg.org/)（macOS 可通过 `brew install ffmpeg` 安装）
- Apple Silicon Mac（M1/M2/M3/M4 系列），用于 mlx-whisper 本地转录加速
- yt-dlp 可执行文件（开发/打包时放在 `bin/` 目录中）

### 步骤 / Steps

```bash
# 1. 克隆仓库
git clone https://github.com/codebyjune/videosub.git
cd videosub

# 2. 安装 Python 依赖（uv 自动管理虚拟环境）
uv sync

# 3. 安装 Electron 依赖
cd electron-app
npm install

# 4. 确保 yt-dlp 和 FFmpeg 可用
#    FFmpeg: brew install ffmpeg
#    yt-dlp: https://github.com/yt-dlp/yt-dlp/releases
#    将 yt-dlp 可执行文件放入 bin/ 目录（打包时同理）

# 5. 启动
npm start
```

### 获取 DeepSeek API Key / Get API Key

1. 访问 [platform.deepseek.com](https://platform.deepseek.com/)
2. 注册并充值（最低 $2）
3. 在 API Keys 页面创建 key，粘贴到应用中的输入框

## 使用 / Usage

1. 填入视频链接（YouTube / 直链均可）
2. 选择 Whisper 模型大小（越大越准但越慢）
3. 填入 DeepSeek API Key
4. （可选）勾选 "硬嵌入字幕到视频"
5. 点击 **Start**

生成的 SRT 字幕和视频文件在 `downloads/` 目录下。

## 架构 / Architecture

```
videosub/
├── main.py                  # Python: mlx-whisper 转录脚本
├── pyproject.toml           # Python 项目配置 (uv)
├── bin/                     # 预置二进制文件（需自行下载/安装）
│   ├── yt-dlp*              #   视频下载
│   ├── ffmpeg*              #   字幕烧录（也可直接使用系统 PATH 中的 ffmpeg）
│   ├── ffplay*
│   └── ffprobe*
├── downloads/               # 输出目录（自动创建）
└── electron-app/
    ├── main.js              # Electron 主进程 — 流程编排
    ├── preload.js           # contextBridge — IPC 桥梁
    ├── renderer.js          # 渲染进程 — UI 逻辑
    ├── index.html           # 界面布局
    ├── style.css            # 样式（暗色/亮色主题）
    └── package.json
```

### 数据流 / Data Flow

```
UI (index.html)
  │ 用户点击 Start
  ▼
renderer.js ──IPC──▶ main.js
                        │
                        ├─ 1. spawn yt-dlp     → 下载视频
                        ├─ 2. spawn python     → mlx-whisper 转录 → .srt
                        ├─ 3. call DeepSeek API → 翻译 → .zh.srt
                        └─ 4. spawn ffmpeg     → 硬嵌入 → _subtitled.mp4
                        │
                        ◀── IPC 实时推送日志/进度 ──
  ▼
UI 更新 logBox + progressBar
```

## License

MIT © [codebyjune](https://github.com/codebyjune)
