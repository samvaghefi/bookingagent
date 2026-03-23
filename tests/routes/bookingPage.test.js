'use strict';

const request = require('supertest');
const express = require('express');

// ── Shared fixtures ───────────────────────────────────────────────────────────

const BUSINESS = {
  id: 'biz-123',
  name: "Sam's Barbershop",
  address: '200 Goulding Ave',
  business_hours: {
    tuesday:  { open: '09:00', close: '18:00', closed: false },
    saturday: { open: '09:00', close: '17:00', closed: false },
    sunday:   { open: '09:00', close: '17:00', closed: true  },
  },
  timezone: 'America/Toronto',
  business_type: 'Barbershop',
  barbers: [],
  team_members: [],
  is_active: true,
  deposit_enabled: false,
  google_access_token: null,
  google_refresh_token: null,
};

const SERVICES = [
  { id: 'svc-1', name: "Men's Haircut", price: 35, duration_minutes: 30, description: null },
  { id: 'svc-2', name: 'Beard Trim',    price: 20, duration_minutes: 20, description: null },
];

const BOOKING_RECORD = {
  id: 'booking-1', business_id: 'biz-123',
  customer_name: 'John Smith', appointment_date: '2026-03-24', appointment_time: '10:00:00',
};

// ── Supabase chain builder ────────────────────────────────────────────────────
// Returns an object where every method returns itself (builder pattern),
// with terminal methods (single/maybeSingle) resolving to the given value.

function chain(result) {
  const self = {};
  ['select','eq','neq','or','order','gte','lte','in','limit'].forEach(m => {
    self[m] = () => chain(result);
  });
  self.single      = () => Promise.resolve(result);
  self.maybeSingle = () => Promise.resolve(result);
  self.insert      = () => chain(result);  // supports .insert().select().single()
  self.update      = () => chain(result);
  return self;
}

// ── App factory using jest.doMock (not hoisted) ───────────────────────────────

function buildApp(supabaseMock) {
  jest.resetModules();

  jest.doMock('@supabase/supabase-js', () => ({
    createClient: () => supabaseMock,
  }));
  jest.doMock('../../server/calendarService', () => ({
    getFreeBusy:         jest.fn().mockResolvedValue([]),
    createCalendarEvent: jest.fn().mockResolvedValue(null),
  }));
  jest.doMock('../../server/notificationService', () => ({
    sendCustomerSMS: jest.fn().mockResolvedValue(null),
    sendOwnerEmail:  jest.fn().mockResolvedValue(null),
  }));
  jest.doMock('../../server/depositService', () => ({
    createDepositToken: jest.fn().mockReturnValue('tok_test'),
  }));

  const router = require('../../server/bookingPageRoutes');
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

// ── GET /api/book/:businessId/info ────────────────────────────────────────────

describe('GET /api/book/:businessId/info', () => {
  test('returns 200 with business and services', () => {
    const supabase = {
      from: (table) => {
        if (table === 'businesses') return chain({ data: BUSINESS, error: null });
        if (table === 'services')   return { select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: SERVICES, error: null }) }) }) }) };
        return chain({ data: null, error: null });
      },
    };
    const app = buildApp(supabase);
    return request(app).get('/api/book/biz-123/info').then(res => {
      expect(res.status).toBe(200);
      expect(res.body.business).toBeDefined();
      expect(Array.isArray(res.body.services)).toBe(true);
      expect(res.body.services.length).toBe(2);
    });
  });

  test('normalises legacy string barbers to { name, role, calendarId }', () => {
    const bizWithStrings = { ...BUSINESS, barbers: ['Sam', 'Alex'], team_members: null };
    const supabase = {
      from: (table) => {
        if (table === 'businesses') return chain({ data: bizWithStrings, error: null });
        if (table === 'services')   return { select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }) };
        return chain({ data: null, error: null });
      },
    };
    const app = buildApp(supabase);
    return request(app).get('/api/book/biz-123/info').then(res => {
      expect(res.status).toBe(200);
      expect(res.body.business.barbers[0]).toEqual({ name: 'Sam', role: '', calendarId: '' });
      expect(res.body.business.barbers[1]).toEqual({ name: 'Alex', role: '', calendarId: '' });
    });
  });

  test('preserves role field from team_members column', () => {
    const bizWithRoles = { ...BUSINESS, team_members: [{ name: 'Sam', role: 'Barber', calendarId: '' }], barbers: [] };
    const supabase = {
      from: (table) => {
        if (table === 'businesses') return chain({ data: bizWithRoles, error: null });
        if (table === 'services')   return { select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }) };
        return chain({ data: null, error: null });
      },
    };
    const app = buildApp(supabase);
    return request(app).get('/api/book/biz-123/info').then(res => {
      expect(res.status).toBe(200);
      expect(res.body.business.team_members[0]).toEqual({ name: 'Sam', role: 'Barber', calendarId: '' });
      expect(res.body.business.team_members[0].role).toBe('Barber');
    });
  });

  test('returns business_type in /info response', () => {
    const supabase = {
      from: (table) => {
        if (table === 'businesses') return chain({ data: BUSINESS, error: null });
        if (table === 'services')   return { select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: SERVICES, error: null }) }) }) }) };
        return chain({ data: null, error: null });
      },
    };
    const app = buildApp(supabase);
    return request(app).get('/api/book/biz-123/info').then(res => {
      expect(res.status).toBe(200);
      expect(res.body.business.business_type).toBeDefined();
      expect(res.body.business.business_type).toBe('Barbershop');
    });
  });

  test('team_members preferred over barbers when both present', () => {
    const biz = {
      ...BUSINESS,
      team_members: [{ name: 'Sam', role: 'Barber', calendarId: '' }],
      barbers: [{ name: 'OldData', calendarId: '' }],
    };
    const supabase = {
      from: (table) => {
        if (table === 'businesses') return chain({ data: biz, error: null });
        if (table === 'services')   return { select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }) }) };
        return chain({ data: null, error: null });
      },
    };
    const app = buildApp(supabase);
    return request(app).get('/api/book/biz-123/info').then(res => {
      expect(res.status).toBe(200);
      expect(res.body.business.team_members[0].name).toBe('Sam');
      expect(res.body.business.team_members[0].role).toBe('Barber');
    });
  });

  test('returns 404 when business not found', () => {
    const supabase = { from: () => chain({ data: null, error: { message: 'not found' } }) };
    const app = buildApp(supabase);
    return request(app).get('/api/book/nonexistent/info').then(res => {
      expect(res.status).toBe(404);
    });
  });
});

