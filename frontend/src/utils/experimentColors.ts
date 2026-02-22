/**
 * 20 hand-picked colors sorted by hue (rainbow gradient).
 * Red → Orange → Yellow → Green → Cyan → Blue → Purple → Pink
 */
export const PRESET_COLORS = [
  "#dc2626", // red
  "#e11d48", // rose
  "#ea580c", // orange
  "#d97706", // amber
  "#ca8a04", // yellow
  "#84cc16", // lime
  "#16a34a", // green
  "#059669", // emerald
  "#0d9488", // teal
  "#2dd4bf", // turquoise
  "#0891b2", // cyan
  "#06b6d4", // sky
  "#345f94", // blue
  "#4f46e5", // indigo
  "#6366f1", // blue-violet
  "#7c3aed", // violet
  "#9333ea", // purple
  "#a855f7", // lavender
  "#db2777", // pink
  "#f43f5e", // coral
];

/**
 * Deterministically hash a session ID to an index into PRESET_COLORS.
 * Colors are stable regardless of how many experiments exist or their order.
 */
export function getExperimentColor(sessionId: string): string {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = (hash << 5) - hash + sessionId.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % PRESET_COLORS.length;
  return PRESET_COLORS[index];
}
