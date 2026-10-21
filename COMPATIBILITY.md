# Platform and device compatibility — 21 October 2026

The current release is a **Linux x64** application. Electron makes the UI portable; the OS audio backend still determines whether virtual-device creation, cleanup and routing work. No claim of universal hardware compatibility is made.

| Environment | Current evidence | What is needed |
| --- | --- | --- |
| Fedora 44 KDE, native Wayland | Desktop audio integration and sandboxed packaged smoke checks pass on this machine. | Test actual microphones/headsets and the user-run Meet call. |
| Fedora 44 KDE, X11 through XWayland | The same audio integration and packaged checks pass. | A separate native Xorg session and other compositors remain untested. |
| Other supported Fedora releases / desktops | Expected to use the same audio backend, not verified here. | Check Electron runtime libraries, one supported backend and browser endpoint access; test each supported release. |
| Supported Ubuntu releases, X11 or Wayland | Expected to work when the required audio tools/server and runtime are available; no Ubuntu run completed. | Use `pulseaudio-utils` or the native tools from `pipewire-bin`; run the new dependency and route checks; test sandbox policies and provide a `.deb` with dependencies. |
| PipeWire with native tools, but no pactl | Native virtual-device creation and routing work on the tested Fedora system; the app has no pactl dependency in this mode. | `pw-loopback`, `pw-dump` and working browser endpoint access. |
| ALSA/JACK alone, or PipeWire without browser endpoint access | No direct ALSA/JACK backend; native cable creation does not establish browser support. | Enable an appropriate Pulse-compatible service or configure installed virtual devices accessible to the browser. |
| macOS | UI/Gemini code and manual four-endpoint cable mapping exist; no Mac build or native audio lifecycle has been tested. | Separate Mac builds, permissions/signing and a CoreAudio virtual-device backend are required for the promised automatic setup. |
| ARM64 Linux / Apple Silicon | The supplied Linux x64 archive is not the corresponding native build. | Build and test each target architecture, including its audio backend. |

## Why X11 and Wayland can both work

