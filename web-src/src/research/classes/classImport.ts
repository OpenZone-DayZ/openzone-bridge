// Вбудований імпортер індексу класів (T7 Step 3): обхід тек гри/модпаку, воркер-пул на
// LZSS+raP, кеш IndexedDB, збірка ClassIndex v2 прямо в браузері — без Python і DayZ
// Tools. Чистий конвеєр (розбір PBO, мердж, фіналізація) — у classImportCore.ts (спільний
// з воркером і Node-тестом паритету); тут — усе середовищне: адаптери файлових API,
// виявлення джерел, кеш, пул, оркестрація.
//
// Вимоги швидкості з брифа (архітектурні, не полірування):
// - File.slice(): читаються ЛИШЕ заголовок PBO і байти записів config.bin/config.cpp/
//   stringtable.csv (classImportCore.parsePboSource) — повний PBO не читається ніколи;
// - пул Web Worker'ів min(hardwareConcurrency-1, 8) — I/O + LZSS + raP поза головним
//   потоком; сумісність `?worker&inline` із singlefile-збіркою доведена спайком
//   (window.__zpProbeWorker, перший крок задачі); fallback — головний потік з yield'ами
//   (шлях середовищ без Worker, напр. юніт-тести);
// - інкрементальність: кеш IndexedDB за ключем (шлях, розмір, lastModified) — повторний
//   імпорт розбирає лише змінені PBO;
// - прогрес по PBO + скасування через AbortSignal.

import {
  parsePboSource,
  fileLikeFromFile,
  createMergeState,
  mergeParseResult,
  finalizeIndex,
} from './classImportCore.ts'
import type { DirLike, DirChild, FileLike, PboParseResult, RawClassIndexV3 } from './classImportCore.ts'
import { parseClassIndexJson } from './classIndex.ts'
import type { ClassIndex } from './classIndex.ts'

// The worker as Vite bundles it: a module worker beside the page.
const PboWorkerCtor = function () {
  return new Worker(new URL('./pboWorker.ts', import.meta.url), { type: 'module' })
} as unknown as new () => Worker

// ---- Адаптери файлових API -----------------------------------------------------------------

// File System Access API (Chromium): основний шлях «Відкрити теку гри/модпаку».
export function dirFromHandle(handle: FileSystemDirectoryHandle): DirLike {
  return {
    name: handle.name,
    async children(): Promise<DirChild[]> {
      const out: DirChild[] = []
      for await (const [name, child] of handle.entries()) {
        if (child.kind === 'file') {
          const fileHandle = child as FileSystemFileHandle
          out.push({
            kind: 'file',
            name,
            open: async () => fileLikeFromFile(await fileHandle.getFile()),
          })
        } else {
          out.push({ kind: 'dir', name, dir: dirFromHandle(child as FileSystemDirectoryHandle) })
        }
      }
      return out
    },
  }
}

// Фолбек без FS Access API (Firefox) і шлях headless-смоуку: <input webkitdirectory>
// віддає плаский список File з webkitRelativePath ('DayZ/Addons/x.pbo') — збираємо з
// нього віртуальне дерево тек. Вміст файлів ЛІНИВИЙ (File — це хендл, читання лише через
// slice), тож великий вибір теки не тягне багатогігабайтного читання.
export function dirFromFileList(files: File[]): DirLike | null {
  interface TreeDir {
    dirs: Map<string, TreeDir>
    files: Map<string, File>
  }
  const mkdir = (): TreeDir => ({ dirs: new Map(), files: new Map() })
  const root = mkdir()
  let rootName = ''
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath
    if (!rel) continue
    const parts = rel.split('/')
    if (parts.length < 2) continue
    rootName = parts[0]
    let dir = root
    for (let i = 1; i < parts.length - 1; i++) {
      let next = dir.dirs.get(parts[i])
      if (!next) {
        next = mkdir()
        dir.dirs.set(parts[i], next)
      }
      dir = next
    }
    dir.files.set(parts[parts.length - 1], f)
  }
  if (rootName === '') return null
  const wrap = (name: string, tree: TreeDir): DirLike => ({
    name,
    async children(): Promise<DirChild[]> {
      const out: DirChild[] = []
      for (const [childName, sub] of tree.dirs) {
        out.push({ kind: 'dir', name: childName, dir: wrap(childName, sub) })
      }
      for (const [fileName, file] of tree.files) {
        out.push({ kind: 'file', name: fileName, open: async () => fileLikeFromFile(file) })
      }
      return out
    },
  })
  return wrap(rootName, root)
}

