const express = require('express');
const router = express.Router();
const db = require('../database');
const bcrypt = require('bcryptjs');

// ── Credentials ──────────────────────────────────────────────────────────────

// GET /api/employee-admin/credentials
router.get('/credentials', (req, res) => {
  try {
    const creds = db.prepare(`
      SELECT ec.*, e.name as employee_name, e.position, e.department, e.email as employee_email
      FROM employee_credentials ec
      JOIN employees e ON e.id = ec.employee_id
      ORDER BY e.name ASC
    `).all();
    res.json(creds);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/employee-admin/employees-without-access
router.get('/employees-without-access', (req, res) => {
  try {
    const emps = db.prepare(`
      SELECT e.* FROM employees e
      WHERE e.id NOT IN (SELECT employee_id FROM employee_credentials)
      AND e.status = 'Active'
      ORDER BY e.name ASC
    `).all();
    res.json(emps);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/employee-admin/credentials
router.post('/credentials', async (req, res) => {
  try {
    const { employee_id, username, password } = req.body;
    if (!employee_id || !username || !password) return res.status(400).json({ error: 'employee_id, username and password required' });
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare(`INSERT INTO employee_credentials (employee_id, username, password_hash) VALUES (?, ?, ?)`).run(employee_id, username, hash);
    res.json({ id: result.lastInsertRowid, message: 'Portal access created' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already taken or employee already has access' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/employee-admin/credentials/:id
router.put('/credentials/:id', async (req, res) => {
  try {
    const { is_active, password } = req.body;
    if (password !== undefined) {
      const hash = await bcrypt.hash(password, 12);
      db.prepare(`UPDATE employee_credentials SET password_hash=? WHERE id=?`).run(hash, req.params.id);
    }
    if (is_active !== undefined) {
      db.prepare(`UPDATE employee_credentials SET is_active=? WHERE id=?`).run(is_active, req.params.id);
    }
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/employee-admin/credentials/:id
router.delete('/credentials/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM employee_credentials WHERE id=?`).run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Leave Requests ────────────────────────────────────────────────────────────

// GET /api/employee-admin/leave-requests
router.get('/leave-requests', (req, res) => {
  try {
    const { status } = req.query;
    let q = `SELECT elr.*, e.email as employee_email, e.position FROM employee_leave_requests elr JOIN employees e ON e.id = elr.employee_id`;
    if (status) q += ` WHERE elr.status = '${status}'`;
    q += ` ORDER BY elr.requested_at DESC`;
    res.json(db.prepare(q).all());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/employee-admin/leave-requests/:id  (approve or reject)
router.put('/leave-requests/:id', async (req, res) => {
  try {
    const { status, admin_notes } = req.body;
    const lr = db.prepare(`SELECT elr.*, e.email as employee_email, e.name as employee_name FROM employee_leave_requests elr JOIN employees e ON e.id = elr.employee_id WHERE elr.id=?`).get(req.params.id);
    if (!lr) return res.status(404).json({ error: 'Leave request not found' });
    if (lr.status !== 'Pending') return res.status(400).json({ error: 'Already reviewed' });

    db.prepare(`UPDATE employee_leave_requests SET status=?, admin_notes=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`).run(status, admin_notes || null, req.params.id);

    if (status === 'Approved') {
      // Reduce used days
      const col = lr.leave_type === 'Annual' ? 'annual_used' : lr.leave_type === 'Sick' ? 'sick_used' : 'casual_used';
      const yr = new Date(lr.start_date).getFullYear();

      // Ensure leave balance row exists
      db.prepare(`INSERT OR IGNORE INTO employee_leaves (employee_id, year) VALUES (?, ?)`).run(lr.employee_id, yr);
      db.prepare(`UPDATE employee_leaves SET ${col} = ${col} + ? WHERE employee_id=? AND year=?`).run(lr.days_count, lr.employee_id, yr);

      const balance = db.prepare(`SELECT * FROM employee_leaves WHERE employee_id=? AND year=?`).get(lr.employee_id, yr);

      // Notification for employee
      const col2 = lr.leave_type === 'Annual' ? 'annual' : lr.leave_type === 'Sick' ? 'sick' : 'casual';
      const remaining = (balance[`${col2}_total`] || 0) - (balance[`${col2}_used`] || 0);
      db.prepare(`INSERT INTO notifications (type, title, message, related_id, related_type) VALUES ('success', 'Leave Approved', ?, ?, 'leave_request')`).run(
        `Your ${lr.leave_type} leave (${lr.start_date} to ${lr.end_date}) has been approved. You have ${remaining} ${lr.leave_type.toLowerCase()} leave days remaining.`,
        lr.id
      );

      // Email employee
      try {
        const settings = db.prepare(`SELECT * FROM settings WHERE id=1`).get() || {};
        const { sendLeaveApprovalEmail } = require('../services/emailService');
        if (lr.employee_email && sendLeaveApprovalEmail) {
          await sendLeaveApprovalEmail(lr, balance, settings);
        }
      } catch (e) { console.error('Leave approval email error:', e.message); }
    } else {
      // Rejected
      db.prepare(`INSERT INTO notifications (type, title, message, related_id, related_type) VALUES ('warning', 'Leave Rejected', ?, ?, 'leave_request')`).run(
        `Your ${lr.leave_type} leave request (${lr.start_date} to ${lr.end_date}) was not approved.${admin_notes ? ' Note: ' + admin_notes : ''}`,
        lr.id
      );
      try {
        const settings = db.prepare(`SELECT * FROM settings WHERE id=1`).get() || {};
        const { sendLeaveRejectionEmail } = require('../services/emailService');
        if (lr.employee_email && sendLeaveRejectionEmail) {
          await sendLeaveRejectionEmail(lr, admin_notes, settings);
        }
      } catch (e) { console.error('Leave rejection email error:', e.message); }
    }

    res.json({ message: `Leave request ${status.toLowerCase()}` });
  } catch (err) {
    console.error('Review leave error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Leave Balances ────────────────────────────────────────────────────────────

// GET /api/employee-admin/leave-balances/:employeeId
router.get('/leave-balances/:employeeId', (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    let balance = db.prepare(`SELECT * FROM employee_leaves WHERE employee_id=? AND year=?`).get(req.params.employeeId, year);
    if (!balance) {
      db.prepare(`INSERT OR IGNORE INTO employee_leaves (employee_id, year) VALUES (?, ?)`).run(req.params.employeeId, year);
      balance = db.prepare(`SELECT * FROM employee_leaves WHERE employee_id=? AND year=?`).get(req.params.employeeId, year);
    }
    res.json(balance);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/employee-admin/leave-balances/:employeeId
router.put('/leave-balances/:employeeId', (req, res) => {
  try {
    const { year, annual_total, sick_total, casual_total } = req.body;
    const yr = year || new Date().getFullYear();
    db.prepare(`INSERT OR IGNORE INTO employee_leaves (employee_id, year) VALUES (?, ?)`).run(req.params.employeeId, yr);
    db.prepare(`UPDATE employee_leaves SET annual_total=?, sick_total=?, casual_total=? WHERE employee_id=? AND year=?`)
      .run(annual_total ?? 14, sick_total ?? 7, casual_total ?? 3, req.params.employeeId, yr);
    res.json({ message: 'Leave balance updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── KPI ───────────────────────────────────────────────────────────────────────

// GET /api/employee-admin/kpi
router.get('/kpi', (req, res) => {
  try {
    const { employee_id, month } = req.query;
    let q = `SELECT ek.*, e.name as employee_name FROM employee_kpi ek JOIN employees e ON e.id = ek.employee_id WHERE 1=1`;
    const params = [];
    if (employee_id) { q += ` AND ek.employee_id=?`; params.push(employee_id); }
    if (month) { q += ` AND ek.month=?`; params.push(month); }
    q += ` ORDER BY ek.month DESC, e.name ASC LIMIT 100`;
    res.json(db.prepare(q).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/employee-admin/kpi
router.post('/kpi', (req, res) => {
  try {
    const { employee_id, month, performance_score, kpi_target, tasks_completed, attendance_pct, notes } = req.body;
    if (!employee_id || !month) return res.status(400).json({ error: 'employee_id and month required' });
    const emp = db.prepare(`SELECT name FROM employees WHERE id=?`).get(employee_id);
    db.prepare(`
      INSERT INTO employee_kpi (employee_id, employee_name, month, performance_score, kpi_target, tasks_completed, attendance_pct, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(employee_id, month) DO UPDATE SET
        performance_score=excluded.performance_score,
        kpi_target=excluded.kpi_target,
        tasks_completed=excluded.tasks_completed,
        attendance_pct=excluded.attendance_pct,
        notes=excluded.notes
    `).run(employee_id, emp?.name, month, performance_score ?? 0, kpi_target ?? 80, tasks_completed ?? 0, attendance_pct ?? 100, notes || null);
    res.json({ message: 'KPI saved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/employee-admin/kpi/:id
router.put('/kpi/:id', (req, res) => {
  try {
    const { performance_score, kpi_target, tasks_completed, attendance_pct, notes } = req.body;
    db.prepare(`UPDATE employee_kpi SET performance_score=?, kpi_target=?, tasks_completed=?, attendance_pct=?, notes=? WHERE id=?`)
      .run(performance_score, kpi_target, tasks_completed, attendance_pct, notes || null, req.params.id);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/employee-admin/kpi/:id
router.delete('/kpi/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM employee_kpi WHERE id=?`).run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
