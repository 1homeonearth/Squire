// Minimal helpers for native YouTube playback via Discord's unfurl
export const isYouTubeUrl = (text: string): boolean =>
  /(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[^\s<>]+/i.test(text);

export function prepareForNativeEmbed(text: string): string {
  // Ensure the URL isn't wrapped in angle brackets, which disables previews
  // Also avoid code blocks or markdown that could hide the link
  return text.replace(/<\s*(https?:\/\/[^>]+)\s*>/gi, '$1');
}
