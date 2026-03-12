const express = require('express');
const router = express.Router();
const db = require('../database');
const { format, addMonths, addYears, addDays } = require('date-fns');

router.get('/', (req, res) => {
  try {
    const { type, status } = req.query;
    let query = 'SELECT * FROM recurring_payments WHERE 1=1';
    const params = [];
    if (type) { query += ' AND type=?'; params.push(type); }
    if (status) { query += ' AND status=?'; params.push(status); }
    query += ' ORDER BY next_payment_date ASC';
    res.json(db.prepare(query).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', (req, res) => {
  try {
    const { name, type, category, billing_cycle, amount, currency, next_payment_date, auto_renewal, client_vendor, email, reminder_days, notes } = req.body;
    const result = db.prepare(`
      INSERT INTO recurring_payments (name, type, category, billing_cycle, amount, currency, next_payment_date, auto_renewal, client_vendor, email, reminder_days, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(name, type, category, billing_cycle || 'Monthly', amount, currency || 'LKR', next_payment_date, auto_renewal !== false ? 1 : 0, client_vendor, email, reminder_days || 3, notes);
    res.json({ id: result.lastInsertRowid, message: 'Recurring payment added' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const { name, type, category, billing_cycle, amount, currency, next_payment_date, auto_renewal, status, client_vendor, email, reminder_days, notes } = req.body;
    db.prepare(`
      UPDATE recurring_payments SET name=?, type=?, category=?, billing_cycle=?, amount=?, currency=?, next_payment_date=?, auto_renewal=?, status=?, client_vendor=?, email=?, reminder_days=?, notes=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(name, type, category, billing_cycle, amount, currency || 'LKR', next_payment_date, auto_renewal ? 1 : 0, status || 'Active', client_vendor, email, reminder_days || 3, notes, req.params.id);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM recurring_payments WHERE id=?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Process/advance a recurring payment (mark as processed & advance date)
router.post('/:id/process', (req, res) => {
  try {
    const rp = db.prepare('SELECT * FROM recurring_payments WHERE id=?').get(req.params.id);
    if (!rp) return res.status(404).json({ error: 'Not found' });
    let nextDate = new Date(rp.next_payment_date);
    if (rp.billing_cycle === 'Monthly') nextDate = addMonths(nextDate, 1);
    else if (rp.billing_cycle === 'Quarterly') nextDate = addMonths(nextDate, 3);
    else if (rp.billing_cycle === 'Annual') nextDate = addYears(nextDate, 1);
    else if (rp.billing_cycle === 'Weekly') nextDate = addDays(nextDate, 7);
    db.prepare(`UPDATE recurring_payments SET last_processed_date=date('now'), next_payment_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(format(nextDate, 'yyyy-MM-dd'), rp.id);
    res.json({ message: 'Processed', next_payment_date: format(nextDate, 'yyyy-MM-dd') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
