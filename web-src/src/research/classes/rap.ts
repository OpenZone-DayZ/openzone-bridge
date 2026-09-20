// raP-парсер (T7 Step 1): бінаризований config.bin -> дефініції прямих нащадків п'яти
// конфіг-коренів (ім'я, база, тіло/forward, сирий displayName=). Формат звірено
// ЕМПІРИЧНО по золотій парі (наш власний ZP_Research/config.cpp, бінаризований
// CfgConvert.exe -bin): заголовок `\0raP` + u32(0) + u32(8) + u32(офсет enum-таблиці);
// далі тіло кореневого класу з офсету 16. Тіло класу: asciiz успадкованого імені
// ('' якщо немає) + 7-бітний варінт кількості записів + записи. Типи записів (перший
// байт): 0 = підклас (asciiz ім'я + u32 АБСОЛЮТНИЙ офсет тіла), 1 = значення (байт
// підтипу: 0 asciiz-рядок / 1 float32 / 2 int32; asciiz ім'я; значення), 2 = масив
// (asciiz ім'я + варінт n + елементи), 3 = extern/forward-декларація (asciiz ім'я),
// 4 = delete (asciiz ім'я), 5 = масив із прапорцями ("+=", u32 прапорці + як тип 2).
// Елементи масиву: байт підтипу 0/1/2 як у значень, 3 = вкладений масив, 4 = змінна
// (asciiz). Уся золота пара проходить цим граматичним обходом байт-у-байт до самої
// enum-таблиці (перевірено зондом до порту) — не здогадка з пам'яті.
//
// Швидкість (вимога брифа архітектурна): тіла НЕ-кореневих класів не відвідуються
// взагалі (запис підкласу несе лише ім'я+офсет — обхід тіла кореня коштує O(записів
// кореня), не O(усього файла)); asciiz-значення, які не потрібні (рядкові значення,
// елементи масивів), лише СКАНУЮТЬСЯ до нуль-байта без декодування UTF-8.

import { ROOT_NAMES } from './classIndex.ts'

export interface ConfigClassDef {
  root: number // індекс у ROOT_NAMES (0..4)
  name: string
  base: string | null
  hasBody: boolean
  displayRaw: string | null // сирий displayName= (нерозв'язаний $STR_), null якщо немає
}

const ROOT_BY_LOWER = new Map<string, number>(ROOT_NAMES.map((n, i) => [n.toLowerCase(), i]))

const decoder = new TextDecoder('utf-8')

export function isRapConfig(bytes: Uint8Array): boolean {
  return bytes.length >= 16 && bytes[0] === 0x00 && bytes[1] === 0x72 && bytes[2] === 0x61 && bytes[3] === 0x50
}

class Cursor {
  readonly buf: Uint8Array
  readonly view: DataView
  pos: number

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    this.pos = 0
  }

  fail(what: string): never {
    throw new Error(`raP: ${what} (офсет ${this.pos}, розмір ${this.buf.length})`)
  }

  u8(): number {
    if (this.pos >= this.buf.length) this.fail('обрив на байті')
    return this.buf[this.pos++]
  }

  u32(): number {
    if (this.pos + 4 > this.buf.length) this.fail('обрив на u32')
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  skip(n: number): void {
    if (this.pos + n > this.buf.length) this.fail(`обрив на пропуску ${n} байтів`)
    this.pos += n
  }

  // asciiz БЕЗ декодування — для значень, які нікому не потрібні
  skipAsciiz(): void {
    const end = this.buf.indexOf(0, this.pos)
    if (end < 0) this.fail('asciiz без термінатора')
    this.pos = end + 1
  }

  asciiz(): string {
    const end = this.buf.indexOf(0, this.pos)
    if (end < 0) this.fail('asciiz без термінатора')
    const s = decoder.decode(this.buf.subarray(this.pos, end))
    this.pos = end + 1
    return s
  }

  // 7-бітний варінт (compressed int формату raP)
  cint(): number {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = this.u8()
      value |= (byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return value >>> 0
      shift += 7
      if (shift > 28) this.fail('варінт задовгий')
    }
  }
}

// Пропустити елементи масиву (після варінта кількості) — рекурсивно для вкладених.
function skipArrayElements(c: Cursor): void {
  const n = c.cint()
  for (let i = 0; i < n; i++) {
    const subtype = c.u8()
    switch (subtype) {
      case 0:
        c.skipAsciiz()
        break
      case 1:
      case 2:
        c.skip(4)
        break
      case 3:
        skipArrayElements(c)
        break
      case 4: // змінна (ім'я enum/дефайна) — asciiz
        c.skipAsciiz()
        break
      default:
        c.fail(`невідомий підтип елемента масиву ${subtype}`)
    }
  }
}

interface BodyEntry {
  kind: 'class' | 'extern' | 'delete' | 'value-str' | 'value-num' | 'array'
  name?: string
  bodyOffset?: number // kind === 'class'
  strValue?: string // kind === 'value-str'
}

