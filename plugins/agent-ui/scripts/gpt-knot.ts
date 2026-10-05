// Rasterizes the gpt avatar's knot to sprite pixel strings: six rounded links (capsule
// outlines) rotated in 60° steps, each passing over the next and under the one before.
// Prints the frames for SPRITES.gpt in hooks/sprites.ts.
//   bun plugins/agent-ui/scripts/gpt-knot.ts
const SIZE = 32
const ROTATIONS = [0, 15, 30, 45] // the knot repeats every 60°, so these loop seamlessly
const SUB = 4 // subsamples per pixel side; a pixel is set at half coverage or more

// Geometry in pixels, the knot centered in the frame.
const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback)
const RADIAL = env('KNOT_RADIAL', 5.5) // link center's distance from the knot center
const HALF = env('KNOT_HALF', 5) // half-length of a link's straight run
const BEND = env('KNOT_BEND', 3.6) // radius of a link's rounded ends, to the stroke middle
const STROKE = env('KNOT_STROKE', 2.8) // stroke width
const GAP = env('KNOT_GAP', 1) // clear space either side of the link on top at a crossing
const TWIST = env('KNOT_TWIST', -60) // a link's tilt from tangential, degrees

type Link = { cx: number; cy: number; ux: number; uy: number }

function links(rotation: number): Link[] {
  return Array.from({ length: 6 }, (_, k) => {
    const at = ((rotation + k * 60) * Math.PI) / 180
    const axis = at + Math.PI / 2 + (TWIST * Math.PI) / 180
    return { cx: RADIAL * Math.cos(at), cy: RADIAL * Math.sin(at), ux: Math.cos(axis), uy: Math.sin(axis) }
  })
}

// Distance from (x, y) to the link's outline (the capsule's middle line).
function offOutline(link: Link, x: number, y: number): number {
  const dx = x - link.cx
  const dy = y - link.cy
  const along = Math.max(-HALF, Math.min(HALF, dx * link.ux + dy * link.uy))
  const px = dx - along * link.ux
  const py = dy - along * link.uy
  return Math.abs(Math.hypot(px, py) - BEND)
}

function inked(all: Link[], x: number, y: number): boolean {
  for (let k = 0; k < all.length; k++) {
    const link = all[k] as Link
    if (offOutline(link, x, y) > STROKE / 2) continue
    // the link before this one passes over it here: leave the gap around it clear
    const over = all[(k + all.length - 1) % all.length] as Link
    if (offOutline(over, x, y) <= STROKE / 2 + GAP) continue
    return true
  }
  return false
}

function frame(rotation: number): string[] {
  const all = links(rotation)
  const rows: string[] = []
  for (let py = 0; py < SIZE; py++) {
    let row = ''
    for (let px = 0; px < SIZE; px++) {
      let hits = 0
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const x = px + (sx + 0.5) / SUB - SIZE / 2
          const y = py + (sy + 0.5) / SUB - SIZE / 2
          if (inked(all, x, y)) hits++
        }
      }
      row += hits * 2 >= SUB * SUB ? 'X' : '.'
    }
    rows.push(row)
  }
  return rows
}

const lines = ROTATIONS.map(frame).map(rows => `    [\n${rows.map(row => `      '${row}',`).join('\n')}\n    ],`)
console.log(`  gpt: [\n${lines.join('\n')}\n  ],`)
