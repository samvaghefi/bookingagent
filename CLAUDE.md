# BookingAgent — Claude Code Guide

## What This Is
Multi-tenant AI voice receptionist SaaS. Small businesses get an AI agent that answers calls and books appointments 24/7. Built under the Bimbly brand (bimblyai.com).

## First Customer
Sam's Barbershop, Toronto
- Business ID: a09fdd0b-421e-479a-b4d7-120f6a72a043
- Vapi Assistant ID: 3f7183f9-4796-4104-8b08-015a4d675792
- Email: samsbarbershoptoronto@gmail.com
- Phone: +16475845925

## Tech Stack
- Backend: Node.js + Express
- Database: Supabase (Postgres)
- Voice AI: Vapi (Custom Tools for structured data extraction)
- SMS: Twilio
- Email: SendGrid
- Calendar: Google Calendar API
- Hosting: Render (https://bookingagent-gmo2.onrender.com)

## Key Files
- server/index.js — main webhook handler, branches on message.type; billing routes
- server/bookingService.js — extractFromToolCall(), saveBooking(), findBusiness()
- server/calendarService.js — Google Calendar event creation, OAuth flow
- server/notificationService.js — SMS, email, and payment failure notifications
- server/billingService.js — Stripe customer, subscription, and checkout session helpers
- vapi-system-prompt.txt — AI assistant prompt (paste into Vapi manually)

## Webhook Flow
1. Vapi calls POST /webhook/booking
2. If message.type === "tool-calls" → use extractFromToolCall() (structured, reliable)
3. If message.type === "end-of-call-report" → use extractBookingInfo() (regex fallback)
4. findBusiness() looks up business by phone or assistant ID
5. saveBooking() saves to Supabase bookings table
6. Send SMS to customer, email to owner, create Google Calendar event

## Vapi Custom Tool
- Tool ID: 97f86d72-3fc7-44bd-82f1-9b76b270023e
- Tool name: bookAppointment
- Server URL: https://bookingagent-gmo2.onrender.com/webhook/booking
- 10 properties: customerName, service, appointmentDate, appointmentTime, specialRequests, customerPhone, callbackNumber, serviceCount, preferredBarber, isNewCustomer

## Database Tables
- businesses — one row per customer business, includes Google OAuth tokens
- bookings — all appointments, 16+ columns including new: is_new_customer, preferred_barber, service_count, callback_number
- services — service menu per business

## Environment Variables (set in Render)
SUPABASE_URL, SUPABASE_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SENDGRID_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, NODE_ENV, STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET

## Google Calendar
- OAuth flow: GET /auth/google?businessId=xxx → Google login → /auth/google/callback
- Tokens stored per business in businesses table
- To reconnect: https://bookingagent-gmo2.onrender.com/auth/google?businessId=a09fdd0b-421e-479a-b4d7-120f6a72a043

## Stripe Billing
- GET /billing/checkout?businessId=xxx — creates Stripe Checkout Session, redirects to Stripe hosted page
- POST /billing/webhook — handles Stripe events (raw body required for sig verification)
- GET /billing/success — shown after successful checkout
- GET /billing/cancel — shown if user exits checkout
- billingService.js exports: createCustomer, createSubscription, cancelSubscription, getSubscription, createCheckoutSession
- Webhook handles: checkout.session.completed, customer.subscription.deleted, customer.subscription.updated, invoice.payment_failed
- STRIPE_WEBHOOK_SECRET: get from Stripe Dashboard → Developers → Webhooks after adding endpoint https://bookingagent-gmo2.onrender.com/billing/webhook
- Webhook skips sig verification if STRIPE_WEBHOOK_SECRET is not set (logs a warning) — set it after creating the webhook in Stripe

## Supabase — businesses table additions (run in SQL editor)
```sql
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_status text DEFAULT 'inactive',
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS billing_email text;
```

## Deploy Workflow
After EVERY change:
1. git add .
2. git commit -m "description"
3. git push origin main
Pushing to main auto-deploys to Render.

## Next Priorities
1. Fix Vapi system prompt to use {{currentDateTime}} for accurate date handling
2. Build admin dashboard for self-serve business onboarding
3. Run Supabase SQL migration to add Stripe columns (see above)
4. Create webhook endpoint in Stripe Dashboard and set STRIPE_WEBHOOK_SECRET in Render

## Known Issues
- System prompt has hardcoded date — needs {{currentDateTime}} variable
- Preferred barber sometimes not captured correctly
- No self-serve onboarding yet — businesses manually added to Supabase
