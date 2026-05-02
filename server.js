'use strict';
const express      = require('express');
const multer       = require('multer');
const QRCode       = require('qrcode');
const { parse }    = require('csv-parse/sync');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');
const os           = require('os');
const fs           = require('fs');
const path         = require('path');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DB_FILE  = path.join(__dirname, 'data.json');

// ─── File-based storage ───────────────────────────────────────────────────────

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch {
    return { sessions: [], projects: [], votes: [], _seq: { session: 1, project: 1, vote: 1 } };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function nextId(db, table) {
  const id = db._seq[table];
  db._seq[table]++;
  return id;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDefaultBaseURL() {
  if (process.env.RAILWAY_PUBLIC_DOMAIN)
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.RENDER_EXTERNAL_URL)
    return process.env.RENDER_EXTERNAL_URL;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return `http://${iface.address}:${PORT}`;
    }
  }
  return `http://localhost:${PORT}`;
}

function getVoterToken(req, res) {
  if (!req.cookies.voter_token) {
    const token = crypto.randomUUID();
    res.cookie('voter_token', token, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
    return token;
  }
  return req.cookies.voter_token;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(dt) {
  return dt ? new Date(dt).toLocaleString() : '';
}

function layout(title, body, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — Senior Design Voter</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css" rel="stylesheet">
${extraHead}
<style>
  body { background:#f0f2f5; }
  .navbar-brand { font-weight:700; letter-spacing:.5px; }
  .card { border:none; box-shadow:0 2px 10px rgba(0,0,0,.08); border-radius:12px; }
  .card-header { border-radius:12px 12px 0 0 !important; }
  .stat-card h2 { font-size:2.2rem; font-weight:700; }
  @media print {
    .no-print { display:none !important; }
    nav { display:none !important; }
    body { background:#fff; }
    .qr-card { break-inside:avoid; page-break-inside:avoid; }
  }
</style>
</head>
<body>
<nav class="navbar navbar-dark bg-primary mb-4 no-print shadow-sm">
  <div class="container">
    <a class="navbar-brand" href="/"><i class="bi bi-qr-code-scan me-2"></i>Senior Design Voter</a>
    <a href="/" class="btn btn-outline-light btn-sm"><i class="bi bi-house me-1"></i>Dashboard</a>
  </div>
</nav>
<div class="container pb-5">
${body}
</div>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
</body>
</html>`;
}

// ─── Admin Dashboard ──────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const db       = loadDB();
  const sessions = [...db.sessions].reverse();
  const localIP  = getDefaultBaseURL();

  const sessionCards = sessions.map(s => {
    const projectCount = db.projects.filter(p => p.session_id === s.id).length;
    const voteCount    = db.votes.filter(v => v.session_id === s.id).length;
    const isActive     = !s.ended_at;
    return `
    <div class="col-sm-6 col-xl-4">
      <div class="card h-100">
        <div class="card-header d-flex justify-content-between align-items-center bg-white border-bottom">
          <span class="fw-semibold text-truncate me-2" title="${esc(s.name)}">${esc(s.name)}</span>
          <span class="badge ${isActive ? 'bg-success' : 'bg-secondary'} flex-shrink-0">${isActive ? 'Active' : 'Ended'}</span>
        </div>
        <div class="card-body">
          <div class="d-flex gap-3 mb-3">
            <div class="text-center">
              <div class="fs-4 fw-bold text-primary">${projectCount}</div>
              <small class="text-muted">Projects</small>
            </div>
            <div class="text-center">
              <div class="fs-4 fw-bold text-success">${voteCount}</div>
              <small class="text-muted">Votes</small>
            </div>
          </div>
          <p class="text-muted small mb-0"><i class="bi bi-clock me-1"></i>${fmt(s.created_at)}</p>
          ${s.ended_at ? `<p class="text-muted small mb-0"><i class="bi bi-stop-circle me-1"></i>Ended ${fmt(s.ended_at)}</p>` : ''}
        </div>
        <div class="card-footer bg-white border-top d-flex gap-2 flex-wrap">
          <a href="/sessions/${s.id}/qrcodes" class="btn btn-sm btn-outline-primary"><i class="bi bi-qr-code me-1"></i>QR Codes</a>
          <a href="/sessions/${s.id}/report"  class="btn btn-sm btn-outline-success"><i class="bi bi-bar-chart me-1"></i>Report</a>
          ${isActive ? `
          <form action="/sessions/${s.id}/end" method="POST" class="d-inline"
                onsubmit="return confirm('End this voting session? No more votes will be accepted.')">
            <button type="submit" class="btn btn-sm btn-outline-danger">
              <i class="bi bi-stop-circle me-1"></i>End Session
            </button>
          </form>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  res.send(layout('Dashboard', `
  <div class="row g-4">
    <div class="col-12">
      <div class="card">
        <div class="card-header bg-primary text-white">
          <h5 class="mb-0"><i class="bi bi-plus-circle me-2"></i>Create New Voting Session</h5>
        </div>
        <div class="card-body">
          <form action="/sessions" method="POST" enctype="multipart/form-data">
            <div class="row g-3">
              <div class="col-md-4">
                <label class="form-label fw-semibold">Session Name</label>
                <input type="text" name="name" class="form-control" placeholder="e.g. Spring 2025 Poster Session" required>
              </div>
              <div class="col-md-4">
                <label class="form-label fw-semibold">Base URL for QR Codes</label>
                <input type="text" name="base_url" class="form-control" value="${localIP}" required>
                <div class="form-text">Use your local network IP so phones can reach the server.</div>
              </div>
              <div class="col-md-4">
                <label class="form-label fw-semibold">CSV File</label>
                <input type="file" name="csv" class="form-control" accept=".csv" required>
                <div class="form-text">Required columns: <code>title</code>, <code>team_code</code></div>
              </div>
            </div>
            <div class="mt-3 d-flex gap-2 align-items-center">
              <button type="submit" class="btn btn-primary">
                <i class="bi bi-upload me-1"></i>Upload CSV &amp; Create Session
              </button>
              <a href="/sample.csv" class="btn btn-outline-secondary btn-sm">
                <i class="bi bi-download me-1"></i>Download Sample CSV
              </a>
            </div>
          </form>
        </div>
      </div>
    </div>

    ${sessions.length ? `
    <div class="col-12">
      <h5 class="fw-semibold mb-3">Sessions</h5>
      <div class="row g-3">${sessionCards}</div>
    </div>` : `
    <div class="col-12">
      <div class="card text-center py-5">
        <i class="bi bi-inbox text-muted" style="font-size:3rem"></i>
        <p class="mt-3 text-muted mb-1">No sessions yet. Upload a CSV to get started.</p>
        <p class="text-muted small">Download the <a href="/sample.csv">sample CSV</a> to see the required format.</p>
      </div>
    </div>`}
  </div>
  `));
});

// ─── Sample CSV download ──────────────────────────────────────────────────────

app.get('/sample.csv', (req, res) => {
  const csv = [
    'title,team_code',
    'Smart Campus Navigation System,TEAM-01',
    'AI-Powered Plant Disease Detector,TEAM-02',
    'Autonomous Drone Delivery System,TEAM-03',
    'Wearable Fall Detection Device,TEAM-04',
    'Solar-Powered Water Purification Unit,TEAM-05',
    'Real-Time Sign Language Translator,TEAM-06',
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sample_projects.csv"');
  res.send(csv);
});

// ─── Create Session ───────────────────────────────────────────────────────────

app.post('/sessions', upload.single('csv'), (req, res) => {
  try {
    const { name, base_url } = req.body;
    if (!req.file) return res.status(400).send(layout('Error', '<div class="alert alert-danger">No CSV file uploaded.</div>'));

    const csvText = req.file.buffer.toString('utf-8');
    let records;
    try {
      records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch (e) {
      return res.status(400).send(layout('Error', `<div class="alert alert-danger">CSV parse error: ${esc(e.message)}</div><a href="/" class="btn btn-secondary mt-2">Back</a>`));
    }

    if (!records.length) return res.status(400).send(layout('Error', '<div class="alert alert-danger">CSV file is empty.</div><a href="/" class="btn btn-secondary mt-2">Back</a>'));

    const firstRow = records[0];
    const titleKey = Object.keys(firstRow).find(k => k.toLowerCase().trim() === 'title');
    const teamKey  = Object.keys(firstRow).find(k =>
      ['team_code','team code','teamcode','team'].includes(k.toLowerCase().trim())
    );

    if (!titleKey || !teamKey) {
      return res.status(400).send(layout('Error', `
        <div class="alert alert-danger">
          <strong>CSV column error.</strong> Need columns <code>title</code> and <code>team_code</code>.<br>
          Found: <code>${esc(Object.keys(firstRow).join(', '))}</code>
        </div>
        <a href="/" class="btn btn-secondary mt-2">Back</a>`));
    }

    const db       = loadDB();
    const sid      = nextId(db, 'session');
    const session  = { id: sid, name: name.trim(), base_url: base_url.trim(), created_at: new Date().toISOString(), ended_at: null };
    db.sessions.push(session);

    let count = 0;
    for (const row of records) {
      const title    = row[titleKey]?.trim();
      const teamCode = row[teamKey]?.trim();
      if (title && teamCode) {
        db.projects.push({ id: nextId(db, 'project'), session_id: sid, title, team_code: teamCode });
        count++;
      }
    }

    if (count === 0) return res.status(400).send(layout('Error', '<div class="alert alert-danger">No valid rows found in CSV.</div><a href="/" class="btn btn-secondary mt-2">Back</a>'));

    saveDB(db);
    res.redirect(`/sessions/${sid}/qrcodes`);
  } catch (err) {
    console.error(err);
    res.status(500).send(layout('Error', `<div class="alert alert-danger">${esc(err.message)}</div><a href="/" class="btn btn-secondary mt-2">Back</a>`));
  }
});

// ─── End Session ──────────────────────────────────────────────────────────────

app.post('/sessions/:id/end', (req, res) => {
  const db  = loadDB();
  const sid = parseInt(req.params.id);
  const s   = db.sessions.find(x => x.id === sid);
  if (s) { s.ended_at = new Date().toISOString(); saveDB(db); }
  res.redirect(`/sessions/${sid}/report`);
});

// ─── QR Codes Page ────────────────────────────────────────────────────────────

app.get('/sessions/:id/qrcodes', async (req, res) => {
  const db      = loadDB();
  const sid     = parseInt(req.params.id);
  const session = db.sessions.find(s => s.id === sid);
  if (!session) return res.status(404).send(layout('Not Found', '<div class="alert alert-danger">Session not found.</div>'));

  const projects = db.projects.filter(p => p.session_id === sid).sort((a, b) => a.team_code.localeCompare(b.team_code));
  const baseUrl  = (session.base_url || `http://localhost:${PORT}`).replace(/\/$/, '');
  const isActive = !session.ended_at;

  const projectsWithQR = await Promise.all(projects.map(async p => {
    const url       = `${baseUrl}/vote/${p.id}`;
    const qrDataUrl = await QRCode.toDataURL(url, { width: 220, margin: 2 });
    return { ...p, qrDataUrl, url };
  }));

  const cards = projectsWithQR.map(p => `
  <div class="col-6 col-md-4 col-lg-3 qr-card">
    <div class="card text-center h-100" style="border:1.5px solid #dee2e6 !important;">
      <div class="card-body p-2">
        <img src="${p.qrDataUrl}" class="img-fluid mb-1" alt="QR for ${esc(p.team_code)}" style="max-width:180px">
        <p class="fw-bold mb-0 small lh-sm">${esc(p.title)}</p>
        <span class="badge bg-secondary mt-1">${esc(p.team_code)}</span>
        <p class="text-muted mt-1 mb-0" style="font-size:.6rem;word-break:break-all">${esc(p.url)}</p>
      </div>
    </div>
  </div>`).join('');

  res.send(layout(`QR Codes — ${session.name}`, `
  <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3 no-print">
    <div>
      <h4 class="mb-0"><i class="bi bi-qr-code me-2"></i>${esc(session.name)}</h4>
      <p class="text-muted mb-0 small">${projects.length} projects · Print and post each QR next to its poster.</p>
    </div>
    <div class="d-flex gap-2 flex-wrap">
      <a href="/sessions/${session.id}/report" class="btn btn-outline-success btn-sm"><i class="bi bi-bar-chart me-1"></i>View Report</a>
      ${isActive ? `<form action="/sessions/${session.id}/end" method="POST" class="d-inline"
          onsubmit="return confirm('End this voting session?')">
        <button type="submit" class="btn btn-outline-danger btn-sm"><i class="bi bi-stop-circle me-1"></i>End Session</button>
      </form>` : '<span class="badge bg-secondary align-self-center p-2">Session Ended</span>'}
      <button onclick="window.print()" class="btn btn-primary btn-sm"><i class="bi bi-printer me-1"></i>Print All QR Codes</button>
    </div>
  </div>
  <div class="row g-3">${cards}</div>
  `, `<style>
    @media print {
      @page { margin:1cm; size:A4; }
      .row { display:flex!important; flex-wrap:wrap!important; }
      .col-6 { width:50%!important; box-sizing:border-box; padding:4px; }
      .card { border:1px solid #999!important; }
    }
  </style>`));
});

// ─── Report Page ──────────────────────────────────────────────────────────────

app.get('/sessions/:id/report', (req, res) => {
  const db      = loadDB();
  const sid     = parseInt(req.params.id);
  const session = db.sessions.find(s => s.id === sid);
  if (!session) return res.status(404).send(layout('Not Found', '<div class="alert alert-danger">Session not found.</div>'));

  const projects = db.projects.filter(p => p.session_id === sid);
  const sessionVotes = db.votes.filter(v => v.session_id === sid);

  const results = projects.map(p => ({
    ...p,
    vote_count: sessionVotes.filter(v => v.project_id === p.id).length
  })).sort((a, b) => b.vote_count - a.vote_count || a.team_code.localeCompare(b.team_code));

  const totalVotes = results.reduce((s, r) => s + r.vote_count, 0);
  const isActive   = !session.ended_at;
  const winner     = results.find(r => r.vote_count > 0);

  const rows = results.map((r, i) => {
    const pct     = totalVotes > 0 ? Math.round(r.vote_count / totalVotes * 100) : 0;
    const isFirst = i === 0 && r.vote_count > 0;
    return `
    <tr class="${isFirst ? 'table-warning' : ''}">
      <td class="fw-bold">${isFirst ? '<i class="bi bi-trophy-fill text-warning"></i>' : i + 1}</td>
      <td>${esc(r.title)}</td>
      <td><span class="badge bg-secondary">${esc(r.team_code)}</span></td>
      <td class="fw-bold">${r.vote_count}</td>
      <td style="min-width:180px">
        <div class="d-flex align-items-center gap-2">
          <div class="progress flex-grow-1" style="height:18px;border-radius:9px">
            <div class="progress-bar ${isFirst ? 'bg-warning' : 'bg-primary'}" style="width:${pct}%"></div>
          </div>
          <small class="text-muted">${pct}%</small>
        </div>
      </td>
    </tr>`;
  }).join('');

  res.send(layout(`Report — ${session.name}`, `
  <div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-4 no-print">
    <div>
      <h4 class="mb-0"><i class="bi bi-bar-chart-fill me-2"></i>${esc(session.name)}</h4>
      <span class="badge ${isActive ? 'bg-success' : 'bg-secondary'} mt-1">${isActive ? 'Active — votes still open' : 'Session ended'}</span>
    </div>
    <div class="d-flex gap-2 flex-wrap">
      <a href="/sessions/${session.id}/qrcodes" class="btn btn-outline-primary btn-sm"><i class="bi bi-qr-code me-1"></i>QR Codes</a>
      <a href="/sessions/${session.id}/report/csv" class="btn btn-success btn-sm"><i class="bi bi-download me-1"></i>Export CSV</a>
      <button onclick="window.print()" class="btn btn-outline-secondary btn-sm"><i class="bi bi-printer me-1"></i>Print</button>
      ${isActive ? `<form action="/sessions/${session.id}/end" method="POST" class="d-inline"
          onsubmit="return confirm('End this voting session? No more votes can be cast.')">
        <button type="submit" class="btn btn-danger btn-sm"><i class="bi bi-stop-circle me-1"></i>End Session</button>
      </form>` : ''}
    </div>
  </div>

  <div class="row g-3 mb-4">
    <div class="col-6 col-md-3">
      <div class="card stat-card text-center py-3">
        <h2 class="text-primary">${results.length}</h2>
        <small class="text-muted">Projects</small>
      </div>
    </div>
    <div class="col-6 col-md-3">
      <div class="card stat-card text-center py-3">
        <h2 class="text-success">${totalVotes}</h2>
        <small class="text-muted">Total Votes</small>
      </div>
    </div>
    <div class="col-6 col-md-3">
      <div class="card stat-card text-center py-3">
        <h2 class="${winner ? 'text-warning' : 'text-muted'} text-truncate px-2">${winner ? esc(winner.team_code) : '—'}</h2>
        <small class="text-muted">Leading Team</small>
      </div>
    </div>
    <div class="col-6 col-md-3">
      <div class="card stat-card text-center py-3">
        <h2 class="${winner ? 'text-warning' : 'text-muted'}">${winner ? winner.vote_count : '—'}</h2>
        <small class="text-muted">Top Vote Count</small>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-body p-0">
      <table class="table table-hover mb-0 align-middle">
        <thead class="table-light">
          <tr>
            <th style="width:50px">Rank</th>
            <th>Project Title</th>
            <th>Team Code</th>
            <th>Votes</th>
            <th>Distribution</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="5" class="text-center text-muted py-4">No projects found.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
  `));
});

// ─── CSV Export ───────────────────────────────────────────────────────────────

app.get('/sessions/:id/report/csv', (req, res) => {
  const db      = loadDB();
  const sid     = parseInt(req.params.id);
  const session = db.sessions.find(s => s.id === sid);
  if (!session) return res.status(404).send('Session not found');

  const projects     = db.projects.filter(p => p.session_id === sid);
  const sessionVotes = db.votes.filter(v => v.session_id === sid);

  const results = projects.map(p => ({
    ...p,
    vote_count: sessionVotes.filter(v => v.project_id === p.id).length
  })).sort((a, b) => b.vote_count - a.vote_count);

  const totalVotes = results.reduce((s, r) => s + r.vote_count, 0);
  const lines = [
    `"Session","${session.name.replace(/"/g, '""')}"`,
    `"Generated","${new Date().toLocaleString()}"`,
    `"Total Votes","${totalVotes}"`,
    '',
    'Rank,Project Title,Team Code,Votes,Percentage',
    ...results.map((r, i) => {
      const pct = totalVotes > 0 ? ((r.vote_count / totalVotes) * 100).toFixed(1) : '0.0';
      return `${i+1},"${r.title.replace(/"/g,'""')}","${r.team_code.replace(/"/g,'""')}",${r.vote_count},${pct}%`;
    })
  ];

  const safeName = session.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="votes_${safeName}.csv"`);
  res.send(lines.join('\n'));
});

// ─── Vote Page (GET) ──────────────────────────────────────────────────────────

app.get('/vote/:projectId', (req, res) => {
  const voterToken = getVoterToken(req, res);
  const db         = loadDB();
  const pid        = parseInt(req.params.projectId);
  const project    = db.projects.find(p => p.id === pid);

  if (!project) return res.status(404).send(layout('Not Found', `
    <div class="row justify-content-center"><div class="col-md-5">
      <div class="card text-center p-4">
        <i class="bi bi-exclamation-triangle text-warning mb-3" style="font-size:3rem"></i>
        <h4>Project Not Found</h4>
        <p class="text-muted">This QR code may be invalid.</p>
      </div>
    </div></div>`));

  const session = db.sessions.find(s => s.id === project.session_id);

  if (session.ended_at) {
    return res.send(layout('Session Ended', `
      <div class="row justify-content-center"><div class="col-md-5">
        <div class="card text-center p-4">
          <i class="bi bi-x-circle text-danger mb-3" style="font-size:3rem"></i>
          <h4>Voting Has Closed</h4>
          <p class="text-muted">The session "<strong>${esc(session.name)}</strong>" has ended.</p>
          <p class="text-muted small">Thank you for attending the poster session!</p>
        </div>
      </div></div>`));
  }

  const existing = db.votes.find(v => v.voter_token === voterToken && v.project_id === pid);
  if (existing) {
    return res.send(layout('Already Voted for This Project', `
      <div class="row justify-content-center"><div class="col-md-5">
        <div class="card text-center p-4">
          <i class="bi bi-check-circle-fill text-success mb-3" style="font-size:3rem"></i>
          <h4>Already Voted for This Project!</h4>
          <p class="text-muted mb-1">You already cast a vote for:</p>
          <h5 class="fw-bold">${esc(project.title)}</h5>
          <span class="badge bg-secondary mb-3">${esc(project.team_code)}</span>
          <p class="text-muted small">You can vote for other projects, but only once per project.</p>
        </div>
      </div></div>`));
  }

  res.send(layout(`Vote — ${project.title}`, `
  <div class="row justify-content-center"><div class="col-md-5">
    <div class="card">
      <div class="card-header text-center bg-primary text-white">
        <h5 class="mb-0"><i class="bi bi-hand-thumbs-up me-2"></i>Cast Your Vote</h5>
        <small class="opacity-75">${esc(session.name)}</small>
      </div>
      <div class="card-body text-center p-4">
        <p class="text-muted mb-2">You are voting for:</p>
        <h3 class="fw-bold mb-1">${esc(project.title)}</h3>
        <span class="badge bg-secondary fs-6 mb-4">${esc(project.team_code)}</span>
        <p class="text-muted small mb-4">
          <i class="bi bi-info-circle me-1"></i>You can vote for multiple projects, but only <strong>once per project</strong>.
        </p>
        <form action="/vote/${pid}" method="POST">
          <button type="submit" class="btn btn-primary btn-lg w-100">
            <i class="bi bi-check-lg me-2"></i>Confirm Vote
          </button>
        </form>
      </div>
    </div>
  </div></div>`));
});

// ─── Vote Submit (POST) ───────────────────────────────────────────────────────

app.post('/vote/:projectId', (req, res) => {
  const voterToken = getVoterToken(req, res);
  const db         = loadDB();
  const pid        = parseInt(req.params.projectId);
  const project    = db.projects.find(p => p.id === pid);

  if (!project) return res.status(404).send(layout('Error', '<div class="alert alert-danger">Project not found.</div>'));

  const session = db.sessions.find(s => s.id === project.session_id);
  if (session.ended_at) return res.status(400).send(layout('Error', '<div class="alert alert-danger">This session has ended.</div>'));

  const alreadyVoted = db.votes.find(v => v.voter_token === voterToken && v.project_id === pid);
  if (alreadyVoted) {
    return res.status(409).send(layout('Already Voted for This Project', `
    <div class="row justify-content-center"><div class="col-md-5">
      <div class="card text-center p-4">
        <i class="bi bi-exclamation-circle text-warning mb-3" style="font-size:3rem"></i>
        <h4>Already Voted for This Project</h4>
        <p class="text-muted">You already voted for <strong>${esc(project.title)}</strong>. You can still vote for other projects.</p>
      </div>
    </div></div>`));
  }

  db.votes.push({
    id: nextId(db, 'vote'),
    project_id:  pid,
    session_id:  session.id,
    voter_token: voterToken,
    voter_ip:    req.ip,
    voted_at:    new Date().toISOString()
  });
  saveDB(db);

  res.send(layout('Vote Recorded!', `
  <div class="row justify-content-center"><div class="col-md-5">
    <div class="card text-center p-4">
      <i class="bi bi-check-circle-fill text-success mb-3" style="font-size:4rem"></i>
      <h3 class="text-success fw-bold mb-1">Vote Recorded!</h3>
      <p class="text-muted lead mb-1">You voted for:</p>
      <h4 class="fw-bold">${esc(project.title)}</h4>
      <span class="badge bg-secondary fs-6 mb-3">${esc(project.team_code)}</span>
      <p class="text-muted small">Thank you for participating in <strong>${esc(session.name)}</strong>!</p>
    </div>
  </div></div>`));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n=== Senior Design Voter ===');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Base URL: ${getDefaultBaseURL()}  <-- used for QR codes\n`);
});
