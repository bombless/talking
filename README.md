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
- `CHAT_COMMAND`

If your binaries need different flags, override the args with JSON arrays, for example:

```bash
WHISPER_ARGS='["-m","{model}","-f","{input}","-nt","-oj","-of","{output}","-l","{language}"]'
TTS_ARGS='["-m","{model}","-t","{text}","-o","{output}","-l","{language}"]'
```

`/api/chat` falls back to an echo-style reply unless `CHAT_COMMAND` is set.

## Ports

- `HOST` defaults to `0.0.0.0`
- `PORT` defaults to `3000`
- `HTTPS_PORT` defaults to `10443`
- `CERT_DIR` defaults to a temp directory under your system
