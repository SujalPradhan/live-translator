export const defaults = Object.freeze({
  model: 'gemini-3.5-live-translate-preview',
  baseUrl: 'https://generativelanguage.googleapis.com',
  chunkMs: 40, playbackBufferMs: 60, maxBufferMs: 1500,
  silenceSeconds: 0, echoTargetLanguage: true,
  voiceTarget: 'hi', listenTarget: 'hi',
  microphone: '', speaker: '',
  theme: 'system', audioBackend: 'auto',
  // Only used with separately installed virtual devices on Windows/macOS.
  virtualMicFeed: '', virtualMic: '', virtualSpeaker: '', virtualSpeakerCapture: ''
});

export const languages = `Afrikaans:af|Akan:ak|Albanian:sq|Amharic:am|Arabic:ar|Armenian:hy|Azerbaijani:az|Basque:eu|Belarusian:be|Bengali:bn|Bulgarian:bg|Burmese:my|Catalan:ca|Chinese (Simplified):zh-Hans|Chinese (Traditional):zh-Hant|Croatian:hr|Czech:cs|Danish:da|Dutch:nl|English:en|Estonian:et|Filipino:fil|Finnish:fi|French:fr|Galician:gl|Georgian:ka|German:de|Greek:el|Gujarati:gu|Hausa:ha|Hebrew:he|Hindi:hi|Hungarian:hu|Icelandic:is|Indonesian:id|Italian:it|Japanese:ja|Javanese:jv|Kannada:kn|Kazakh:kk|Khmer:km|Kinyarwanda:rw|Korean:ko|Lao:lo|Latvian:lv|Lithuanian:lt|Macedonian:mk|Malay:ms|Malayalam:ml|Marathi:mr|Mongolian:mn|Nepali:ne|Norwegian:no|Persian:fa|Polish:pl|Portuguese (Brazil):pt-BR|Portuguese (Portugal):pt-PT|Punjabi:pa|Romanian:ro|Russian:ru|Serbian:sr|Sindhi:sd|Sinhala:si|Slovak:sk|Somali:so|Spanish:es|Sundanese:su|Swahili:sw|Swedish:sv|Tamil:ta|Telugu:te|Thai:th|Turkish:tr|Ukrainian:uk|Urdu:ur|Uzbek:uz|Vietnamese:vi|Zulu:zu`.split('|').map(item => item.split(':'));

export function validateSettings(input) {
  if (!input || typeof input !== 'object') throw Error('Invalid settings.');
  const settings = { ...defaults };
  for (const name of Object.keys(defaults)) if (Object.hasOwn(input, name)) settings[name] = input[name];
  const url = new URL(settings.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('Gemini base URL must be an HTTPS origin, without a path or credentials.');
  if (!/^[a-z0-9][a-z0-9._-]{2,150}$/.test(settings.model)) throw Error('Enter a valid Gemini model ID.');
  for (const [name, min, max] of [['chunkMs', 20, 200], ['playbackBufferMs', 0, 1000], ['maxBufferMs', 200, 10000], ['silenceSeconds', 0, 3600]]) {
    if (!Number.isInteger(settings[name]) || settings[name] < min || settings[name] > max)
      throw Error(`${name} must be a whole number between ${min} and ${max}.`);
  }
  if (settings.maxBufferMs < settings.playbackBufferMs + 100) throw Error('Maximum queue must exceed playback buffer by at least 100 ms.');
  if (typeof settings.echoTargetLanguage !== 'boolean') throw Error('Invalid target-language echo setting.');
  if (!['auto', 'pulse', 'pipewire', 'external'].includes(settings.audioBackend)) throw Error('Choose a supported audio backend.');
  if (!['system', 'light', 'dark'].includes(settings.theme)) throw Error('Choose System, Light or Dark theme.');
  for (const name of ['voiceTarget', 'listenTarget']) {
    if (!languages.some(([, code]) => code === settings[name])) throw Error('Choose a supported target language.');
  }
  for (const name of ['microphone', 'speaker', 'virtualMicFeed', 'virtualMic', 'virtualSpeaker', 'virtualSpeakerCapture']) {
    if (typeof settings[name] !== 'string' || settings[name].length > 1024) throw Error('Invalid audio device selection.');
  }
  return settings;
}

export function translationSetup(settings, target) {
  // Preserve the top-level transcription placement proven by this project's probes.
  // Transcripts are intentionally not requested: this app has no caption feature.
  return { setup: {
    model: `models/${settings.model}`,
    generationConfig: { responseModalities: ['AUDIO'], translationConfig: {
      targetLanguageCode: target, echoTargetLanguage: settings.echoTargetLanguage
    } }
  } };
}
