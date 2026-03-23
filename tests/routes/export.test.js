'use strict';

const request = require('supertest');
const express = require('express');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BUSINESS = {
  id: 'biz-123',
  name: "Sam's Barbershop",
  booking_slug: 'sams-barbershop',
  plan: 'starter',
};

const BOOKINGS = [
  {
    id: 'b1',
    appointment_date: '2026-03-24',
    appointment_time: '10:00:00',
    customer_name: 'John Smith',
    customer_phone: '+14165550001',
    service_ids: ["Men's Haircut"],
    preferred_barber: 'Sam',
    special_requests: null,
    deposit_status: 'none',
    reminder_sent: false,
    created_at: '2026-03-20T12:00:00Z',
  },
  {
    id: 'b2',
    appointment_date: '2026-03-25',
    appointment_time: '14:30:00',
    customer_name: 'Jane Doe',
    customer_phone: '+14165550002',
    service_ids: ['Beard Trim', 'Shampoo'],
    preferred_barber: null,
    special_requests: 'Please be gentle',
    deposit_status: 'paid',
    reminder_sent: true,
    created_at: '2026-03-21T09:00:00Z',
  },
];

const CLIENTS = [
  {
    id: 'c1',
    name: 'John Smith',
    phone: '+14165550001',
    notes: 'VIP customer',
    tags: ['vip', 'regular'],
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'c2',
    name: 'Jane Doe',
    phone: '+14165550002',
    notes: null,
    tags: [],
    created_at: '2026-02-01T00:00:00Z',
  },
];

const BOOKING_STATS = [
  { customer_phone: '+14165550001', appointment_date: '2026-03-24', service_ids: ["Men's Haircut"], preferred_barber: 'Sam' },
  { customer_phone: '+14165550002', appointment_date: '2026-03-25', service_ids: ['Beard Trim'], preferred_barber: null },
];

// ── Supabase chain builder ────────────────────────────────────────────────────

function chain(result) {
  const self = { then: (res, rej) => Promise.resolve(result).then(res, rej) };
  ['select','eq','neq','order','gte','lte','in','limit','not'].forEach(m => {
    self[m] = () => chain(result);
  });
  self.single      = () => Promise.resolve(result);
  self.maybeSingle = () => Promise.resolve(result);
  self.insert      = () => chain(result);
  self.update      = () => chain(result);
  return self;
}

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp({ plan = 'starter', bookings = BOOKINGS, clients = CLIENTS, bookingStats = BOOKING_STATS } = {}) {
  jest.resetModules();

  jest.doMock('../../server/authMiddleware', () => (req, res, next) => {
    req.business = { id: 'biz-123' };
    next();
  });

  jest.doMock('@supabase/supabase-js', () => ({
    createClient: () => ({
      from: (table) => {
        if (table === 'businesses') return chain({ data: { ...BUSINESS, plan }, error: null });
        if (table === 'bookings')   return chain({ data: bookings, error: null });
        if (table === 'clients')    return chain({ data: clients, error: null });
        return chain({ data: null, error: null });
      },
    }),
  }));

  const router = require('../../server/exportRoutes');
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

// ── GET /api/export/bookings ──────────────────────────────────────────────────

describe('GET /api/export/bookings', () => {
  test('403 for solo plan', () => {
    const app = buildApp({ plan: 'solo' });
    return request(app).get('/api/export/bookings').then(res => {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/upgrade|starter/i);
    });
  });

  test('200 with CSV content-type for starter plan', async () => {
    const app = buildApp({ plan: 'starter' });
    const res = await request(app).get('/api/export/bookings');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  test('200 with CSV content-type for pro plan', async () => {
    const app = buildApp({ plan: 'pro' });
    const res = await request(app).get('/api/export/bookings');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  test('Content-Disposition includes bookings filename with slug and date', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/export/bookings');
    expect(res.headers['content-disposition']).toMatch(/bookings-sams-barbershop-\d{4}-\d{2}-\d{2}\.csv/);
  });

  test('CSV contains header row with all required columns', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/export/bookings');
    const lines = res.text.split('\n');
    expect(lines[0]).toMatch(/Date/);
    expect(lines[0]).toMatch(/Time/);
    expect(lines[0]).toMatch(/Customer Name/);
    expect(lines[0]).toMatch(/Phone/);
    expect(lines[0]).toMatch(/Service/);
    expect(lines[0]).toMatch(/Team Member/);
    expect(lines[0]).toMatch(/Special Requests/);
    expect(lines[0]).toMatch(/Deposit Status/);
    expect(lines[0]).toMatch(/Reminder Sent/);
    expect(lines[0]).toMatch(/Created At/);
  });

  test('CSV contains one data row per booking', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/export/bookings');
    const lines = res.text.trim().split('\n');
    expect(lines.length).toBe(3); // header + 2 bookings
  });

  test('booking data row contains correct field values', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/export/bookings');
    const lines = res.text.trim().split('\n');
    expect(lines[1]).toMatch(/2026-03-24/);
    expect(lines[1]).toMatch(/John Smith/);
    expect(lines[1]).toMatch(/\+14165550001/);
    expect(lines[1]).toMatch(/Sam/);
  });

  test('multiple services are joined', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/export/bookings');
    const lines = res.text.trim().split('\n');
    expect(lines[2]).toMatch(/Beard Trim/);
  });

  test('handles empty bookings gracefully — only header row', async () => {
    const app = buildApp({ bookings: [] });
    const res = await request(app).get('/api/export/bookings');
    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n');
    expect(lines.length).toBe(1); // header only
  });

  test('commas in fields are quoted', async () => {
    const bookingsWithComma = [{
      ...BOOKINGS[0],
      special_requests: 'Short on sides, long on top',
    }];
    const app = buildApp({ bookings: bookingsWithComma });
    const res = await request(app).get('/api/export/bookings');
    expect(res.text).toMatch(/"Short on sides, long on top"/);
  });
});

