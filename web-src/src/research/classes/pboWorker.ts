// Воркер пулу імпорту класів (T7). Тонка обгортка транспорту: приймає File (structured
// clone передає хендл без копіювання вмісту — байти читаються всередині воркера через
// slice, і I/O, і LZSS+raP йдуть ПОЗА головним потоком), викликає ту саму чисту
// parsePboSource, що й fallback головного потоку та Node-тест паритету
// (classImportCore.ts). Повідомлення ping/pong лишається для спайк-зонда сумісності
// `?worker&inline` із singlefile-збіркою (window.__zpProbeWorker).

import { parsePboSource, fileLikeFromFile } from './classImportCore.ts'

// self у контексті воркера — DedicatedWorkerGlobalScope, але tsconfig проєкту живе з
// lib DOM (не WebWorker): типи воркерного postMessage/onmessage беруться вузьким
// локальним інтерфейсом замість підключення конфліктної lib.
interface WorkerScope {
  onmessage: ((ev: MessageEvent) => void) | null
  postMessage(message: unknown): void
}

export interface PboWorkerRequest {
  taskId: number
  ping?: string
  file?: File
}

const scope = self as unknown as WorkerScope

scope.onmessage = (ev: MessageEvent) => {
  const data = ev.data as PboWorkerRequest
  if (data.file === undefined) {
    scope.postMessage({ taskId: data.taskId, pong: data.ping ?? null })
    return
  }
  void parsePboSource(fileLikeFromFile(data.file))
    .then((result) => scope.postMessage({ taskId: data.taskId, result }))
    .catch((err: unknown) =>
      scope.postMessage({ taskId: data.taskId, error: err instanceof Error ? err.message : String(err) }),
    )
}
