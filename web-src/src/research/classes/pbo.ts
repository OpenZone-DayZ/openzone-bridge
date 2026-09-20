// PBO-читач (T7 Step 2): заголовок (плейнтекстова таблиця імен на початку файла) + LZSS.
// Порт scripts/extract_pbo.py зі скіла (звірений байт-у-байт із BankRev.exe) — константи
// взяті З НЬОГО, не з пам'яті; LZSS-семантика підтверджена крос-імплементаційними
// векторами в tests/pbo.test.ts (очікувані байти згенеровані python-еталоном).
//
// Швидкість (вимога брифа): цей модуль працює по ШМАТКАХ, не по цілому файлу — імпортер
// читає File.slice() заголовка (з повторами при обрізанні: TruncatedPboHeader — сигнал
// «читай більший шмат»), обчислює офсети записів і читає ЛИШЕ байти потрібних записів
// (config.bin/config.cpp/stringtable.csv). Повний PBO не завантажується ніколи — модпак
// важить десятки ГБ, а конфіги в ньому — мегабайти.

export interface PboEntry {
  name: string
  packing: number
  originalSize: number
  dataSize: number
  dataOffset: number // абсолютний офсет даних запису від початку PBO-файла
}

export const PBO_PACKING_CPRS = 0x43707273 // 'Cprs' — LZSS-стиснутий запис
const PBO_PACKING_VERS = 0x56657273 // 'Vers' — блок властивостей без даних

// Сигнал «заголовок не вмістився в прочитаний шмат» — НЕ помилка формату: викликач
// повторює читання з більшим розміром (експоненційно), доки не впреться в кінець файла.
export class TruncatedPboHeader extends Error {
  constructor(what: string) {
    super(`PBO: обрізаний заголовок (${what})`)
    this.name = 'TruncatedPboHeader'
  }
}

const decoder = new TextDecoder('utf-8')

class HeaderCursor {
  readonly buf: Uint8Array
  readonly view: DataView
  pos = 0

  constructor(buf: Uint8Array) {
    this.buf = buf
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  asciiz(): string {
    const end = this.buf.indexOf(0, this.pos)
    if (end < 0) throw new TruncatedPboHeader('asciiz без термінатора')
    const s = decoder.decode(this.buf.subarray(this.pos, end))
    this.pos = end + 1
    return s
  }

  u32(): number {
    if (this.pos + 4 > this.buf.length) throw new TruncatedPboHeader('u32 за межею шматка')
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }
}

// Розбирає заголовок PBO з (можливо, часткового) префікса файла. Повертає перелік
// записів з АБСОЛЮТНИМИ офсетами даних. Кидає TruncatedPboHeader, якщо таблиця імен не
// вмістилась у переданий шмат (викликач читає більший префікс і повторює).
export function parsePboHeader(buf: Uint8Array): { entries: PboEntry[] } {
  const c = new HeaderCursor(buf)
  const raw: Array<{ name: string; packing: number; originalSize: number; dataSize: number }> = []
  for (;;) {
    const name = c.asciiz()
    const packing = c.u32()
    const originalSize = c.u32()
    c.u32() // reserved
    c.u32() // timestamp
    const dataSize = c.u32()
    if (packing === PBO_PACKING_VERS) {
      // блок властивостей: пари ключ/значення до порожнього ключа, даних не має
      for (;;) {
        const key = c.asciiz()
        if (!key) break
        c.asciiz()
      }
      continue
    }
    if (name === '' && packing === 0 && dataSize === 0) break // термінатор заголовка
    raw.push({ name, packing, originalSize, dataSize })
  }
  let dataOffset = c.pos
  const entries: PboEntry[] = raw.map((e) => {
    const entry: PboEntry = { ...e, dataOffset }
    dataOffset += e.dataSize
    return entry
  })
  return { entries }
}

// LZSS DayZ/Arma (дистанційний LZ77): dist = b1 | ((b2 & 0xF0) << 4), dist 0 означає
// 4096; довжина = (b2 & 0x0F) + 3; позиції перед початком виходу читаються як 0x20.
// Класичний варіант з кільцевим буфером, забитим пробілами, ДЕКОДУЄ ПЕРШІ БАЙТИ ТАК
// САМО, А ПОТІМ РОЗХОДИТЬСЯ — не повертатись до нього (перевірено в python-еталоні
// проти BankRev.exe).
export function lzssDecompress(data: Uint8Array, expectedSize: number): Uint8Array {
  const out = new Uint8Array(expectedSize)
  let outLen = 0
  let i = 0
  const n = data.length
  while (outLen < expectedSize && i < n) {
    const flags = data[i++]
    for (let bit = 0; bit < 8; bit++) {
      if (outLen >= expectedSize || i >= n) break
      if (flags & (1 << bit)) {
        out[outLen++] = data[i++]
      } else {
        if (i + 1 >= n) {
          i = n
          break
        }
        const b1 = data[i]
        const b2 = data[i + 1]
        i += 2
        let dist = b1 | ((b2 & 0xf0) << 4)
        if (dist === 0) dist = 4096
        const length = (b2 & 0x0f) + 3
        const src = outLen - dist
        for (let k = 0; k < length; k++) {
          if (outLen >= expectedSize) break
          out[outLen++] = src + k < 0 ? 0x20 : out[src + k]
        }
      }
    }
  }
  // python-еталон повертає стільки, скільки реально декодовано (може бути менше за
  // expectedSize на биті вході) — дзеркалимо, щоб битий запис не тягнув хвіст нулів
  return outLen === expectedSize ? out : out.subarray(0, outLen)
}

// Байти запису з ПОВНОГО буфера PBO (шлях юніт-тестів і дрібних файлів; імпортер на
// великих файлах читає той самий діапазон через File.slice замість цілого буфера).
export function extractPboEntry(pboBuf: Uint8Array, entry: PboEntry): Uint8Array {
  const raw = pboBuf.subarray(entry.dataOffset, entry.dataOffset + entry.dataSize)
  return decodePboEntryData(raw, entry)
}

// Сирі байти діапазону запису -> корисні байти (розпаковка Cprs за потреби)
export function decodePboEntryData(raw: Uint8Array, entry: Pick<PboEntry, 'packing' | 'originalSize'>): Uint8Array {
  if (entry.packing === PBO_PACKING_CPRS) {
    return lzssDecompress(raw, entry.originalSize)
  }
  return raw
}

// Базове ім'я запису в нижньому регістрі ('config.bin' / 'stringtable.csv' ...) — PBO
// використовують '\' як роздільник, обфусковані паки інколи мішають '/'
export function pboEntryBasename(name: string): string {
  const norm = name.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return (idx < 0 ? norm : norm.slice(idx + 1)).toLowerCase()
}