// ---- Виявлення джерел (дзеркало python iter_sources, узагальнене на «що вибрав адмін») -----

export interface PboSourceRef {
  modLabel: string
  path: string // стабільний ключ кеша: '<тека>/<відносний шлях>' у нижньому регістрі
  open(): Promise<FileLike>
}

export interface SkipReport {
  source: string
  reason: string
}

interface ChildIndex {
  byLower: Map<string, DirChild>
  all: DirChild[]
}

async function indexChildren(dir: DirLike): Promise<ChildIndex> {
  const all = await dir.children()
  const byLower = new Map<string, DirChild>()
  for (const c of all) byLower.set(c.name.toLowerCase(), c)
  return { byLower, all }
}

function sortByNameLower<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const al = a.name.toLowerCase()
    const bl = b.name.toLowerCase()
    return al < bl ? -1 : al > bl ? 1 : 0
  })
}

function pbosOf(index: ChildIndex): Array<DirChild & { kind: 'file' }> {
  return sortByNameLower(
    index.all.filter((c): c is DirChild & { kind: 'file' } => c.kind === 'file' && c.name.toLowerCase().endsWith('.pbo')),
  )
}

// Один мод (@X): pbo з підтеки addons/ (регістронезалежно). Відсутність addons/ —
// легально (server-only/docs-only моди, python: continue мовчки).
async function collectModSources(
  modDir: DirLike,
  label: string,
  pathPrefix: string,
  out: PboSourceRef[],
  skipped: SkipReport[],
): Promise<void> {
  let index: ChildIndex
  try {
    index = await indexChildren(modDir)
  } catch {
    // Мертвий Steam-junction (контент видалено зі збірки) — легально відсутній, не помилка
    skipped.push({ source: label, reason: 'вміст мода відсутній на диску (битий junction — мод видалено зі збірки)' })
    return
  }
  const addons = index.byLower.get('addons')
  if (!addons || addons.kind !== 'dir') return
  let addonsIndex: ChildIndex
  try {
    addonsIndex = await indexChildren(addons.dir)
  } catch {
    skipped.push({ source: label, reason: 'тека addons/ не читається' })
    return
  }
  for (const p of pbosOf(addonsIndex)) {
    out.push({ modLabel: label, path: `${pathPrefix}/addons/${p.name}`.toLowerCase(), open: p.open })
  }
}

// Тека з @*-модами (\!Workshop або будь-яка інша): моди за алфавітом (ключ — нижній
// регістр, як python sorted(key=name.lower())). Повертає кількість ЗНАЙДЕНИХ модів —
// нуль на непорожній !Workshop означає, що моди «зникли» дорогою (типово: браузер не
// бачить крізь NTFS-junction'и Steam-клієнта — перевірено зондом, webkitdirectory
// віддає 0 файлів під junction'ом; викликач попереджає адміна явно).
async function collectWorkshopSources(
  wsDir: DirLike,
  pathPrefix: string,
  out: PboSourceRef[],
  skipped: SkipReport[],
): Promise<number> {
  const index = await indexChildren(wsDir)
  const modDirs = sortByNameLower(
    index.all.filter((c): c is DirChild & { kind: 'dir' } => c.kind === 'dir' && c.name.startsWith('@')),
  )
  const before = out.length
  for (const mod of modDirs) {
    await collectModSources(mod.dir, mod.name, `${pathPrefix}/${mod.name}`, out, skipped)
  }
  return modDirs.length > 0 && out.length > before ? modDirs.length : 0
}

// Тека Steam-контенту (steamapps\workshop\content\221100): підтеки названі Workshop-ID
// (не @Ім'я), кожна з addons/*.pbo — окремий мод. Це шлях для машин, де !Workshop
// зібраний junction-посиланнями, крізь які браузер не бачить. Повертає кількість
// знайдених модів (0 — форма не розпізнана).
async function collectContentRootSources(
  index: ChildIndex,
  pathPrefix: string,
  out: PboSourceRef[],
  skipped: SkipReport[],
): Promise<number> {
  const subdirs = sortByNameLower(index.all.filter((c): c is DirChild & { kind: 'dir' } => c.kind === 'dir'))
  let found = 0
  for (const sub of subdirs) {
    const before = out.length
    await collectModSources(sub.dir, sub.name, `${pathPrefix}/${sub.name}`, out, skipped)
    if (out.length > before) found++
  }
  return found
}

