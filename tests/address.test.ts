import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { matchesAddress, parseAddress } from '../src/extractors/pobeda/address.js';

test('addresses match formatting, abbreviations and optional room', () => {
  for (const [actual, requested] of [
    ['Шумерля, Косточкина,6А', 'ул. Косточкина, д. 6 A'],
    ['Шумерля, Косточкина,6А', 'Косточкина6а'],
    ['Старый Оскол, б-р Дружбы,8 пом.1', 'Дружбы,8'],
    ['Старый Оскол, б-р Дружбы,8 пом.1', 'г. Старый Оскол, бульвар Дружбы, дом 8, помещение 1'],
    ['Город, Молодёжная,2А', 'МОЛОДЕЖНАЯ, 2-А'],
    ['Медынь, Молодежная,2 А', 'Медынь, Молодежная, 2А'],
    ['Город, Ленина,8 корп.1', 'Ленина, д.8 к1'],
    ['Город, Ленина,8 стр.2', 'улица Ленина дом 8 строение 2'],
    ['Город, Ленина,1/1', 'Ленина 1 / 1'],
    ['Город, пр-кт Мира,12', 'пр-т Мира 12'],
    ['Город, 50 лет Октября,12', '50 лет Октября, д.12'],
  ]) assert.equal(matchesAddress(actual, requested), true, `${requested} → ${actual}`);
});

test('different streets, cities, houses, buildings and rooms do not match', () => {
  for (const [actual, requested] of [
    ['Город, Дружбы,80', 'Дружбы,8'],
    ['Город, Дружбы,8А', 'Дружбы,8'],
    ['Город, Дружбы,8/1', 'Дружбы,8'],
    ['Город, Дружбы,8 корпус 1', 'Дружбы,8'],
    ['Город, Дружбы,8 стр.1', 'Дружбы,8 корпус 1'],
    ['Город, Дружбы,8 пом.2', 'Дружбы,8 пом.1'],
    ['Город, Большая Молодежная,2', 'Молодежная,2'],
    ['Казань, Мира,12', 'Самара, Мира,12'],
    ['Медынь, Молодежная,2 А', 'Медынь, Молодежная, 2'],
    ['Другой город, Молодежная,2 А', 'Медынь, Молодежная, 2А'],
    ['Выберите любимый магазин', 'Медынь, Молодежная, 2А'],
    ['Город, Мира,12', 'Миар,12'],
    ['Выбрать', 'Дружбы,8'],
  ]) assert.equal(matchesAddress(actual, requested), false, `${requested} → ${actual}`);
});

test('search query uses street token, not city or house', () => {
  assert.equal(parseAddress('г. Старый Оскол, б-р Дружбы, д. 8 пом.1').query, 'дружбы');
  assert.equal(parseAddress('Молодёжная,2А').query, 'молодежная');
  assert.throws(() => parseAddress('Молодежная'), /Не удалось разобрать/);
  assert.throws(() => parseAddress('8'), /Не удалось разобрать/);
});
