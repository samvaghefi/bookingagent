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
- server/index.js — main webhook handler, branches on message.type
- server/bookingService.js — extractFromToolCall(), saveBooking(), findBusiness()
- server/calendarService.js — Google Calendar event creation, OAuth flow
- server/notificationService.js — SMS and email sending
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
SUPABASE_URL, SUPABASE_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SENDGRID_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, NODE_ENV

## Google Calendar
- OAuth flow: GET /auth/google?businessId=xxx → Google login → /auth/google/callback
- Tokens stored per business in businesses table
- To reconnect: https://bookingagent-gmo2.onrender.com/auth/google?businessId=a09fdd0b-421e-479a-b4d7-120f6a72a043

## Deploy Workflow
After EVERY change:
1. git add .
2. git commit -m "description"
3. git push origin main
Pushing to main auto-deploys to Render.

## Next Priorities
1. Fix Vapi system prompt to use {{currentDateTime}} for accurate date handling
2. Build admin dashboard for self-serve business onboarding
3. Add Stripe billing

## Known Issues
- System prompt has hardcoded date — needs {{currentDateTime}} variable
- Preferred barber sometimes not captured correctly
- No self-serve onboarding yet — businesses manually added to Supabase