export interface DiscoveryResult {
  sources: PboSourceRef[]
  skipped: SkipReport[]
}

// Розпізнає, ЩО саме вибрав адмін, і збирає джерела в детермінованому порядку (паритет
// з python iter_sources: ваніль -> моди за алфавітом; кілька вибраних тек — у порядку
// додавання). Розпізнавані форми:
// - корінь гри (є Addons/ і dta/): ваніль (Addons/*.pbo + dta/bin.pbo +
//   dta/languagecore.pbo — stringtable ванілі) + !Workshop/@* + @* просто в корені;
// - тека модпаку (є @*-підтеки): всі моди;
// - тека одного мода (є addons/*.pbo): один мод;
// - тека з *.pbo напряму: один мод (вибрали саму addons/).
export async function discoverSources(dirs: DirLike[]): Promise<DiscoveryResult> {
  const sources: PboSourceRef[] = []
  const skipped: SkipReport[] = []
  const seenPaths = new Set<string>()

  for (const dir of dirs) {
    const before = sources.length
    let index: ChildIndex
    try {
      index = await indexChildren(dir)
    } catch (err) {
      skipped.push({ source: dir.name, reason: `тека не читається: ${err instanceof Error ? err.message : String(err)}` })
      continue
    }
    const addons = index.byLower.get('addons')
    const dta = index.byLower.get('dta')
    const workshop = index.byLower.get('!workshop')
    const atMods = index.all.filter((c): c is DirChild & { kind: 'dir' } => c.kind === 'dir' && c.name.startsWith('@'))

    if (addons?.kind === 'dir' && dta?.kind === 'dir') {
      // Корінь гри: ваніль
      const addonsIndex = await indexChildren(addons.dir)
      for (const p of pbosOf(addonsIndex)) {
        sources.push({ modLabel: 'vanilla', path: `${dir.name}/addons/${p.name}`.toLowerCase(), open: p.open })
      }
      const dtaIndex = await indexChildren(dta.dir)
      for (const dtaName of ['bin.pbo', 'languagecore.pbo']) {
        const child = dtaIndex.byLower.get(dtaName)
        if (child?.kind === 'file') {
          sources.push({ modLabel: 'vanilla', path: `${dir.name}/dta/${child.name}`.toLowerCase(), open: child.open })
        }
      }
      if (workshop?.kind === 'dir') {
        const foundMods = await collectWorkshopSources(workshop.dir, `${dir.name}/!workshop`, sources, skipped)
        if (foundMods === 0) {
          skipped.push({
            source: '!Workshop',
            reason:
              'жодного мода не знайдено — якщо моди підключені junction-посиланнями Steam, браузер крізь них не бачить; додайте окремо теку steamapps\\workshop\\content\\221100',
          })
        }
      }
      for (const mod of sortByNameLower(atMods)) {
        await collectModSources(mod.dir, mod.name, `${dir.name}/${mod.name}`, sources, skipped)
      }
    } else if (atMods.length > 0) {
      await collectWorkshopSources(dir, dir.name, sources, skipped)
    } else if (addons?.kind === 'dir') {
      await collectModSources(dir, dir.name, dir.name, sources, skipped)
    } else {
      const direct = pbosOf(index)
      if (direct.length > 0) {
        for (const p of direct) {
          sources.push({ modLabel: dir.name, path: `${dir.name}/${p.name}`.toLowerCase(), open: p.open })
        }
      } else if ((await collectContentRootSources(index, dir.name, sources, skipped)) === 0) {
        skipped.push({
          source: dir.name,
          reason:
            'не схоже ні на корінь гри (Addons/+dta/), ні на модпак (@* чи Steam-контент з addons/), ні на мод (addons/*.pbo)',
        })
      }
    }
    if (sources.length === before && skipped.every((s) => s.source !== dir.name)) {
      skipped.push({ source: dir.name, reason: 'жодного PBO не знайдено' })
    }
  }

  // Дедуп (адмін міг додати і корінь гри, і !Workshop з нього окремо): перший виграє —
  // повторна обробка тих самих PBO лише подвоїла б роботу, не змінивши мерджу.
  const unique: PboSourceRef[] = []
  let duplicates = 0
  for (const s of sources) {
    if (seenPaths.has(s.path)) {
      duplicates++
      continue
    }
    seenPaths.add(s.path)
    unique.push(s)
  }
  if (duplicates > 0) {
    skipped.push({ source: '(дедуп)', reason: `пропущено повторів тих самих PBO: ${duplicates}` })
  }
  return { sources: unique, skipped }
}

