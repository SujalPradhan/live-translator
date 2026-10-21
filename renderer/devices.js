const virtualName = /gemini(?:mic|speaker)|emotioncast|blackhole|cable (?:input|output)|vb-audio|soundflower|\bmonitor\b|loopback/i;
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
    if (!device) throw Error(`Missing ${native.managed ? native.labels[name] : name}. Open Settings → Virtual devices.`);
    endpoints[name] = device;
  }
  if (endpoints.virtualMic.deviceId === endpoints.virtualSpeakerCapture.deviceId ||
    endpoints.virtualMicFeed.deviceId === endpoints.virtualSpeaker.deviceId)
    throw Error('Use two separate virtual cables. Sharing one cable creates a feedback loop.');
  return endpoints;
}
