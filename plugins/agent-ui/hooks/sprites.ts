// Provider avatars: 2 terminal cells wide, one row tall (a square on screen). Where the
// terminal draws pictures, a 16x16 RGBA sprite fills the box; elsewhere braille (2x4 dots a
// cell, so 4x4 pixels) in a Raster, and the same braille is the picture's alt text. Every
// frame is encoded once, here.
export type Avatar = 'claude' | 'gpt' | 'kimi'
export type Status = 'running' | 'done' | 'failed' | 'dead'
export type Picture = { source: { rgba: string; width: number; height: number }; alt: string }
type Look<T> = { run: T[]; done: T; failed: T }

export const SPRITE_COLS = 2
export const SPRITE_PX = 16
const DEFAULT_BG = 0x01000000
const FAILED = 0xe06c75
const WHITE = 0xf2f2f2
const EYE = 0x1a1a1a
const COLORS: Record<Avatar, { main: number; accent: number }> = {
  claude: { main: 0xd97757, accent: 0xd97757 },
  gpt: { main: WHITE, accent: WHITE },
  kimi: { main: WHITE, accent: 0x5b7fff },
}
const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

// Braille frames, 4 rows of 4 pixels. 'X' is the main color, 'B' the accent. Color is per
// cell, so the Kimi dot (upper right, in the right cell) turns that whole cell blue: the
// K's right half and the dot. A cadence plays the frames in order.
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

// Sprite frames, 16 rows of 16 pixels, one per braille frame: 'X' main, 'B' accent, 'E' eye,
// '.' transparent.
const SPRITES: Record<Avatar, string[][]> = {
  // body, two eyes, arms out; the legs walk
  claude: [
    [
      '................', '................', '...XXXXXXXXXX...', '...XXXXXXXXXX...',
      '...XXEXXXXEXX...', '...XXEXXXXEXX...', '.XXXXXXXXXXXXXX.', '.XXXXXXXXXXXXXX.',
      '...XXXXXXXXXX...', '...XXXXXXXXXX...', '...XXXXXXXXXX...', '...XXXXXXXXXX...',
      '....XX....XX....', '....XX....XX....', '....XX..........', '................',
    ],
    [
      '................', '................', '...XXXXXXXXXX...', '...XXXXXXXXXX...',
      '...XXEXXXXEXX...', '...XXEXXXXEXX...', '.XXXXXXXXXXXXXX.', '.XXXXXXXXXXXXXX.',
      '...XXXXXXXXXX...', '...XXXXXXXXXX...', '...XXXXXXXXXX...', '...XXXXXXXXXX...',
      '....XX....XX....', '....XX....XX....', '..........XX....', '................',
    ],
  ],
  // a ring, tilting one way then the other
  gpt: [
    [
      '................', '.....XXXXXX.....', '....XXXXXXXX....', '...XXXXXXXXXX...',
      '..XXXX....XXXX..', '.XXXX......XXXX.', '.XXX........XXX.', '.XXX........XXX.',
      '.XXX........XXX.', '.XXX........XXX.', '.XXXX......XXXX.', '..XXXX....XXXX..',
      '...XXXXXXXXXX...', '....XXXXXXXX....', '.....XXXXXX.....', '................',
    ],
    [
      '................', '.....XX.........', '...XXXXXXX......', '..XXXXXXXXX.....',
      '..XXXX..XXXX....', '.XXXX.....XXX...', '.XXX.......XXX..', '..XX.......XXX..',
      '..XXX.......XX..', '..XXX.......XXX.', '...XXX.....XXXX.', '....XXXX..XXXX..',
      '.....XXXXXXXXX..', '......XXXXXXX...', '.........XX.....', '................',
    ],
    [
      '................', '.........XX.....', '......XXXXXXX...', '.....XXXXXXXXX..',
      '....XXXX..XXXX..', '...XXX.....XXXX.', '..XXX.......XXX.', '..XXX.......XX..',
      '..XX.......XXX..', '.XXX.......XXX..', '.XXXX.....XXX...', '..XXXX..XXXX....',
      '..XXXXXXXXX.....', '...XXXXXXX......', '.....XX.........', '................',
    ],
  ],
  // the K, then the K half turned; the dot stays
  kimi: [
    [
      '................', '................', '..XX......XX.BB.', '..XX.....XX..BB.',
      '..XX....XX......', '..XX...XX.......', '..XX..XX........', '..XXXXX.........',
      '..XXXXX.........', '..XX..XX........', '..XX...XX.......', '..XX....XX......',
      '..XX.....XX.....', '..XX......XX....', '................', '................',
    ],
    [
      '................', '................', '....XX...XX..BB.', '....XX..XX...BB.',
      '....XX..XX......', '....XX.XX.......', '....XX.XX.......', '....XXXX........',
      '....XXXX........', '....XX.XX.......', '....XX.XX.......', '....XX..XX......',
      '....XX..XX......', '....XX...XX.....', '................', '................',
    ],
  ],
}
const CADENCE: Record<Avatar, number[]> = { claude: [0, 1], gpt: [0, 1, 0, 2], kimi: [0, 0, 1, 1] }

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

