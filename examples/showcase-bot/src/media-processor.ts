import type { TextPart, ImagePart } from 'ai';
import { log } from './logger.js';
import { createSttProvider, type SttProvider } from './stt/index.js';

export type MediaContent = Array<TextPart | ImagePart>;

export interface MediaProcessResult {
  content: MediaContent;
  transcription?: string;
}

let sttProvider: SttProvider | null | undefined;

function getSttProvider(): SttProvider | null {
  if (sttProvider === undefined) {
    sttProvider = createSttProvider();
    if (sttProvider) {
      log('info', `STT provider initialized: ${sttProvider.name}`);
    } else {
      log('warn', 'No STT provider configured — audio transcription disabled');
    }
  }
  return sttProvider;
}

function parseVCard(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const match = line.match(/^([^:;]+)[;:](.+)$/);
    if (!match) continue;
    const key = match[1]!.toUpperCase();
    const value = match[2]!;
    switch (key) {
      case 'FN':
        fields.name = value;
        break;
      case 'TEL':
        fields.phone = (fields.phone ? fields.phone + ', ' : '') + value;
        break;
      case 'EMAIL':
        fields.email = (fields.email ? fields.email + ', ' : '') + value;
        break;
      case 'ORG':
        fields.organization = value;
        break;
      case 'TITLE':
        fields.title = value;
        break;
      case 'ADR': {
        const parts = value.split(';').filter(Boolean);
        if (parts.length > 0) fields.address = parts.join(', ');
        break;
      }
    }
  }
  if (Object.keys(fields).length === 0) return raw;
  const parts: string[] = ['Contact Card:'];
  if (fields.name) parts.push(`  Name: ${fields.name}`);
  if (fields.phone) parts.push(`  Phone: ${fields.phone}`);
  if (fields.email) parts.push(`  Email: ${fields.email}`);
  if (fields.organization) parts.push(`  Organization: ${fields.organization}`);
  if (fields.title) parts.push(`  Title: ${fields.title}`);
  if (fields.address) parts.push(`  Address: ${fields.address}`);
  return parts.join('\n');
}

export async function buildMediaContent(
  mediaType: string,
  mediaUrl: string,
  textMessage: string
): Promise<MediaProcessResult> {
  const caption = textMessage?.trim();

  if (mediaType.startsWith('image/')) {
    // Only the AI SDK's documented image MIME types are guaranteed to round-trip
    // to provider APIs. iOS often delivers `image/heic`, which most providers
    // reject — fall back to text so the bot can at least acknowledge the image.
    const SUPPORTED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    if (!SUPPORTED_IMAGE_MIME.has(mediaType)) {
      return {
        content: [
          {
            type: 'text',
            text: caption
              ? `${caption}\n\n[Image received (${mediaType}) — format not supported by the model. Acknowledge receipt and ask the user to send a JPEG or PNG.]`
              : `[Image received (${mediaType}) — format not supported by the model. Acknowledge receipt and ask the user to send a JPEG or PNG.]`
          }
        ]
      };
    }
    try {
      const response = await fetch(mediaUrl);
      const buffer = new Uint8Array(await response.arrayBuffer());
      const parts: MediaContent = [{ type: 'image', image: buffer, mediaType }];
      parts.push({ type: 'text', text: caption || '[User sent an image]' });
      return { content: parts };
    } catch (err) {
      log('warn', `Failed to fetch image from ${mediaUrl}: ${err}`);
      return {
        content: [
          {
            type: 'text',
            text: caption ? `${caption}\n\n[Image received but could not be loaded]` : '[Image received but could not be loaded]'
          }
        ]
      };
    }
  }

  if (mediaType === 'application/pdf') {
    let parser: { getText: () => Promise<unknown>; destroy?: () => Promise<void> } | undefined;
    try {
      const response = await fetch(mediaUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const { PDFParse } = await import('pdf-parse');
      parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      const extractedText = (result as { text: string }).text.trim();
      if (extractedText) {
        const preamble = caption
          ? `${caption}\n\n[PDF Document — extracted text below]\n`
          : '[PDF Document — extracted text below]\n';
        return { content: [{ type: 'text', text: `${preamble}${extractedText}` }] };
      }
      return {
        content: [
          {
            type: 'text',
            text: caption
              ? `${caption}\n\n[PDF received but no text could be extracted]`
              : '[PDF received but no text could be extracted]'
          }
        ]
      };
    } catch (err) {
      log('warn', `Failed to parse PDF from ${mediaUrl}: ${err}`);
      return {
        content: [
          {
            type: 'text',
            text: caption ? `${caption}\n\n[PDF received but could not be read]` : '[PDF received but could not be read]'
          }
        ]
      };
    } finally {
      // pdf-parse v2 docs: always call destroy() after getText() to free the worker.
      if (parser?.destroy) {
        try {
          await parser.destroy();
        } catch {
          // ignore — best-effort cleanup
        }
      }
    }
  }

  if (mediaType === 'text/vcard' || mediaType === 'text/x-vcard') {
    try {
      const response = await fetch(mediaUrl);
      const raw = await response.text();
      const formatted = parseVCard(raw);
      return {
        content: [
          { type: 'text', text: caption ? `${caption}\n\n${formatted}` : `[User shared a contact]\n${formatted}` }
        ]
      };
    } catch (err) {
      log('warn', `Failed to fetch vCard from ${mediaUrl}: ${err}`);
      return {
        content: [
          {
            type: 'text',
            text: caption
              ? `${caption}\n\n[Contact card received but could not be read]`
              : '[Contact card received but could not be read]'
          }
        ]
      };
    }
  }

  if (mediaType.startsWith('audio/')) {
    const provider = getSttProvider();
    if (!provider) {
      return {
        content: [
          {
            type: 'text',
            text: '[Voice note received — no STT provider configured. Acknowledge receipt and ask the user to send a text message instead.]'
          }
        ]
      };
    }
    try {
      const response = await fetch(mediaUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      log('info', `Transcribing audio (${mediaType}, ${buffer.length} bytes) via ${provider.name}`);
      const result = await provider.transcribe(buffer, mediaType);
      if (!result.text.trim()) {
        return {
          content: [
            {
              type: 'text',
              text: '[Voice note received but transcription returned empty text. Acknowledge receipt and ask the user to try again.]'
            }
          ]
        };
      }
      log('info', `Transcription complete (${result.durationSeconds?.toFixed(1)}s, lang=${result.language})`);
      const transcriptLabel = caption
        ? `${caption}\n\n[Voice note transcript]: ${result.text}`
        : `[Voice note transcript]: ${result.text}`;
      return { content: [{ type: 'text', text: transcriptLabel }], transcription: result.text };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log('warn', `Audio transcription failed: ${errMsg}`);
      return {
        content: [
          {
            type: 'text',
            text: `[Voice note received but transcription failed: ${errMsg}. Acknowledge receipt of the voice note.]`
          }
        ]
      };
    }
  }

  if (mediaType.startsWith('application/')) {
    return {
      content: [
        {
          type: 'text',
          text: caption
            ? `${caption}\n\n[Document received (${mediaType}) — text extraction is not supported for this format. Acknowledge receipt.]`
            : `[Document received (${mediaType}) — text extraction is not supported for this format. Acknowledge receipt.]`
        }
      ]
    };
  }

  if (mediaType.startsWith('video/')) {
    return {
      content: [
        { type: 'text', text: '[Video received — video processing is not supported. Acknowledge receipt.]' }
      ]
    };
  }

  return {
    content: [{ type: 'text', text: `[Media received: ${mediaType} — unsupported format. Acknowledge receipt.]` }]
  };
}
