const express = require('express');
const router = express.Router();
const db = require('../database');
const { format } = require('date-fns');
const { generateInvoicePDF } = require('../services/pdfService');
const { sendInvoiceEmail } = require('../services/emailService');

function generateInvoiceNumber() {
  const settings = db.prepare('SELECT invoice_prefix FROM settings WHERE id=1').get();
  const prefix = settings?.invoice_prefix || 'INV';
  const count = db.prepare('SELECT COUNT(*) as c FROM invoices').get().c + 1;
  return `${prefix}-${String(count).padStart(4, '0')}-${format(new Date(), 'yyyy')}`;
}

const CURRENCY_SYMBOLS = {
  LKR: 'Rs.', USD: '$', EUR: '€', GBP: '£',
  AUD: 'A$', SGD: 'S$', INR: '₹', CAD: 'C$', JPY: '¥'
};

router.get('/', (req, res) => {
  try {
    const { status, search } = req.query;
    let query = 'SELECT * FROM invoices WHERE 1=1';
    const params = [];
    if (status) { query += ' AND status=?'; params.push(status); }
    if (search) { query += ' AND (client_name LIKE ? OR invoice_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    query += ' ORDER BY created_at DESC';
    const invoices = db.prepare(query).all(...params);
    invoices.forEach(inv => {
      inv.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id=?').all(inv.id);
    });
    res.json(invoices);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', (req, res) => {
  try {
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Not found' });
    inv.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id=?').all(inv.id);
    res.json(inv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', (req, res) => {
  try {
    const {
      client_name, client_email, client_address, client_company,
      issue_date, due_date, items, tax_rate, discount, notes, terms, status,
      currency = 'LKR'
    } = req.body;
    const invoice_number = generateInvoiceNumber();
    const currency_symbol = CURRENCY_SYMBOLS[currency] || currency;
    const subtotal = items.reduce((s, i) => s + (parseFloat(i.quantity) * parseFloat(i.unit_price)), 0);
    const tax_amount = (subtotal * (parseFloat(tax_rate) || 0)) / 100;
    const total = subtotal + tax_amount - (parseFloat(discount) || 0);

    const result = db.prepare(`
      INSERT INTO invoices (invoice_number, client_name, client_email, client_address, client_company,
        issue_date, due_date, subtotal, tax_rate, tax_amount, discount, total,
        status, notes, terms, currency, currency_symbol)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(invoice_number, client_name, client_email, client_address, client_company,
      issue_date, due_date, subtotal, tax_rate || 0, tax_amount, discount || 0, total,
      status || 'Draft', notes, terms, currency, currency_symbol);

    const invoiceId = result.lastInsertRowid;
    items.forEach(item => {
      db.prepare(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES (?,?,?,?,?)`)
        .run(invoiceId, item.description, item.quantity, item.unit_price,
          parseFloat(item.quantity) * parseFloat(item.unit_price));
    });

    res.json({ id: invoiceId, invoice_number, message: 'Invoice created' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', (req, res) => {
  try {
    const {
      client_name, client_email, client_address, client_company,
      issue_date, due_date, items, tax_rate, discount, notes, terms, status, paid_date,
      currency = 'LKR'
    } = req.body;
    const currency_symbol = CURRENCY_SYMBOLS[currency] || currency;
    const subtotal = items.reduce((s, i) => s + (parseFloat(i.quantity) * parseFloat(i.unit_price)), 0);
    const tax_amount = (subtotal * (parseFloat(tax_rate) || 0)) / 100;
    const total = subtotal + tax_amount - (parseFloat(discount) || 0);

    db.prepare(`
      UPDATE invoices SET client_name=?, client_email=?, client_address=?, client_company=?,
        issue_date=?, due_date=?, subtotal=?, tax_rate=?, tax_amount=?, discount=?, total=?,
        status=?, notes=?, terms=?, paid_date=?, currency=?, currency_symbol=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(client_name, client_email, client_address, client_company,
      issue_date, due_date, subtotal, tax_rate || 0, tax_amount, discount || 0, total,
      status, notes, terms, paid_date || null, currency, currency_symbol, req.params.id);

    db.prepare('DELETE FROM invoice_items WHERE invoice_id=?').run(req.params.id);
    items.forEach(item => {
      db.prepare(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES (?,?,?,?,?)`)
        .run(req.params.id, item.description, item.quantity, item.unit_price,
          parseFloat(item.quantity) * parseFloat(item.unit_price));
    });

    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM invoices WHERE id=?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send invoice via email
router.post('/:id/send', async (req, res) => {
  try {
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    inv.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id=?').all(inv.id);
    const settings = db.prepare('SELECT * FROM settings WHERE id=1').get();
    // Use the invoice's own currency symbol on PDF/email
    const emailSettings = { ...settings, currency_symbol: inv.currency_symbol || settings.currency_symbol || 'Rs.' };
    const pdfPath = await generateInvoicePDF(inv, emailSettings);
    await sendInvoiceEmail(inv, pdfPath, emailSettings);
    db.prepare(`UPDATE invoices SET status='Sent', email_sent=1, email_sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(inv.id);
    db.prepare(`INSERT INTO notifications (type, title, message) VALUES ('success', 'Invoice Sent', ?)`)
      .run(`Invoice ${inv.invoice_number} sent to ${inv.client_email}`);
    res.json({ message: `Invoice sent to ${inv.client_email}` });
  } catch (err) {
    console.error('Send invoice error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Mark as paid → AUTO-RECORD in Revenue with correct currency
router.post('/:id/mark-paid', (req, res) => {
  try {
    const { paid_date } = req.body;
    const paidDate = paid_date || format(new Date(), 'yyyy-MM-dd');
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    // Update invoice status
    db.prepare(`UPDATE invoices SET status='Paid', paid_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(paidDate, inv.id);

    // ✅ Auto-record in revenue — check for existing record by invoice_number to avoid duplicates
    const existingRevenue = db.prepare(`SELECT id FROM revenue WHERE invoice_number=?`).get(inv.invoice_number);

    if (existingRevenue) {
      // Update existing record to Paid
      db.prepare(`UPDATE revenue SET payment_status='Paid', invoice_date=?, updated_at=CURRENT_TIMESTAMP WHERE invoice_number=?`)
        .run(paidDate, inv.invoice_number);
    } else {
      // Create new revenue entry automatically
      db.prepare(`
        INSERT INTO revenue
          (client_name, project_name, service_type, invoice_number, invoice_date,
           due_date, amount, payment_status, currency, auto_recorded, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'Paid', ?, 1, ?)
      `).run(
        inv.client_name,
        null,
        null,
        inv.invoice_number,
        paidDate,
        inv.due_date,
        inv.total,
        inv.currency || 'LKR',
        `Auto-recorded from Invoice #${inv.invoice_number}`
      );
    }

    const sym = inv.currency_symbol || inv.currency || 'Rs.';
    db.prepare(`INSERT INTO notifications (type, title, message) VALUES ('success', 'Invoice Paid & Revenue Recorded', ?)`)
      .run(`Invoice ${inv.invoice_number} paid. ${sym} ${Number(inv.total).toLocaleString()} recorded in Revenue automatically.`);

    res.json({ message: 'Marked as paid and recorded in revenue' });
  } catch (err) {
    console.error('Mark paid error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Download PDF (uses invoice's own currency)
router.get('/:id/pdf', async (req, res) => {
  try {
    const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Not found' });
    inv.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id=?').all(inv.id);
    const settings = db.prepare('SELECT * FROM settings WHERE id=1').get();
    const pdfSettings = { ...settings, currency_symbol: inv.currency_symbol || settings.currency_symbol || 'Rs.' };
    const pdfPath = await generateInvoicePDF(inv, pdfSettings);
    res.download(pdfPath, `Invoice-${inv.invoice_number}.pdf`);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