// One braille code point a cell, with the cell's color.
function brailleCells(frame: string[], main: number, accent: number): { glyph: number; color: number }[] {
  return Array.from({ length: SPRITE_COLS }, (_, cell) => {
    let bits = 0
    let hasAccent = false
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 4; dy++) {
        const pixel = frame[dy]?.[cell * 2 + dx]
        if (pixel === 'X' || pixel === 'B') bits |= DOT_BITS[dx]?.[dy] ?? 0
        if (pixel === 'B') hasAccent = true
      }
    }
    return { glyph: bits ? 0x2800 + bits : 0x20, color: hasAccent ? accent : main }
  })
}

function encodeCells(frame: string[], main: number, accent: number): string {
  const words = Uint32Array.from(brailleCells(frame, main, accent).flatMap(({ glyph, color }) => [glyph, color, DEFAULT_BG]))
  return toBase64(new Uint8Array(words.buffer))
}

function encodeSprite(sprite: string[], main: number, accent: number): string {
  if (sprite.length !== SPRITE_PX || sprite.some(row => !new RegExp(`^[XBE.]{${SPRITE_PX}}$`).test(row))) {
    throw new Error(`agent-ui: a sprite frame must be ${SPRITE_PX} rows of ${SPRITE_PX} of X, B, E or .`)
  }
  const bytes = new Uint8Array(SPRITE_PX * SPRITE_PX * 4)
  for (let y = 0; y < SPRITE_PX; y++) {
    for (let x = 0; x < SPRITE_PX; x++) {
      const pixel = sprite[y]?.[x]
      const rgb = pixel === 'X' ? main : pixel === 'B' ? accent : pixel === 'E' ? EYE : null
      if (rgb !== null) bytes.set([(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, 255], (y * SPRITE_PX + x) * 4)
    }
  }
  return toBase64(bytes)
}

function encodePicture(avatar: Avatar, i: number, main: number, accent: number): Picture {
  const frame = FRAMES[avatar][i]
  const sprite = SPRITES[avatar][i]
  if (!frame || !sprite) throw new Error(`agent-ui: ${avatar} has no frame ${i}`)
  const alt = brailleCells(frame, main, accent).map(({ glyph }) => String.fromCodePoint(glyph)).join('')
  return { source: { rgba: encodeSprite(sprite, main, accent), width: SPRITE_PX, height: SPRITE_PX }, alt }
}

export const dim = (rgb: number) => ((((rgb >> 16) & 255) * 0.4) << 16) | ((((rgb >> 8) & 255) * 0.4) << 8) | ((rgb & 255) * 0.4)

function looks<T>(encode: (avatar: Avatar, i: number, main: number, accent: number) => T): Record<Avatar, Look<T>> {
  return Object.fromEntries(
    (Object.keys(FRAMES) as Avatar[]).map(avatar => {
      const { main, accent } = COLORS[avatar]
      const frames = FRAMES[avatar].map((_, i) => encode(avatar, i, main, accent))
      return [avatar, {
        run: CADENCE[avatar].map(i => frames[i] as T),
        done: encode(avatar, 0, dim(main), dim(accent)),
        failed: encode(avatar, 0, FAILED, FAILED),
      }]
    }),
  ) as Record<Avatar, Look<T>>
}

const CELLS = looks((avatar, i, main, accent) => encodeCells(FRAMES[avatar][i] ?? [], main, accent))
const PICTURES = looks(encodePicture)

function pick<T>(look: Look<T>, status: Status, tick: number): T {
  if (status === 'running') return look.run[tick % look.run.length] as T
  return status === 'done' ? look.done : look.failed
}

export const avatarCells = (avatar: Avatar, status: Status, tick: number): string => pick(CELLS[avatar], status, tick)
export const avatarPicture = (avatar: Avatar, status: Status, tick: number): Picture => pick(PICTURES[avatar], status, tick)

export function avatarOf(kind: string): Avatar | null {
  return kind === 'gpt' || kind === 'kimi' ? kind : kind === 'claude' || kind === 'claude-panel' ? 'claude' : null
}