// ---- Кеш IndexedDB -------------------------------------------------------------------------

export interface CachedPbo {
  size: number
  mtime: number
  result: PboParseResult
}

export interface ImportCache {
  get(key: string): Promise<CachedPbo | undefined>
  put(key: string, value: CachedPbo): Promise<void>
  close(): void
}

const IDB_NAME = 'oz-admin-classimport'
const IDB_STORE = 'pbo'
// Версія СЕМАНТИКИ розбору в ключі кеша: (шлях, розмір, mtime) незмінні, коли міняється
// САМ ПАРСЕР (нове поле в ConfigClassDef, інша граматика raP...) — без версії теплий
// імпорт мовчки віддавав би результати старого парсера. Підняти при будь-якій зміні
// формату PboParseResult чи семантики parsePboSource.
const CACHE_PARSER_VERSION = 1

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB: невідома помилка'))
  })
}

// Кеш «best effort»: середовище без IndexedDB (юніт-тести, приватні вкладки з
// вимкненим сховищем) отримує no-op — імпорт працює, просто без тепла.
export async function openImportCache(): Promise<ImportCache> {
  if (typeof indexedDB === 'undefined') {
    return { get: async () => undefined, put: async () => undefined, close: () => undefined }
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB: не відкрився'))
  })
  return {
    async get(key) {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly')
        return (await idbRequest(tx.objectStore(IDB_STORE).get(`v${CACHE_PARSER_VERSION}|${key}`))) as
          | CachedPbo
          | undefined
      } catch {
        return undefined
      }
    },
    async put(key, value) {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite')
        await idbRequest(tx.objectStore(IDB_STORE).put(value, `v${CACHE_PARSER_VERSION}|${key}`))
      } catch {
        // кеш — прискорення, не коректність; збій запису не валить імпорт
      }
    },
    close() {
      db.close()
    },
  }
}

// ---- Пул воркерів --------------------------------------------------------------------------

interface ParseExecutor {
  run(file: FileLike): Promise<PboParseResult>
  destroy(): void
}

// Головний потік із поступкою планувальнику після кожного PBO — fallback для середовищ
// без Worker і шлях Node-тестів (воркери — ціль, брифом; але імпорт не має права
// НЕ ПРАЦЮВАТИ без них).
function mainThreadExecutor(): ParseExecutor {
  return {
    async run(file) {
      const result = await parsePboSource(file)
      await new Promise((r) => setTimeout(r, 0))
      return result
    },
    destroy() {
      /* нічого тримати */
    },
  }
}

// Мінімальний структурний інтерфейс воркера — щоб (а) тест-шов міг підсунути фейковий
// конструктор (симуляція CSP/збоїв — рев'ю T7, фікс-раунд 1, Important 1), (б) типи не
// вимагали повного lib.dom Worker
export interface WorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null
  onerror: ((ev: { message?: string }) => void) | null
  postMessage(message: unknown): void
  terminate(): void
}

export type WorkerCtor = new () => WorkerLike

