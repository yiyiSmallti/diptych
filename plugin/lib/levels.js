// The levels. Each is drawn with a few fills on an empty room so the
// geometry stays readable; engine.js parses the resulting rows. Map
// characters: # wall, = ledge, . air, ^ lava, ~ frost water, % ooze,
// * Ember's gem, o Rime's gem, E / R exits, 1 / 2 starts, other letters
// the objects (lower case for buttons and levers, upper case for gates
// and lifts).
//
// Physics to design against (engine.js P): a hero climbs 2 tiles, clears
// a 3-tile gap in the open (a 5-tile pool is a wall for the hero it
// kills), and under a 2-tile-high ceiling can only hop 1 tile up. Ledges
// are jumped through from below and stood on from above. Every level is
// checked by e2e/solver.mjs: it can be solved, every gem can be reached,
// and neither hero reaches its exit without the other's help.

function room (w, h) {
  const g = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (x === 0 || y === 0 || x === w - 1 || y === h - 1 ? '#' : '.')))
  const api = {
    fill (x0, y0, x1, y1, ch) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g[y][x] = ch; return api },
    put (x, y, ch) { g[y][x] = ch; return api },
    rows: () => g.map((r) => r.join(''))
  }
  return api
}

const button = { type: 'button' }
const lever = { type: 'lever' }
const gate = (by, o = {}) => ({ type: 'gate', h: 2, ...o, by })
const lift = (by, o = {}) => ({ type: 'lift', w: 2, ...o, by })

export const CHAPTERS = [
  { from: 1, name: '初见', en: 'First Light' },
  { from: 7, name: '机关', en: 'Machinery' },
  { from: 13, name: '高塔', en: 'The Tower' },
  { from: 19, name: '熔炉', en: 'The Forge' },
  { from: 25, name: '双联', en: 'Diptych' }
]