They control the app window. Managed devices are created either through `pactl` or native `pw-loopback`. Inventory comes from Pulse commands or `pw-dump`. Browser audio capture and Web Audio output selection then handle streaming. Meet explicitly sends its output to GeminiSpeaker; the app does not depend on desktop screen/audio capture or a screen-sharing portal. PipeWire documents its PulseAudio server as compatible with existing tools including `pactl`. This is the architectural reason the same routing can work on both display systems. [PipeWire protocol documentation](https://docs.pipewire.org/page_module_protocol_pulse.html).

Wayland does restrict some programmatic positioning, resizing and focus operations. This UI does not require them for translation. Where necessary, Electron supports XWayland with `--ozone-platform=x11`, provided XWayland is installed. [Electron BrowserWindow documentation](https://www.electronjs.org/docs/latest/api/browser-window).

The local desktop tests force each backend separately and measure audio at the real virtual endpoints using distinct synthetic tones. They check normal passthrough, independent and simultaneous translation using simulated provider audio, Stop restoration, sample playback isolation, unplug recovery and lifecycle cleanup. They are not a real two-party Meet test. Previous real Gemini transport/sample checks are documented in VERIFICATION.md.

## Linux requirements and broader distribution

The Pulse backend requires an accessible PulseAudio server or `pipewire-pulse`, the `pactl` client, working JSON source/sink inventory, and the built-in `module-null-sink` and `module-remap-source` modules. Restricted module loading or missing tools blocks automatic creation. PipeWire supports loading its built-in Pulse modules via `pactl`; arbitrary external Pulse modules are a different matter. [PipeWire module documentation](https://docs.pipewire.org/page_pulse_modules.html).

The native backend creates its own isolated sink/source pairs using `pw-loopback` and inventories audio nodes/default metadata using `pw-dump`. It does not call pactl. Optional `wpctl status` verifies WirePlumber access; wpctl alone cannot construct the cables. These are actual implemented backends, not just dropdown entries. [PipeWire loopback tool](https://docs.pipewire.org/page_man_pw-loopback_1.html), [WirePlumber control tool](https://pipewire.pages.freedesktop.org/wireplumber/man/wpctl.html).

The missing-pactl scenario has been tested with a real Electron audio graph using a test runner that rejects all pactl calls from the app, and with the actual packaged app launched with a PATH containing only the native PipeWire tools. The test system still runs pipewire-pulse for Chromium's device access. Removing that service was not tested and is not claimed to work. The test harness uses pactl outside the app for synthetic fixtures and independent audio measurement.

Tool packages: [Ubuntu pulseaudio-utils](https://packages.ubuntu.com/noble/amd64/pulseaudio-utils/filelist), [Ubuntu pipewire-bin](https://packages.ubuntu.com/noble/all/pipewire-bin/filelist), [Fedora pipewire-utils](https://packages.fedoraproject.org/pkgs/pipewire/pipewire-utils/). The app reports missing dependencies and guidance; it does not silently install packages or switch the system sound server.

Check inventory with `pactl -f json list sinks` and `pactl -f json list sources`. Use **Check selected / Check all backends** for per-backend dependency reports, then **Use selected & test routing**. Use the app's **Settings → Virtual devices → Check devices** to verify all four endpoints and physical routing. Dependency packaging should provide `.deb` for Ubuntu and `.rpm` for Fedora, with release/desktop tests rather than assuming one tarball is turnkey everywhere. Sandboxed distribution formats also need access to the host audio socket and management tools.

Some Ubuntu installations restrict the unprivileged user namespaces used by Chromium's sandbox. A failure there needs a properly installed package and scoped sandbox/AppArmor policy; globally disabling the sandbox is not the distribution fix. [Ubuntu AppArmor documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/).

Fresh virtual devices on start and removal on normal close are implemented on Linux. An uncatchable crash, SIGKILL or power loss cannot run cleanup; the next start removes matching leftovers before recreating them.

## macOS / Windows external backends and remaining native work

This version uses Electron 44, whose minimum supported macOS version is **13 Ventura**. A Mac release needs Intel and Apple Silicon builds (or a tested universal build), microphone permission and appropriate hardened-runtime entitlements, signing/notarization, and actual CoreAudio hardware tests. A Linux executable cannot run as a Mac application. [Electron 44 platform changes](https://www.electronjs.org/blog/electron-44-0).

The external backend needs **two independent** installed loopback cables and the four mapping fields. Backend selection and mapping checks are implemented; macOS and Windows hardware tests are not completed. These paths do not require pactl or wpctl. On Windows two independent VB-CABLE endpoints are one option; on macOS two separately configured BlackHole buses are one option. BlackHole provides a CoreAudio loopback driver with configurable names and channels; its mirrored output is not an independent second bus. Redistribution/customization also requires attention to its license. This installed-driver arrangement does not satisfy automatic create/remove on app launch/close. [BlackHole project documentation](https://github.com/ExistentialAudio/BlackHole).

To deliver the same simple setup on Mac, implement and distribute a signed CoreAudio driver/helper exposing two isolated buses named GeminiMic and GeminiSpeaker. Install its driver once, then have the helper publish and remove the session devices with the app, including recovery after crashes. Uninstalling and reinstalling a privileged driver every launch is unnecessary; matching the requested device visibility/lifecycle is the requirement. This backend remains future implementation work.

## Why “all devices” cannot yet be promised

The application selects OS-reported physical defaults, permits explicit overrides, adapts negotiated audio formats, and reacts to device changes. Format tests cover 16/44.1/48/96 kHz PCM conversion. That does not establish compatibility with every driver, channel layout or Bluetooth implementation.

Bluetooth microphone use can change the headset profile and available endpoints; USB unplug/replug can replace device IDs; exclusive-use devices and denied microphone permissions can prevent capture. Some headphones have no microphone. These need real hardware tests and clear recovery paths. Software isolation prevents digital cross-routing but cannot eliminate acoustic pickup from laptop speakers; headphones remain recommended.

To broaden verified support, test Ubuntu/Fedora on native Xorg, KDE Wayland and GNOME Wayland, then Intel/Apple Silicon Macs. Include built-in audio, analog headsets, USB headsets and Bluetooth profile changes, sleep/resume, unplug/replug, normal/translated transitions and a real Meet call. Native Mac lifecycle support and distribution packages are separate development work, not already completed features.