function workerPoolExecutor(workerCount: number, ctor: WorkerCtor): ParseExecutor {
  interface Slot {
    worker: WorkerLike
    busy: boolean
  }
  const slots: Slot[] = []
  // Синхронний кид конструктора (CSP worker-src на хостованій копії, вичерпані ресурси)
  // мусить долетіти до викликача ЦІЛИМ, без витоку вже створених воркерів — викликач
  // (importClassIndex) на нього відповідає фолбеком на головний потік.
  try {
    for (let i = 0; i < workerCount; i++) {
      slots.push({ worker: new ctor(), busy: false })
    }
  } catch (err) {
    for (const s of slots) s.worker.terminate()
    throw err
  }
  let nextTaskId = 1
  const waiters: Array<(slot: Slot) => void> = []

  const acquire = (): Promise<Slot> => {
    const free = slots.find((s) => !s.busy)
    if (free) {
      free.busy = true
      return Promise.resolve(free)
    }
    return new Promise((resolve) => waiters.push(resolve))
  }
  const release = (slot: Slot): void => {
    const waiter = waiters.shift()
    if (waiter) {
      waiter(slot) // busy лишається true — слот переходить наступному напряму
    } else {
      slot.busy = false
    }
  }

  return {
    async run(file) {
      if (!file.native) {
        // Не-браузерний FileLike (Node-тест випадково з пулом) — чесний фолбек
        return parsePboSource(file)
      }
      const slot = await acquire()
      const taskId = nextTaskId++
      try {
        return await new Promise<PboParseResult>((resolve, reject) => {
          slot.worker.onmessage = (ev: MessageEvent) => {
            const data = ev.data as { taskId: number; result?: PboParseResult; error?: string }
            if (data.taskId !== taskId) return
            if (data.error !== undefined) reject(new Error(data.error))
            else resolve(data.result!)
          }
          slot.worker.onerror = (ev) => reject(new Error(`воркер упав: ${ev.message ?? 'без повідомлення'}`))
          slot.worker.postMessage({ taskId, file: file.native })
        })
      } catch {
        // Per-run фолбек (рев'ю T7, фікс-раунд 1, Important 1): воркер-рівнева відмова
        // (onerror до першого результату, несподіваний кид усередині) не сміє валити
        // весь імпорт — той самий PBO чесно розбирається головним потоком; parsePboSource
        // сама не кидається (усі помилки формату йдуть у result.error).
        return parsePboSource(file)
      } finally {
        release(slot)
      }
    },
    destroy() {
      for (const s of slots) s.worker.terminate()
    },
  }
}

// ---- Оркестрація ---------------------------------------------------------------------------

export interface ImportProgress {
  phase: 'scan' | 'parse' | 'finalize'
  done: number
  total: number
  label: string
  cacheHits: number
}

export interface ImportStats {
  pboTotal: number
  pboOk: number
  pboNoConfig: number
  pboFailed: number
  cacheHits: number
  classes: number
  mods: number
  stringtableKeys: number
  durationMs: number
  usedWorkers: number
  failedDetails: Array<{ source: string; reason: string }>
}

export interface ImportResult {
  index: ClassIndex
  raw: RawClassIndexV3
  skipped: SkipReport[]
  stats: ImportStats
}

export interface ImportOptions {
  workers?: number // 0 -> головний потік; за замовчуванням min(hardwareConcurrency-1, 8)
  cache?: ImportCache | null // null -> без кеша; за замовчуванням openImportCache()
  // Тест-шов (рев'ю T7, фікс-раунд 1): конструктор воркера для симуляції збоїв
  // (кидається при створенні / onerror у рантаймі). Бойовий шлях його не передає.
  workerCtor?: WorkerCtor
}

function defaultWorkerCount(): number {
  if (typeof Worker === 'undefined') return 0
  const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4
  return Math.max(1, Math.min(hw - 1, 8))
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Імпорт скасовано', 'AbortError')
}

