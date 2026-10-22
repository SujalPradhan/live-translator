# Gemini Audio

A simple Electron app for independent microphone and listening-audio translation with Gemini. Both directions start with normal, untranslated audio. Hindi is the default target language for each direction.

## Run from source

Install **Git and Node.js 22.12+**, then:

```sh
git clone https://github.com/hrmiitm/live-translator.git
cd live-translator
npm install
npm start
```

The Electron app is at the repository root. The browser extension and a separate backend are not required. For reproducible development/CI installs, use `npm ci` instead of `npm install`.

1. Open **Settings → Gemini**, enter your API key, check the connection and save.
2. Open **Settings → Virtual devices**. Leave the backend on **Automatic**, choose **Check all backends**, then **Use selected & test routing** if setup needs attention.
3. Choose your physical microphone and headphones in the main window.
4. In Meet, choose **GeminiMic** as microphone and **GeminiSpeaker** as speaker. With external drivers, use the actual mapped device labels shown by the app.
5. Start either translation direction when needed. Stop restores that direction's original audio.

Keep the app open while calling. Headphones help avoid acoustic echo.

### macOS quick start

Needs macOS 13+, [Homebrew](https://brew.sh) and Node.js 22.12+.

```sh
git clone https://github.com/hrmiitm/live-translator.git
cd live-translator
npm run setup:mac   # installs BlackHole 2ch + 16ch and npm dependencies (asks for your password)
npm start
```

Allow microphone access when macOS asks. The app detects both BlackHole cables and maps them automatically (**Settings → Virtual devices → Auto-detect cables** remaps them at any time). In Meet, choose **BlackHole 2ch** as microphone and **BlackHole 16ch** as speaker.

## Audio dependencies

`npm install` installs Electron and JavaScript dependencies. OS audio tools and virtual drivers are separate; the app checks them and reports what is missing.

| Platform | Setup |
| --- | --- |
| Linux | A running PulseAudio or PipeWire audio service. Automatic tries `pactl`, then native PipeWire using `pw-loopback` + `pw-dump`. `wpctl` is optional and cannot create the cables alone. |
| Windows | Install two independent virtual cables, such as [VB-CABLE A+B](https://vb-audio.com/Cable/), then map all four endpoints in Settings. |
| macOS 13+ | Run `npm run setup:mac` to install two independent [BlackHole](https://github.com/ExistentialAudio/BlackHole) drivers (2ch and 16ch). The app maps all four endpoints automatically; adjust them in Settings if needed. |

Linux tool packages, if the dependency report identifies them as missing:

```sh
# Ubuntu / Debian: tools for the Pulse and native PipeWire backends
sudo apt update
sudo apt install pulseaudio-utils pipewire-bin

# Fedora
sudo dnf install pulseaudio-utils pipewire-utils
```

Keep your existing sound service; installing these tools does not require replacing PipeWire with PulseAudio. Ordinary Chromium-based Linux apps still need PulseAudio or `pipewire-pulse` to expose the audio endpoints. Missing `pactl` alone is handled by the native fallback when its tools are available.

**Check selected** tests one backend; **Check all backends** checks them sequentially without interrupting translation. Reports distinguish dependencies from actual route readiness. **Use selected & test routing** restarts routing in normal mode; reselect the virtual devices in your meeting afterward.

Managed Linux devices are recreated on launch and removed on close. Windows/macOS drivers remain installed; automatic native driver/device lifecycle and hardware compatibility are not verified there. See [compatibility details](COMPATIBILITY.md) and the [full app guide](docs/APP_GUIDE.md).

## Download or build installers

Download from [GitHub Releases](https://github.com/hrmiitm/live-translator/releases):

| System | File |
| --- | --- |
| Linux x64 | `.AppImage` |
| Windows x64 | `.exe` installer |
| macOS Intel | `macos-x64.dmg` |
| macOS Apple Silicon | `macos-arm64.dmg` |

On Linux, make the AppImage executable with `chmod +x Gemini-Audio-*.AppImage`, then launch it. If FUSE is unavailable, try `./Gemini-Audio-<version>-linux-x86_64.AppImage --appimage-extract-and-run`.

Build on the corresponding operating system:

```sh
npm run dist:linux                   # Linux AppImage
npm run dist:windows                 # Windows NSIS installer
npm run dist:mac -- --x64            # Intel Mac DMG
npm run dist:mac -- --arm64          # Apple Silicon Mac DMG
npm run release:checksums
```

Outputs are in `release/`. Windows installers are unsigned; Mac apps use ad-hoc signing and are not notarized. OS security warnings may appear. Trusted public distribution requires appropriate Windows signing and Apple Developer ID/notarization credentials; these are not included in this repository. No Gemini key is needed to build or test the app.

## GitHub Actions releases

Push to `main` or open a pull request to run tests on Linux, Windows and macOS. To publish installers, increase the package version and push its matching tag:

```sh
npm version patch
# npm version creates the version commit and tag, for example v1.1.1
git push origin main --follow-tags
```

You can also run **Actions → Release → Run workflow** to release the current package version. The release workflow tests and builds all four targets, generates SHA-256 checksums, and publishes only after every build succeeds. A published version is not overwritten; bump the version for the next release.

## Tests

```sh
npm test
```

Local Linux audio integration tests and the user-run Meet checklist are in [VERIFICATION.md](VERIFICATION.md). They require additional audio tools and a desktop session. API keys stay out of source control and release files; enter yours in the app. Settings use the OS keyring when secure storage is available.
