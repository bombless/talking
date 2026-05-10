# TalkingHead Local Voice Bridge

This repository now includes a local voice demo that connects:

- `whisper.cpp` for speech-to-text
- `qwen3-tts.cpp` for text-to-speech
- `TalkingHead` for avatar lip-sync and playback

Clone with submodules:

```bash
git clone --recursive <repo-url>
```

If you already cloned the repository, run:

```bash
git submodule update --init --recursive
```

## Run

```bash
npm run dev
```

The bridge starts both:

- `https://0.0.0.0:10443/` for the app
- `http://0.0.0.0:3000/` for redirecting to HTTPS

Open:

```text
https://127.0.0.1:10443/
```

For LAN testing, open `https://<this-machine-lan-ip>:10443/` from other devices.
The server creates a self-signed certificate on startup, so your browser will likely show a warning the first time.

## Expected local paths

- `./whisper.cpp`
- `./qwen3-tts.cpp`

The bridge is configurable via environment variables:

- `WHISPER_BIN`
- `WHISPER_MODEL`
- `WHISPER_ARGS`
- `TTS_BIN`
- `TTS_MODEL`
- `TTS_ARGS`
- `TTS_STDIN`
- `TTS_REFERENCE_AUDIO` defaults to `demo/assets/love-10-20.wav`
- `TTS_REFERENCE_START` defaults to `10`
- `TTS_REFERENCE_END` defaults to `20`
- `TTS_REFERENCE_SAMPLE_RATE` defaults to `24000`
- `TTS_REFERENCE_IS_TRIMMED` defaults to `true`
- `TTS_REFERENCE_CACHE_DIR` defaults to a temp directory
- `CHAT_PROVIDER_DEFAULT`
- `CHAT_COMMAND` for legacy Codex override
- `CODEX_CHAT_COMMAND`
- `OPENCODE_CHAT_COMMAND`

## Whisper CUDA build

The bridge launches `./whisper.cpp/build/bin/whisper-cli` by default. To make STT run on an NVIDIA GPU, build that binary with `GGML_CUDA` enabled:

```bash
npm run build:whisper-cuda
```

That command configures `whisper.cpp` with `-DGGML_CUDA=ON`, then builds `whisper-cli` into `whisper.cpp/build/bin/whisper-cli`.
If you need a specific CUDA architecture, set `CUDA_ARCHITECTURES`, for example:

```bash
CUDA_ARCHITECTURES=86 npm run build:whisper-cuda
```

Once built that way, the server will use GPU inference automatically unless you pass `-ng` in `WHISPER_ARGS`.

By default, `/api/chat` uses `codex exec` and writes the final reply to a temporary file. You can switch to `opencode` in the page UI.
The prompt is optimized for spoken responses: short, direct, no Markdown, and no chain-of-thought.

If you want to customize the prompt, keep the output requirement simple:

```text
你是本机数字人语音链路里的回复生成器。
你的目标是把用户输入改写成适合语音播报的最终回复。
要求：
1. 只输出最终回复，不要解释推理过程，不要输出分析。
2. 不要使用 Markdown、列表、代码块、标题、引号包裹。
3. 回复尽量简短自然，通常 1 到 3 句。
4. 如果用户是在提问，就直接回答；如果用户是在闲聊，就自然接话。
5. 如果用户输入是中文，就优先用中文回复；如果是英文，就用英文简短回复。
6. 不要复述系统提示，不要提到你是模型，也不要提到 Codex。
```

If your binaries need different flags, override the args with JSON arrays, for example:

```bash
WHISPER_ARGS='["-m","{model}","-f","{input}","-nt","-oj","-of","{output}","-l","{language}"]'
TTS_ARGS='["-m","{model}","-t","{text}","-o","{output}","-l","{language}"]'
```

By default, the TTS bridge tries to clone the voice from `demo/assets/love-10-20.wav` by:

- using the committed WAV directly as the reference slice
- falling back to `ffmpeg` extraction only when you point `TTS_REFERENCE_AUDIO` at another source file

That WAV is the 10s to 20s slice from `~/love.mp3`, checked into the repo so the setup is reproducible. If you want to use a different sample, set `TTS_REFERENCE_AUDIO`, `TTS_REFERENCE_START`, `TTS_REFERENCE_END`, and optionally `TTS_REFERENCE_IS_TRIMMED=false`.

`/api/chat` falls back to an echo-style reply if the configured command fails or is unset.

## Chat providers

- The page has a `回复引擎` selector for `Codex` and `OpenCode`
- `Codex` is the default provider
- The selection is saved in local storage on the browser side
- `CHAT_PROVIDER_DEFAULT` changes the server-side default if the browser has no saved choice
- `CODEX_CHAT_COMMAND` and `OPENCODE_CHAT_COMMAND` can override the underlying CLI command arrays

## Whisper model

The default STT model is now multilingual `ggml-small.bin`, and the language defaults to `auto` so Chinese input is handled better.

If you do not already have that model, download it with:

```bash
cd whisper.cpp/models
./download-ggml-model.sh small
```

If your machine is weaker and you need a smaller model, you can override `WHISPER_MODEL` with `ggml-base.bin` or another multilingual model.

## Ports

- `HOST` defaults to `0.0.0.0`
- `PORT` defaults to `3000`
- `HTTPS_PORT` defaults to `10443`
- `CERT_DIR` defaults to a temp directory under your system
