import Groq, { toFile } from 'groq-sdk';
import type { SttProvider, SttResult } from './types.js';

const MIME_TO_EXT: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac'
};

const PRIMARY_MODEL = 'whisper-large-v3-turbo';
const FALLBACK_MODEL = 'whisper-large-v3';

export function createGroqProvider(apiKey: string): SttProvider {
  const client = new Groq({ apiKey });

  return {
    name: 'groq',

    async transcribe(audio: Buffer, mimeType: string): Promise<SttResult> {
      const baseMime = mimeType.split(';')[0]!.trim();
      const ext = MIME_TO_EXT[baseMime];
      if (!ext) {
        throw new Error(`Unsupported audio format for Groq transcription: ${mimeType}`);
      }

      const file = await toFile(audio, `audio.${ext}`);

      try {
        return await callWhisper(client, file, PRIMARY_MODEL);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isModelError =
          msg.includes('model') ||
          msg.includes('404') ||
          msg.includes('not found') ||
          msg.includes('not available');
        if (!isModelError) throw err;

        try {
          return await callWhisper(client, file, FALLBACK_MODEL);
        } catch (fallbackErr) {
          const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          throw new Error(`Primary model failed: ${msg}; fallback model also failed: ${fallbackMsg}`);
        }
      }
    }
  };
}

interface VerboseTranscription {
  text: string;
  language?: string;
  duration?: number;
}

async function callWhisper(
  client: Groq,
  file: Awaited<ReturnType<typeof toFile>>,
  model: string
): Promise<SttResult> {
  const response = (await client.audio.transcriptions.create({
    file,
    model,
    response_format: 'verbose_json'
  })) as unknown as VerboseTranscription;

  return {
    text: response.text,
    language: response.language,
    durationSeconds: response.duration
  };
}
