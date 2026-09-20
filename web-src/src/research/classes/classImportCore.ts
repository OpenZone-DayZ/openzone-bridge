// Ядро вбудованого імпортера класів (T7 Step 3) — ЧИСТА частина конвеєра, спільна для
// трьох середовищ: воркера (pboWorker.ts), головного потоку (fallback) і Node-тесту
// паритету (importParity.test.ts). Тут НЕМАЄ ні DOM, ні IndexedDB, ні воркерів — лише
// байти -> дефініції -> індекс. Оркестрація (обхід тек, кеш, пул) — у classImport.ts.
// Винесено окремим модулем свідомо: воркер мусить імпортувати конвеєр, а classImport.ts
// імпортує КОНСТРУКТОР воркера (`?worker&inline`) — спільний модуль розриває цикл
// worker-бандла із самим собою.
//
// Семантика мерджу/фіналізації — построчне дзеркало python-еталона
// scripts/gen-classindex.py (build_index/finalize/parse_stringtable_csv/resolve_display);
// паритет доводиться корпусом у importParity.test.ts, а не заявляється.

import { parsePboHeader, decodePboEntryData, pboEntryBasename, TruncatedPboHeader } from './pbo.ts'
import type { PboEntry } from './pbo.ts'
import { parseRapConfig, isRapConfig } from './rap.ts'
import type { ConfigClassDef } from './rap.ts'
import { parseTextConfig, looksLikeConfigText } from './configText.ts'
import { ROOT_NAMES } from './classIndex.ts'

// ---- Абстракції файлової системи -----------------------------------------------------------
// FileLike/DirLike — мінімальний інтерфейс, що його однаково реалізують File System
// Access API (браузер), webkitdirectory-список File'ів (фолбек без FS Access) і Node fs
// (тест паритету). ЄДИНИЙ спосіб читання — slice(start,end): випадковий доступ, вимога
// брифа (повний PBO не читається ніколи — модпак десятки ГБ, конфіги — мегабайти).

export interface FileLike {
  name: string
  size: number
  lastModified: number
  slice(start: number, end: number): Promise<Uint8Array>
  // Браузерний шлях: справжній File для передачі у воркер structured clone'ом.
  native?: File
}

export type DirChild =
  | { kind: 'file'; name: string; open(): Promise<FileLike> }
  | { kind: 'dir'; name: string; dir: DirLike }

export interface DirLike {
  name: string
  children(): Promise<DirChild[]>
}

export function fileLikeFromFile(f: File): FileLike {
  return {
    name: f.name,
    size: f.size,
    lastModified: f.lastModified,
    native: f,
    async slice(start, end) {
      return new Uint8Array(await f.slice(start, end).arrayBuffer())
    },
  }
}

// ---- stringtable.csv -----------------------------------------------------------------------
// Дзеркало python parse_stringtable_csv: заголовок `"Language","original","english",...`
// (колонки шукаються за ІМЕНЕМ, регістронезалежно — порядок і зайві мови байдужі), ключ у
// колонці 0, значення можуть нести коми, подвоєні лапки і переноси рядків усередині
// лапок. Невпізнаний заголовок (декой/бінарне сміття) — нуль рядків, не помилка PBO.

// Семантика лапок — ДЗЕРКАЛО python csv.reader (еталон паритету, не RFC 4180 заради
// RFC): лапка відкриває цитований режим ЛИШЕ як ПЕРШИЙ символ поля; лапка посеред
// незацитованого поля — літерал. Знайдено паритет-тестом на реальному корпусі: рядки
// @ProcolPack мають ПРОБІЛ перед відкривною лапкою (` "Tactical Belt USA"`), python
// віддає значення З лапками (поле незацитоване, .strip() зрізає лише пробіли) — наївний
// «лапки будь-де цитують» парсер тихо зрізав їх і розходився з еталоном на 130+ класах.
// Після закривної лапки залишок поля до роздільника — теж літерал (python: `"a"x` -> ax).
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let fieldTouched = false // чи бачило поточне поле хоч один символ (для «лапка лише першою»)
  let inQuotes = false
  let i = 0
  const n = text.length
  const pushField = () => {
    row.push(field)
    field = ''
    fieldTouched = false
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }
  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false // залишок поля до роздільника — літерал
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"' && !fieldTouched) {
      inQuotes = true
      fieldTouched = true
      i++
      continue
    }
    if (c === ',') {
      pushField()
      i++
      continue
    }
    if (c === '\r') {
      if (i + 1 < n && text[i + 1] === '\n') i++
      pushRow()
      i++
      continue
    }
    if (c === '\n') {
      pushRow()
      i++
      continue
    }
    field += c
    fieldTouched = true
    i++
  }
  if (field !== '' || fieldTouched || row.length > 0) pushRow()
  return rows
}

