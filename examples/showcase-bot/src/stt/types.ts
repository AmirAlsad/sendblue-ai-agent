export interface SttResult {
  text: string;
  language?: string;
  durationSeconds?: number;
}

export interface SttProvider {
  readonly name: string;
  transcribe(audio: Buffer, mimeType: string): Promise<SttResult>;
}
