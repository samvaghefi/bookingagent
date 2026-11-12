'use strict';

// POST /api/bookings: the owner or a team member adds a booking by hand.

const request = require('supertest');
const express = require('express');

const TEAM = [{ name: 'Sam Vaghefi' }, { name: 'Lina' }];
let inserted;
let slotResult;
let failBookedByOnce;

function buildApp() {
  jest.resetModules();
  inserted = [];
  const chain = (table, result) => {
    const self = {};
    ['select', 'eq', 'gte', 'lte', 'order', 'not', 'limit'].forEach(m => { self[m] = () => self; });
    self.insert = rec => {
      if (failBookedByOnce && 'booked_by' in rec) {
        failBookedByOnce = false;
        const err = chain(table, { data: null, error: { message: "Could not find the 'booked_by' column of 'bookings'" } });
        return err;
      }
      inserted.push(rec);
      return chain(table, { data: { id: 'bk-1', ...rec }, error: null });
    };
    self.update = () => self;
    self.single = () => self;
    self.then = (res, rej) => Promise.resolve(result).then(res, rej);
    return self;
  };
  jest.doMock('@supabase/supabase-js', () => ({
    createClient: () => ({ from: table => chain(table, { data: table === 'services' ? [{ name: 'Manicure', duration_minutes: 45 }] : [], error: null }) }),
  }));
  jest.doMock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
  jest.doMock('googleapis', () => ({ google: { auth: { OAuth2: jest.fn() }, calendar: jest.fn() } }));
  jest.doMock('../../server/availabilityService', () => ({ checkSlot: jest.fn(async () => slotResult) }));
  jest.doMock('../../server/calendarService', () => ({ createCalendarEvent: jest.fn(async () => {}) }));
  jest.doMock('../../server/notificationService', () => ({ sendCustomerSMS: jest.fn(async () => true) }));
  jest.doMock('../../server/reminderService', () => ({ maybeScheduleReminder: jest.fn(async () => {}) }));
  jest.doMock('../../server/authMiddleware', () => (req, res, next) => {
    req.business = { id: 'biz-1', timezone: 'America/Toronto', owner_name: 'Sam Vaghefi', team_members: TEAM };
    next();
  });
  const app = express();
  app.use(express.json());
  app.use(require('../../server/dashboardRoutes'));
  return app;
}

const body = over => ({
  customerName: 'Rita', customerPhone: '647 555 0101', service: 'manicure',
  date: '2030-01-15', time: '14:30', teamMember: 'Lina', bookedBy: 'Lina', ...over,
});

beforeEach(() => { slotResult = { available: true }; failBookedByOnce = false; });

test('saves a manual booking with the team member who added it', async () => {
  const res = await request(buildApp()).post('/api/bookings').send(body());
  expect(res.status).toBe(201);
  expect(inserted).toHaveLength(1);
  expect(inserted[0]).toMatchObject({
    source: 'manual', booked_by: 'Lina', customer_name: 'Rita', service_ids: ['Manicure'],
    appointment_date: '2030-01-15', appointment_time: '14:30:00', duration_minutes: 45, preferred_barber: 'Lina',
  });
});

test('a taken time answers 409 with free alternatives, and force books it anyway', async () => {
  slotResult = { available: false, reason: 'busy', alternatives: [{ date: '2030-01-15', time: '15:00' }] };
  const app = buildApp();
  const res = await request(app).post('/api/bookings').send(body());
  expect(res.status).toBe(409);
  expect(res.body.alternatives).toEqual([{ date: '2030-01-15', time: '15:00' }]);
  expect(inserted).toHaveLength(0);
  const forced = await request(app).post('/api/bookings').send(body({ force: true }));
  expect(forced.status).toBe(201);
  expect(inserted).toHaveLength(1);
});

test('rejects someone who is not on the team as "added by", and missing fields', async () => {
  const app = buildApp();
  expect((await request(app).post('/api/bookings').send(body({ bookedBy: 'Stranger' }))).status).toBe(400);
  expect((await request(app).post('/api/bookings').send(body({ customerName: '' }))).status).toBe(400);
  expect((await request(app).post('/api/bookings').send(body({ time: '2pm' }))).status).toBe(400);
  expect(inserted).toHaveLength(0);
});

test('still saves when the booked_by column has not been added yet', async () => {
  failBookedByOnce = true;
  const res = await request(buildApp()).post('/api/bookings').send(body());
  expect(res.status).toBe(201);
  expect(inserted).toHaveLength(1);
  expect(inserted[0].booked_by).toBeUndefined();
  expect(inserted[0].source).toBe('manual');
});