// ── GET /api/book/:businessId/availability ────────────────────────────────────

function availabilityApp(bizOverride = {}) {
  const biz = { ...BUSINESS, ...bizOverride };
  const supabase = {
    from: (table) => {
      if (table === 'businesses') return chain({ data: biz, error: null });
      if (table === 'bookings')   return { select: () => ({ eq: () => ({ eq: () => ({ neq: () => Promise.resolve({ data: [], error: null }) }) }) }) };
      return chain({ data: null, error: null });
    },
  };
  return buildApp(supabase);
}

describe('GET /api/book/:businessId/availability', () => {
  test('returns 400 when date param is missing', () => {
    return request(availabilityApp()).get('/api/book/biz-123/availability').then(res => {
      expect(res.status).toBe(400);
    });
  });

  test('returns 400 for invalid date format', () => {
    return request(availabilityApp()).get('/api/book/biz-123/availability?date=25-03-2026').then(res => {
      expect(res.status).toBe(400);
    });
  });

  test('returns closed:true for Sunday (closed day)', () => {
    return request(availabilityApp()).get('/api/book/biz-123/availability?date=2026-03-22&duration=30').then(res => {
      expect(res.status).toBe(200);
      expect(res.body.closed).toBe(true);
    });
  });

  test('returns slots array for Tuesday (open day)', () => {
    return request(availabilityApp()).get('/api/book/biz-123/availability?date=2026-03-24&duration=30').then(res => {
      expect(res.status).toBe(200);
      expect(res.body.closed).toBe(false);
      expect(Array.isArray(res.body.slots)).toBe(true);
      expect(res.body.slots.length).toBeGreaterThan(0);
    });
  });

  test('slot objects have time (HH:MM) and available (boolean) fields', () => {
    return request(availabilityApp()).get('/api/book/biz-123/availability?date=2026-03-24&duration=30').then(res => {
      const slot = res.body.slots[0];
      expect(slot).toHaveProperty('time');
      expect(/^\d{2}:\d{2}$/.test(slot.time)).toBe(true);
      expect(typeof slot.available).toBe('boolean');
    });
  });

  test('returns closed:true for a day not in business_hours', () => {
    // Wednesday not in BUSINESS.business_hours → closed
    return request(availabilityApp()).get('/api/book/biz-123/availability?date=2026-03-25&duration=30').then(res => {
      expect(res.body.closed).toBe(true);
    });
  });

  test('returns 404 when business not found', () => {
    const supabase = { from: () => chain({ data: null, error: { message: 'not found' } }) };
    return request(buildApp(supabase)).get('/api/book/biz-123/availability?date=2026-03-24&duration=30').then(res => {
      expect(res.status).toBe(404);
    });
  });
});

