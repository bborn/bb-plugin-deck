// Every project gets a stable colour and a short label. This is the layer that
// always works: no repo, no network, no configuration. A detected repo icon
// draws on top of it when there is one.
//
// Colours come from a slot the server hands out once per project, not from a
// hash of the id. Hashing four ids put every real project inside one 83° band
// of blue-purple — two of them 14° apart, which reads as the same colour. The
// golden angle spreads consecutive slots as far apart as a circle allows, and
// a slot never changes once assigned, so a project keeps its colour for good.

/** 360° / φ — consecutive slots land as far from each other as possible. */
const GOLDEN_ANGLE = 137.508;

/** Fixed so white text stays legible on any hue and the set reads as a family. */
const LIGHTNESS = 0.55;
const CHROMA = 0.15;

export function hueForSlot(slot: number): number {
  const spun = (slot * GOLDEN_ANGLE) % 360;
  return Math.round(spun < 0 ? spun + 360 : spun);
}

/** A project's accent colour, as a CSS colour usable in an inline style. */
export function colorForHue(hue: number): string {
  return `oklch(${LIGHTNESS} ${CHROMA} ${((hue % 360) + 360) % 360})`;
}

/**
 * One or two characters standing in for a project with no icon. Words win over
 * raw characters, so "influence kit" reads IK and "checkout" reads OF.
 */
export function projectInitials(name: string): string {
  const words = name.split(/[\s_\-./]+/).filter((word) => /[a-z0-9]/i.test(word));
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
