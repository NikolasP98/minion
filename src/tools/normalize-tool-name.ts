export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[-\s]/g, "_");
}
