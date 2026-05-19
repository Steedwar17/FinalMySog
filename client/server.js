require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    window.AUTH_SERVICE_URL   = "${process.env.AUTH_SERVICE_URL   || 'http://localhost:4000'}";
    window.COORDINATOR_WS_URL = "${process.env.COORDINATOR_WS_URL || ''}";
    window.GOOGLE_CLIENT_ID   = "${process.env.GOOGLE_CLIENT_ID   || ''}";
  `);
});


app.use(express.static(__dirname));


app.get('/', (req, res) => {
  res.redirect('/login.html');
});

app.listen(PORT, () => {
  console.log(`Cliente web en puerto ${PORT}`);
});