// ── POST /api/book/:businessId ────────────────────────────────────────────────

const VALID_BODY = {
  customerName:    'John Smith',
  customerPhone:   '+14165550000',
  customerEmail:   'john@example.com',
  service:         "Men's Haircut",
  appointmentDate: '2026-03-24',
  appointmentTime: '10:00',
  duration_minutes: 30,
};

function bookingApp(bizOverride = {}) {
  const biz = { ...BUSINESS, ...bizOverride };
  const supabase = {
    from: (table) => {
      if (table === 'businesses') return chain({ data: biz, error: null });
      if (table === 'bookings') {
        return {
          insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: BOOKING_RECORD, error: null }) }) }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        };
      }
      return chain({ data: null, error: null });
    },
  };
  return buildApp(supabase);
}

describe('POST /api/book/:businessId', () => {
  test('200 + bookingId on valid input', () => {
    return request(bookingApp()).post('/api/book/biz-123').send(VALID_BODY).then(res => {
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.bookingId).toBeDefined();
    });
  });

  test('400 when required fields missing', () => {
    return request(bookingApp()).post('/api/book/biz-123').send({ customerName: 'John' }).then(res => {
      expect(res.status).toBe(400);
    });
  });

  test('400 for invalid phone number', () => {
    return request(bookingApp()).post('/api/book/biz-123').send({ ...VALID_BODY, customerPhone: 'notaphone' }).then(res => {
      expect(res.status).toBe(400);
    });
  });

  test('400 for invalid date format', () => {
    return request(bookingApp()).post('/api/book/biz-123').send({ ...VALID_BODY, appointmentDate: '24/03/2026' }).then(res => {
      expect(res.status).toBe(400);
    });
  });

  test('400 for invalid time format (2 PM not HH:MM)', () => {
    return request(bookingApp()).post('/api/book/biz-123').send({ ...VALID_BODY, appointmentTime: '2 PM' }).then(res => {
      expect(res.status).toBe(400);
    });
  });

  test('400 for invalid email', () => {
    return request(bookingApp()).post('/api/book/biz-123').send({ ...VALID_BODY, customerEmail: 'notanemail' }).then(res => {
      expect(res.status).toBe(400);
    });
  });

  test('400 for out-of-range duration', () => {
    return request(bookingApp()).post('/api/book/biz-123').send({ ...VALID_BODY, duration_minutes: 999 }).then(res => {
      expect(res.status).toBe(400);
    });
  });

  test('deposit_required: false when deposit_enabled is false', () => {
    return request(bookingApp()).post('/api/book/biz-123').send(VALID_BODY).then(res => {
      expect(res.body.deposit_required).toBe(false);
    });
  });

  test('deposit_required: true and deposit_url set when deposit_enabled is true', () => {
    return request(bookingApp({ deposit_enabled: true })).post('/api/book/biz-123').send(VALID_BODY).then(res => {
      expect(res.body.deposit_required).toBe(true);
      expect(res.body.deposit_url).toBeDefined();
    });
  });

  test('404 when business not found', () => {
    const supabase = { from: () => chain({ data: null, error: { message: 'not found' } }) };
    return request(buildApp(supabase)).post('/api/book/biz-123').send(VALID_BODY).then(res => {
      expect(res.status).toBe(404);
    });
  });

  test('400 — PostgREST injection attempt in phone field', () => {
    return request(bookingApp()).post('/api/book/biz-123')
      .send({ ...VALID_BODY, customerPhone: '+1,eq.businesses.select.*' })
      .then(res => { expect(res.status).toBe(400); });
  });

  test('400 — SQL injection in appointmentDate', () => {
    return request(bookingApp()).post('/api/book/biz-123')
      .send({ ...VALID_BODY, appointmentDate: "2026-03-24'; DROP TABLE bookings;--" })
      .then(res => { expect(res.status).toBe(400); });
  });
});