// ── GET /api/export/clients ───────────────────────────────────────────────────

describe('GET /api/export/clients', () => {
  test('403 for solo plan', () => {
    const app = buildApp({ plan: 'solo' });
    return request(app).get('/api/export/clients').then(res => {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/upgrade|starter/i);
    });
  });

  test('200 with CSV content-type for starter plan', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/export/clients');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });

  test('Content-Disposition includes clients filename with slug and date', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/export/clients');
    expect(res.headers['content-disposition']).toMatch(/clients-sams-barbershop-\d{4}-\d{2}-\d{2}\.csv/);
  });

  test('CSV contains header row with all required columns', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/export/clients');
    const lines = res.text.split('\n');
    expect(lines[0]).toMatch(/Name/);
    expect(lines[0]).toMatch(/Phone/);
    expect(lines[0]).toMatch(/Total Visits/);
    expect(lines[0]).toMatch(/Last Visit/);
    expect(lines[0]).toMatch(/Preferred Service/);
    expect(lines[0]).toMatch(/Preferred Team Member/);
    expect(lines[0]).toMatch(/Tags/);
    expect(lines[0]).toMatch(/Notes/);
    expect(lines[0]).toMatch(/Created At/);
  });

  test('CSV contains one data row per client', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/export/clients');
    const lines = res.text.trim().split('\n');
    expect(lines.length).toBe(3); // header + 2 clients
  });

  test('client data row contains correct field values', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/export/clients');
    const lines = res.text.trim().split('\n');
    expect(lines[1]).toMatch(/John Smith/);
    expect(lines[1]).toMatch(/\+14165550001/);
    expect(lines[1]).toMatch(/VIP customer/);
  });

  test('tags are joined as semicolon-separated string', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/export/clients');
    const lines = res.text.trim().split('\n');
    expect(lines[1]).toMatch(/vip;regular/);
  });

  test('visit stats (total visits, last visit, preferred service) are computed from bookings', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/export/clients');
    const lines = res.text.trim().split('\n');
    // John Smith has 1 booking
    expect(lines[1]).toMatch(/1/);
    expect(lines[1]).toMatch(/2026-03-24/);
  });

  test('handles empty clients gracefully — only header row', async () => {
    const app = buildApp({ clients: [] });
    const res = await request(app).get('/api/export/clients');
    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n');
    expect(lines.length).toBe(1);
  });

  test('notes with commas are quoted', async () => {
    const clientsWithComma = [{ ...CLIENTS[0], notes: 'Good customer, always on time' }];
    const app = buildApp({ clients: clientsWithComma });
    const res = await request(app).get('/api/export/clients');
    expect(res.text).toMatch(/"Good customer, always on time"/);
  });
});
