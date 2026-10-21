# Gemini Audio

A separate Electron desktop app. The existing extension is unchanged.

**Translate my voice** and **Translate listening audio** each have their own Start/Stop button and target language. Both start in **normal audio** mode. Hindi is the default target for both directions; source language is detected automatically.

## Run

From this folder, with Node 22.12 or newer:

```sh
npm ci
npm start
```

On Linux, Automatic first tries PulseAudio/PipeWire Pulse through `pactl`, then native PipeWire through `pw-loopback` and `pw-dump`. Missing `pactl` no longer prevents the native backend from starting. `wpctl` is an optional WirePlumber check, not a cable-creation tool. Electron and the meeting browser must be able to enumerate the virtual endpoints; ordinary Chromium setups still need PulseAudio or `pipewire-pulse` for that access. Every launch removes the app's old virtual devices and creates fresh ones, including matching leftovers from an interrupted run. Closing the app removes them again. Unrelated virtual cables and system defaults are left alone. If setup fails, use **Set up audio** or **Settings → Virtual devices → Repair / refresh audio**.

1. Open **Settings → Gemini**, follow the larger setup instructions, enter your Gemini API key, and save.
2. Keep the physical microphone and listening-device selectors on Automatic, or choose your headset manually.
3. In Meet, select **GeminiMic** as microphone and **GeminiSpeaker** as speaker.
4. Leave the app open. Press either translation Start button as needed.

Use headphones to avoid acoustic echo. Closing the app ends audio routing and removes its Linux virtual devices; switch Meet back to your physical devices afterward. The app does not run a separate backend or need the extension.

## Audio behavior

| Direction | Translation off | Translation on |
| --- | --- | --- |
| My voice | Physical microphone → GeminiMic → meeting | Physical microphone → Gemini → GeminiMic → meeting |
| Listening | Meeting → GeminiSpeaker → physical output | Meeting → GeminiSpeaker → Gemini → physical output |

Original audio continues while Gemini connects or reconnects. Once connected, that direction plays translated audio only. Stop immediately restores original audio and clears translated playback. The other direction is unaffected. A silence timeout or unrecoverable provider failure also restores normal audio.

Only active translation sends audio to Gemini. Normal mode uses no Gemini connection. There are no transcripts, recordings, analytics, usage dashboards or automatic provider/model fallbacks in the app.

## Settings

Choose **System**, **Light** or **Dark** in the header. The choice is saved and changes appearance without stopping translation. Text, setup instructions and device labels are larger in both themes.

Settings has three keyboard-accessible tabs: **Gemini**, **Audio tuning**, and **Virtual devices**.

**Settings → Virtual devices → Audio backend** provides:

- **Automatic**: try usable managed Linux backends in order, including fallback when setup fails. On macOS/Windows use installed virtual cables.
- **PulseAudio / PipeWire Pulse (pactl)**: the existing managed backend.
- **Native PipeWire / WirePlumber (without pactl)**: create two isolated virtual cables using `pw-loopback`; inspect devices/defaults using `pw-dump`. `wpctl` is checked when present.
- **Existing virtual cables**: browser/OS audio with four explicitly mapped endpoints. On macOS this uses CoreAudio-accessible devices; on Windows it uses Windows audio devices. Driver installation/removal is not managed.

**Check selected** checks one backend; **Check all backends** checks each sequentially and reports missing commands, server access and mapping status, with setup guidance. Neither sends audio or stops active translation. Dependency availability is distinct from routing success. **Use selected & test routing** saves the selected backend, creates its devices and checks both local capture/playback routes. It stops translation and restores normal mode. If a managed setup fails, the app attempts to restore the previous backend. Checks do not prove that sound is physically audible or that translation is linguistically correct.

Select the backend before a call. Switching/rebuilding virtual devices can invalidate the meeting's open streams; reselect GeminiMic and GeminiSpeaker afterward. External mapping can be configured and checked before applying it. Installation guidance never runs privileged package-manager commands automatically.

On Ubuntu the native tools are normally in `pipewire-bin`; Fedora uses `pipewire-utils`. The Pulse tool is in `pulseaudio-utils`. If all usable tools/services are absent, the app reports this instead of claiming a working fallback. See the dependency references in COMPATIBILITY.md.

