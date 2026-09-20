// Текстовий конфіг-парсер (T7 Step 1): порт Section 2 python-еталона
// scripts/gen-classindex.py (дужко-свідомий обхід, НЕ regex по всьому файлу) — потрібен
// браузерному імпортеру для PBO з незабінареним config.cpp (наш власний @ZP_Research
// пакується FileBank'ом і возить config.cpp плейнтекстом — без цього шляху жоден клас
// ZP_* не потрапив би в індекс). Семантика звірена з python построчно; будь-яка зміна
// тут мусить мати дзеркало там (паритет-тест importParity ловить розбіжності корпусом).

import { ROOT_NAMES } from './classIndex.ts'
import type { ConfigClassDef } from './rap.ts'

const ROOT_BY_LOWER = new Map<string, number>(ROOT_NAMES.map((n, i) => [n.toLowerCase(), i]))

function isIdentChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f // _
  )
}

function skipWsComments(s: string, i: number, n: number): number {
  while (i < n) {
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++
    } else if (c === '/' && i + 1 < n && s[i + 1] === '/') {
      const j = s.indexOf('\n', i)
      i = j < 0 ? n : j + 1
    } else if (c === '/' && i + 1 < n && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2)
      i = j < 0 ? n : j + 2
    } else {
      break
    }
  }
  return i
}

function readIdent(s: string, i: number, n: number): [string, number] {
  const start = i
  while (i < n && isIdentChar(s.charCodeAt(i))) i++
  return [s.slice(start, i), i]
}

