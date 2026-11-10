'use strict';

// createBusiness must store the password hash, city and province it is given.
const inserted = [];

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      insert: row => {
        inserted.push(row);
        return { select: () => ({ single: async () => ({ data: { id: 'test-id', ...row }, error: null }) }) };
      },
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  }),
}));

const { createBusiness } = require('../../server/signupService');

beforeEach(() => { inserted.length = 0; });

test('stores password_hash, city and province', async () => {
  await createBusiness({
    businessName: 'Fade Room', ownerName: 'Jay', email: 'jay@faderoom.ca', phone: '+14165550123',
    businessType: 'barbershop', plan: 'starter', city: 'Toronto', province: 'ON', passwordHash: '$2a$10$hash',
  });
  expect(inserted).toHaveLength(1);
  expect(inserted[0]).toMatchObject({ password_hash: '$2a$10$hash', city: 'Toronto', province: 'ON', plan: 'starter' });
});

test('password_hash is null when none is given (admin test provisioning)', async () => {
  await createBusiness({ businessName: 'Test', ownerName: 'T', email: 't@t.co', phone: '+14165550123', businessType: 'other' });
  expect(inserted[0].password_hash).toBeNull();
});