Three additional health checks are available:

- **Settings → Gemini → Check connection** checks the entered API key, endpoint and model without saving the draft or sending audio. It leaves active translation running.
- **Test with sample** under either translation control sends a short fixed English phrase to Gemini using that direction's saved target language, then plays the translated result on your selected physical listening device. It uses Gemini audio and can be cancelled. Test playback never enters GeminiMic. The check verifies returned audio and local playback, not linguistic accuracy or the physical loudness of your headphones.
- **Check devices**, available beside the Meet setup and inside **Settings → Virtual devices**, checks all four virtual endpoints and both physical routes. Missing endpoints are named; **Repair / refresh audio** rebuilds an incomplete graph.

The sample test has its own temporary session, explicitly ends the audio input and closes the connection when finished or cancelled. A bounded drain also handles providers that keep generating background audio. The sample requires no live microphone recording.

| Setting | Default |
| --- | --- |
| Model | `gemini-3.5-live-translate-preview` |
| Gemini base URL | `https://generativelanguage.googleapis.com` |
| API key | Empty; enter in Settings |
| Voice / listening targets | Hindi / Hindi, independently editable |
| Audio backend | Automatic, with managed Linux fallback |
| Appearance | System; Light and Dark overrides available |
| Source language | Automatic; the dedicated translation model has no manual source-language parameter |
| Send interval | 40 ms |
| Playback buffer | 60 ms |
| Maximum queued audio | 1500 ms |
| Silence timeout | 0 seconds, disabled; applied independently |
| Echo speech already in target language | Enabled |

Preferences persist locally. Connection and tuning changes stop translation and keep normal routing active. Changing one target or physical device stops only its translation direction. A missing explicitly selected device pauses that route until it is reconnected or replaced; Automatic follows safe physical defaults. The app never chooses its own virtual endpoints as physical devices.

The interval and queue settings do not promise a particular end-to-end latency. Input is converted from the negotiated device format to 16 kHz mono PCM; returned PCM is played at its declared rate. Playback and WebSocket queues are bounded and old audio is discarded rather than replayed after a disconnect. Each direction has at most three reconnect attempts. Long sessions can have an audible normal-audio interval during provider session renewal.

The API key stays in Electron's main process. It is saved separately using the OS keyring when available; Linux's insecure `basic_text` fallback is refused. Without a secure keyring the key stays in memory for the app session. **Forget key** stops both translations and deletes the saved credential. The app does not read or copy the parent project's `.env` file.

## Platform support

| Platform | Current implementation / verification |
| --- | --- |
| Linux x64 | Automatic device creation, repair and cleanup with Pulse and native PipeWire backends. A real Electron integration test also passes with pactl deliberately unavailable. Tested here on Fedora 44 KDE Wayland, through native Wayland and X11/XWayland, with PipeWire 1.6.8 and Electron 44.9.3. |
| Windows | External two-cable mapping is implemented in Settings. Native driver installation, hardware behavior and the Windows build are unverified here. |
| macOS | External two-cable mapping is implemented in Settings. Native driver installation, hardware behavior and the macOS build are unverified here. |

See [COMPATIBILITY.md](../COMPATIBILITY.md) for the tested scope, Ubuntu requirements and work needed for macOS and broader device support. GitHub Actions builds Linux x64 AppImage, Windows x64 EXE and Intel/Apple Silicon macOS DMGs. Building an installer does not establish hardware audio compatibility.

On Windows/macOS, install **two independent virtual cables**, then map their playback/capture endpoints under **Settings → Virtual devices**. The app shows the actual meeting-facing labels below its translation controls. Exact `GeminiMic` / `GeminiSpeaker` names depend on OS/driver renaming; this app does not ship custom signed Windows/macOS audio drivers.