export type StringRow = [key: string, original: string, english: string]

export function parseStringtableCsv(raw: Uint8Array): StringRow[] {
  let text = new TextDecoder('utf-8').decode(raw)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // BOM
  const rows = parseCsvRows(text)
  if (rows.length === 0) return []
  const header = rows[0].map((c) => c.trim().toLowerCase())
  const origI = header.indexOf('original')
  const engI = header.indexOf('english')
  if (origI < 0 && engI < 0) return []
  const out: StringRow[] = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (row.length === 0) continue
    const key = row[0].trim()
    if (!key) continue
    const original = origI >= 0 && origI < row.length ? row[origI].trim() : ''
    const english = engI >= 0 && engI < row.length ? row[engI].trim() : ''
    out.push([key, original, english])
  }
  return out
}

// ---- Розбір одного PBO ---------------------------------------------------------------------

export interface PboParseResult {
  defs: ConfigClassDef[]
  strings: StringRow[]
  // null -> або все гаразд, або конфіг-записів просто немає (no_config, легальний
  // asset-pbo); рядок -> кандидати були, але ЖОДЕН не розібрався (декой/битий)
  error: string | null
  hadValidConfig: boolean // дзеркало python "texts непорожні" -> pbo_ok
}

// Прогресивне читання заголовка: стартовий шмат 128KB, при TruncatedPboHeader — учетверо
// більший, до повного файла. Таблиця імен майже завжди вміщається в перший шмат.
async function readHeaderEntries(file: FileLike): Promise<PboEntry[]> {
  let size = 128 * 1024
  for (;;) {
    const take = Math.min(size, file.size)
    const buf = await file.slice(0, take)
    try {
      return parsePboHeader(buf).entries
    } catch (err) {
      if (err instanceof TruncatedPboHeader && take < file.size) {
        size *= 4
        continue
      }
      throw err
    }
  }
}

