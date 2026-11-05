import type { CookKind } from "../pipeline/schemaDocs";

/**
 * Infer deliverable kind from brief + attachment names (Argon may override after classify).
 */
export function inferCookKind(prompt: string, files: string[] = []): CookKind {
  const p = prompt.toLowerCase();
  const names = files.map((f) => f.toLowerCase()).join(" ");

  if (/\b(pptx|powerpoint|slide\s*deck|presentation)\b/i.test(prompt) || /\.pptx\b/i.test(names)) {
    return "pptx";
  }
  if (/\b(pdf)\b/i.test(prompt) && !/\b(from\s+pdf|attached\s+pdf)\b/i.test(prompt)) {
    if (/\b(export|deliver|output|generate).{0,40}\bpdf\b/i.test(prompt) || /\bpdf\b.{0,20}\b(deliverable|master|output)\b/i.test(prompt)) {
      return "pdf";
    }
  }
  if (
    /\b(html|three\.?js|webgl|web\s*page|landing\s*page|interactive|browser\s*game|canvas\s*game)\b/i.test(prompt) ||
    /\.html?\b/i.test(names)
  ) {
    return "html";
  }
  if (
    /\b(png|svg|logo\s*mark|icon\s*set|raster|still\s*image|generate\s+(an?\s+)?image)\b/i.test(prompt) &&
    !/\b(video|mp4|clip|ugc|reel)\b/i.test(prompt)
  ) {
    return "image";
  }
  if (/\b(audio.?only|podcast|voiceover|lyria|tts|radio\s*ad|radio\s*commercial)\b/i.test(prompt)) {
    return "audio";
  }
  if (
    files.some((f) => /\.(wav|mp3|m4a|flac|aac)$/i.test(f)) &&
    !files.some((f) => /\.(mp4|mov|webm|png|jpg|jpeg)$/i.test(f))
  ) {
    return "audio";
  }
  if (/\b(docx|word\s*doc)\b/i.test(prompt)) {
    // DOCX deferred — fall through to html as printable document unless pptx asked.
    return "html";
  }
  return "video";
}
