const virtualName = /gemini(?:mic|speaker)|emotioncast|blackhole|cable (?:input|output)|vb-audio|soundflower|\bmonitor\b|loopback/i;
const fieldNames = { virtualMicFeed: 'Outgoing cable · app playback output', virtualMic: 'Outgoing cable · meeting microphone',
  virtualSpeaker: 'Incoming cable · meeting speaker', virtualSpeakerCapture: 'Incoming cable · app capture input' };
export const isAlias = device => ['default', 'communications'].includes(device.deviceId);
export const sameLabel = (left, right) => left.replace(/^(default|communications)\s*[-:]\s*/i, '').toLowerCase() === right.toLowerCase();

export function deviceLists(devices, settings, native) {
  const mapped = new Set(['virtualMicFeed', 'virtualMic', 'virtualSpeaker', 'virtualSpeakerCapture'].map(name => settings[name]).filter(Boolean));
  const known = new Set(Object.values(native.labels || {}));
  const isVirtual = device => mapped.has(device.deviceId) || virtualName.test(device.label) ||
    [...known].some(label => sameLabel(device.label, label)) ||
    native.devices?.some(item => item.kind === device.kind && item.isVirtual && sameLabel(item.label, device.label));
  // Chromium's PulseAudio enumeration can briefly retain removed endpoints,
  // and the server may move their open streams to another microphone. Check
  // the native inventory as well before keeping an explicit capture alive.
  const present = device => !native.managed || !native.devices ||
    native.devices.some(item => item.kind === device.kind && sameLabel(item.label, device.label));
  return {
    inputs: devices.filter(device => device.kind === 'audioinput' && !isAlias(device) && !isVirtual(device) && present(device)),
    outputs: devices.filter(device => device.kind === 'audiooutput' && !isAlias(device) && !isVirtual(device) && present(device))
  };
}

export function chooseDevice(candidates, requested, kind, devices, native, pairWith) {
  if (requested) {
    const chosen = candidates.find(device => device.deviceId === requested);
    if (!chosen) throw Error(`Your selected ${kind === 'audioinput' ? 'microphone' : 'listening device'} is disconnected. Reconnect it or choose another device.`);
    return chosen;
  }
  const nativeDefault = native.devices?.find(device => device.kind === kind && device.isDefault && !device.isVirtual);
  const browserDefault = devices.find(device => device.kind === kind && device.deviceId === 'default');
  const preferred = candidates.find(device => nativeDefault && sameLabel(device.label, nativeDefault.label)) ||
    candidates.find(device => browserDefault && sameLabel(browserDefault.label, device.label));
  // Pair by the OS/browser group identifier, never by guessing name fragments.
  const paired = pairWith?.groupId && candidates.filter(device => device.groupId === pairWith.groupId);
  if (paired?.length === 1) return paired[0];
  if (preferred) return preferred;
  if (candidates.length === 1) return candidates[0];
  throw Error(`Choose a physical ${kind === 'audioinput' ? 'microphone' : 'listening device'}. A safe system default could not be identified.`);
}

export function virtualEndpoints(devices, settings, native) {
  const kinds = { virtualMicFeed: 'audiooutput', virtualMic: 'audioinput', virtualSpeaker: 'audiooutput', virtualSpeakerCapture: 'audioinput' };
  const endpoints = {};
  for (const [name, kind] of Object.entries(kinds)) {
    const device = devices.find(device => !isAlias(device) && device.kind === kind &&
      (native.managed ? sameLabel(device.label, native.labels[name]) : device.deviceId === settings[name]));
    if (!device) throw Error(native.managed ? `Missing ${native.labels[name]}. Open Settings → Virtual devices.` :
      `Choose “${fieldNames[name]}” in Settings → Virtual devices, or press Auto-detect cables.`);
    endpoints[name] = device;
  }
  const shared = endpoints.virtualMic.deviceId === endpoints.virtualSpeakerCapture.deviceId ? endpoints.virtualMic :
    endpoints.virtualMicFeed.deviceId === endpoints.virtualSpeaker.deviceId ? endpoints.virtualMicFeed : null;
  if (shared) throw Error(`Use two separate virtual cables. “${shared.label}” is mapped to both directions, which creates a feedback loop.`);
  return endpoints;
}

// CoreAudio loopback drivers (BlackHole, or custom GeminiMic/GeminiSpeaker
// builds) expose one input and one output with the same name. Pair those into
// cables and map one cable per direction. Returns null without two cables.
export function suggestMappings(devices) {
  const cables = new Map();
  for (const device of devices) {
    if (isAlias(device) || !virtualName.test(device.label)) continue;
    const name = device.label.replace(/\s*\(virtual\)\s*$/i, '').trim().toLowerCase();
    const cable = cables.get(name) || { name };
    cable[device.kind] ??= device;
    cables.set(name, cable);
  }
  const channels = cable => Number(/(\d+)\s*ch\b/.exec(cable.name)?.[1] ?? Infinity);
  const usable = [...cables.values()].filter(cable => cable.audioinput && cable.audiooutput)
    .sort((left, right) => channels(left) - channels(right) || left.name.localeCompare(right.name));
  // The smallest bus (BlackHole 2ch) is the most meeting-compatible microphone.
  const outgoing = usable.find(cable => /geminimic/.test(cable.name)) || usable.find(cable => !/geminispeaker/.test(cable.name));
  const incoming = usable.find(cable => cable !== outgoing && /geminispeaker/.test(cable.name)) || usable.find(cable => cable !== outgoing);
  if (!outgoing || !incoming) return null;
  return { virtualMicFeed: outgoing.audiooutput.deviceId, virtualMic: outgoing.audioinput.deviceId,
    virtualSpeaker: incoming.audiooutput.deviceId, virtualSpeakerCapture: incoming.audioinput.deviceId };
}
