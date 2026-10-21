# Verification — 21 October 2026

The automated local tests use synthetic speech or tones. They do not represent an authenticated Meet call or a hardware compatibility certification.

## Completed

- Unit/integration suite: all 24 tests pass. Coverage includes PCM framing across 16/44.1/48/96 kHz, queue limits, endpoint validation, safe default selection, credential persistence/fallback, stale-session cancellation, independent Gemini connections, reconnect cancellation, restart reset and cancellable health checks.
- Backend tests cover missing pactl, unavailable native tools (including a wpctl-only scenario), automatic fallback after module-creation failure, manual-selection failure recovery and non-Linux external selection without running Linux commands.
- Real Electron/Linux audio graph, tested on both native Wayland and X11/XWayland on Fedora 44 KDE: normal passthrough, voice-only translation, listening-only translation, simultaneous translation, original restoration on Stop, isolation between both directions and independent source silence timeout. Translation responses in this graph test come from a local simulator; endpoint measurements identify incorrect audio mixing.
- Real Gemini model check: each direction sent the same synthetic English phrase to `gemini-3.5-live-translate-preview`, target `hi`, using the real production adapter and configured Google endpoint. Each returned 6.25 seconds of audio. Approximately 7.37 seconds of input including trailing silence was sent per direction. This made two short paid sessions using the existing private key, without copying that key into the desktop app.
- OS keyring behavior: preferences do not contain credentials; renderer settings do not reveal the API key; insecure Linux basic-text storage is refused.
- Real Linux device lifecycle: switching to a synthetic 44.1 kHz mono microphone, explicit-device unplug isolation, automatic-selection recovery, repeated repair without duplicate endpoints and virtual-device cleanup on application exit.
- Startup now replaces old app-owned devices with fresh audio nodes on every launch, including recoverable leftovers from an interrupted run. The tests also verify missing virtual-device detection, connection checks without audio input, sample playback isolated from the meeting microphone and cancellation.
- The production health checker passed against Gemini: the connection check succeeded, and the voice/listening sample checks returned 3.75 / 6.5 seconds of audio respectively using their Hindi defaults. See `test-artifacts/live/health-report.json`. These are additional short paid sample sessions; no physical microphone was used.
- Packaged Linux executable: starts with the normal Electron sandbox enabled, connects both normal-audio routes, opens Settings when Start is pressed without an API key, and removes its virtual devices on exit. No translation was started, audio recorded or Gemini call made in this packaged smoke check. Current packaged checks pass on X11/XWayland and on native Wayland with a restricted app PATH that contains pw-loopback/pw-dump/wpctl but no pactl. The sandbox stays enabled. Backend detection, sequential reports and applying native routing all pass. See `test-artifacts/package-report-x11.json` and `package-report-wayland-pipewire-no-pactl.json`. Earlier Wayland smoke evidence is in `package-report-wayland.json`.
- Linux AppImage build and extract-and-run launch pass with the Electron sandbox enabled. The packaged UI checks verify both normal routes, backend reports, switching to native PipeWire and cleanup. See `test-artifacts/package-report-x11-appimage.json`. Windows/macOS build automation is configured separately; physical audio behavior remains unverified on those systems.
- Dependency audit: zero reported vulnerabilities after updating the build tool's proxy-agent dependency; the runtime package contains only `ws` alongside the application and Electron runtime.

- Larger UI text and Gemini/Meet instructions, separate Settings tabs with arrow-key navigation, and System/Light/Dark theme selection. Both themes were visually inspected. Appearance changes preserve both active translations, and the saved theme survives renderer reload.

- Native PipeWire fallback passes the complete desktop audio test on Wayland with every pactl command from the app rejected. This includes fresh startup nodes, both audio directions, simultaneous translation, Stop, unplug recovery, partial-graph repair, dependency reports and exit cleanup. See `desktop-report-wayland-pipewire-no-pactl.json`.
- The X11/XWayland test also switches the running app from Pulse to native PipeWire and back to Automatic, verifies the saved choice, and measures both normal routes after reconnecting the simulated meeting output to the recreated device.
- Dependency checks run sequentially and leave both active translations running. Backend reports show missing tools/configuration rather than equating an installed command with working audio.

See `test-artifacts/desktop-report-x11.json`, `desktop-report-wayland.json`, the screenshots and `test-artifacts/live/live-report.json` for machine-readable evidence. The X11 run used XWayland inside the same Wayland session; a separate native Xorg desktop, Ubuntu, GNOME, macOS and other physical devices were not tested. See [COMPATIBILITY.md](COMPATIBILITY.md). Backend-specific desktop reports are regenerated by `npm run test:desktop`; live checks are separately opt-in.

## Your final Meet check

You chose to run this with your own meeting and second participant.

1. Open the desktop app and enter your API key in Settings. Select your physical microphone and headphones.
2. In Meet, set the microphone to **GeminiMic** and speaker to **GeminiSpeaker**. Disable the existing translation extension for this check to avoid translating twice.
3. With both translation buttons off, confirm the other participant hears your normal voice and you hear their original speech.
4. Start **Translate my voice** only. Speak a non-Hindi phrase; ask the other participant to confirm Hindi audio. Their speech should still reach you unchanged.
5. Stop voice translation. Confirm your normal voice resumes immediately without a delayed translated tail.
6. Start **Translate listening audio** only. Ask the participant to speak a non-Hindi phrase; confirm you hear Hindi while they still hear your original voice.
7. Start both directions and verify both work simultaneously. Speak Hindi as well to check target-language echo.
8. Stop either direction while the other stays active. Confirm no duplicate original/translated playback or cross-routing.
9. Switch/unplug/reconnect your headset and check the status and recovery. Explicitly selected disconnected devices should require reconnection or reselection.
10. Close the app, switch Meet back to physical audio devices and confirm ordinary calling works.

## Remaining limits

- A real two-way Meet call remains user-run and unverified here.
- Real physical microphone/speaker quality, acoustic echo cancellation and Bluetooth profile behavior need tests on the actual devices. Headphones are recommended; software routing isolation does not eliminate acoustic pickup from loudspeakers.
- Windows/macOS virtual-device mappings are implemented, but their hardware tests, signed native drivers and installer validation have not been completed. Exact custom names on those platforms are not provided automatically.
- Real Gemini output was received for Hindi-configured sessions; linguistic fidelity and voice consistency have not been independently graded.
