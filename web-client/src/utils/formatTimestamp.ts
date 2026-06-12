export function formatTimestamp(
  isoString: string | null | undefined
): string {
  if (!isoString) return 'Unknown'
  return new Date(isoString).toLocaleString()
}