export async function importClassIndex(
  dirs: Array<FileSystemDirectoryHandle | DirLike>,
  onProgress?: (p: ImportProgress) => void,
  signal?: AbortSignal,
  options?: ImportOptions,
): Promise<ImportResult> {
  const t0 = Date.now()
  const dirLikes: DirLike[] = dirs.map((d) =>
    typeof (d as FileSystemDirectoryHandle).kind === 'string' && (d as FileSystemDirectoryHandle).kind === 'directory'
      ? dirFromHandle(d as FileSystemDirectoryHandle)
      : (d as DirLike),
  )

  onProgress?.({ phase: 'scan', done: 0, total: 0, label: 'пошук PBO…', cacheHits: 0 })
  const { sources, skipped } = await discoverSources(dirLikes)
  throwIfAborted(signal)

  const cache = options?.cache === undefined ? await openImportCache() : options.cache
  const workerCount = options?.workers ?? defaultWorkerCount()
  // Фолбек без воркерів (рев'ю T7, фікс-раунд 1, Important 1): синхронний кид
  // конструктора воркера (типово — CSP worker-src на хостованій копії редактора) не
  // валить імпорт, а чесно деградує до головного потоку; usedWorkers у звіті тоді 0.
  let executor: ParseExecutor
  let actualWorkers = workerCount
  if (workerCount > 0) {
    try {
      executor = workerPoolExecutor(workerCount, options?.workerCtor ?? (PboWorkerCtor as unknown as WorkerCtor))
    } catch {
      executor = mainThreadExecutor()
      actualWorkers = 0
    }
  } else {
    executor = mainThreadExecutor()
  }

  const stats: ImportStats = {
    pboTotal: sources.length,
    pboOk: 0,
    pboNoConfig: 0,
    pboFailed: 0,
    cacheHits: 0,
    classes: 0,
    mods: 0,
    stringtableKeys: 0,
    durationMs: 0,
    usedWorkers: actualWorkers,
    failedDetails: [],
  }

  // Результати збираються ЗА ІНДЕКСОМ ДЖЕРЕЛА і мерджаться строго в порядку джерел
  // ПІСЛЯ завершення всіх — паралельне завершення не сміє міняти семантику later-wins
  // (інакше два прогони того самого модпака давали б різні індекси залежно від того,
  // який воркер фінішував першим).
  const results = new Array<PboParseResult | null>(sources.length).fill(null)
  let done = 0
  let cursor = 0

  // Обмежена конкурентність «смугами» РІВНО за кількістю воркерів: кожна смуга завжди
  // знаходить вільний слот пулу одразу (acquire ніколи не чергується), тож скасування
  // не лишає підвислих очікувачів — смуга перевіряє AbortSignal на початку кожної
  // ітерації і чесно кидається. Для головного потоку (зокрема після фолбека з
  // невдалого пулу) — 2 смуги (перекриття I/O з розбором; сам розбір послідовний).
  const lanes = actualWorkers > 0 ? actualWorkers : 2

  async function processOne(i: number): Promise<void> {
    const src = sources[i]
    let file: FileLike
    try {
      file = await src.open()
    } catch (err) {
      results[i] = {
        defs: [],
        strings: [],
        error: `файл не відкрився: ${err instanceof Error ? err.message : String(err)}`,
        hadValidConfig: false,
      }
      return
    }
    const cached = cache ? await cache.get(src.path) : undefined
    if (cached && cached.size === file.size && cached.mtime === file.lastModified) {
      results[i] = cached.result
      stats.cacheHits++
      return
    }
    const result = await executor.run(file)
    results[i] = result
    if (cache) await cache.put(src.path, { size: file.size, mtime: file.lastModified, result })
  }

  async function lane(): Promise<void> {
    for (;;) {
      throwIfAborted(signal)
      const i = cursor++
      if (i >= sources.length) return
      await processOne(i)
      done++
      onProgress?.({ phase: 'parse', done, total: sources.length, label: sources[i].modLabel, cacheHits: stats.cacheHits })
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(lanes, Math.max(1, sources.length)) }, () => lane()))

    throwIfAborted(signal)
    onProgress?.({ phase: 'finalize', done: sources.length, total: sources.length, label: 'збірка індексу…', cacheHits: stats.cacheHits })

    const state = createMergeState()
    for (let i = 0; i < sources.length; i++) {
      const result = results[i]!
      if (result.hadValidConfig) {
        stats.pboOk++
      } else if (result.error === null) {
        stats.pboNoConfig++
      } else {
        stats.pboFailed++
        stats.failedDetails.push({ source: `${sources[i].modLabel}/${sources[i].path.split('/').pop()}`, reason: result.error })
      }
      mergeParseResult(state, sources[i].modLabel, result)
    }
    const generated = new Date().toISOString().slice(0, 10)
    const raw = finalizeIndex(state, generated)
    stats.classes = raw.classes.length
    stats.mods = raw.mods.length
    stats.stringtableKeys = state.strings.size
    stats.durationMs = Date.now() - t0
    return { index: parseClassIndexJson(raw), raw, skipped, stats }
  } finally {
    executor.destroy()
    cache?.close()
  }
}