export async function parsePboSource(file: FileLike): Promise<PboParseResult> {
  let entries: PboEntry[]
  try {
    entries = await readHeaderEntries(file)
  } catch (err) {
    return { defs: [], strings: [], error: `header parse failed: ${describe(err)}`, hadValidConfig: false }
  }

  const strings: StringRow[] = []
  const defs: ConfigClassDef[] = []
  let hadCandidates = false
  let hadValidConfig = false
  let lastError = 'no candidate produced config-like text'

  for (const entry of entries) {
    const base = pboEntryBasename(entry.name)
    if (base !== 'config.bin' && base !== 'config.cpp' && base !== 'stringtable.csv') continue
    let bytes: Uint8Array
    try {
      const raw = await file.slice(entry.dataOffset, entry.dataOffset + entry.dataSize)
      bytes = decodePboEntryData(raw, entry)
    } catch (err) {
      if (base !== 'stringtable.csv') {
        hadCandidates = true
        lastError = `${entry.name}: ${describe(err)}`
      }
      continue
    }
    if (base === 'stringtable.csv') {
      strings.push(...parseStringtableCsv(bytes))
      continue
    }
    hadCandidates = true
    if (isRapConfig(bytes)) {
      try {
        defs.push(...parseRapConfig(bytes))
        hadValidConfig = true
      } catch (err) {
        lastError = `${entry.name}: ${describe(err)}`
      }
    } else {
      const text = new TextDecoder('utf-8').decode(bytes)
      if (looksLikeConfigText(text)) {
        defs.push(...parseTextConfig(text))
        hadValidConfig = true
      } else {
        lastError = `${entry.name}: decoded but does not look like a config (decoy?)`
      }
    }
  }

  if (hadCandidates && !hadValidConfig) {
    return { defs: [], strings, error: lastError, hadValidConfig: false }
  }
  return { defs, strings, error: null, hadValidConfig }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- Мердж і фіналізація (дзеркало python build_index/finalize) ----------------------------

interface MergedEntry {
  name: string // оригінальний регістр переможця
  base: string | null
  hasBody: boolean
  mod: string
  displayRaw: string | null
}

export interface MergeState {
  tables: Array<Map<string, MergedEntry>> // по одній на корінь, ключ name.toLowerCase()
  strings: Map<string, [string, string]> // key.toLowerCase() -> [original, english]
  duplicateConflicts: number
}

export function createMergeState(): MergeState {
  return {
    tables: ROOT_NAMES.map(() => new Map<string, MergedEntry>()),
    strings: new Map(),
    duplicateConflicts: 0,
  }
}

// Порядок викликів = порядок джерел (ваніль -> модпак за алфавітом -> власні моди) —
// пізніший виграє, ТОЧНО як python build_index. strings мерджаться незалежно від
// успіху конфігів того самого PBO (дзеркало: python зливає stringtable ДО перевірки texts).
export function mergeParseResult(state: MergeState, modLabel: string, result: PboParseResult): void {
  for (const [key, original, english] of result.strings) {
    state.strings.set(key.toLowerCase(), [original, english])
  }
  for (const def of result.defs) {
    const table = state.tables[def.root]
    const key = def.name.toLowerCase()
    const existing = table.get(key)
    if (existing === undefined) {
      table.set(key, { name: def.name, base: def.base, hasBody: def.hasBody, mod: modLabel, displayRaw: def.displayRaw })
      continue
    }
    if (def.hasBody) {
      if (existing.hasBody) state.duplicateConflicts++
      // Display property-merge (дзеркало python): рушій МЕРДЖИТЬ властивості конфігів,
      // тож перевизначення без власного displayName= зберігає попередній.
      const mergedDisplay = def.displayRaw ? def.displayRaw : existing.displayRaw
      table.set(key, { name: def.name, base: def.base, hasBody: true, mod: modLabel, displayRaw: mergedDisplay })
    }
    // forward-декларація ніколи не перезаписує наявний запис
  }
}

// A '$'-prefixed display is a stringtable key, looked up without case; each
// column falls back to the other, then to the raw key (kept with its '$', an
// honest mark of 'unresolved', as the game itself would show it).
export function resolveDisplay(displayRaw: string | null, strings: Map<string, [string, string]>): [string, string] {
  if (!displayRaw) return ['', '']
  if (displayRaw.startsWith('$')) {
    const hit = strings.get(displayRaw.slice(1).toLowerCase())
    if (hit) return [hit[0] || hit[1] || displayRaw, hit[1] || hit[0] || displayRaw]
    return [displayRaw, displayRaw]
  }
  return [displayRaw, displayRaw]
}

export interface RawClassIndexV3 {
  v: 3
  generated: string
  mods: string[]
  classes: Array<[string, number, number, number, string, string]>
}
export function finalizeIndex(state: MergeState, generated: string): RawClassIndexV3 {
  const modsSeen = new Set<string>()
  for (const table of state.tables) {
    for (const entry of table.values()) modsSeen.add(entry.mod)
  }
  const mods = [...modsSeen].sort((a, b) => {
    const al = a.toLowerCase()
    const bl = b.toLowerCase()
    return al < bl ? -1 : al > bl ? 1 : 0
  })
  const modIndex = new Map(mods.map((m, i) => [m, i]))

  const nameToIndex: Array<Map<string, number>> = ROOT_NAMES.map(() => new Map())
  const classes: RawClassIndexV3['classes'] = []
  for (let rootI = 0; rootI < state.tables.length; rootI++) {
    for (const [key] of state.tables[rootI]) {
      nameToIndex[rootI].set(key, classes.length)
      classes.push(['', -1, -1, rootI, '', '']) // заповнюється другим проходом нижче
    }
  }
  let idx = 0
  for (let rootI = 0; rootI < state.tables.length; rootI++) {
    for (const entry of state.tables[rootI].values()) {
      let baseIdx = -1
      if (entry.base) {
        baseIdx = nameToIndex[rootI].get(entry.base.toLowerCase()) ?? -1
      }
      const [original, english] = resolveDisplay(entry.displayRaw, state.strings)
      classes[idx] = [entry.name, baseIdx, modIndex.get(entry.mod)!, rootI, original, english]
      idx++
    }
  }
  return { v: 3, generated, mods, classes }
}
