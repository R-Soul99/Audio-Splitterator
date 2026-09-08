/**
 * Parses artist and title from a filename using the "[Artist] - [Title]" format.
 * E.g., "Abba - Tragedy" -> { artist: "Abba", title: "Tragedy" }
 * Also handles prefixes like "01 - Abba - Tragedy" or "01. Abba - Tragedy"
 */
export function parseArtistTitle(filename: string): { artist: string; title: string } {
  // Remove file extension if present
  let clean = filename.replace(/\.(mp3|wav|flac|ogg|m4a|aac|aiff)$/i, '').trim();

  // Strip leading track numbers like "01 - ", "01. ", "1 - "
  const trackNumMatch = clean.match(/^(\d{1,3})[\s._-]+(.+)$/);
  if (trackNumMatch && trackNumMatch[2].includes('-')) {
    clean = trackNumMatch[2].trim();
  }

  // Split on " - " or "-" with spaces
  const parts = clean.split(/\s+-\s+/);
  if (parts.length >= 2) {
    const artist = parts[0].trim();
    const title = parts.slice(1).join(' - ').trim();
    return { artist, title };
  }

  // Fallback: single hyphen without surrounding spaces if available
  const singleHyphen = clean.split('-');
  if (singleHyphen.length >= 2) {
    const artist = singleHyphen[0].trim();
    const title = singleHyphen.slice(1).join('-').trim();
    return { artist, title };
  }

  // No separator found: entire name as title
  return { artist: '', title: clean };
}
