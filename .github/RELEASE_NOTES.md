Independent microphone and listening-audio translation with normal audio passthrough, Hindi defaults, configurable audio backends and local dependency/connection checks.

- **Linux:** download the AppImage, make it executable and launch it. A running PulseAudio/PipeWire service and tools for at least one backend are required; Settings → Virtual devices reports missing components.
- **Windows:** download the EXE installer. Two independent virtual audio cables must be installed and mapped in Settings.
- **macOS 13+:** choose the Intel (`x64`) or Apple Silicon (`arm64`) DMG. Two independent CoreAudio virtual cables must be installed and mapped in Settings.

Windows installers are unsigned. Mac apps are ad-hoc signed, not Apple-notarized. These builds do not bundle third-party virtual drivers; platform security prompts and driver setup may still be needed. Building these installers is not certification of all audio hardware.

Enter your own Gemini API key in the app; builds contain no API key. See the repository README for setup and COMPATIBILITY.md for tested limitations. SHA-256 checksum files accompany each installer.