// s[i] === '"'; BI-конфіг екранує лапку ПОДВОЄННЯМ ("")
function skipString(s: string, i: number, n: number): number {
  i++
  while (i < n) {
    if (s[i] === '"') {
      if (i + 1 < n && s[i + 1] === '"') {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return i
}

// s[i] === '"'; повертає [значення з розекранованими лапками, індекс за закривною лапкою]
function readConfigString(s: string, i: number, n: number): [string, number] {
  i++
  const parts: string[] = []
  while (i < n) {
    if (s[i] === '"') {
      if (i + 1 < n && s[i + 1] === '"') {
        parts.push('"')
        i += 2
        continue
      }
      return [parts.join(''), i + 1]
    }
    parts.push(s[i])
    i++
  }
  return [parts.join(''), n]
}

// s[i] === '{'; індекс парної '}'
function findMatchingBrace(s: string, i: number, n: number): number {
  let depth = 0
  while (i < n) {
    const c = s[i]
    if (c === '"') {
      i = skipString(s, i, n)
      continue
    }
    if (c === '/' && i + 1 < n && s[i + 1] === '/') {
      const j = s.indexOf('\n', i)
      i = j < 0 ? n : j + 1
      continue
    }
    if (c === '/' && i + 1 < n && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2)
      i = j < 0 ? n : j + 2
      continue
    }
    if (c === '{') {
      depth++
      i++
      continue
    }
    if (c === '}') {
      depth--
      i++
      if (depth === 0) return i - 1
      continue
    }
    i++
  }
  return n
}

// Пропуск не-класового statement до завершального top-level ';' включно (рядки,
// коментарі та вкладені {...} значення масивів шануються)
function skipStatement(s: string, i: number, n: number): number {
  let depth = 0
  while (i < n) {
    const c = s[i]
    if (c === '"') {
      i = skipString(s, i, n)
      continue
    }
    if (c === '/' && i + 1 < n && s[i + 1] === '/') {
      const j = s.indexOf('\n', i)
      i = j < 0 ? n : j + 1
      continue
    }
    if (c === '/' && i + 1 < n && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2)
      i = j < 0 ? n : j + 2
      continue
    }
    if (c === '{') {
      depth++
      i++
      continue
    }
    if (c === '}') {
      depth--
      i++
      continue
    }
    if (c === ';' && depth === 0) return i + 1
    i++
  }
  return n
}

// '#'-рядок препроцесора обмежений ФІЗИЧНИМ рядком, не ';' (CRITICAL 2 еталона:
// пропуск через skipStatement з'їдав наступний клас цілком)
function skipPreprocessorLine(s: string, i: number, n: number): number {
  const j = s.indexOf('\n', i)
  return j < 0 ? n : j + 1
}

interface ChildDef {
  name: string
  base: string | null
  bodyStart: number | null
  bodyEnd: number | null
}

function parseChildren(s: string, start: number, end: number): ChildDef[] {
  const out: ChildDef[] = []
  let i = start
  const n = end
  while (i < n) {
    i = skipWsComments(s, i, n)
    if (i >= n) break
    if (s.startsWith('class', i) && (i + 5 >= n || !isIdentChar(s.charCodeAt(i + 5)))) {
      i += 5
      i = skipWsComments(s, i, n)
      let name: string
      ;[name, i] = readIdent(s, i, n)
      i = skipWsComments(s, i, n)
      let base: string | null = null
      if (i < n && s[i] === ':') {
        i++
        i = skipWsComments(s, i, n)
        ;[base, i] = readIdent(s, i, n)
        i = skipWsComments(s, i, n)
      }
      if (i < n && s[i] === '{') {
        const close = findMatchingBrace(s, i, n)
        if (name) out.push({ name, base, bodyStart: i + 1, bodyEnd: close })
        i = close + 1
        i = skipWsComments(s, i, n)
        if (i < n && s[i] === ';') i++
      } else if (i < n && s[i] === ';') {
        if (name) out.push({ name, base, bodyStart: null, bodyEnd: null })
        i++
      } else {
        // Зіпсований statement (на реальних конфігах не трапляється) — безпечний вихід
        i = skipStatement(s, i, n)
      }
    } else if (s[i] === '#') {
      i = skipPreprocessorLine(s, i, n)
    } else {
      i = skipStatement(s, i, n)
    }
  }
  return out
}

// Власний displayName= тіла класу (span body). Вкладені класи пропускаються цілком;
// дубль властивості в ОДНОМУ тілі тримає ПЕРШЕ значення — звірено емпірично по
// тулчейну рушія (рев'ю T7, фікс-раунд 1): CfgConvert попереджає «Member already
// defined» на дублі, і бінаризований раундтрип несе САМЕ ПЕРШЕ значення (попереднє
// твердження «останній виграє» було хибним). displayNameShort/displayName[] не
// матчаться. Дзеркало python extract_display_name.
export function extractDisplayNameText(s: string, start: number, end: number): string | null {
  let i = start
  const n = end
  while (i < n) {
    i = skipWsComments(s, i, n)
    if (i >= n) break
    if (s.startsWith('class', i) && (i + 5 >= n || !isIdentChar(s.charCodeAt(i + 5)))) {
      i += 5
      i = skipWsComments(s, i, n)
      ;[, i] = readIdent(s, i, n)
      i = skipWsComments(s, i, n)
      if (i < n && s[i] === ':') {
        i++
        i = skipWsComments(s, i, n)
        ;[, i] = readIdent(s, i, n)
        i = skipWsComments(s, i, n)
      }
      if (i < n && s[i] === '{') {
        const close = findMatchingBrace(s, i, n)
        i = close + 1
        i = skipWsComments(s, i, n)
        if (i < n && s[i] === ';') i++
      } else if (i < n && s[i] === ';') {
        i++
      } else {
        i = skipStatement(s, i, n)
      }
      continue
    }
    if (s[i] === '#') {
      i = skipPreprocessorLine(s, i, n)
      continue
    }
    const [ident, afterIdent] = readIdent(s, i, n)
    if (ident.toLowerCase() === 'displayname') {
      let j = skipWsComments(s, afterIdent, n)
      if (j < n && s[j] === '=') {
        j = skipWsComments(s, j + 1, n)
        if (j < n && s[j] === '"') {
          // Перше входження виграє (докази CfgConvert вище) — ніщо далі в тілі
          // відповіді не змінить, повертаємось одразу.
          return readConfigString(s, j, n)[0]
        }
      }
    }
    i = skipStatement(s, i, n)
  }
  return null
}

// Дешевий декой-фільтр (дзеркало python looks_like_config_text / евристики ScanPbo.ps1):
// справжній конфіг містить слово 'class' або 'Cfg' і переважно друкований текст; декой
// обфускованого пака чи хибно декодований блоб провалює одну з двох умов. «Друкованість»
// python-isprintable дзеркалиться по суті, що реально ловить корпус: керівні байти
// (U+0000..U+001F поза \r\n\t, U+007F..U+009F) — недруковані; U+FFFD (replacement від
// errors=replace) у python ДРУКОВАНИЙ (категорія So) — тут теж не штрафується.
export function looksLikeConfigText(text: string): boolean {
  if (!text) return false
  const sample = text.slice(0, 65536)
  if (!sample.includes('class') && !sample.includes('Cfg')) return false
  let printable = 0
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      printable++
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // недрукований
    } else {
      printable++
    }
  }
  return printable / Math.max(1, sample.length) > 0.85
}

// Дзеркало python parse_class_defs: прямі нащадки п'яти коренів (регістронезалежно,
// канонічний індекс кореня), останній блок кореня у файлі виграє; display — власний
// сирий displayName= тіла (null для forward-декларацій)
export function parseTextConfig(text: string): ConfigClassDef[] {
  const rootSpans = new Map<number, [number, number]>()
  for (const child of parseChildren(text, 0, text.length)) {
    const rootIdx = ROOT_BY_LOWER.get(child.name.toLowerCase())
    if (rootIdx !== undefined && child.bodyStart !== null) {
      rootSpans.set(rootIdx, [child.bodyStart, child.bodyEnd!])
    }
  }
  const defs: ConfigClassDef[] = []
  for (const [rootIdx, [start, end]] of rootSpans) {
    for (const child of parseChildren(text, start, end)) {
      const hasBody = child.bodyStart !== null
      defs.push({
        root: rootIdx,
        name: child.name,
        base: child.base || null,
        hasBody,
        displayRaw: hasBody ? extractDisplayNameText(text, child.bodyStart!, child.bodyEnd!) : null,
      })
    }
  }
  return defs
}
