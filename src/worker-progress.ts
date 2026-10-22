export type WorkerProgress = {
  worker: number;
  status: string;
  directory: string;
  current: string;
  category: string;
  error: string;
  exitCode: number | null;
  started: string | null;
  ended: string | null;
  addresses: { address: string; status: string; products: number; errors: string[] }[];
};

export function updateProgress(worker: WorkerProgress, event: Record<string, unknown>) {
  const current = worker.addresses.find((item) => item.address === worker.current);
  switch (event.type) {
    case 'worker-ready': worker.directory = String(event.directory); worker.status = 'Копирование AVD'; break;
    case 'run-start': worker.status = 'Загрузка Android'; break;
    case 'app-ready': worker.status = 'Работает'; break;
    case 'store-start': {
      worker.current = String(event.address);
      worker.category = '';
      const address = worker.addresses.find((item) => item.address === worker.current);
      if (address) address.status = 'Собирается';
      break;
    }
    case 'configured-category-start': worker.category = String(event.path); break;
    case 'category-error':
      current?.errors.push(`${event.path}: ${event.message}`);
      worker.error = `${worker.current} / ${event.path}: ${event.message}`;
      break;
    case 'fatal-error':
      worker.error = String(event.message);
      if (current) { current.status = 'Ошибка'; current.errors.push(worker.error); }
      break;
    case 'store-end': {
      const address = worker.addresses.find((item) => item.address === event.address);
      if (address) {
        address.products = Number(event.products);
        address.status = Number(event.errors) || address.errors.length ? 'Частично' : 'Готово';
      }
      break;
    }
    case 'worker-cleanup': worker.status = 'Очистка AVD'; break;
    case 'worker-error': worker.error = String(event.message); break;
    case 'emulator-restart':
      worker.status = `Перезапуск ${event.attempt}/2`;
      worker.current = String(event.address);
      worker.category = '';
      worker.error = String(event.message);
      break;
  }
}

export function finishProgress(worker: WorkerProgress, code: number | null, error = '') {
  worker.exitCode = code;
  worker.ended = new Date().toISOString();
  for (const address of worker.addresses) {
    if (address.status === 'Ожидает') address.status = 'Не запущен';
    if (address.status === 'Собирается') {
      address.status = 'Ошибка';
      address.errors.push(error || worker.error || 'Процесс завершился без подтверждения окончания адреса');
    }
  }
  const complete = worker.addresses.every((address) => address.status === 'Готово');
  worker.status = code === 0 && complete ? 'Готово' : 'Ошибка';
  if (error) worker.error = error;
  if (worker.status === 'Ошибка' && !worker.error) worker.error = 'Сбор или очистка не завершены успешно; см. worker.log и run.log';
}
