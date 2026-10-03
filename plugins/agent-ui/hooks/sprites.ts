// Provider avatars: 2 terminal cells wide, one row tall, drawn in braille (2x4 dots a
// cell, so a square 4x4 pixels). Every frame is encoded once, here.
export type Avatar = 'claude' | 'gpt' | 'kimi'
type Look = { run: string[]; done: string; failed: string }

export const SPRITE_COLS = 2
const DEFAULT_BG = 0x01000000
const FAILED = 0xe06c75
const WHITE = 0xf2f2f2
const COLORS: Record<Avatar, { main: number; accent: number }> = {
  claude: { main: 0xd97757, accent: 0xd97757 },
  gpt: { main: WHITE, accent: WHITE },
  kimi: { main: WHITE, accent: 0x5b7fff },
}
const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

// 'X' is the main color, 'B' the accent. Color is per cell, so the Kimi dot (upper right,
// in the right cell) turns that whole cell blue: the K's right half and the dot. A frame
// is 4 rows of 4 pixels; a cadence plays the frames in order.
const FRAMES: Record<Avatar, string[][]> = {
  // eyes are the gaps; the legs alternate
  claude: [
    ['XXXX', 'X..X', 'XXXX', 'X..X'],
    ['XXXX', 'X..X', 'XXXX', '.XX.'],
  ],
  // a ring with a center gap, turning
  gpt: [
    ['.XX.', 'X..X', 'X..X', '.XX.'],
    ['XXX.', 'X..X', 'X..X', '.XXX'],
    ['.XXX', 'X..X', 'X..X', 'XXX.'],
  ],
  // the K flips left to right, its dot stays
  kimi: [
    ['X.XB', 'XX..', 'XX..', 'X.X.'],
    ['X.XB', '.XX.', '.XX.', 'X.X.'],
  ],
}
const CADENCE: Record<Avatar, number[]> = { claude: [0, 1], gpt: [0, 1, 0, 2], kimi: [0, 0, 1, 1] }

function encode(frame: string[], main: number, accent: number): string {
  const words = new Uint32Array(SPRITE_COLS * 3)
  for (let cell = 0; cell < SPRITE_COLS; cell++) {
    let bits = 0
    let hasAccent = false
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 4; dy++) {
        const pixel = frame[dy]?.[cell * 2 + dx]
        if (pixel === 'X' || pixel === 'B') bits |= DOT_BITS[dx]?.[dy] ?? 0
        if (pixel === 'B') hasAccent = true
      }
    }
    words.set([bits ? 0x2800 + bits : 0x20, hasAccent ? accent : main, DEFAULT_BG], cell * 3)
  }
  return btoa(String.fromCharCode(...new Uint8Array(words.buffer)))
}

const dim = (rgb: number) => ((((rgb >> 16) & 255) * 0.4) << 16) | ((((rgb >> 8) & 255) * 0.4) << 8) | ((rgb & 255) * 0.4)

const LOOKS = Object.fromEntries(
  (Object.keys(FRAMES) as Avatar[]).map(avatar => {
    const { main, accent } = COLORS[avatar]
    const frames = FRAMES[avatar]
    const encoded = frames.map(frame => encode(frame, main, accent))
    return [avatar, {
      run: CADENCE[avatar].map(i => encoded[i] ?? ''),
      done: encode(frames[0] ?? [], dim(main), dim(accent)),
      failed: encode(frames[0] ?? [], FAILED, FAILED),
    }]
  }),
) as Record<Avatar, Look>

export function avatarCells(avatar: Avatar, status: 'running' | 'done' | 'failed' | 'dead', tick: number): string {
  const look = LOOKS[avatar]
  if (status === 'running') return look.run[tick % look.run.length] ?? ''
  return status === 'done' ? look.done : look.failed
}

export function avatarOf(kind: string): Avatar | null {
  return kind === 'gpt' || kind === 'kimi' ? kind : kind === 'claude' || kind === 'claude-panel' ? 'claude' : null
}
