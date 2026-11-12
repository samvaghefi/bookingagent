'use strict';

// Dashboard numbers: a booking made today for later this month counts right away.

const request = require('supertest');
const express = require('express');
const { DateTime } = require('luxon');

const TZ = 'America/Toronto';
const now = DateTime.now().setZone(TZ);
const laterThisMonth = now.endOf('month').toISODate();
const earlierThisMonth = now.startOf('month').toISODate();
const lastMonth = now.minus({ months: 1 }).startOf('month').plus({ days: 2 }).toISODate();

const BOOKINGS = [
  { appointment_date: laterThisMonth, appointment_time: '11:00:00', customer_name: 'Sarah', service_ids: ['Manicure'], status: 'confirmed' },
  { appointment_date: earlierThisMonth, appointment_time: '10:00:00', customer_name: 'Ana', service_ids: ['Pedicure'], status: 'confirmed' },
  { appointment_date: earlierThisMonth, appointment_time: '12:00:00', customer_name: 'Bo', service_ids: ['Pedicure'], status: 'cancelled' },
  { appointment_date: null, appointment_time: null, customer_name: null, service_ids: [null], status: 'confirmed' }, // empty tool-call record
  { appointment_date: lastMonth, appointment_time: '09:00:00', customer_name: 'Cy', service_ids: ['Manicure'], status: 'confirmed' },
];
const SERVICES = [{ name: 'Manicure', price: 35 }, { name: 'Pedicure', price: 45 }];
// Walk-ins checked in today (UTC timestamps); no-shows and removed entries don't count
const nowUtc = now.toUTC().toISO();
let WALK_INS = [];

function buildApp() {
  jest.resetModules();
  const chain = result => {
    const self = {};
    ['select', 'eq', 'gte', 'lte', 'order', 'not', 'limit'].forEach(m => { self[m] = () => chain(result); });
    self.then = (res, rej) => Promise.resolve(result).then(res, rej);
    return self;
  };
  jest.doMock('@supabase/supabase-js', () => ({
    createClient: () => ({ from: table => chain({ data: table === 'services' ? SERVICES : table === 'walk_in_queue' ? WALK_INS : BOOKINGS, error: null }) }),
  }));
  jest.doMock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
  jest.doMock('googleapis', () => ({ google: { auth: { OAuth2: jest.fn() }, calendar: jest.fn() } }));
  jest.doMock('../../server/authMiddleware', () => (req, res, next) => { req.business = { id: 'biz-1', timezone: TZ }; next(); });
  const app = express();
  app.use(express.json());
  app.use(require('../../server/dashboardRoutes'));
  return app;
}

test('this month counts upcoming bookings; cancelled and empty records are ignored', async () => {
  const res = await request(buildApp()).get('/api/analytics');
  expect(res.status).toBe(200);
  expect(res.body.totalBookingsThisMonth).toBe(2);
  expect(res.body.revenueEstimateThisMonth).toBe(35 + 45);
  expect(res.body.totalBookingsLastMonth).toBe(1);
  const services = Object.fromEntries(res.body.popularServices.map(s => [s.service, s.count]));
  expect(services).toEqual({ Manicure: 2, Pedicure: 1 });
  expect(res.body.popularServices.some(s => s.service === 'null' || s.service == null)).toBe(false);
});

test('walk-ins count toward today, this month and revenue; no-shows and removed do not', async () => {
  WALK_INS = [
    { id: 'w1', customer_name: 'Jill', service: 'Manicure', status: 'waiting', created_at: nowUtc },
    { id: 'w2', customer_name: 'Alex', service: 'Pedicure', status: 'served', created_at: nowUtc, served_at: nowUtc },
    { id: 'w3', customer_name: 'Gone', service: 'Manicure', status: 'no_show', created_at: nowUtc },
    { id: 'w4', customer_name: 'Oops', service: 'Manicure', status: 'removed', created_at: nowUtc },
  ];
  try {
    const res = await request(buildApp()).get('/api/analytics');
    expect(res.status).toBe(200);
    expect(res.body.totalBookingsThisMonth).toBe(2 + 2);
    expect(res.body.revenueEstimateThisMonth).toBe(35 + 45 + 35 + 45);
    const todayWalkIns = res.body.todayBookings.filter(b => b.source === 'walk_in').map(b => b.customer_name).sort();
    expect(todayWalkIns).toEqual(['Alex', 'Jill']);
  } finally {
    WALK_INS = [];
  }
});
