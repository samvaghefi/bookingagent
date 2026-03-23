'use strict';

const express = require('express');
const multer  = require('multer');
const { createClient } = require('@supabase/supabase-js');
const authMiddleware = require('./authMiddleware');

const router   = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const ALLOWED_MIMETYPES = ['image/png', 'image/jpeg'];
const BUCKET = 'business-logos';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

// Wrapper that catches multer LIMIT_FILE_SIZE errors
function handleUpload(req, res, next) {
  upload.single('logo')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 2MB.' });
    }
    if (err) return next(err);
    next();
  });
}

// ── POST /api/business/logo ───────────────────────────────────────────────────
router.post('/api/business/logo', authMiddleware, handleUpload, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file attached.' });
  }

  if (!ALLOWED_MIMETYPES.includes(req.file.mimetype)) {
    return res.status(400).json({ error: 'Only PNG and JPG files are allowed.' });
  }

  const businessId = req.business.id;

  // Fetch business to check plan
  const { data: business, error: bizErr } = await supabase
    .from('businesses')
    .select('plan')
    .eq('id', businessId)
    .single();

  if (bizErr || !business) {
    return res.status(404).json({ error: 'Business not found.' });
  }

  if (business.plan === 'solo') {
    return res.status(403).json({ error: 'Logo upload requires a Starter or higher plan. Please upgrade.' });
  }

  const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
  const storagePath = `logos/${businessId}/logo.${ext}`;

  // Ensure bucket exists (idempotent)
  await supabase.storage.createBucket(BUCKET, { public: true });

  // Upload to Supabase Storage
  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: true,
    });

  if (uploadErr) {
    return res.status(500).json({ error: 'Upload failed. Please try again.' });
  }

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  const logoUrl = urlData.publicUrl;

  await supabase.from('businesses').update({ logo_url: logoUrl }).eq('id', businessId);

  res.json({ logo_url: logoUrl });
});

// ── DELETE /api/business/logo ─────────────────────────────────────────────────
router.delete('/api/business/logo', authMiddleware, async (req, res) => {
  const businessId = req.business.id;

  const { data: business } = await supabase
    .from('businesses')
    .select('logo_url')
    .eq('id', businessId)
    .single();

  if (business?.logo_url) {
    // Extract path after /object/public/business-logos/
    const marker = `/object/public/${BUCKET}/`;
    const idx = business.logo_url.indexOf(marker);
    if (idx !== -1) {
      const storagePath = business.logo_url.slice(idx + marker.length);
      try {
        await supabase.storage.from(BUCKET).remove([storagePath]);
      } catch (e) {
        console.error('Logo storage remove error (non-fatal):', e.message);
      }
    }
  }

  await supabase.from('businesses').update({ logo_url: null }).eq('id', businessId);

  res.json({ success: true });
});

module.exports = router;
