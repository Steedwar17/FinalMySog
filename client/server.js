require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Exponer las URLs de entorno al cliente sin hardcodear
// El cliente las lee de window.AUTH_SERVICE_URL y window.COORDINATOR_WS_URL
app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    window.AUTH_SERVICE_URL   = "${process.env.AUTH_SERVICE_URL   || 'http://localhost:4000'}";
    window.COORDINATOR_WS_URL = "${process.env.COORDINATOR_WS_URL || 'ws://localhost:5000'}";
  `);
});

// Servir solo los HTML del cliente
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/lobby.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'lobby.html'));
});

// Ruta raíz redirige a login
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

app.listen(PORT, () => {
  console.log(`Cliente web en puerto ${PORT}`);
});