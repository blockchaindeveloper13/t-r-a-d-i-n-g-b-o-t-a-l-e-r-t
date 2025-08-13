function initDB(db) {
  db.run(`CREATE TABLE IF NOT EXISTS analizler (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tarih TEXT,
    coin TEXT,
    analiz TEXT
  )`);
}

async function saveAnalysis(db, analysis) {
  db.run(`INSERT INTO analizler (tarih, coin, analiz) VALUES (?, ?, ?)`, [
    analysis.tarih,
    analysis.coin,
    JSON.stringify(analysis)
  ]);
  db.run(`DELETE FROM analizler WHERE id NOT IN (SELECT id FROM analizler ORDER BY id DESC LIMIT 100)`);
}

async function getRecentAnalyses(db) {
  return new Promise((resolve) => {
    db.all(`SELECT * FROM analizler ORDER BY id DESC LIMIT 100`, [], (err, rows) => {
      resolve(rows);
    });
  });
}

module.exports = { initDB, saveAnalysis, getRecentAnalyses };
