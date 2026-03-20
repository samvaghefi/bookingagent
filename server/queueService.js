const { createClient } = require('@supabase/supabase-js');
const notificationService = require('./notificationService');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/**
 * Add a customer to the walk-in queue.
 * Returns { entry, position } where position is 1-based index in the active queue.
 */
async function joinQueue(businessId, { customerName, customerPhone, service, preferredBarber }) {
  const { data: entry, error } = await supabase
    .from('walk_in_queue')
    .insert({
      business_id: businessId,
      customer_name: customerName,
      customer_phone: customerPhone,
      service: service || null,
      preferred_barber: preferredBarber || null,
      status: 'waiting',
    })
    .select()
    .single();

  if (error) throw error;

  const queue = await getActiveQueue(businessId);
  const position = queue.findIndex(e => e.id === entry.id) + 1;

  return { entry, position };
}

/**
 * Fetch all active (waiting + notified) queue entries for a business.
 * Adds a computed 1-based `position` field.
 * Only includes entries from the last 24 hours.
 */
async function getActiveQueue(businessId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('walk_in_queue')
    .select('*')
    .eq('business_id', businessId)
    .in('status', ['waiting', 'notified'])
    .gte('created_at', since)
    .order('created_at', { ascending: true });

  if (error) throw error;

  return (data || []).map((entry, index) => ({ ...entry, position: index + 1 }));
}

/**
 * Send the "you're up" SMS to a waiting customer and mark them notified.
 * SMS is sent first — if it fails, the DB is not updated and the barber can retry.
 */
async function notifyCustomer(queueEntryId, businessId, businessName, fromPhone) {
  const { data: entry, error: fetchError } = await supabase
    .from('walk_in_queue')
    .select('*')
    .eq('id', queueEntryId)
    .eq('business_id', businessId)
    .single();

  if (fetchError) throw fetchError;
  if (!entry) throw new Error('Queue entry not found');
  if (entry.status !== 'waiting') {
    throw new Error(`Cannot notify: entry is already "${entry.status}"`);
  }

  // Send SMS first — if this fails, we throw before updating the DB
  await notificationService.sendQueueReadySMS(
    entry.customer_phone,
    entry.customer_name,
    businessName,
    fromPhone
  );

  const { data: updated, error: updateError } = await supabase
    .from('walk_in_queue')
    .update({ status: 'notified', notified_at: new Date().toISOString() })
    .eq('id', queueEntryId)
    .select()
    .single();

  if (updateError) throw updateError;
  return updated;
}

/**
 * Auto-expire notified entries that exceeded their business's timeout.
 * Called on a 60-second interval. Errors are caught and logged — never crashes server.
 */
async function autoExpireNoShows() {
  try {
    // Step 1: Fetch all notified entries
    const { data: notifiedEntries, error: fetchError } = await supabase
      .from('walk_in_queue')
      .select('id, business_id, notified_at')
      .eq('status', 'notified');

    if (fetchError) throw fetchError;
    if (!notifiedEntries || notifiedEntries.length === 0) return;

    // Step 2: Fetch timeout setting for each unique business
    const businessIds = [...new Set(notifiedEntries.map(e => e.business_id))];

    const { data: businesses, error: bizError } = await supabase
      .from('businesses')
      .select('id, queue_notify_timeout')
      .in('id', businessIds);

    if (bizError) throw bizError;

    const timeoutByBusiness = {};
    for (const biz of businesses || []) {
      timeoutByBusiness[biz.id] = biz.queue_notify_timeout ?? 10;
    }

    // Step 3: Filter entries that have exceeded their business's timeout
    const now = Date.now();
    const expiredIds = notifiedEntries
      .filter(entry => {
        const timeoutMs = (timeoutByBusiness[entry.business_id] ?? 10) * 60_000;
        return entry.notified_at && now - new Date(entry.notified_at).getTime() > timeoutMs;
      })
      .map(entry => entry.id);

    // Step 4: Guard against empty array (Supabase .in() can error on empty)
    if (expiredIds.length === 0) return;

    // Step 5: Bulk-update expired entries to no_show
    const { error: updateError } = await supabase
      .from('walk_in_queue')
      .update({ status: 'no_show' })
      .in('id', expiredIds);

    if (updateError) throw updateError;

    console.log(`[queueService] Auto-expired ${expiredIds.length} no-show(s)`);
  } catch (err) {
    console.error('[queueService] autoExpireNoShows error:', err.message);
  }
}

module.exports = { joinQueue, getActiveQueue, notifyCustomer, autoExpireNoShows };
