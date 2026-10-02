// Normalize formatting, not street-name typos or distinct house numbers.
export function parseAddress(text: string) {
  const normalized = text.toLowerCase().replace(/ё/g, 'е')
    .replace(/[abcehkmoptxy]/g, (letter) => ({ a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' })[letter]!)
    .replace(/б\s*-\s*р/g, 'бульвар').replace(/пр\s*-\s*(?:кт|т)/g, 'проспект')
    .replace(/пр\s*-\s*д/g, 'проезд').replace(/м\s*-\s*н/g, 'микрорайон')
    .replace(/[.№"«»]/g, ' ').replace(/,/g, ' , ')
    .replace(/(?<![а-я])(?:корпус|корп|к)\s*(?=\d)/g, ' корпус ')
    .replace(/(?<![а-я])(?:строение|стр)\s*(?=\d)/g, ' строение ')
    .replace(/(?<![а-я])(?:помещение|пом)\s*(?=\d)/g, ' помещение ')
    .replace(/(?<![а-я])(?:дом|д)\s*(?=\d)/g, ' ')
    .replace(/(?:^|\s)(?:город|г)(?=\s|$)/g, ' ')
    .replace(/(?:^|\s)(?:улица|ул|бульвар|проспект|просп|пркт|проезд|прд|переулок|пер|шоссе|ш|площадь|пл|микрорайон|мкр|набережная|наб)(?=\s|$)/g, ' , ')
    .replace(/([а-я])(?=\d)/g, '$1 ')
    .replace(/(\d)\s*-\s*([а-я])(?=\s|,|$)/g, '$1$2')
    .replace(/(\d)\s+([а-я])(?=\s|$)/g, '$1$2')
    .replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
  const match = normalized.match(/^(.*?)\s+(\d+[а-я]?(?:\/\d+[а-я]?)?)(?:[\s,]+корпус\s+(\d+[а-я]?))?(?:[\s,]+строение\s+(\d+[а-я]?))?(?:[\s,]+помещение\s+(\d+[а-я]?(?:\/\d+)?))?$/u);
  if (!match || !match[1]) throw new Error(`Не удалось разобрать адрес (нужны улица и номер дома): ${text}`);
  const parts = match[1].split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`Не указана улица: ${text}`);
  return { city: parts.slice(0, -1).join(' '), street: parts.at(-1)!, house: match[2], building: match[3] || '', structure: match[4] || '', room: match[5] || '', query: parts.at(-1)!.split(' ').at(-1)! };
}

export function matchesAddress(text: string, address: string) {
  const requested = parseAddress(address);
  let actual;
  try { actual = parseAddress(text); } catch { return false; }
  return actual.street === requested.street && (!requested.city || actual.city === requested.city)
    && actual.house === requested.house && actual.building === requested.building && actual.structure === requested.structure
    && (!requested.room || actual.room === requested.room);
}
