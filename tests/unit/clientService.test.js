'use strict';

// Clients are matched by phone digits, so different formats are one person.

let rows;
let inserted;

function load() {
  jest.resetModules();
  inserted = [];
  const chain = result => {
    const self = {};
    let phones = null;
    ['select', 'eq', 'limit', 'single'].forEach(m => { self[m] = () => self; });
    self.in = (col, list) => { phones = list; return self; };
    self.insert = rec => { inserted.push(rec); return chain({ data: { id: 'new' }, error: null }); };
    self.then = (res, rej) => Promise.resolve(
      phones ? { data: rows.filter(r => phones.includes(r.phone)), error: null } : result
    ).then(res, rej);
    return self;
  };
  jest.doMock('@supabase/supabase-js', () => ({ createClient: () => ({ from: () => chain({ data: [], error: null }) }) }));
  return require('../../server/clientService');
}

test('phoneKey and toE164 treat every format of a number the same', () => {
  const { phoneKey, toE164 } = load();
  for (const p of ['+16475551234', '16475551234', '6475551234', '(647) 555-1234', '647 555 1234']) {
    expect(phoneKey(p)).toBe('6475551234');
    expect(toE164(p)).toBe('+16475551234');
  }
});

test('ensureClient adds a new customer once, stored as +1XXXXXXXXXX', async () => {
  rows = [];
  const { ensureClient } = load();
  await ensureClient('biz', { name: 'Alice James', phone: '647 239 7654' });
  expect(inserted).toEqual([{ business_id: 'biz', name: 'Alice James', phone: '+16472397654' }]);
});

test('ensureClient finds an existing client saved in another format and leaves it alone', async () => {
  rows = [{ id: 'c1', phone: '6472397654' }];
  const { ensureClient } = load();
  const c = await ensureClient('biz', { name: 'Alice J', phone: '+16472397654' });
  expect(c.id).toBe('c1');
  expect(inserted).toHaveLength(0);
});

test('ensureClient skips customers without a usable name or phone', async () => {
  rows = [];
  const { ensureClient } = load();
  await ensureClient('biz', { name: '', phone: '6475551234' });
  await ensureClient('biz', { name: 'Bo', phone: '' });
  expect(inserted).toHaveLength(0);
});