const DEFS = [
  // ---------------------------------------------------------- 初见
  {
    name: '两条路',
    en: 'Two Ways',
    tip: '烬踩住右边的按钮 b，左边的闸门 A 才开；凇进去拉下拉杆 l，烬那边的闸门 B 就一直开着。',
    map: room(28, 10)
      .fill(1, 6, 26, 6, '#').fill(1, 3, 26, 3, '#')
      .put(2, 8, '1').put(25, 8, '2')
      .fill(7, 8, 11, 8, '^').fill(16, 8, 20, 8, '~')
      .put(13, 8, '#').fill(12, 6, 14, 6, '.')
      .put(3, 5, 'l').put(7, 4, 'A').put(18, 5, 'b').put(21, 4, 'B')
      .put(2, 5, '#').fill(1, 3, 2, 3, '.')
      .put(25, 5, '#').fill(25, 3, 26, 3, '.')
      .put(10, 5, 'o').put(16, 5, '*')
      .fill(13, 1, 14, 2, '#')
      .put(5, 2, 'R').put(8, 2, 'o').put(22, 2, 'E').put(19, 2, '*'),
    objects: { l: lever, b: button, A: gate(['b']), B: gate(['l']) }
  },
  {
    name: '升降台',
    en: 'The Lift',
    tip: '有人踩着按钮 a，升降台 P 就升上去；上面的拉杆 v 也能让它停在上面。先上去的人要把它放下来接同伴。',
    map: room(28, 12)
      .fill(1, 4, 26, 7, '#').fill(12, 4, 13, 7, '.')
      .fill(1, 10, 26, 10, '#').fill(12, 10, 13, 10, '.').put(12, 10, 'P')
      .put(2, 9, '1').put(4, 9, '2').put(8, 9, 'a')
      .fill(16, 9, 17, 9, '^').put(18, 9, '*').fill(21, 9, 22, 9, '~').put(13, 6, 'o')
      .put(15, 3, 'v')
      .fill(9, 3, 10, 3, '%').fill(4, 3, 7, 3, '~').put(2, 3, 'R').put(5, 1, 'o')
      .fill(18, 3, 21, 3, '^').put(24, 3, 'E').put(20, 1, '*'),
    objects: { a: button, v: lever, P: lift(['a', 'v'], { dy: -6 }) }
  },
  {
    name: '对岸',
    en: 'Across',
    tip: '烬踩住 b 放凇过闸门 B；凇到了那边踩住 c，烬的闸门 A 才开。',
    map: room(28, 7)
      .fill(11, 3, 14, 3, '=').put(12, 2, '1').put(13, 2, '2')
      .fill(5, 1, 5, 3, '#').put(5, 4, 'B').fill(22, 1, 22, 3, '#').put(22, 4, 'A')
      .put(2, 5, 'R').put(4, 5, 'c').put(21, 5, 'b').put(25, 5, 'E')
      .fill(8, 5, 10, 5, '^').fill(11, 5, 15, 5, '~').fill(16, 5, 18, 5, '^')
      .put(3, 2, 'o').put(24, 2, '*').put(8, 2, 'o').put(19, 2, '*'),
    objects: { b: button, c: button, A: gate(['c']), B: gate(['b']) }
  },
  {
    name: '两把钥匙',
    en: 'Two Keys',
    tip: '拉杆 v 在寒潭那头，只有凇过得去，它开的是烬的闸门 A；拉杆 l 在熔岩那头，开凇的闸门 B。',
    map: room(28, 7)
      .put(2, 5, 'R').put(6, 5, 'v').fill(8, 5, 12, 5, '~').put(13, 5, '2').put(14, 5, '1')
      .fill(15, 5, 19, 5, '^').put(21, 5, 'l').put(25, 5, 'E')
      .fill(4, 1, 4, 3, '#').put(4, 4, 'B').fill(23, 1, 23, 3, '#').put(23, 4, 'A').put(10, 3, 'o').put(17, 3, '*'),
    objects: { v: lever, l: lever, A: gate(['v']), B: gate(['l']) }
  },
  {
    name: '接力',
    en: 'Relay',
    tip: '一层一层轮流开路：凇踩 b 放烬过 A，烬拉 c 放凇过 C，凇踩 d 放烬过 D。',
    map: room(28, 14)
      .fill(1, 10, 26, 10, '#').fill(1, 7, 26, 7, '#').fill(1, 4, 26, 4, '#')
      .put(2, 12, '1').put(3, 12, '2')
      .put(5, 12, '#').fill(5, 10, 6, 10, '.')
      .put(9, 11, 'A')
      .fill(12, 12, 16, 12, '^').put(14, 11, '*')
      .put(19, 12, '#').fill(19, 10, 20, 10, '.')
      .put(2, 9, 'b').put(8, 8, 'C').put(10, 9, '#').fill(10, 7, 11, 7, '.')
      .fill(12, 9, 16, 9, '%')
      .put(17, 9, 'c').put(23, 8, 'D').put(25, 9, '#').fill(25, 7, 26, 7, '.').put(3, 8, 'o')
      .fill(14, 6, 18, 6, '~').put(16, 5, 'o').put(19, 6, 'd')
      .put(23, 6, '#').fill(22, 4, 23, 4, '.')
      .fill(14, 3, 15, 3, '%').put(8, 3, 'E').put(6, 3, 'R').put(18, 1, '*').put(11, 2, 'o'),
    objects: { b: button, c: lever, d: button, A: gate(['b']), C: gate(['c']), D: gate(['d']) }
  },
  {
    name: '踏板',
    en: 'Ledges',
    tip: '木踏板 = 能从下面跳上去。凇踩住 b，烬那边顶上的闸门 A 才开；烬上去拉 l，凇那边的闸门 B 就开了。',
    map: room(28, 13)
      .fill(2, 10, 4, 10, '=').fill(5, 8, 7, 8, '=').fill(2, 6, 4, 6, '=').fill(5, 4, 7, 4, '=').fill(1, 2, 8, 2, '=')
      .fill(23, 10, 25, 10, '=').fill(20, 8, 22, 8, '=').fill(23, 6, 25, 6, '=').fill(20, 4, 22, 4, '=').fill(19, 2, 26, 2, '=')
      .put(2, 1, 'E').put(3, 1, 'l').put(4, 1, 'A')
      .put(25, 1, 'R').put(23, 1, 'B')
      .put(11, 11, '1').put(16, 11, '2').fill(13, 11, 14, 11, '%').put(18, 11, 'b')
      .put(6, 6, '*').put(21, 6, 'o'),
    objects: { b: button, l: lever, A: gate(['b'], { h: 1 }), B: gate(['l'], { h: 1 }) }
  },
  // ---------------------------------------------------------- 机关
  {
    name: '浮桥',
    en: 'Pontoon',
    tip: '毒沼谁掉下去都不行。踩着按钮时，浮桥 K 才会出现：烬踩 a 让凇过去，凇在对面踩 c 接烬过来。',
    map: room(28, 12)
      .fill(1, 9, 26, 9, '#').fill(1, 10, 26, 10, '#')
      .fill(9, 9, 18, 9, '.').fill(9, 10, 18, 10, '%').put(9, 9, 'K')
      .put(2, 8, '1').put(3, 8, '2').put(6, 8, 'a').put(21, 8, 'c')
      .put(23, 8, 'E').put(25, 8, 'R')
      .put(13, 6, '*').put(15, 6, 'o'),
    objects: { a: button, c: button, K: gate(['a', 'c'], { w: 10, h: 1, invert: true }) }
  },
  {
    name: '双锁',
    en: 'Double Lock',
    tip: '顶层的闸门 D、F 要拉杆 v 和 l 都拉下才开。v 在寒潭那头（凇），l 在熔岩那头（烬）；凇要过闸门 A，得烬踩着 b。',
    map: room(28, 9)
      .fill(1, 5, 26, 5, '#').fill(12, 5, 14, 5, '.').put(13, 7, '#')
      .put(2, 7, 'v').fill(4, 7, 8, 7, '~').put(10, 6, 'A').put(11, 7, 'b')
      .put(15, 7, '2').put(16, 7, '1').fill(18, 7, 22, 7, '^').put(24, 7, 'l')
      .put(8, 1, 'D').put(19, 1, 'F').put(3, 4, 'E').put(24, 4, 'R')
      .put(20, 6, '*').put(6, 6, 'o').put(13, 2, '*').put(5, 2, 'o'),
    objects: { b: button, v: lever, l: lever, A: gate(['b']), D: gate(['v', 'l'], { h: 4, all: true }), F: gate(['v', 'l'], { h: 4, all: true }) }
  },
  {
    name: '双塔',
    en: 'Twin Shafts',
    tip: '踩 a 升起左边的 P，踩 c 升起右边的 Q。一个人坐上去，另一个人踩按钮；先上去的人在上面踩 c 接同伴。',
    map: room(28, 12)
      .fill(1, 4, 26, 6, '#').fill(5, 4, 6, 6, '.').fill(21, 4, 22, 6, '.')
      .fill(1, 10, 26, 10, '#').fill(5, 10, 6, 10, '.').put(5, 10, 'P').fill(21, 10, 22, 10, '.').put(21, 10, 'Q')
      .put(13, 9, '1').put(14, 9, '2').put(10, 9, 'a').fill(16, 9, 17, 9, '%')
      .put(15, 3, 'c').fill(8, 3, 11, 3, '^').fill(17, 3, 19, 3, '~')
      .put(2, 3, 'E').put(25, 3, 'R').put(9, 1, '*').put(18, 1, 'o').put(3, 9, '*').put(24, 9, 'o'),
    objects: { a: button, c: button, P: lift(['a'], { dy: -6 }), Q: lift(['c'], { dy: -6 }) }
  },
  {
    name: '跳房子',
    en: 'Leapfrog',
    tip: '每个按钮开它两边的闸门。一人踩住，另一人过闸门去踩下一个，轮流往前跳。',
    map: room(28, 6)
      .put(1, 4, '1').put(2, 4, '2')
      .fill(6, 1, 6, 2, '#').fill(12, 1, 12, 2, '#').fill(18, 1, 18, 2, '#')
      .put(3, 4, 'a').put(6, 3, 'A').put(9, 4, 'c').put(12, 3, 'B').put(15, 4, 'd').put(18, 3, 'C').put(21, 4, 'f')
      .put(24, 4, 'E').put(25, 4, 'R').put(9, 1, '*').put(15, 1, 'o').put(4, 1, 'o').put(22, 1, '*'),
    objects: {
      a: button, c: button, d: button, f: button,
      A: gate(['a', 'c']), B: gate(['c', 'd']), C: gate(['d', 'f'])
    }
  },
  {
    name: '反闸',
    en: 'Turnstile',
    tip: '踩着 b 时闸门 A 开、闸门 B 关；离开 b 正好反过来。先过 A 的人在两扇门之间等一等，过了 B 再拉 l，A 就一直开着了。',
    map: room(28, 7)
      .put(2, 5, '1').put(3, 5, '2').put(5, 5, 'b')
      .fill(9, 1, 9, 3, '#').put(9, 4, 'A').fill(15, 1, 15, 3, '#').put(15, 4, 'B')
      .fill(11, 5, 13, 5, '~').put(19, 5, 'l').put(23, 5, 'E').put(25, 5, 'R')
      .put(12, 2, 'o').put(7, 2, '*').put(21, 2, '*').put(17, 2, 'o'),
    objects: { b: button, l: lever, A: gate(['b', 'l']), B: gate(['b'], { invert: true }) }
  },
  {
    name: '倒吊台',
    en: 'Upside Down',
    tip: '升降台 Q 平时停在上面，有人踩着 c 才降下来。烬在上面踩 c 接凇上来；凇过寒潭去拉 v，下面的闸门 G 才开，烬从左边的洞跳下去。',
    map: room(28, 12)
      .fill(1, 4, 26, 7, '#').fill(14, 4, 15, 7, '.').fill(7, 4, 7, 7, '.')
      .fill(1, 10, 26, 10, '#').fill(14, 10, 15, 10, '.').put(14, 10, 'Q')
      .put(4, 3, '1').put(11, 3, 'c').fill(17, 3, 21, 3, '~').put(23, 3, 'v').put(25, 3, 'R')
      .put(3, 9, '2').put(19, 8, 'G').put(24, 9, 'E')
      .put(2, 1, '*').put(19, 1, 'o').put(10, 9, 'o').put(22, 9, '*'),
    objects: { c: button, v: lever, Q: lift(['c'], { dy: -6, invert: true }), G: gate(['v']) }
  },
  // ---------------------------------------------------------- 高塔
  {
    name: '塔',
    en: 'The Tower',
    tip: '一层一个办法：踏板跳上二层；二层踩 a 让升降台 P 上三层（上面的拉杆 v 也管它）；三层踩 b 打开天窗 T，顶上的拉杆 m 让它一直开着。',
    map: room(22, 18)
      .fill(1, 3, 20, 3, '#').put(9, 3, 'T').fill(10, 3, 11, 3, '.')
      .fill(1, 7, 20, 7, '#').fill(16, 7, 17, 7, '.')
      .fill(1, 13, 20, 13, '#').fill(5, 13, 7, 13, '=').fill(16, 13, 17, 13, '.').put(16, 13, 'P')
      .put(2, 16, '1').put(3, 16, '2').fill(4, 15, 6, 15, '=').fill(9, 16, 10, 16, '^').fill(13, 16, 14, 16, '~')
      .put(10, 12, 'a').fill(12, 12, 13, 12, '%')
      .fill(9, 5, 11, 5, '=').put(3, 6, 'b').put(19, 6, 'v')
      .put(13, 2, 'm').put(2, 2, 'E').put(19, 2, 'R')
      .put(9, 15, '*').put(14, 15, 'o').put(12, 9, '*').put(6, 5, 'o').put(16, 1, '*'),
    objects: { a: button, v: lever, b: button, m: lever, P: lift(['a', 'v'], { dy: -6 }), T: gate(['b', 'm'], { w: 3, h: 1 }) }
  },
  {
    name: '天窗',
    en: 'Skylights',
    tip: '天窗 S、U 打开才能从下面的踏板跳上去。c 在寒潭那头，只有凇能踩；先上去的人拉上面的拉杆，天窗就一直开着。',
    map: room(22, 14)
      .fill(1, 9, 20, 9, '#').put(10, 9, 'S').fill(11, 9, 12, 9, '.')
      .fill(1, 5, 20, 5, '#').put(2, 5, 'U').fill(3, 5, 4, 5, '.')
      .fill(10, 11, 12, 11, '=').fill(2, 7, 4, 7, '=')
      .put(17, 12, '1').put(18, 12, '2').put(4, 12, 'a').fill(6, 12, 7, 12, '^')
      .put(7, 8, 'm').fill(15, 8, 17, 8, '~').put(18, 8, 'c')
      .put(12, 4, 'n').put(6, 4, 'E').put(19, 4, 'R')
      .put(6, 11, '*').put(14, 6, 'o').put(11, 2, '*').put(16, 2, 'o'),
    objects: { a: button, m: lever, c: button, n: lever, S: gate(['a', 'm'], { w: 3, h: 1 }), U: gate(['c', 'n'], { w: 3, h: 1 }) }
  },
  {
    name: '落门',
    en: 'Trapdoor',
    tip: '凇被关在上面。烬踩 a 打开地板 T，凇掉下去拉 v 开闸门 G；寒潭上的浮桥 K 要凇踩着 c 才出现。',
    map: room(28, 10)
      .fill(13, 1, 13, 3, '#').fill(23, 1, 23, 3, '#').fill(14, 4, 22, 4, '#').put(17, 4, 'T').put(18, 4, '.')
      .put(16, 3, '2').put(3, 8, '1').put(6, 8, 'a').fill(13, 1, 13, 6, '#').put(13, 7, 'G')
      .fill(15, 8, 19, 8, '~').put(15, 8, 'K').put(14, 8, 'v').put(21, 8, 'c').put(25, 8, 'E').put(23, 8, 'R')
      .put(20, 2, 'o').put(9, 5, '*').put(17, 6, '*').put(10, 8, 'o'),
    objects: { a: button, v: lever, c: button, T: gate(['a'], { w: 2, h: 1 }), G: gate(['v']), K: gate(['c'], { w: 5, h: 1, invert: true }) }
  },
  {
    name: '吊桥',
    en: 'Drawbridges',
    tip: '下面是毒沼。踩着 a，下层的吊桥 K 出现；对面上层踩着 c，上层的吊桥 J 出现。',
    map: room(24, 14)
      .fill(1, 12, 22, 12, '%')
      .fill(1, 10, 6, 10, '=').fill(2, 8, 3, 8, '=').fill(1, 6, 6, 6, '=')
      .fill(17, 10, 22, 10, '=').fill(20, 8, 21, 8, '=').fill(17, 6, 22, 6, '=').fill(17, 4, 22, 4, '=')
      .put(7, 10, 'K').put(7, 6, 'J')
      .put(3, 9, '1').put(4, 9, '2').put(2, 9, 'a').put(21, 5, 'c')
      .put(19, 3, 'E').put(21, 3, 'R')
      .put(11, 8, 'o').put(11, 4, '*').put(3, 2, '*').put(20, 7, 'o'),
    objects: { a: button, c: button, K: gate(['a'], { w: 10, h: 1, invert: true }), J: gate(['c'], { w: 10, h: 1, invert: true }) }
  },
  {
    name: '换层',
    en: 'Swap',
    tip: '踩着 b，左边的 P 升起、右边的 Q 降下；离开 b 就反过来。烬要上去，凇要下来：两个人轮流踩 b。',
    map: room(28, 12)
      .fill(1, 4, 26, 7, '#').fill(5, 4, 6, 7, '.').fill(21, 4, 22, 7, '.')
      .fill(1, 10, 26, 10, '#').fill(5, 10, 6, 10, '.').put(5, 10, 'P').fill(21, 10, 22, 10, '.').put(21, 10, 'Q')
      .fill(3, 3, 4, 3, '^').fill(7, 3, 11, 3, '^').put(2, 3, 'E').put(14, 3, '2').put(17, 3, 'b')
      .put(9, 9, '1').fill(13, 9, 15, 9, '~').put(25, 9, 'R')
      .put(9, 1, '*').put(14, 1, 'o').put(11, 8, '*').put(24, 8, 'o'),
    objects: { b: button, P: lift(['b'], { dy: -6 }), Q: lift(['b'], { dy: -6, invert: true }) }
  },
  {
    name: '登顶',
    en: 'Summit',
    tip: '凇踩 a，烬坐升降台 P 上二层；烬拉 l 打开凇头顶的天窗 T。顶层出口前的闸门 X 要 l 和寒潭那头的 m 都拉下才开。',
    map: room(22, 17)
      .fill(1, 15, 20, 15, '#').fill(16, 15, 17, 15, '.').put(16, 15, 'P')
      .fill(1, 11, 20, 11, '#').put(2, 11, 'T').fill(3, 11, 4, 11, '.').fill(16, 11, 17, 11, '.')
      .fill(1, 7, 20, 7, '#').fill(8, 7, 9, 7, '=')
      .fill(2, 13, 4, 13, '=').fill(6, 14, 8, 14, '~').put(10, 14, '1').put(11, 14, '2').put(13, 14, 'a')
      .fill(8, 9, 9, 9, '=').fill(10, 10, 12, 10, '^').put(14, 10, 'l')
      .put(5, 1, 'X').put(2, 6, 'E').put(3, 6, 'R').fill(14, 6, 18, 6, '~').put(20, 6, 'm')
      .put(3, 3, '*').put(16, 4, 'o').put(11, 9, '*').put(7, 13, 'o'),
    objects: { a: button, l: lever, m: lever, P: lift(['a'], { dy: -4 }), T: gate(['l'], { w: 3, h: 1 }), X: gate(['l', 'm'], { h: 6, all: true }) }
  },
  // ---------------------------------------------------------- 熔炉
  {
    name: '熔岩桥',
    en: 'Lava Bridges',
    tip: '熔岩和寒潭上的浮桥要有人踩着按钮才在：烬踩 a 给凇搭桥；凇踩 c 给烬搭桥；烬再踩 d 给凇搭最后一座。',
    map: room(30, 8)
      .put(1, 6, '1').put(2, 6, '2').put(3, 6, 'a')
      .fill(5, 6, 9, 6, '^').put(5, 6, 'K').put(11, 6, 'c')
      .fill(13, 6, 17, 6, '~').put(13, 6, 'J').put(19, 6, 'd')
      .fill(21, 6, 25, 6, '^').put(21, 6, 'H').put(27, 6, 'E').put(28, 6, 'R')
      .put(7, 3, 'o').put(15, 3, '*').put(23, 3, 'o').put(11, 2, '*'),
    objects: {
      a: button, c: button, d: button,
      K: gate(['a'], { w: 5, h: 1, invert: true }), J: gate(['c'], { w: 5, h: 1, invert: true }), H: gate(['d'], { w: 5, h: 1, invert: true })
    }
  },
  {
    name: '冰河',
    en: 'Frozen River',
    tip: '凇蹚过寒潭去对岸踩 b，左边的升降台 P 送烬上高处的木栈道；烬走栈道时顺手拉 l，凇的闸门 G 才开。',
    map: room(28, 13)
      .fill(1, 11, 26, 11, '#').fill(3, 11, 4, 11, '.').put(3, 11, 'P')
      .fill(7, 10, 20, 10, '~').fill(6, 5, 21, 5, '=')
      .put(1, 10, '1').put(5, 10, '2')
      .put(21, 10, 'E').put(23, 10, 'b').put(24, 9, 'G').put(25, 10, 'R').fill(24, 1, 24, 8, '#')
      .put(14, 4, 'l').put(13, 8, 'o').put(18, 3, '*').put(9, 3, '*').put(17, 8, 'o'),
    objects: { b: button, l: lever, P: lift(['b'], { dy: -6 }), G: gate(['l']) }
  },
  {
    name: '毒井',
    en: 'Ooze Well',
    tip: '毒沼上的两座升降台 P、Q 要有人踩着 a 或 d 才浮上来：烬踩 a 让凇跳过去，凇在对岸踩 d 接烬。',
    map: room(28, 11)
      .fill(1, 9, 26, 9, '#').fill(8, 8, 19, 8, '%').fill(10, 9, 11, 9, '.').put(10, 9, 'P').fill(15, 9, 16, 9, '.').put(15, 9, 'Q')
      .put(2, 8, '1').put(3, 8, '2').put(5, 8, 'a').put(22, 8, 'd').put(24, 8, 'E').put(25, 8, 'R')
      .put(13, 4, '*').put(13, 3, 'o').put(1, 6, '*').put(26, 6, 'o')
      .fill(1, 7, 2, 7, '#').fill(25, 7, 26, 7, '#'),
    objects: { a: button, d: button, P: lift(['a', 'd'], { dy: -2 }), Q: lift(['a', 'd'], { dy: -2 }) }
  },
  {
    name: '交错',
    en: 'Crosswise',
    tip: '上层是烬的路，下层是凇的路，每扇闸门的按钮都在另一层：a 开 H，c 开 G，b 开 K，d 开 J。',
    map: room(28, 9)
      .fill(1, 4, 26, 4, '#')
      .put(1, 3, '1').put(4, 3, 'a').fill(6, 3, 7, 3, '^').put(9, 1, 'G').fill(11, 3, 11, 3, '^').put(13, 3, 'b').put(17, 1, 'J').fill(19, 3, 21, 3, '^').put(25, 3, 'E')
      .put(1, 7, '2').fill(3, 7, 4, 7, '~').put(7, 5, 'H').put(11, 7, 'c').fill(13, 7, 13, 7, '~').put(15, 5, 'K').put(19, 7, 'd').fill(21, 7, 22, 7, '~').put(25, 7, 'R')
      .put(15, 1, '*').put(23, 5, 'o').put(6, 1, '*').put(10, 5, 'o'),
    objects: {
      a: button, b: button, c: button, d: button,
      G: gate(['c'], { h: 3 }), J: gate(['d'], { h: 3 }), H: gate(['a'], { h: 3 }), K: gate(['b'], { h: 3 })
    }
  },
  {
    name: '锻炉',
    en: 'Smithy',
    tip: '熔岩湖里的拉杆只有烬拿得到：l 升起 P，m 升起 S，l 和 m 都拉下 Q 才升起。凇踩着升降台过湖，再去踩 b 打开烬的闸门 G。',
    map: room(28, 12)
      .fill(1, 10, 26, 10, '#').fill(5, 9, 20, 9, '^')
      .fill(7, 10, 8, 10, '.').put(7, 10, 'P').fill(12, 10, 13, 10, '.').put(12, 10, 'Q').fill(17, 10, 18, 10, '.').put(17, 10, 'S')
      .put(10, 9, 'l').put(15, 9, 'm')
      .put(2, 9, '1').put(3, 9, '2').put(22, 9, 'R').put(21, 9, 'b').fill(24, 1, 24, 7, '#').put(24, 8, 'G').put(25, 9, 'E')
      .put(12, 5, 'o').put(17, 5, 'o').put(4, 6, '*').put(26, 6, '*'),
    objects: { l: lever, m: lever, b: button, P: lift(['l'], { dy: -2 }), Q: lift(['l', 'm'], { dy: -2, all: true }), S: lift(['m'], { dy: -2 }), G: gate(['b']) }
  },
  {
    name: '熔炉心',
    en: 'Heart of the Forge',
    tip: '凇踩 a 让烬坐 P 上去；烬在上面拉 l，浮桥 K 架到熔岩上，凇过桥去踩 c，烬的寒潭上才有桥 J。',
    map: room(28, 12)
      .fill(1, 6, 26, 6, '#').fill(3, 6, 4, 6, '.')
      .fill(1, 10, 26, 10, '#').fill(3, 10, 4, 10, '.').put(3, 10, 'P')
      .put(7, 9, '1').put(9, 9, '2').put(12, 9, 'a').fill(14, 9, 18, 9, '^').put(14, 9, 'K').put(20, 9, 'c').put(23, 9, 'R')
      .fill(24, 7, 24, 8, '#').put(25, 9, '.')
      .put(8, 5, 'l').fill(12, 5, 16, 5, '~').put(12, 5, 'J').put(22, 5, 'E')
      .put(16, 7, 'o').put(14, 2, '*').put(25, 8, 'o').put(2, 2, '*'),
    objects: { a: button, l: lever, c: button, P: lift(['a'], { dy: -4 }), K: gate(['l'], { w: 5, h: 1, invert: true }), J: gate(['c'], { w: 5, h: 1, invert: true }) }
  },
  // ---------------------------------------------------------- 双联
  {
    name: '镜像',
    en: 'Mirror',
    tip: '左边是烬的半幅，右边是凇的半幅，可开关都在对方那边：凇踩 c 送烬坐 P；烬拉 l 送凇坐 Q；到了顶上，烬拉 n 开凇的闸门 Y，凇拉 m 开烬的闸门 X。',
    map: room(28, 15)
      .fill(1, 5, 26, 5, '#').fill(1, 9, 26, 9, '#').fill(1, 13, 26, 13, '#').fill(13, 1, 14, 8, '#')
      .fill(2, 9, 3, 9, '.').fill(2, 13, 3, 13, '.').put(2, 13, 'P').fill(24, 9, 25, 9, '.').fill(24, 13, 25, 13, '.').put(24, 13, 'Q')
      .fill(7, 7, 8, 7, '=').fill(7, 5, 8, 5, '=').fill(19, 7, 20, 7, '=').fill(19, 5, 20, 5, '=')
      .put(2, 4, 'E').put(4, 1, 'X').put(10, 4, 'n').put(25, 4, 'R').put(23, 1, 'Y').put(17, 4, 'm')
      .fill(5, 8, 6, 8, '^').put(11, 8, 'l').fill(21, 8, 22, 8, '~')
      .put(12, 12, '1').put(15, 12, '2').fill(6, 12, 8, 12, '^').fill(19, 12, 21, 12, '~').put(23, 12, 'c')
      .put(7, 10, '*').put(20, 10, 'o').put(5, 6, '*').put(22, 6, 'o').put(10, 1, '*').put(17, 1, 'o'),
    objects: { c: button, l: lever, m: lever, n: lever, P: lift(['c'], { dy: -4 }), Q: lift(['l'], { dy: -4 }), X: gate(['m'], { h: 4 }), Y: gate(['n'], { h: 4 }) }
  },
  {
    name: '回廊',
    en: 'Gallery',
    tip: '底层往右：一人踩 a，另一人过闸门 A 上二层拉 l。二层往左：踩着 d，升降台 P 就上去，顶上的拉杆 m 也管它。顶层坑里的拉杆 n 和 k 都拉下，X 才开。',
    map: room(28, 14)
      .fill(1, 5, 26, 5, '#').fill(1, 9, 26, 9, '#')
      .put(1, 12, '1').put(2, 12, '2').put(4, 12, 'a').put(7, 10, 'A').fill(10, 12, 11, 12, '^').fill(14, 12, 15, 12, '~').fill(18, 12, 19, 12, '%')
      .fill(24, 11, 25, 11, '=').fill(24, 9, 25, 9, '=')
      .put(22, 8, 'l').put(12, 8, 'd').fill(5, 8, 6, 8, '%').fill(2, 9, 3, 9, '.').put(2, 9, 'P').fill(2, 5, 3, 5, '.')
      .put(6, 4, 'm').fill(9, 5, 11, 5, '.').fill(9, 6, 11, 6, '#').fill(9, 5, 10, 5, '^').put(11, 5, 'n')
      .fill(15, 5, 17, 5, '.').fill(15, 6, 17, 6, '#').fill(16, 5, 17, 5, '~').put(15, 5, 'k')
      .put(21, 1, 'X').put(24, 4, 'E').put(25, 4, 'R')
      .put(10, 2, '*').put(16, 2, 'o').put(14, 10, 'o').put(10, 10, '*').put(19, 6, '*').put(8, 6, 'o'),
    objects: {
      a: button, l: lever, d: button, m: lever, n: lever, k: lever,
      A: gate(['a', 'l'], { h: 3 }), P: lift(['d', 'm'], { dy: -4 }), X: gate(['n', 'k'], { h: 4, all: true })
    }
  },
  {
    name: '守桥',
    en: 'Bridgekeepers',
    tip: '三座毒沼上的桥，每个按钮管它两边的桥：一人踩住，另一人过桥去踩下一个，轮流往前。',
    map: room(32, 10)
      .fill(1, 7, 30, 7, '#').fill(5, 7, 9, 7, '.').fill(5, 8, 9, 8, '%').fill(13, 7, 17, 7, '.').fill(13, 8, 17, 8, '%').fill(21, 7, 25, 7, '.').fill(21, 8, 25, 8, '%')
      .put(5, 7, 'K').put(13, 7, 'J').put(21, 7, 'H')
      .put(1, 6, '1').put(2, 6, '2').put(3, 6, 'a').put(11, 6, 'c').put(19, 6, 'd').put(27, 6, 'f').put(29, 6, 'E').put(30, 6, 'R')
      .put(7, 3, 'o').put(15, 3, '*').put(23, 3, 'o').put(11, 3, '*'),
    objects: {
      a: button, c: button, d: button, f: button,
      K: gate(['a', 'c'], { w: 5, h: 1, invert: true }), J: gate(['c', 'd'], { w: 5, h: 1, invert: true }), H: gate(['d', 'f'], { w: 5, h: 1, invert: true })
    }
  },
  {
    name: '上下',
    en: 'Up and Down',
    tip: '烬要下去，凇要上来。凇踩 c 打开烬脚下的地板 T；烬下来后踩 b，升降台 P 送凇上去。',
    map: room(28, 12)
      .fill(1, 5, 26, 6, '#').fill(1, 10, 26, 10, '#')
      .put(3, 5, 'T').fill(4, 5, 5, 6, '.').fill(3, 6, 3, 6, '.')
      .fill(12, 5, 13, 6, '.').fill(12, 10, 13, 10, '.').put(12, 10, 'P')
      .put(1, 4, '1').fill(7, 4, 11, 4, '~').fill(14, 4, 15, 4, '~').put(26, 4, 'R')
      .put(1, 9, '2').put(6, 9, 'c').put(17, 9, 'b').fill(20, 9, 22, 9, '^').put(26, 9, 'E')
      .put(2, 2, '*').put(19, 2, 'o').put(21, 7, '*').put(9, 8, 'o'),
    objects: { b: button, c: button, P: lift(['b'], { dy: -5 }), T: gate(['c'], { w: 3, h: 2 }) }
  },
  {
    name: '天平',
    en: 'Balance',
    tip: '踩着 b，左边的 P 升、右边的 Q 降。两人换了上下层以后，还要互相开门：凇在下面拉 v 开烬的闸门 G，烬在上面拉 u 开凇的闸门 H。',
    map: room(28, 12)
      .fill(1, 4, 26, 7, '#').fill(5, 4, 6, 7, '.').fill(21, 4, 22, 7, '.')
      .fill(1, 10, 26, 10, '#').fill(5, 10, 6, 10, '.').put(5, 10, 'P').fill(21, 10, 22, 10, '.').put(21, 10, 'Q')
      .put(3, 3, '^').fill(7, 3, 11, 3, '^').put(2, 3, 'E').put(4, 2, 'G').put(12, 3, 'u').put(14, 3, '2').put(17, 3, 'b')
      .put(9, 9, '1').fill(13, 9, 15, 9, '~').put(19, 9, 'v').put(25, 9, 'R').put(24, 8, 'H')
      .put(9, 1, '*').put(14, 1, 'o').put(11, 8, '*').put(17, 8, 'o'),
    objects: { b: button, u: lever, v: lever, P: lift(['b'], { dy: -6 }), Q: lift(['b'], { dy: -6, invert: true }), G: gate(['v']), H: gate(['u']) }
  },
  {
    name: '双联画',
    en: 'Diptych',
    tip: '最后一关，三层楼把前面的都用上：底层轮流踩按钮过两扇闸门；二层的浮桥 K 要对岸有人踩着；升降台 P 上顶层；顶层两头的拉杆 n、k 都拉下，X 才开，出口在高台上。',
    map: room(30, 18)
      .fill(1, 16, 28, 16, '#').fill(1, 12, 28, 12, '#').fill(1, 7, 28, 7, '#')
      .put(1, 15, '1').put(2, 15, '2').put(3, 15, 'a').put(6, 13, 'A').put(9, 15, 'c').put(12, 13, 'B').put(15, 15, 'd')
      .fill(18, 15, 19, 15, '^').fill(22, 15, 23, 15, '~').fill(26, 14, 27, 14, '=').fill(26, 12, 27, 12, '=')
      .put(23, 11, 'e').fill(12, 11, 19, 11, '%').put(12, 11, 'K').put(10, 11, 'f').put(5, 11, 'g')
      .fill(8, 12, 9, 12, '.').put(8, 12, 'P').fill(8, 7, 9, 7, '.')
      .put(1, 6, 'n').fill(2, 6, 6, 6, '^').put(11, 6, 'm').fill(21, 6, 25, 6, '~').put(27, 6, 'k')
      .fill(13, 5, 14, 5, '=').fill(15, 3, 19, 3, '#').put(14, 1, 'X').put(16, 2, 'E').put(18, 2, 'R')
      .put(4, 3, '*').put(23, 3, 'o').put(16, 9, '*').put(14, 9, 'o').put(20, 14, '*').put(10, 14, 'o'),
    objects: {
      a: button, c: button, d: button, e: button, f: button, g: button, m: lever, n: lever, k: lever,
      A: gate(['a', 'c'], { h: 3 }), B: gate(['c', 'd'], { h: 3 }),
      K: gate(['e', 'f'], { w: 8, h: 1, invert: true }),
      P: lift(['g', 'm'], { dy: -5 }),
      X: gate(['n', 'k'], { all: true })
    }
  }
]

export const LEVELS = DEFS.map((d, i) => {
  const map = d.map.rows()
  for (const r of map) if (r.length !== map[0].length) throw new Error(`level ${i + 1}: ragged map`)
  return { id: String(i + 1), name: d.name, en: d.en, tip: d.tip, map, objects: d.objects }
})