// Обхід записів ОДНОГО тіла класу з офсету offset. wantNames — чи декодувати імена
// властивостей/рядкові значення (потрібно лише на глибині, де шукаємо displayName;
// на інших рівнях імена властивостей і значення лише скануються).
function walkBody(
  c: Cursor,
  offset: number,
  wantValueNames: boolean,
  onEntry: (e: BodyEntry) => void,
): string {
  c.pos = offset
  const inherited = c.asciiz()
  const count = c.cint()
  for (let i = 0; i < count; i++) {
    const type = c.u8()
    switch (type) {
      case 0: {
        const name = c.asciiz()
        const bodyOffset = c.u32()
        onEntry({ kind: 'class', name, bodyOffset })
        break
      }
      case 1: {
        const subtype = c.u8()
        if (subtype === 0) {
          if (wantValueNames) {
            const name = c.asciiz()
            const strValue = c.asciiz()
            onEntry({ kind: 'value-str', name, strValue })
          } else {
            c.skipAsciiz()
            c.skipAsciiz()
          }
        } else if (subtype === 1 || subtype === 2) {
          c.skipAsciiz()
          c.skip(4)
          onEntry({ kind: 'value-num' })
        } else {
          c.fail(`невідомий підтип значення ${subtype}`)
        }
        break
      }
      case 2: {
        c.skipAsciiz()
        skipArrayElements(c)
        onEntry({ kind: 'array' })
        break
      }
      case 3: {
        const name = c.asciiz()
        onEntry({ kind: 'extern', name })
        break
      }
      case 4: {
        c.skipAsciiz()
        onEntry({ kind: 'delete' })
        break
      }
      case 5: {
        c.skip(4) // u32 прапорці ("+=")
        c.skipAsciiz()
        skipArrayElements(c)
        onEntry({ kind: 'array' })
        break
      }
      default:
        c.fail(`невідомий тип запису ${type}`)
    }
  }
  return inherited
}

// Тіло класу-предмета: витягнути успадковане ім'я + власний displayName. Дубль
// властивості в одному тілі тримає ПЕРШЕ значення (рев'ю T7, фікс-раунд 1, звірено
// емпірично: CfgConvert попереджає «Member already defined» і раундтрип несе перше;
// у самому raP такий дубль з'явиться хіба з нестандартного бінаризатора — семантика
// однаково дзеркалиться з текстовим парсером). displayName вкладеного підкласу НЕ
// читається — підклас у raP лише (ім'я, офсет), його тіло тут не відвідується взагалі.
function readItemClass(c: Cursor, offset: number): { base: string | null; displayRaw: string | null } {
  let displayRaw: string | null = null
  const inherited = walkBody(c, offset, true, (e) => {
    if (displayRaw === null && e.kind === 'value-str' && e.name!.toLowerCase() === 'displayname') {
      displayRaw = e.strValue!
    }
  })
  return { base: inherited === '' ? null : inherited, displayRaw }
}

export function parseRapConfig(bytes: Uint8Array): ConfigClassDef[] {
  if (!isRapConfig(bytes)) throw new Error('raP: відсутня сигнатура \\0raP')
  const c = new Cursor(bytes)
  c.pos = 4
  c.u32() // завжди 0
  c.u32() // завжди 8
  c.u32() // офсет enum-таблиці — не потрібен обходу

  // Кореневе тіло з офсету 16: знайти БЛОКИ п'яти коренів. Пізніший блок того самого
  // кореня виграє (дзеркало python "last CfgX block wins"); порядок коренів — порядок
  // ПЕРШОЇ появи у файлі (Map зберігає порядок вставки, як python-dict).
  const rootBodies = new Map<number, number>() // rootIdx -> body offset
  walkBody(c, 16, false, (e) => {
    if (e.kind === 'class') {
      const rootIdx = ROOT_BY_LOWER.get(e.name!.toLowerCase())
      if (rootIdx !== undefined) rootBodies.set(rootIdx, e.bodyOffset!)
    }
    // extern-декларація кореня (тип 3) тіла не має — як і в текстовому парсері,
    // враховуються лише блоки з тілом
  })

  const defs: ConfigClassDef[] = []
  for (const [rootIdx, bodyOffset] of rootBodies) {
    // Спершу зібрати прямих нащадків (обхід тіла кореня), ПОТІМ читати їхні тіла:
    // walkBody їздить одним спільним курсором, вкладене читання зсунуло б позицію.
    const children: Array<{ name: string; bodyOffset?: number }> = []
    walkBody(c, bodyOffset, false, (e) => {
      if (e.kind === 'class') children.push({ name: e.name!, bodyOffset: e.bodyOffset })
      else if (e.kind === 'extern') children.push({ name: e.name! })
    })
    for (const child of children) {
      if (child.bodyOffset === undefined) {
        defs.push({ root: rootIdx, name: child.name, base: null, hasBody: false, displayRaw: null })
      } else {
        const { base, displayRaw } = readItemClass(c, child.bodyOffset)
        defs.push({ root: rootIdx, name: child.name, base, hasBody: true, displayRaw })
      }
    }
  }
  return defs
}
