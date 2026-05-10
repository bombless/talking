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

Open:

```text
http://127.0.0.1:3000/
```

For LAN testing, open `http://<this-machine-lan-ip>:3000/` from other devices.

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
