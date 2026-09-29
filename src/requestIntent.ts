export function isDirectSelectedCodeRequest(text: string): boolean {
  return /\b(?:give|show|provide|send|return|display|paste)\s+(?:(?:it|me|the|this|selected|exact)\s+){0,3}(?:source\s+)?(?:code|snippet|lines?)\b/iu.test(
    text
  );
}