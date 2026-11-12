-- Who added a booking by hand from the dashboard (a team member's name).
-- Bookings made by Bimbly (source 'voice' or 'online') leave this empty.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booked_by text;
