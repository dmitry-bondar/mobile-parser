import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { finishProgress, updateProgress, type WorkerProgress } from '../src/worker-progress.js';

function worker(): WorkerProgress {
  return { worker: 1, status: 'Ожидает', directory: '', current: '', category: '', error: '', exitCode: null, started: null, ended: null,
    addresses: ['Адрес 1', 'Адрес 2'].map((address) => ({ address, status: 'Ожидает', products: 0, errors: [] })) };
}

test('completed addresses are successful only after explicit store-end', () => {
  const state = worker();
  for (const address of state.addresses) {
    updateProgress(state, { type: 'store-start', address: address.address });
    updateProgress(state, { type: 'store-end', address: address.address, errors: 0, products: 12 });
  }
  updateProgress(state, { type: 'worker-cleanup' });
  assert.equal(state.status, 'Очистка AVD');
  finishProgress(state, 0);
  assert.equal(state.status, 'Готово');
  assert.deepEqual(state.addresses.map((item) => item.products), [12, 12]);
});

test('category errors mark only the affected address partial; next address can succeed', () => {
  const state = worker();
  updateProgress(state, { type: 'store-start', address: 'Адрес 1' });
  updateProgress(state, { type: 'category-error', path: 'Мясо/Птица', message: 'Не загрузились товары' });
  updateProgress(state, { type: 'store-end', address: 'Адрес 1', errors: 1, products: 4 });
  updateProgress(state, { type: 'store-start', address: 'Адрес 2' });
  updateProgress(state, { type: 'store-end', address: 'Адрес 2', errors: 0, products: 9 });
  finishProgress(state, 1);
  assert.deepEqual(state.addresses.map((item) => item.status), ['Частично', 'Готово']);
  assert.match(state.addresses[0].errors[0], /Мясо\/Птица/);
  assert.equal(state.addresses[1].errors.length, 0);
  assert.equal(state.status, 'Ошибка');
});

test('fatal store failure retains its message and marks remaining addresses not started', () => {
  const state = worker();
  updateProgress(state, { type: 'store-start', address: 'Адрес 1' });
  updateProgress(state, { type: 'fatal-error', message: 'Адрес не найден: Адрес 1' });
  finishProgress(state, 1);
  assert.deepEqual(state.addresses.map((item) => item.status), ['Ошибка', 'Не запущен']);
  assert.match(state.addresses[0].errors[0], /Адрес не найден/);
});

test('crash without final metric is not counted as a successful address even with code zero', () => {
  const state = worker();
  updateProgress(state, { type: 'store-start', address: 'Адрес 1' });
  finishProgress(state, 0);
  assert.equal(state.status, 'Ошибка');
  assert.deepEqual(state.addresses.map((item) => item.status), ['Ошибка', 'Не запущен']);
});

test('failed cleanup does not erase successfully collected address statuses', () => {
  const state = worker();
  for (const address of state.addresses) updateProgress(state, { type: 'store-end', address: address.address, errors: 0, products: 3 });
  updateProgress(state, { type: 'worker-error', message: 'Копия оставлена: остановка не подтверждена' });
  finishProgress(state, 1);
  assert.ok(state.addresses.every((address) => address.status === 'Готово'));
  assert.equal(state.status, 'Ошибка');
  assert.match(state.error, /остановка не подтверждена/);
});

test('startup error and cancellation cannot report unstarted addresses as complete', () => {
  const state = worker();
  finishProgress(state, null, 'Порт уже занят');
  assert.ok(state.addresses.every((address) => address.status === 'Не запущен'));
  assert.equal(state.status, 'Ошибка');
});

test('emulator restart does not turn an already completed address into an error', () => {
  const state = worker();
  updateProgress(state, { type: 'store-start', address: 'Адрес 1' });
  updateProgress(state, { type: 'store-end', address: 'Адрес 1', products: 5, errors: 0 });
  updateProgress(state, { type: 'emulator-restart', address: 'Адрес 2', attempt: 1, message: 'native crash' });
  assert.equal(state.status, 'Перезапуск 1/2');
  updateProgress(state, { type: 'fatal-error', message: 'Повторы исчерпаны' });
  finishProgress(state, 1);
  assert.equal(state.addresses[0].status, 'Готово');
  assert.equal(state.addresses[0].errors.length, 0);
});