For Windows, [VB-CABLE A+B](https://vb-audio.com/Cable/) provides independent A and B cables and requires its own license/download. Cable A playback goes in “Outgoing cable · app playback output”; Cable A recording goes in “Outgoing cable · meeting microphone”. Cable B playback goes in “Incoming cable · meeting speaker”; Cable B recording goes in “Incoming cable · app capture input”. Rename the meeting-facing endpoints to GeminiMic and GeminiSpeaker in Windows sound settings if supported.

For macOS, two separate [BlackHole](https://github.com/ExistentialAudio/BlackHole) devices can provide the two buses; custom small-channel devices avoid unsupported multichannel behavior in meeting apps. A mirrored device is **not** an independent second cable. Custom names/builds require driver work, signing/notarization and appropriate licensing. Third-party drivers are not bundled or modified by this project. Select each cable's matching output/input pair in the four mapping fields.

Bluetooth profile changes, permission restrictions and exclusive-use hardware can temporarily interrupt audio. Devices with no usable input/output cannot be made compatible by the app. Physical Bluetooth/headset coverage and Windows/macOS compatibility remain to be checked on their actual hardware.

## Packaging

```sh
npm run pack          # release/linux-unpacked/ on Linux
npm run dist          # Linux x64 AppImage
npm run dist:windows  # run on a Windows build machine
npm run dist:mac      # run on a macOS build machine
```

The Linux release is an AppImage. Make it executable and launch it; `npm run pack` also produces an unpacked app. The runtime dependency is `ws`. Test fixtures, reports, credentials, `.env` files and the parent extension are excluded from the packaged app. Windows/macOS distribution additionally needs platform testing and signing credentials.

## Verification

```sh
npm test
npm run test:desktop                    # X11 / XWayland
node tests/desktop.mjs --wayland --no-pactl # native PipeWire fallback, no pactl in app
node tests/package-smoke.mjs --wayland --no-pactl # actual packaged app PATH lacks pactl; sandbox enabled
```

The desktop check needs Linux `pactl`, `ffmpeg`, a display and no other running Gemini Audio instance. It uses real Electron and real virtual audio devices with synthetic input/output devices and a local simulated Gemini server. It does not change OS defaults. Its isolated Electron test process disables the sandbox for automation; the normal app keeps the sandbox enabled.

The check measures distinct tones at both audio endpoints to detect cross-routing, original/translated mixing and Stop failures. It also checks a 44.1 kHz mono device switch, unplug recovery, independent silence stopping, idempotent repair and exit cleanup. Screenshots and the JSON report are written under `test-artifacts/`.

Optional **paid** Gemini check, requiring `espeak-ng` and `ffmpeg`:

```sh
node tests/live-check.mjs --env /path/to/private.env
```

The private file supplies `GEMINI_API_KEY` and optionally `GEMINI_BASE_URL`. This streams a short locally synthesized English phrase through each direction's real Gemini adapter, configured for Hindi. Outputs and a report are saved under `test-artifacts/live/`. Receiving audio verifies the transport/configuration, not translation accuracy or acoustic quality across all devices.

The completed checks and the remaining user-run Meet steps are recorded in [VERIFICATION.md](../VERIFICATION.md).

## Code map

- `main/application.mjs`: Electron window, narrow IPC bridge and permissions.
- `main/backends.mjs`: backend detection, dependency reports, selection and automatic fallback.
- `main/pipewire.mjs`: native PipeWire cable helpers, inventory and owned-process recovery.
- `main/routing.mjs`: Linux virtual device lifecycle; external-device platform status.
- `main/gemini.mjs`: independent main-process Gemini sessions and bounded transport.
- `main/store.mjs`: validated preferences and OS-protected credentials.
- `renderer/route.js`: persistent audio passthrough and translation switching.
- `renderer/devices.js`: safe physical selection and virtual endpoint mapping.
- `renderer/pcm.js`, `capture.js`: framing/resampling and bounded playback scheduling.
- `renderer/app.js`: single-window controls and device recovery.

The streaming resampler, playback overflow approach and Gemini setup were adapted from the earlier extension project. The Electron app is self-contained and does not require those original source files. Their Chrome-specific lifecycle and UI were not carried across.

Protocol and platform references: [Gemini Live Translation](https://ai.google.dev/gemini-api/docs/live-api/live-translate), [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [Electron protocol](https://www.electronjs.org/docs/latest/api/protocol).
