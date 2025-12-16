const express = require('express');
const path = require('path');
const storage = require('./storage');
const { discoverWizFixtures } = require('./wiz-discovery');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Art-Net daemon management
let artnetDaemon = null;
let restartCount = 0;
let lastRestartTime = null;
const MAX_RESTART_DELAY = 60000; // 60 seconds max backoff

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API Routes

// Get all devices
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await storage.readAll();
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a device by MAC address
app.get('/api/devices/:macAddress', async (req, res) => {
  try {
    const device = await storage.read(req.params.macAddress);
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    res.json(device);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new device
app.post('/api/devices', async (req, res) => {
  try {
    const { macAddress, ipAddress, name, type, channel } = req.body;

    // Validation
    if (!macAddress || !ipAddress || !name || !type || channel === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const device = await storage.create({
      macAddress,
      ipAddress,
      name,
      type,
      channel
    });

    res.status(201).json(device);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update a device
app.put('/api/devices/:macAddress', async (req, res) => {
  try {
    const { ipAddress, name, type, channel } = req.body;

    const updates = {};
    if (ipAddress !== undefined) updates.ipAddress = ipAddress;
    if (name !== undefined) updates.name = name;
    if (type !== undefined) updates.type = type;
    if (channel !== undefined) updates.channel = channel;

    const device = await storage.update(req.params.macAddress, updates);
    res.json(device);
  } catch (err) {
    if (err.message === 'Device not found') {
      return res.status(404).json({ error: err.message });
    }
    res.status(400).json({ error: err.message });
  }
});

// Delete a device
app.delete('/api/devices/:macAddress', async (req, res) => {
  try {
    const deleted = await storage.remove(req.params.macAddress);
    if (!deleted) {
      return res.status(404).json({ error: 'Device not found' });
    }
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Discover WiZ fixtures
app.post('/api/discover', async (req, res) => {
  try {
    const timeout = req.body.timeout || 3000;
    const devices = await discoverWizFixtures(timeout);
    res.json({ discovered: devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Art-Net daemon status
app.get('/api/artnet/status', (req, res) => {
  res.json({
    running: artnetDaemon !== null && !artnetDaemon.killed,
    restartCount,
    lastRestartTime
  });
});

// Start Art-Net daemon
app.post('/api/artnet/start', (req, res) => {
  if (artnetDaemon && !artnetDaemon.killed) {
    return res.status(400).json({ error: 'Art-Net daemon already running' });
  }
  startArtNetDaemon();
  res.json({ message: 'Art-Net daemon started' });
});

// Stop Art-Net daemon
app.post('/api/artnet/stop', (req, res) => {
  if (!artnetDaemon || artnetDaemon.killed) {
    return res.status(400).json({ error: 'Art-Net daemon not running' });
  }
  stopArtNetDaemon();
  res.json({ message: 'Art-Net daemon stopped' });
});

// Art-Net daemon management functions
function startArtNetDaemon() {
  artnetDaemon = spawn('node', ['artnet-daemon.js'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  artnetDaemon.stdout.on('data', (data) => {
    console.log(`[Art-Net Daemon] ${data.toString().trim()}`);
  });

  artnetDaemon.stderr.on('data', (data) => {
    console.error(`[Art-Net Daemon Error] ${data.toString().trim()}`);
  });

  artnetDaemon.on('exit', (code) => {
    console.log(`Art-Net daemon exited with code ${code}`);
    artnetDaemon = null;

    // Calculate backoff delay: exponential backoff with max limit
    const now = Date.now();
    if (lastRestartTime && (now - lastRestartTime) < 60000) {
      restartCount++;
    } else {
      restartCount = 0;
    }
    lastRestartTime = now;

    const delay = Math.min(Math.pow(2, restartCount) * 1000, MAX_RESTART_DELAY);
    console.log(`Restarting Art-Net daemon in ${delay}ms (restart count: ${restartCount})`);

    setTimeout(() => {
      startArtNetDaemon();
    }, delay);
  });

  console.log('Art-Net daemon started');
}

function stopArtNetDaemon() {
  if (artnetDaemon) {
    artnetDaemon.kill();
    artnetDaemon = null;
    restartCount = 0;
    console.log('Art-Net daemon stopped');
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Auto-start Art-Net daemon
  startArtNetDaemon();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  stopArtNetDaemon();
  process.exit(0);
});
