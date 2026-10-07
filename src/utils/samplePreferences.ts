export function samplePreferences(format: string | null, depth: string | null): { format: 'wav' | 'flac'; depth: 16 | 24 } {
  return { format: format === 'wav' ? 'wav' : 'flac', depth: depth === '24' ? 24 : 16 };
}
